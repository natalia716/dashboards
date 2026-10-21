// Vendas da Payt para os painéis de criativos. A Payt não tem API de vendas: cada evento chega por postback no
// Cloudflare Worker do cliente (payt/worker.js), que guarda o último estado de cada transação sem dado do comprador.
//
// config.json do cliente:  "vendas": "payt", "payt": { "url": "https://payt-<cliente>.<conta>.workers.dev", "produtos": [] }
// Chave de leitura (a mesma do secret READ_KEY do Worker), no .env ou nos Secrets do GitHub: PAYT_READ_KEY_<CLIENTE>
//
// Cada venda vira [codigo, data, adId, adName, valorLiquido, produto, origem, contaVenda] — o formato da Hotmart mais
// `contaVenda`: 0 para upsell (o valor entra no faturamento do anúncio, mas não conta como mais uma venda).

const readKey = slug => process.env['PAYT_READ_KEY_' + slug.toUpperCase().replace(/-/g, '_')] || null;

// utm_content dos anúncios = {{ad.name}}|{{ad.id}} — o ID é o último trecho numérico. Só conta como Meta com
// utm_source do Facebook/Instagram (o tracker acrescenta sufixo: "FBjLj6aba…"); o Google também manda ID numérico
// no utm_content (ex.: 824766346248). Sem utm_source, vale o ID com cara de Meta (15+ dígitos).
function origin(utmContent, utmSource) {
  const parts = String(utmContent || '').split('::')[0].split('|').map(x => x.trim()).filter(Boolean);
  const i = parts.map(p => /^\d{10,}$/.test(p)).lastIndexOf(true);
  const src = String(utmSource || '').trim();
  const meta = src ? /^(fb|facebook|ig|instagram|meta)/i.test(src) : i >= 0 && parts[i].length >= 15;
  if (i >= 0 && meta) return { origem: 'meta', adId: parts[i], adName: parts.slice(0, i).join('|') || null };
  return { origem: i >= 0 || src ? 'outro' : 'semId', adId: null, adName: null };
}

// "AAAA-MM-DD HH:MM:SS" da Payt (horário de Brasília) → "AAAA-MM-DD"
const dayOf = v => { const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };

async function fetchSales(cfg, slug, since) {
  const key = readKey(slug);
  if (!cfg.payt || !cfg.payt.url) throw new Error(`defina "payt": { "url": ... } em clientes/${slug}/config.json`);
  if (!key) throw new Error('sem PAYT_READ_KEY_' + slug.toUpperCase().replace(/-/g, '_'));
  const res = await fetch(`${cfg.payt.url.replace(/\/$/, '')}/vendas?desde=${since}`, { headers: { authorization: 'Bearer ' + key } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(`Payt (receptor): HTTP ${res.status} ${j.error || ''}`.trim());

  const produtos = (cfg.payt.produtos || []).map(String);
  const valid = j.rows.filter(r => !r.test && r.payment_status === 'paid' && (!produtos.length || (produtos.includes(String(r.product_code)) || produtos.includes(String(r.product_name)))));
  // upsell sem UTM própria herda o anúncio da compra de origem
  const byId = new Map(j.rows.map(r => [r.transaction_id, r]));
  const out = [];
  let semComissao = 0;
  for (const r of valid) {
    const date = dayOf(r.paid_at) || dayOf(r.created_at);
    if (!date || date < since) continue;
    const upsell = /upsell/.test(r.type || '');
    let o = origin(r.utm_content, r.utm_source);
    if (!o.adId && upsell && r.upsell_from && byId.has(r.upsell_from)) { const p = byId.get(r.upsell_from); o = origin(p.utm_content, p.utm_source); }
    if (r.producer_cents == null) semComissao++;
    const cents = r.producer_cents != null ? r.producer_cents : r.total_cents || 0;
    out.push([r.transaction_id, date, o.adId, o.adName, Math.round(cents) / 100, String(r.product_name || r.product_code || ''), o.origem, upsell ? 0 : 1]);
  }
  // primeiro dia com postback recebido: antes dele não há venda da Payt no painel (a não ser pelo import do histórico)
  const firstDay = j.rows.map(r => (r.recebido_em || '').slice(0, 10)).filter(Boolean).sort()[0] || null;
  return { rows: out, firstDay, ultimoPostback: j.ultimoPostback, semComissao };
}

module.exports = { origin, fetchSales, readKey };
