// Importa o histórico de vendas da Payt (antes do postback existir) para um cliente de criativos com "vendas": "payt".
//
//   node importar-payt.js <cliente> <arquivo> [<arquivo> ...]   ex.: node importar-payt.js chefbernadete origem_de_vendas_20_10_2026.xlsx
//
// Use o relatório **Relatórios → Origem de vendas** da Payt (origem_de_vendas_*.xlsx): é o único export com as UTMs
// ("Utm Content (URL)" = {{ad.name}}|{{ad.id}}). O relatório de vendas comum não traz UTM, e traz nome, e-mail, CPF e
// endereço do comprador — não use. Daqui sai só clientes/<cliente>/vendas/payt.json com código, data, anúncio, valor
// (o "Você Recebe" = comissão da produtora) e produto.
//
// Vários exports se somam (a chave é o código da venda). Venda que voltar com status diferente de aprovado sai da base.
// No refresh, a venda que também chegou pelo postback vale a do postback.
const fs = require('fs');
const path = require('path');
const { readXlsx } = require('./xlsx');
const { origin } = require('./payt');

const [slug, ...files] = process.argv.slice(2);
if (!slug || !files.length) { console.error('uso: node importar-payt.js <cliente> <origem_de_vendas_*.xlsx> [...]'); process.exit(1); }
const OUT = path.join(__dirname, 'clientes', slug, 'vendas', 'payt.json');
if (!fs.existsSync(path.dirname(path.dirname(OUT)))) { console.error(`ERRO: cliente "${slug}" não existe em clientes/`); process.exit(1); }
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const money = v => typeof v === 'number' ? v : Number(String(v || '0').replace(/[^\d,-]/g, '').replace(',', '.')) || 0;

const base = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { vendas: [] };
const COLS = ['codigo', 'data', 'adId', 'adName', 'valorLiquido', 'produto', 'origem', 'contaVenda'];
const byCode = new Map(base.vendas.map(v => [v[0], v]));
let added = 0, updated = 0, removed = 0;

for (const file of files) {
  const rows = readXlsx(file);
  const head = rows[0].map(norm);
  const col = name => { const i = head.indexOf(norm(name)); if (i < 0) throw new Error(`${path.basename(file)}: coluna "${name}" não encontrada — use o relatório "Origem de vendas" da Payt`); return i; };
  const C = {
    code: col('Código da Venda'), status: col('Status da Venda'), pay: col('Status do Pagamento'), type: col('Tipo de Venda'),
    product: col('Produto'), net: col('Você Recebe'), date: col('Data'),
    uc: col('Utm Content (URL)'), us: col('Utm Source (URL)'), ucC: col('Utm Content (Campanha)'), usC: col('Utm Source (Campanha)')
  };
  for (const r of rows.slice(1)) {
    const code = String(r[C.code] || '').trim();
    if (!code) continue;
    const m = String(r[C.date] || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) throw new Error(`${code}: data inesperada "${r[C.date]}"`);
    if (norm(r[C.status]) !== 'compra aprovada' || norm(r[C.pay]) !== 'pagamento aprovado') {
      if (byCode.delete(code)) removed++;
      continue;
    }
    // UTM da URL do checkout; na falta, a do link de campanha da Payt
    const o = r[C.uc] || r[C.us] ? origin(r[C.uc], r[C.us]) : origin(r[C.ucC], r[C.usC]);
    const v = [code, `${m[3]}-${m[2]}-${m[1]}`, o.adId, o.adName, Math.round(money(r[C.net]) * 100) / 100, String(r[C.product] || ''), o.origem,
      norm(r[C.type]) === 'upsell' ? 0 : 1];
    byCode.has(code) ? updated++ : added++;
    byCode.set(code, v);
  }
}

const vendas = [...byCode.values()].sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1);
fs.writeFileSync(OUT, JSON.stringify({
  // "desde"/"ate" = primeira e última venda vistas nos exports: o painel avisa quando o período começa antes do histórico
  desde: vendas.length ? vendas[0][1] : null, ate: vendas.length ? vendas[vendas.length - 1][1] : null,
  importadoEm: new Date().toISOString(), colunas: COLS, vendas
}).replace(/\],\[/g, '],\n['));

const count = k => vendas.filter(v => v[6] === k).length;
console.log(`[${slug}] ${path.relative(__dirname, OUT)}: ${vendas.length} vendas (+${added} novas, ${updated} já existiam, -${removed} removidas) de ${vendas[0] && vendas[0][1]} a ${vendas.length && vendas[vendas.length - 1][1]}`);
console.log(`  por anúncio do Meta: ${count('meta')} · outra origem (Google, WhatsApp, e-mail…): ${count('outro')} · sem origem: ${count('semId')}`);
