// Vendas da Hotmart para os painéis de criativos: API (automático) e o parser do SCK, que o importar-hotmart.js também usa.
//
// Credenciais (Hotmart → Ferramentas → Credenciais Developers), por cliente, no .env ou nos Secrets do GitHub:
//   HOTMART_CLIENT_ID_<CLIENTE>, HOTMART_CLIENT_SECRET_<CLIENTE>, HOTMART_BASIC_<CLIENTE>
//
// Cada venda vira [codigo, data, adId, adName, valorLiquido, produto, origem] — o mesmo formato do import manual.
// A API também devolve nome e e-mail do comprador: nada disso é guardado.

const SEP = 'hQwK21wXxR';

// Anúncio do Meta a partir do SCK, montado pelos parâmetros de URL dos anúncios:
//   FB␟{{campaign.name}}|{{campaign.id}}␟{{adset.name}}|{{adset.id}}␟{{ad.name}}|{{ad.id}}␟{{placement}}   (␟ = SEP)
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

const credentials = slug => {
  const sfx = '_' + slug.toUpperCase().replace(/-/g, '_');
  const id = process.env['HOTMART_CLIENT_ID' + sfx], secret = process.env['HOTMART_CLIENT_SECRET' + sfx], basic = process.env['HOTMART_BASIC' + sfx];
  return id && secret && basic ? { id, secret, basic: basic.replace(/^Basic\s+/i, '') } : null;
};

const daySP = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ms));

// Vendas aprovadas/completas com data do pedido entre `since` e `until` (AAAA-MM-DD, fuso de São Paulo).
// Sem filtro de status a API devolve só APPROVED e COMPLETE — reembolso e chargeback somem do resultado.
async function fetchSales(cred, since, until) {
  const tok = await (await fetch(`https://api-sec-vlc.hotmart.com/security/oauth/token?grant_type=client_credentials&client_id=${encodeURIComponent(cred.id)}&client_secret=${encodeURIComponent(cred.secret)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + cred.basic } })).json();
  if (!tok.access_token) throw new Error(`Hotmart: autenticação falhou (${tok.error_description || tok.error || 'sem access_token'})`);
  const H = { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' };
  const api = async (ep, params) => {
    const items = [];
    let page = null;
    do {
      const q = new URLSearchParams({ ...params, max_results: '500', ...(page ? { page_token: page } : {}) });
      const res = await fetch(`https://developers.hotmart.com/payments/api/v1/sales/${ep}?${q}`, { headers: H });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.error) throw new Error(`Hotmart ${ep}: HTTP ${res.status} ${j.error_description || j.error || ''}`.trim());
      items.push(...(j.items || []));
      page = j.page_info && j.page_info.next_page_token;
    } while (page);
    return items;
  };
  const range = { start_date: String(Date.parse(since + 'T00:00:00-03:00')), end_date: String(Date.parse(until + 'T23:59:59.999-03:00')) };
  const [history, commissions] = await Promise.all([api('history', range), api('commissions', range)]);

  // valor = comissão do produtor (o "faturamento líquido" do export)
  const net = new Map(commissions.map(c => [c.transaction, (c.commissions || []).find(x => x.source === 'PRODUCER')]));
  const out = [];
  for (const h of history) {
    const p = h.purchase, c = net.get(p.transaction);
    if (!c) throw new Error(`Hotmart: ${p.transaction} sem comissão de produtor`);
    let value = c.commission.value;
    if (c.commission.currency_code !== 'BRL') {
      // compra no exterior: o líquido vem em USD. Volta para reais como no export:
      // ÷ taxa de recebimento (moeda da compra → USD = bruto em USD ÷ preço base) ÷ taxa de compra (BRL → moeda da compra)
      const d = (await api('price/details', { transaction: p.transaction }))[0];
      const recvRate = (value + p.hotmart_fee.total) / d.base.value;
      value = value / recvRate / d.real_conversion_rate;
    }
    const o = origin(p.tracking && p.tracking.source_sck);
    out.push([p.transaction, daySP(p.order_date), o.adId, o.adName, Math.round(value * 100) / 100, String(h.product.id), o.origem]);
  }
  return out;
}

module.exports = { origin, credentials, fetchSales, SEP };
