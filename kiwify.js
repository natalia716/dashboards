// Vendas da Kiwify (API pública, docs.kiwify.com.br) para o painel de lançamento/perpétuo.
//
// Credenciais (Kiwify → Apps → API → Criar API Key), por cliente, no .env ou nos Secrets do GitHub:
//   KIWIFY_CLIENT_ID_<CLIENTE>, KIWIFY_CLIENT_SECRET_<CLIENTE>, KIWIFY_ACCOUNT_ID_<CLIENTE>
//
// Cada venda vira { id, date, status, productId, productName, valueCents, tracking } — sem nome, e-mail, CPF ou
// telefone do comprador (a API devolve tudo isso; nada sai daqui).

const BASE = 'https://public-api.kiwify.com/v1';

const credentials = slug => {
  const sfx = '_' + slug.toUpperCase().replace(/-/g, '_');
  const id = process.env['KIWIFY_CLIENT_ID' + sfx], secret = process.env['KIWIFY_CLIENT_SECRET' + sfx], account = process.env['KIWIFY_ACCOUNT_ID' + sfx];
  return id && secret && account ? { id, secret, account } : null;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const daySP = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(iso));
const addDays = (iso, n) => { const t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

async function session(cred) {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cred.id, client_secret: cred.secret }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!tok.access_token) throw new Error(`Kiwify: autenticação falhou (HTTP ${res.status} ${tok.message || tok.error || 'sem access_token'})`);
  const H = { Authorization: 'Bearer ' + tok.access_token, 'x-kiwify-account-id': cred.account };
  // limite da Kiwify: 100 chamadas/min — 429 espera e tenta de novo
  return async (ep, params) => {
    for (let tent = 0; ; tent++) {
      const r = await fetch(`${BASE}/${ep}?${new URLSearchParams(params)}`, { headers: H });
      if (r.status === 429 && tent < 4) { await sleep(15000 * (tent + 1)); continue; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(`Kiwify ${ep}: HTTP ${r.status} ${j.message || j.error || ''}`.trim());
      return j;
    }
  };
}

// Todas as vendas (qualquer status) criadas entre `since` e `until` (AAAA-MM-DD). A API aceita no máximo 90 dias por
// consulta e não diz o fuso das datas: a janela pede um dia a mais de cada lado e o corte é feito aqui, no fuso de SP.
async function fetchSales(cred, since, until) {
  const api = await session(cred);
  const PAGE = 100, out = new Map();
  for (let ini = addDays(since, -1); ini <= addDays(until, 1); ini = addDays(ini, 80)) {
    const fim = addDays(ini, 79) < addDays(until, 1) ? addDays(ini, 79) : addDays(until, 1);
    for (let page = 1; ; page++) {
      const j = await api('sales', {
        start_date: ini + ' 00:00:00.000', end_date: fim + ' 23:59:59.999',
        view_full_sale_details: 'true', page_size: String(PAGE), page_number: String(page),
      });
      const data = j.data || [];
      for (const s of data) {
        const date = daySP(s.created_at);
        if (date < since || date > until) continue;
        const p = s.payment || {}, t = s.tracking || {};
        // valor = o que o comprador pagou (bruto). A Kiwify manda os valores em centavos.
        const cents = p.charge_amount != null ? p.charge_amount : p.product_base_price != null ? p.product_base_price : s.net_amount;
        out.set(s.id, {
          id: s.id, date, approvedDate: s.approved_date ? daySP(s.approved_date) : null, status: s.status,
          productId: s.product ? String(s.product.id) : null, productName: s.product ? s.product.name : null,
          parentOrderId: s.parent_order_id || null, currency: p.charge_currency || s.currency || 'BRL',
          valueCents: Math.round(Number(cents) || 0),
          tracking: { utmSource: t.utm_source || null, utmMedium: t.utm_medium || null, utmCampaign: t.utm_campaign || null, utmContent: t.utm_content || null, utmTerm: t.utm_term || null, src: t.src || null, sck: t.sck || null },
        });
      }
      const count = j.pagination && j.pagination.count;
      if (data.length < PAGE || (count != null && page * PAGE >= count)) break;
    }
    if (fim >= addDays(until, 1)) break;
  }
  return [...out.values()];
}

// pago = venda que conta; reembolso, chargeback, boleto/pix em aberto e recusa ficam fora
const PAGO = new Set(['paid', 'approved']);

module.exports = { credentials, fetchSales, PAGO };
