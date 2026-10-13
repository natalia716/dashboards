// Debriefing do lançamento: cruza as vendas do produto final (MBA) com as vendas do
// workshop para descobrir de qual criativo / público veio cada comprador.
//
// Entrada: exports da Hubla (.xlsx) colocados em clientes/<cliente>/entrada/
//   - mba.xlsx       vendas do produto final
//   - workshop.xlsx  vendas do ingresso do workshop (é quem carrega as UTMs do anúncio)
// A pasta `entrada/` tem dado pessoal (nome, e-mail, telefone) e NÃO vai para o git.
//
// Saída: só agregados, sem dado pessoal — é isso que vai para a página publicada.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { lerXlsx } = require('./xlsx');

const PAGO = /^(paga|pago|paid)$/i;
const REEMBOLSO = /reembols|estorn|refund|chargeback/i;

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const email = s => norm(s).replace(/\s+/g, '');
const hash = e => e ? crypto.createHash('sha256').update(e).digest('hex') : null;
const num = v => { const n = Number(String(v || '').replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')); return isFinite(n) ? n : 0; };
// "03/10/2026 12:36:46" ou "2026-10-03..." → "2026-10-03"
const data = v => {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
};

// a aba de vendas é a que tem "Email do cliente"; as outras (recebedores, etc.) são ignoradas
function abaDeVendas(caminho) {
  for (const aba of lerXlsx(caminho)) {
    const l = aba.linhas[0];
    if (l && Object.keys(l).some(k => /email do cliente/i.test(k))) return aba.linhas;
  }
  return [];
}

function faturas(linhas) {
  const col = k => Object.keys(linhas[0] || {}).find(c => norm(c) === norm(k)) || k;
  const c = {
    status: col('Status da fatura'), pago: col('Data de pagamento'), email: col('Email do cliente'),
    total: col('Valor total'), produto: col('Nome do produto'), obNome: col('Nome do produto de orderbump'),
    utmConteudo: col('UTM Conteúdo'), utmCampanha: col('UTM Campanha'), utmTermo: col('UTM Termo'), utmOrigem: col('UTM Origem'),
    cliente: col('ID do cliente'),
  };
  return linhas.map(r => ({
    email: email(r[c.email]),
    status: String(r[c.status] || '').trim(),
    pago: PAGO.test(String(r[c.status] || '').trim()),
    reembolsada: REEMBOLSO.test(String(r[c.status] || '')),
    data: data(r[c.pago]),
    valor: num(r[c.total]),
    produto: String(r[c.produto] || '').trim(),
    orderBump: String(r[c.obNome] || '').trim(),
    utmConteudo: String(r[c.utmConteudo] || '').trim(),
    utmCampanha: String(r[c.utmCampanha] || '').trim(),
    utmTermo: String(r[c.utmTermo] || '').trim(),
    utmOrigem: String(r[c.utmOrigem] || '').trim(),
    clienteId: String(r[c.cliente] || '').trim(),
  })).filter(f => f.email || f.clienteId);
}

// utm_content da Hubla: "NOME-DO-ANUNCIO|<ad id>::<rastreio do Facebook>"
function acharAnuncio(utm, ads) {
  const limpo = decodeURIComponent(String(utm || '').replace(/\+/g, ' ')).split('::')[0].trim();
  if (!limpo) return null;
  const partes = limpo.split('|').map(x => x.trim()).filter(Boolean);
  const porId = new Map(ads.map(a => [a.id, a]));
  const porNome = new Map(ads.map(a => [norm(a.name), a]));
  for (const p of partes) { const hit = porId.get(p) || porNome.get(norm(p)); if (hit) return hit; }
  return null;
}

function soma(lista, campo) { return lista.reduce((t, x) => t + (x[campo] || 0), 0); }

function gerar({ dir, ads, gastoPorAdId, gastoTotal, vendasWebhook = [], campaigns = [] }) {
  const entrada = path.join(dir, 'entrada');
  const fMba = path.join(entrada, 'mba.xlsx'), fWs = path.join(entrada, 'workshop.xlsx');
  if (!fs.existsSync(fMba)) return null;

  const mba = faturas(abaDeVendas(fMba));
  const mbaPagas = mba.filter(f => f.pago);
  const temWorkshop = fs.existsSync(fWs);
  const ws = temWorkshop ? faturas(abaDeVendas(fWs)) : [];
  const wsPagas = ws.filter(f => f.pago);
  const ingressosWebhook = vendasWebhook.filter(v => v.main);
  // sem o export do workshop, os ingressos das tabelas saem das próprias vendas do webhook
  const baseIngressos = wsPagas.length
    ? wsPagas.map(f => ({ ad: acharAnuncio(f.utmConteudo, ads), valor: f.valor }))
    : ingressosWebhook.map(v => ({ ad: v.adId ? ads.find(a => a.id === v.adId) || null : null, valor: (v.valueCents || 0) / 100 }));

  // Comprador do workshop → anúncio. Duas fontes: o export (casa por e-mail) e as próprias
  // vendas do webhook, que a partir da v2 do webhook-planilha.gs trazem customer_id e o
  // SHA-256 do e-mail — dá para cruzar sem guardar dado pessoal. A primeira compra manda.
  const origem = new Map();        // e-mail        → { ad, data }
  const origemPorId = new Map();   // customer_id   → { ad, data }
  const origemPorHash = new Map(); // sha256(email) → { ad, data }
  for (const v of ingressosWebhook) {
    const ad = v.adId ? ads.find(a => a.id === v.adId) || null : null;
    const reg = { ad, data: v.date };
    if (v.customerId && !origemPorId.has(v.customerId)) origemPorId.set(v.customerId, reg);
    if (v.emailHash && !origemPorHash.has(v.emailHash)) origemPorHash.set(v.emailHash, reg);
  }
  for (const f of wsPagas) {
    if (origem.has(f.email)) continue;
    const ad = acharAnuncio(f.utmConteudo, ads);
    origem.set(f.email, {
      ad, data: f.data,
      temTrafego: !!ad || /meta|facebook|instagram|ig|fb/i.test(f.utmOrigem),
    });
  }

  const nomeCampanha = new Map(campaigns.map(c => [c.id, c.name]));
  const compradores = mbaPagas.map(f => {
    const o = origem.get(f.email) || origemPorId.get(f.clienteId) || origemPorHash.get(hash(f.email)) || null;
    return {
      data: f.data, valor: f.valor,
      veioDoWorkshop: !!o,
      ad: o && o.ad ? o.ad : null,
      dataWorkshop: o ? o.data : null,
    };
  });

  // jornada de quem veio do workshop, sem nome nem e-mail: só o caminho até a compra
  const jornada = compradores
    .filter(c => c.veioDoWorkshop)
    .sort((a, b) => (a.dataWorkshop || '').localeCompare(b.dataWorkshop || ''))
    .map((c, i) => ({
      n: i + 1,
      ingresso: c.dataWorkshop,
      compra: c.data,
      valor: c.valor,
      criativo: c.ad ? c.ad.name : null,
      publico: c.ad ? (c.ad.adsetName || null) : null,
      temp: c.ad ? c.ad.temp : null,
      campanha: c.ad ? nomeCampanha.get(c.ad.campaignId) || null : null,
    }));

  const chave = c => c.ad ? c.ad.id : null;
  const agregar = (lista, chaveFn, rotuloFn) => {
    const m = new Map();
    for (const x of lista) {
      const k = chaveFn(x); if (k == null) continue;
      if (!m.has(k)) m.set(k, { chave: k, rotulo: rotuloFn(x), ingressos: 0, mba: 0, receitaMba: 0, gasto: 0, temp: x.temp || (x.ad && x.ad.temp) || null });
      const o = m.get(k);
      if (x.tipo === 'ingresso') o.ingressos++;
      else { o.mba++; o.receitaMba += x.valor || 0; }
    }
    return m;
  };

  // uma lista só, com ingressos e MBAs, para agregar por criativo / público / temperatura
  const itens = [];
  for (const b of baseIngressos) itens.push({ tipo: 'ingresso', ad: b.ad, temp: b.ad && b.ad.temp, valor: b.valor });
  for (const c of compradores) itens.push({ tipo: 'mba', ad: c.ad, temp: c.ad && c.ad.temp, valor: c.valor });

  const porCriativo = [...agregar(itens, x => x.ad ? x.ad.id : null, x => x.ad.name).values()]
    .map(o => ({ ...o, adset: (ads.find(a => a.id === o.chave) || {}).adsetName || null, gasto: gastoPorAdId[o.chave] || 0 }))
    .map(o => ({ ...o, taxa: o.ingressos ? o.mba / o.ingressos : null, cpaMba: o.mba ? o.gasto / o.mba : null }))
    .sort((a, b) => b.mba - a.mba || b.ingressos - a.ingressos);

  const porPublico = [...agregar(itens, x => x.ad ? (x.ad.adsetName || x.ad.adsetId) : null, x => x.ad.adsetName || x.ad.adsetId).values()]
    .map(o => ({ ...o, taxa: o.ingressos ? o.mba / o.ingressos : null }))
    .sort((a, b) => b.mba - a.mba || b.ingressos - a.ingressos);

  const porCampanha = [...agregar(itens, x => x.ad ? x.ad.campaignId : null, x => nomeCampanha.get(x.ad.campaignId) || x.ad.campaignId).values()]
    .map(o => ({ ...o, taxa: o.ingressos ? o.mba / o.ingressos : null }))
    .sort((a, b) => b.mba - a.mba || b.ingressos - a.ingressos);

  const porTemperatura = [...agregar(itens, x => x.temp || null, x => x.temp).values()]
    .map(o => ({ ...o, taxa: o.ingressos ? o.mba / o.ingressos : null }))
    .sort((a, b) => b.mba - a.mba);

  const comAd = compradores.filter(c => c.ad).length;
  const doWorkshop = compradores.filter(c => c.veioDoWorkshop).length;
  const totalWorkshop = wsPagas.length ? new Set(wsPagas.map(f => f.email)).size : ingressosWebhook.length;
  const receita = soma(mbaPagas, 'valor');

  return {
    geradoEm: new Date().toISOString(),
    temWorkshop: temWorkshop || origemPorId.size > 0 || origemPorHash.size > 0,
    fonteWorkshop: wsPagas.length ? 'export' : ((origemPorId.size || origemPorHash.size) ? 'webhook' : 'nenhuma'),
    produto: (mbaPagas[0] || mba[0] || {}).produto || 'Produto final',
    mba: {
      vendas: mbaPagas.length,
      reembolsos: mba.filter(f => f.reembolsada).length,
      receita,
      ticket: mbaPagas.length ? receita / mbaPagas.length : null,
      primeira: mbaPagas.map(f => f.data).filter(Boolean).sort()[0] || null,
      ultima: mbaPagas.map(f => f.data).filter(Boolean).sort().pop() || null,
      roas: gastoTotal ? receita / gastoTotal : null,
      cpa: mbaPagas.length ? gastoTotal / mbaPagas.length : null,
      gasto: gastoTotal,
    },
    workshop: {
      compradores: totalWorkshop,
      comTrafego: wsPagas.length ? [...origem.values()].filter(o => o.ad).length : ingressosWebhook.filter(v => v.adId).length,
    },
    cruzamento: {
      doWorkshop,                               // compradores do MBA que também compraram o ingresso
      comCriativo: comAd,                       // desses, os que dá para ligar a um anúncio
      diretos: mbaPagas.length - doWorkshop,    // compraram o MBA sem ter passado pelo workshop
      taxa: totalWorkshop ? doWorkshop / totalWorkshop : null,
    },
    porCriativo, porPublico, porTemperatura, porCampanha, jornada,
  };
}

module.exports = { gerar };
