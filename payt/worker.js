// Receptor do postback da Payt (Cloudflare Worker) → banco D1. O refresh.js busca as vendas daqui a cada 15 min.
//
//   POST /postback/<POSTBACK_TOKEN>   a Payt manda cada evento de venda (URL cadastrada em Ferramentas → Postbacks)
//   GET  /vendas?desde=AAAA-MM-DD     o painel lê as vendas (cabeçalho Authorization: Bearer <READ_KEY>)
//   GET  /                            só para conferir que está no ar
//
// Guarda UMA linha por transação (o último estado dela) e só o que o painel usa: código, tipo, status, datas, valores,
// produto e UTMs. Nome, e-mail, documento, telefone e endereço do comprador NÃO são guardados.
//
// Segredos (wrangler secret put): POSTBACK_TOKEN (trecho da URL do postback) e READ_KEY (leitura pelo painel).
// A integration_key da Payt é gravada no primeiro postback válido e, a partir daí, postback com outra chave é recusado.
// Publicar: npx wrangler deploy --config payt/wrangler.toml (ver payt/README.md).

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS vendas (
    transaction_id TEXT PRIMARY KEY, type TEXT, status TEXT, payment_status TEXT, test INTEGER,
    created_at TEXT, paid_at TEXT, updated_at TEXT,
    total_cents INTEGER, producer_cents INTEGER, product_code TEXT, product_name TEXT, upsell_from TEXT,
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT, src TEXT,
    recebido_em TEXT)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
];

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const s = v => (v == null ? null : String(v));
const n = v => (v == null || v === '' || isNaN(Number(v)) ? null : Math.round(Number(v)));

// caminhos das chaves do payload, sem os valores: ajuda a conferir o formato que a Payt manda sem guardar dado pessoal
const keyPaths = (o, pre = '') => !o || typeof o !== 'object' ? [] :
  Object.keys(o).flatMap(k => { const p = pre ? `${pre}.${k}` : k; return [p, ...keyPaths(Array.isArray(o[k]) ? o[k][0] : o[k], p)]; });

async function ensureSchema(db) {
  await db.batch(SCHEMA.map(q => db.prepare(q)));
}

async function postback(req, env) {
  let body;
  const text = await req.text();
  try { body = JSON.parse(text); } catch (e) {
    // fallback: formulário (application/x-www-form-urlencoded) com o JSON num campo
    const f = new URLSearchParams(text);
    try { body = JSON.parse(f.get('data') || f.get('payload') || ''); } catch (e2) { return json({ ok: false, error: 'corpo não é JSON' }, 400); }
  }
  const db = env.DB;
  await ensureSchema(db);

  const key = s(body.integration_key);
  const saved = await db.prepare('SELECT v FROM meta WHERE k = ?').bind('integration_key').first();
  if (saved && key && saved.v !== key) return json({ ok: false, error: 'integration_key diferente da registrada' }, 401);
  const now = new Date().toISOString();
  const metas = [db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind('ultimo_postback', now),
                 db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind('estrutura', JSON.stringify(keyPaths(body)))];
  if (!saved && key) metas.push(db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').bind('integration_key', key));

  const type = s(body.type);
  const id = s(body.transaction_id);
  // último evento (sem dado pessoal): ajuda a entender um postback que não virou venda
  metas.push(db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind('ultimo_evento', JSON.stringify({
    em: now, type, status: s(body.status), payment_status: s((body.transaction || {}).payment_status), test: !!body.test, tem_id: !!id })));
  // carrinho abandonado não é venda (e traz dado de contato): não guarda
  if (!id || type === 'abandoned-cart' || body.status === 'lost_cart') { await db.batch(metas); return json({ ok: true, ignorado: type || 'sem transaction_id' }); }

  const t = body.transaction || {};
  const link = body.link || {};
  // UTMs: link.sources (as do checkout); na falta, os parâmetros da URL do checkout ou da origem do cliente
  const origin = body.origin || (body.customer || {}).origin || {};
  const qs = [link.sources, link.query_params, origin.query_params, (origin.most_recent_campaign || {}).last_query_params].filter(Boolean);
  const pick = k => { for (const q of qs) if (q[k] != null && q[k] !== '') return q[k]; return null; };
  const src = { utm_source: pick('utm_source'), utm_medium: pick('utm_medium'), utm_campaign: pick('utm_campaign'), utm_content: pick('utm_content'), utm_term: pick('utm_term'), src: pick('src') };
  const prod = body.product || {};
  const comm = Array.isArray(body.commission) ? body.commission : [];
  const producer = comm.filter(c => String(c.type || '').toLowerCase() === 'producer');
  const producerCents = producer.length ? producer.reduce((a, c) => a + (n(c.amount) || 0), 0) : null;
  const updatedAt = s(t.updated_at || body.updated_at) || now;

  // postbacks podem chegar fora de ordem: só sobrescreve se o evento for igual ou mais novo que o guardado
  const upsert = db.prepare(`INSERT INTO vendas VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
    ON CONFLICT(transaction_id) DO UPDATE SET type=?2, status=?3, payment_status=?4, test=?5, created_at=?6, paid_at=?7, updated_at=?8,
      total_cents=?9, producer_cents=?10, product_code=?11, product_name=?12, upsell_from=?13,
      utm_source=?14, utm_medium=?15, utm_campaign=?16, utm_content=?17, utm_term=?18, src=?19, recebido_em=?20
    WHERE excluded.updated_at >= vendas.updated_at`).bind(
    id, type, s(body.status), s(t.payment_status), body.test ? 1 : 0,
    s(t.created_at || body.started_at), s(t.paid_at), updatedAt,
    n(t.total_price), producerCents, s(prod.code), s(prod.name), s(t.upsell_from || body.upsell_code),
    s(src.utm_source), s(src.utm_medium), s(src.utm_campaign), s(src.utm_content), s(src.utm_term), s(src.src),
    now);
  await db.batch([upsert, ...metas]);
  return json({ ok: true });
}

async function vendas(req, env, url) {
  if (!env.READ_KEY || req.headers.get('authorization') !== `Bearer ${env.READ_KEY}`) return json({ ok: false, error: 'não autorizado' }, 401);
  await ensureSchema(env.DB);
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('desde') || '') ? url.searchParams.get('desde') : '2000-01-01';
  const { results } = await env.DB.prepare(
    `SELECT * FROM vendas WHERE COALESCE(paid_at, created_at, recebido_em) >= ? ORDER BY COALESCE(paid_at, created_at, recebido_em)`).bind(desde).all();
  const meta = Object.fromEntries((await env.DB.prepare('SELECT k, v FROM meta WHERE k != ?').bind('integration_key').all()).results.map(r => [r.k, r.v]));
  return json({ ok: true, ultimoPostback: meta.ultimo_postback || null, estrutura: meta.estrutura ? JSON.parse(meta.estrutura) : null, rows: results });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === 'POST' && url.pathname.startsWith('/postback/')) {
        if (!env.POSTBACK_TOKEN || url.pathname !== `/postback/${env.POSTBACK_TOKEN}`) return json({ ok: false, error: 'token inválido' }, 401);
        return await postback(req, env);
      }
      if (req.method === 'GET' && url.pathname === '/vendas') return await vendas(req, env, url);
      if (req.method === 'GET' && url.pathname === '/') return json({ ok: true, servico: 'postback Payt → painel de criativos' });
      return json({ ok: false, error: 'não encontrado' }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  },
};
