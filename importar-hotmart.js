// Importa o export de vendas da Hotmart ("sales_history_*.xls") para um cliente do tipo "criativos".
//
//   node importar-hotmart.js <cliente> <arquivo>     ex.: node importar-hotmart.js glauborges "%USERPROFILE%\Downloads\sales_history_....xls"
//
// O export traz nome, e-mail, telefone e CPF do comprador — e este repositório é PÚBLICO. Por isso o arquivo nunca entra
// no git: daqui sai só clientes/<cliente>/vendas/hotmart.json com código da transação, data, anúncio, valor e produto.
//
// Vários exports se somam (a chave é o código da transação): dá para importar só a última semana. Venda que voltar
// com status diferente de Aprovado/Completo (reembolso, chargeback…) sai da base.
//
// O anúncio vem do código SCK, montado pelos parâmetros de URL do Meta:
//   FB␟{{campaign.name}}|{{campaign.id}}␟{{adset.name}}|{{adset.id}}␟{{ad.name}}|{{ad.id}}␟{{placement}}   (␟ = "hQwK21wXxR")
const fs = require('fs');
const path = require('path');
const { readXlsx } = require('./xlsx');

const [slug, file] = process.argv.slice(2);
if (!slug || !file) { console.error('uso: node importar-hotmart.js <cliente> <arquivo sales_history_*.xls>'); process.exit(1); }
const OUT = path.join(__dirname, 'clientes', slug, 'vendas', 'hotmart.json');
if (!fs.existsSync(path.dirname(path.dirname(OUT)))) { console.error(`ERRO: cliente "${slug}" não existe em clientes/`); process.exit(1); }

const SEP = 'hQwK21wXxR';
const VALIDO = new Set(['aprovado', 'completo']);
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const rows = readXlsx(file);
const head = rows[0].map(norm);
const col = name => { const i = head.indexOf(name); if (i < 0) throw new Error(`coluna "${name}" não encontrada no export`); return i; };
const C = {
  code: col('codigo da transacao'), status: col('status da transacao'), date: col('data da transacao'),
  product: col('codigo do produto'), net: col('faturamento liquido'), currency: col('moeda de recebimento'), sck: col('codigo sck'),
  buyRate: col('taxa de conversao (moeda de compra)'), recvRate: col('taxa de conversao (moeda de recebimento)')
};

// anúncio do Meta (id + nome), link na bio, ou sem identificação
function origin(sck) {
  const s = String(sck || '');
  const p = s.split('|');
  if (p.length === 4) {
    const adId = p[3].split(SEP)[0], adName = (p[2].split(SEP)[1] || '').trim();
    if (/^\d{10,}$/.test(adId)) return { origem: 'meta', adId, adName: adName || null };
  }
  if (/link_in_bio/i.test(s)) return { origem: 'bio', adId: null, adName: null };
  return { origem: 'semId', adId: null, adName: null };
}

const base = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { vendas: [] };
const COLS = ['codigo', 'data', 'adId', 'adName', 'valorLiquido', 'produto', 'origem'];
const byCode = new Map(base.vendas.map(v => [v[0], v]));
let added = 0, updated = 0, removed = 0, maxDate = base.ate || null;

for (const r of rows.slice(1)) {
  const code = String(r[C.code] || '').trim();
  if (!code) continue;
  const m = String(r[C.date] || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) throw new Error(`${code}: data da transação inesperada "${r[C.date]}"`);
  const date = `${m[3]}-${m[2]}-${m[1]}`;
  if (!maxDate || date > maxDate) maxDate = date;
  if (!VALIDO.has(norm(r[C.status]))) {
    if (byCode.delete(code)) removed++;
    continue;
  }
  // compra no exterior: o líquido vem na moeda de recebimento (ex.: USD). As taxas do próprio export levam de volta a reais:
  // taxa de compra = BRL → moeda da compra; taxa de recebimento = moeda da compra → moeda de recebimento
  let net = Number(r[C.net] || 0);
  if (r[C.currency] !== 'BRL') {
    const buyRate = Number(r[C.buyRate]), recvRate = Number(r[C.recvRate]);
    if (!(buyRate > 0 && recvRate > 0)) throw new Error(`${code}: recebido em ${r[C.currency]} sem taxa de conversão para converter em reais`);
    net = net / recvRate / buyRate;
  }
  const o = origin(r[C.sck]);
  const v = [code, date, o.adId, o.adName, Math.round(net * 100) / 100, String(r[C.product] || ''), o.origem];
  byCode.has(code) ? updated++ : added++;
  byCode.set(code, v);
}

const vendas = [...byCode.values()].sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1);
fs.writeFileSync(OUT, JSON.stringify({
  // "ate" = data da venda mais recente vista num export: o painel avisa que não há vendas importadas depois dela
  ate: maxDate, importadoEm: new Date().toISOString(), colunas: COLS, vendas
}).replace(/\],\[/g, '],\n['));

const count = k => vendas.filter(v => v[6] === k).length;
console.log(`[${slug}] ${path.relative(__dirname, OUT)}: ${vendas.length} vendas (+${added} novas, ${updated} já existiam, -${removed} removidas) até ${maxDate}`);
console.log(`  por anúncio do Meta: ${count('meta')} · link na bio: ${count('bio')} · sem identificação: ${count('semId')}`);
