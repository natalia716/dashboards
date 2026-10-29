// Coleta dados do Meta Ads (+ planilha de leads ou vendas da Hubla) de UM cliente e gera os JSONs do dashboard dele.
//
//   node refresh.js <cliente>      ex.: node refresh.js omundoclinico
//
// Lê clientes/<cliente>/config.json e escreve clientes/<cliente>/out/*.json.
// `tipo` no config escolhe o fluxo: ausente/"leads" = Meta + planilha de leads (mainLeads);
// "lancamento" = Meta em nível de anúncio + vendas da Hubla via planilha do webhook (mainLancamento);
// "criativos" = Meta por anúncio e por dia + vendas da Hotmart ligadas pelo ID do anúncio (mainCriativos).
// O token NUNCA fica no código: vem de META_TOKEN_<CLIENTE> ou, na falta, de META_TOKEN
// (localmente via arquivo .env, no GitHub Actions via Secret).
const fs = require('fs');
const path = require('path');
const hotmart = require('./hotmart');
const payt = require('./payt');

const slug = process.argv[2];
if (!slug || !/^[a-z0-9-]+$/.test(slug)) { console.error('uso: node refresh.js <cliente>   (ex.: omundoclinico)'); process.exit(1); }
const DIR = path.join(__dirname, 'clientes', slug);
const CFG_PATH = path.join(DIR, 'config.json');
if (!fs.existsSync(CFG_PATH)) { console.error(`ERRO: não existe ${CFG_PATH}`); process.exit(1); }
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));

loadDotEnv();
const TOKEN = process.env['META_TOKEN_' + slug.toUpperCase().replace(/-/g, '_')] || process.env.META_TOKEN;
if (!TOKEN) { console.error('ERRO: defina META_TOKEN (arquivo .env ou variável de ambiente)'); process.exit(1); }
const ACCOUNT = CFG.conta;
const sheetCsvUrl = p => `https://docs.google.com/spreadsheets/d/${p.id}/export?format=csv` + (p.gid ? `&gid=${p.gid}` : '');
const SHEET_CSV = CFG.planilha ? sheetCsvUrl(CFG.planilha) : null;
const GRAPH = 'https://graph.facebook.com/v21.0';
const SINCE = CFG.desde || '2026-01-01';
const CAMP_FILTER = new RegExp(CFG.filtroCampanha, 'i');
const STAGES = (CFG.etapas || []).map(e => ({ ...e, re: new RegExp(e.match) }));

const OUT = path.join(DIR, 'out');
fs.mkdirSync(OUT, { recursive: true });

function loadDotEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Erros transitórios do Graph: 1/2 (unknown/service), 4/17/80000 (rate limit), 341 (app limit)
const TRANSIENT = new Set([1, 2, 4, 17, 341, 80000]);

// token de uma conta: META_TOKEN_ACT_<número da conta> (conta em outro Business Manager), senão o do cliente/geral
const tokenFor = act => process.env['META_TOKEN_ACT_' + String(act).replace(/^act_/, '')] || TOKEN;

async function graphGetAll(edge, params, token = TOKEN) {
  let url = `${GRAPH}/${edge}?${new URLSearchParams({ ...params, access_token: token, limit: params.limit || '500' })}`;
  const rows = [];
  while (url) {
    let j, lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(url);
        j = await res.json();
        if (!j.error) { lastErr = null; break; }
        lastErr = j.error;
        // o flag is_transient do Graph não é confiável para o code 2 — na prática o retry resolve
        if (!TRANSIENT.has(Number(j.error.code))) break;
      } catch (e) {
        lastErr = { message: e.message, code: 2 };
      }
      await sleep(1500 * Math.pow(2, attempt)); // 1.5s, 3s, 6s, 12s
    }
    if (lastErr) throw new Error(`Graph API ${edge}: ${lastErr.message} [${rows.length} linhas até aqui]`);
    rows.push(...(j.data || []));
    url = j.paging && j.paging.next ? j.paging.next : null;
  }
  return rows;
}

function todaySP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

// ---------- CSV parser (campos com aspas e vírgulas) ----------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r[0] || '').trim() !== '');
}

// ---------- Estado → UF ----------
const UF = {
  'acre':'AC','alagoas':'AL','amapa':'AP','amazonas':'AM','bahia':'BA','ceara':'CE','distrito federal':'DF',
  'espirito santo':'ES','goias':'GO','maranhao':'MA','mato grosso':'MT','mato grosso do sul':'MS','minas gerais':'MG',
  'para':'PA','paraiba':'PB','parana':'PR','pernambuco':'PE','piaui':'PI','rio de janeiro':'RJ','rio grande do norte':'RN',
  'rio grande do sul':'RS','rondonia':'RO','roraima':'RR','santa catarina':'SC','sao paulo':'SP','sergipe':'SE','tocantins':'TO'
};
const UF_CODES = new Set(Object.values(UF));
const stripAccents = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
function toUF(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (UF_CODES.has(s.toUpperCase())) return s.toUpperCase();
  return UF[stripAccents(s).toLowerCase().replace(/\s+/g, ' ')] || null;
}

// ---------- Data/Hora flexível ----------
function parseTS(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { date: s, time: null };
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const time = m[4] ? `${m[4].padStart(2, '0')}:${m[5]}` : null;
    return { date, time };
  }
  return null;
}

function isMQL(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return ['sim', 'yes', 'true', '1', 'mql', 'qualificado', 'x', 'verdadeiro'].includes(s);
}

function decode(v) {
  let s = String(v || '');
  try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { /* mantém */ }
  return s;
}

// Etapa do funil a partir do nome da campanha (ou do utm_campaign do lead), pelas regras do config:
// o nome é achatado (maiúsculas, só letras e números) e cada `match` é testado nessa forma.
function stageOf(name) {
  if (!name) return null;
  const flat = stripAccents(decode(name)).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const hit = STAGES.find(e => e.re.test(flat));
  return hit ? hit.key : null;
}

// normaliza nomes de campanha/utm para matching (decodifica URL, tira acento, minúsculo, colapsa espaços)
function normKey(v) {
  if (!v) return '';
  return stripAccents(decode(v)).toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---- Meta: campanhas do projeto (as que batem com filtroCampanha) e a data inicial da coleta ----
async function fetchCampaigns() {
  const allCampaigns = (await graphGetAll(`${ACCOUNT}/campaigns`, {
    fields: 'id,name,status,objective,start_time,stop_time,daily_budget'
  })).map(c => ({
    id: c.id, name: c.name, status: c.status, objective: c.objective,
    start: c.start_time ? c.start_time.slice(0, 10) : null,
    stop: c.stop_time ? c.stop_time.slice(0, 10) : null,
    dailyBudget: c.daily_budget ? Number(c.daily_budget) / 100 : null
  }));
  // só campanhas do projeto: batem com filtroCampanha E começaram a partir de `desde` (descarta testes antigos com o mesmo nome)
  const campaigns = allCampaigns.filter(c => CAMP_FILTER.test(c.name) && (!c.start || c.start >= SINCE));
  if (!campaigns.length) throw new Error(`nenhuma campanha bate com o filtro "${CFG.filtroCampanha}" (início a partir de ${SINCE}) na conta ${ACCOUNT}`);
  // busca só desde a primeira campanha do projeto (mantém a coleta leve — roda a cada 15 min)
  const firstStart = campaigns.map(c => c.start).filter(Boolean).sort()[0] || SINCE;
  const since = firstStart < SINCE ? SINCE : firstStart;
  return { campaigns, since };
}

// ---- Meta: insights diários por anúncio, em janelas de 30 dias ----
// `extraActions` = tipos de ação (além de landing_page_view) que entram como colunas no fim de cada linha.
async function fetchInsights(campIds, since, until, extraActions = []) {
  const insights = [];
  let winStart = new Date(since + 'T00:00:00Z');
  const untilD = new Date(until + 'T00:00:00Z');
  while (winStart <= untilD) {
    // janelas de 30 dias: com o breakdown de `actions` por dia/anúncio, 90 dias estoura o limite do Graph
    const winEnd = new Date(Math.min(untilD.getTime(), winStart.getTime() + 29 * 86400000));
    const fmt = d => d.toISOString().slice(0, 10);
    const rows = await graphGetAll(`${ACCOUNT}/insights`, {
      level: 'ad', time_increment: '1',
      fields: 'campaign_id,adset_id,ad_id,spend,impressions,clicks,inline_link_clicks,actions',
      time_range: JSON.stringify({ since: fmt(winStart), until: fmt(winEnd) }),
      filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }])
    });
    for (const r of rows) {
      // aceita mais de um action_type por coluna (ex.: omni_initiated_checkout OU initiate_checkout) — usa o primeiro que existir
      const act = types => { for (const t of [].concat(types)) { const a = (r.actions || []).find(x => x.action_type === t); if (a) return Number(a.value || 0); } return 0; };
      insights.push([r.date_start, r.campaign_id, r.adset_id, r.ad_id,
        Number(r.spend || 0), Number(r.impressions || 0), Number(r.clicks || 0), Number(r.inline_link_clicks || 0),
        act('landing_page_view'), ...extraActions.map(act)]);
    }
    winStart = new Date(winEnd.getTime() + 86400000);
  }
  return insights;
}

async function mainLeads() {
  const until = todaySP();

  // ---- Meta: campanhas do projeto (as que batem com filtroCampanha) ----
  const fc = await fetchCampaigns();
  const campaigns = fc.campaigns.map(c => ({ ...c, stage: stageOf(c.name) }));
  const campIds = campaigns.map(c => c.id);
  const since = fc.since;

  // ---- Meta: insights diários por anúncio ----
  const insights = await fetchInsights(campIds, since, until);

  // ---- Meta: anúncios (nomes, público, permalink do Instagram) ----
  const adsRaw = await graphGetAll(`${ACCOUNT}/ads`, {
    fields: 'id,name,status,adset{id,name},campaign{id},creative{instagram_permalink_url}',
    filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }])
  });
  const ads = adsRaw.map(a => ({
    id: a.id, name: a.name, status: a.status,
    adsetId: a.adset ? a.adset.id : null, adsetName: a.adset ? a.adset.name : null,
    campaignId: a.campaign ? a.campaign.id : null,
    igUrl: a.creative && a.creative.instagram_permalink_url || null
  }));

  // ---- Planilha de leads ----
  const csvText = await (await fetch(SHEET_CSV, { redirect: 'follow' })).text();
  const rows = parseCSV(csvText);
  if (!rows.length) throw new Error('planilha vazia ou inacessível (ela precisa estar como "qualquer pessoa com o link pode ver")');
  const header = rows[0].map(h => h.trim());
  const idx = name => header.findIndex(h => normKey(h) === normKey(name));
  const col = {
    ts: idx('Data/Hora'), status: idx('Status'), mql: idx('MQL'), pagina: idx('Página'), estado: idx('Estado'),
    um: idx('utm_medium'), uc: idx('utm_campaign'), uct: idx('utm_content')
  };
  const g = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  // `v` guarda a linha crua na ordem das colunas da planilha (a seção "Respostas" mostra isso);
  // os campos derivados alimentam KPIs, mapa e filtros.
  const leads = rows.slice(1).map(r => {
    const ts = parseTS(g(r, col.ts));
    const uc = g(r, col.uc);
    return {
      v: header.map((_, i) => g(r, i)),
      date: ts ? ts.date : null, time: ts ? ts.time : null,
      status: g(r, col.status) || null, mql: isMQL(g(r, col.mql)),
      uf: toUF(g(r, col.estado)),
      stage: stageOf(uc) || stageOf(g(r, col.pagina)),
      utmCampaign: normKey(uc) || null,
      utmAdset: normKey(g(r, col.um)) || null,
      utmAd: normKey(g(r, col.uct)) || null
    };
  }).filter(l => l.date); // ignora linhas sem data

  // ---- Anúncios: só os que veicularam na janela (ou estão ativos) ----
  const deliveredAdIds = new Set(insights.map(r => r[3]));
  const activeCampSet = new Set(campaigns.filter(c => c.status === 'ACTIVE').map(c => c.id));
  const keptAds = ads.filter(a => deliveredAdIds.has(a.id) || (a.status === 'ACTIVE' && activeCampSet.has(a.campaignId)));

  // ---- Saída ----
  const write = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj));
  write('campaigns.json', { rows: campaigns });
  write('insights.json', { cols: ['date', 'campaignId', 'adsetId', 'adId', 'spend', 'impressions', 'clicks', 'linkClicks', 'pageViews'], rows: insights });
  write('ads.json', { rows: keptAds });
  write('leads.json', { header, rows: leads });
  write('summary.json', {
    updatedAt: new Date().toISOString(), account: ACCOUNT, since, until,
    counts: { campaigns: campaigns.length, insightRows: insights.length, ads: keptAds.length, leads: leads.length }
  });
  console.log(`[${slug}] OK`, JSON.stringify({ campaigns: campaigns.length, insightRows: insights.length, ads: keptAds.length, leads: leads.length }));
}

// ================= LANÇAMENTO: Meta em nível de anúncio + vendas da Hubla =================
//
// Vendas vêm da planilha que recebe o webhook da Hubla (hubla/webhook-planilha.gs):
// cada evento de fatura vira uma linha; a última linha de cada fatura diz o status atual.
// A venda é casada com o anúncio pelo utm_content (= {{ad.id}} na URL do anúncio; aceita o nome do anúncio).
const TEMP = {
  quente: new RegExp((CFG.temperatura && CFG.temperatura.quente) || 'quente|remarketing|rmkt|retarget|envolv|engaj|lista|lead|visitantes|seguidores|inscritos|warm|hot', 'i'),
  frio: new RegExp((CFG.temperatura && CFG.temperatura.frio) || 'frio|cold|interesse|lookalike|lal|aberto|amplo|advantage', 'i'),
};
// Temperatura pelo nome: aceita as palavras do config e as tags curtas [F]/[Q] (padrão de nomenclatura do cliente).
// Testa o conjunto de anúncios primeiro e, se ele não disser nada, o nome da campanha.
const tempOfName = name => {
  const n = name || '';
  if (/\[\s*Q\s*\]/i.test(n) || TEMP.quente.test(n)) return 'quente';
  if (/\[\s*F\s*\]/i.test(n) || TEMP.frio.test(n)) return 'frio';
  return null;
};
const tempOf = (adsetName, campaignName) => tempOfName(adsetName) || tempOfName(campaignName);

// data da venda no fuso de São Paulo (saleDate vem em ISO-8601 UTC)
function saleDateSP(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) { const ts = parseTS(iso); return ts ? ts.date : null; }
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
}

async function fetchHublaSales(ads) {
  if (!CFG.hubla || !CFG.hubla.planilha || !CFG.hubla.planilha.id) return null;
  const csvText = await (await fetch(sheetCsvUrl(CFG.hubla.planilha), { redirect: 'follow' })).text();
  const rows = parseCSV(csvText);
  if (!rows.length) throw new Error('planilha da Hubla vazia ou inacessível (ela precisa estar como "qualquer pessoa com o link pode ver")');
  const header = rows[0].map(h => normKey(h));
  const idx = name => header.indexOf(normKey(name));
  const col = {
    invoice: idx('invoice_id'), status: idx('status'), sale: idx('sale_date'), total: idx('total_cents'),
    product: idx('product_id'), products: idx('products_ids'), uc: idx('utm_campaign'), uct: idx('utm_content'),
    customer: idx('customer_id'), emailHash: idx('email_hash') // só existem a partir da v2 do webhook-planilha.gs
  };
  for (const k of ['invoice', 'status', 'sale']) if (col[k] < 0) throw new Error(`planilha da Hubla sem a coluna ${k} — use o hubla/webhook-planilha.gs deste repositório`);
  const g = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  const produtos = (CFG.hubla.produtos || []).map(String);     // produto principal (opcional)
  const bumpIds = (CFG.hubla.orderBump || []).map(String);     // produtos de order bump, ex.: gravação (opcional)

  // última linha de cada fatura = status atual (paid → venda; refunded/chargeback depois → sai)
  const byInvoice = new Map();
  for (const r of rows.slice(1)) { const id = g(r, col.invoice); if (id) byInvoice.set(id, r); }

  const adByName = new Map(ads.map(a => [normKey(a.name), a.id]));
  const adIds = new Set(ads.map(a => a.id));
  const sales = [];
  for (const [invoiceId, r] of byInvoice) {
    if (g(r, col.status).toLowerCase() !== 'paid') continue;
    // eventos de teste (sandbox da Hubla termina o id com "-tester"; nossos testes começam com "TESTE-") não são venda
    if (/-tester$/i.test(invoiceId) || /^TESTE-/i.test(invoiceId) || /sandbox/i.test(g(r, col.uc) + ' ' + g(r, col.uct))) continue;
    // produtos da fatura: products_ids traz todos (principal + order bumps); product_id é fallback das linhas antigas.
    // Atenção: a Hubla usa ids DIFERENTES para o mesmo produto nos dois campos, por isso não dá para somar os dois.
    const prods = (g(r, col.products) || g(r, col.product)).split('|').map(x => x.trim()).filter(Boolean);
    const prodIds = [...new Set(prods.concat(g(r, col.product) ? [g(r, col.product).trim()] : []))]; // para casar com o config, que pode trazer qualquer um dos ids
    // order bump = fatura com um produto da lista orderBump; sem a lista, qualquer fatura com 2+ produtos
    const bump = bumpIds.length ? prodIds.some(x => bumpIds.includes(x)) : prods.length > 1;
    // venda principal = fatura com o produto principal; sem a lista, tudo que não for só order bump
    const main = produtos.length ? prodIds.some(x => produtos.includes(x)) : !(bumpIds.length && prods.every(x => bumpIds.includes(x)));
    if (!main && !bump) continue;
    const date = saleDateSP(g(r, col.sale));
    if (!date) continue;
    // utm_content chega como "NOME-DO-ANUNCIO|<ad id>::<rastreio do Facebook>" (ou só o nome, ou só o id)
    const uct = decode(g(r, col.uct)).split('::')[0].trim();
    const partes = uct.split('|').map(x => x.trim()).filter(Boolean);
    const adId = partes.map(x => adIds.has(x) ? x : adByName.get(normKey(x))).find(Boolean) || null;
    sales.push({ date, invoiceId, adId, main, bump, customerId: g(r, col.customer) || null, emailHash: (g(r, col.emailHash) || '').toLowerCase() || null, valueCents: Math.round(Number(g(r, col.total)) || 0), utmCampaign: normKey(g(r, col.uc)) || null, utmContent: uct || null });
  }
  return sales;
}

async function mainLancamento() {
  const until = todaySP();
  const { campaigns, since } = await fetchCampaigns();
  const campIds = campaigns.map(c => c.id);

  // checkout iniciado (pixel) entra como coluna extra; o nome do action_type varia entre contas
  const insights = await fetchInsights(campIds, since, until, [['omni_initiated_checkout', 'initiate_checkout']]);

  // ---- Meta: anúncios com prévia e miniatura ----
  const adsRaw = await graphGetAll(`${ACCOUNT}/ads`, {
    fields: 'id,name,status,adset{id,name},campaign{id},preview_shareable_link,creative{thumbnail_url,instagram_permalink_url}',
    filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }])
  });
  const campName = new Map(campaigns.map(c => [c.id, c.name]));
  const ads = adsRaw.map(a => ({
    id: a.id, name: a.name, status: a.status,
    adsetId: a.adset ? a.adset.id : null, adsetName: a.adset ? a.adset.name : null,
    campaignId: a.campaign ? a.campaign.id : null,
    temp: tempOf(a.adset ? a.adset.name : '', a.campaign ? campName.get(a.campaign.id) : ''),
    previewUrl: a.preview_shareable_link || null,
    thumb: a.creative && a.creative.thumbnail_url || null,
    igUrl: a.creative && a.creative.instagram_permalink_url || null
  }));

  // ---- vendas: Hubla (planilha do webhook) ou Hotmart (API) ----
  const HOTMART = CFG.vendas === 'hotmart';
  const sales = HOTMART ? await fetchHotmartLaunchSales(ads, until) : await fetchHublaSales(ads);

  // ---- câmbio: conta fora do real (ex.: USD) tem o gasto convertido pela PTAX de venda do dia ----
  const CACHE = path.join(OUT, 'cache');
  fs.mkdirSync(CACHE, { recursive: true });
  const readCache = name => { try { return JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8')); } catch (e) { return null; } };
  const writeCache = (name, obj) => fs.writeFileSync(path.join(CACHE, name), JSON.stringify(obj));
  const warnings = [];
  const contaMoeda = await accountCurrency(ACCOUNT, TOKEN);
  if (contaMoeda !== 'BRL') {
    const rates = await ptax(contaMoeda, since, until, readCache, writeCache, warnings);
    for (const r of insights) r[4] = Math.round(r[4] * rateOn(rates, r[0]) * 100) / 100;
  }

  const deliveredAdIds = new Set(insights.map(r => r[3]));
  const soldAdIds = new Set((sales || []).map(s => s.adId).filter(Boolean));
  const activeCampSet = new Set(campaigns.filter(c => c.status === 'ACTIVE').map(c => c.id));
  const keptAds = ads.filter(a => deliveredAdIds.has(a.id) || soldAdIds.has(a.id) || (a.status === 'ACTIVE' && activeCampSet.has(a.campaignId)));

  // ---- Debriefing (exports .xlsx da Hubla em clientes/<cliente>/entrada/) ----
  // Os .xlsx têm dado pessoal e ficam fora do git; o resultado é só agregado e fica
  // versionado em clientes/<cliente>/debrief.json, para o Actions republicar sem os arquivos.
  const gastoPorAdId = {}; let gastoTotal = 0;
  for (const r of insights) { gastoPorAdId[r[3]] = (gastoPorAdId[r[3]] || 0) + r[4]; gastoTotal += r[4]; }
  // debriefing de um lançamento já encerrado fica congelado: o snapshot não é recalculado
  // com o gasto do lançamento seguinte (config: "debrief": { "congelado": true })
  const debriefCongelado = !!(CFG.debrief && CFG.debrief.congelado);
  let debrief = null;
  if (!HOTMART && !debriefCongelado) try {
    debrief = require('./lib/debrief').gerar({ dir: DIR, ads: keptAds, gastoPorAdId, gastoTotal, vendasWebhook: sales || [], campaigns });
  } catch (e) {
    console.error(`[${slug}] debriefing ignorado: ${e.message}`);
  }
  const snapshot = path.join(DIR, 'debrief.json');
  if (debrief) fs.writeFileSync(snapshot, JSON.stringify(debrief, null, 2) + '\n');
  else if (fs.existsSync(snapshot)) debrief = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  if (debrief && CFG.debrief && CFG.debrief.rotulo) debrief.rotulo = CFG.debrief.rotulo;

  const write = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj));
  write('debrief.json', debrief);
  write('campaigns.json', { rows: campaigns });
  write('insights.json', { cols: ['date', 'campaignId', 'adsetId', 'adId', 'spend', 'impressions', 'clicks', 'linkClicks', 'pageViews', 'checkouts'], rows: insights });
  write('ads.json', { rows: keptAds });
  write('sales.json', { rows: sales || [] });
  write('summary.json', {
    updatedAt: new Date().toISOString(), account: ACCOUNT, since, until, hubla: sales !== null,
    plataforma: HOTMART ? 'Hotmart' : 'Hubla', orderBump: !HOTMART, contaMoeda, warnings,
    metaVendas: CFG.metaVendas || null, semRastreio: CFG.vendasSemRastreio === 'trafego' ? 'trafego' : null,
    periodo: { inicio: SINCE, fim: CFG.ate || null }, // janela do lançamento = "Período completo" do painel
    counts: { campaigns: campaigns.length, insightRows: insights.length, ads: keptAds.length, sales: sales ? sales.filter(s => s.main).length : null, bumps: sales ? sales.filter(s => s.bump).length : null, debriefMba: debrief ? debrief.mba.vendas : null }
  });
  for (const w of warnings) console.error(`[${slug}] aviso: ${w}`);
  console.log(`[${slug}] OK`, JSON.stringify({ campaigns: campaigns.length, insightRows: insights.length, ads: keptAds.length, sales: sales ? sales.length : 'hubla não configurada', comAnuncio: sales ? sales.filter(s => s.adId).length : null, contaMoeda }));
}

// Vendas da Hotmart do lançamento (config: "vendas": "hotmart", "hotmart": { "produtos": [ids] }), desde o início
// do lançamento. Cada oferta é um ticket em teste: o ticket é o preço mais comum da oferta (cupom não cria ticket novo).
// Faturamento = preço pago; compra em outra moeda entra pelo ticket da oferta.
async function fetchHotmartLaunchSales(ads, until) {
  const cred = hotmart.credentials(slug);
  if (!cred) throw new Error('sem credenciais HOTMART_*_' + slug.toUpperCase().replace(/-/g, '_'));
  const rows = await hotmart.fetchLaunchSales(cred, SINCE, until, (CFG.hotmart && CFG.hotmart.produtos) || []);
  const freq = new Map();
  for (const [, , , , price, cur, offer] of rows) if (cur === 'BRL') {
    const m = freq.get(offer) || freq.set(offer, new Map()).get(offer);
    m.set(price, (m.get(price) || 0) + 1);
  }
  const ticketOf = new Map([...freq].map(([offer, m]) => [offer, [...m].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]]));
  const adIds = new Set(ads.map(a => a.id));
  return rows.map(([invoiceId, date, adId, , price, cur, offer, productId, origem]) => {
    const ticket = ticketOf.has(offer) ? ticketOf.get(offer) : (cur === 'BRL' ? price : null);
    return {
      date, invoiceId, adId: adId && adIds.has(adId) ? adId : null, main: true, bump: false, origem, offer, productId,
      valueCents: Math.round((cur === 'BRL' ? price : ticket || 0) * 100), ticketCents: ticket == null ? null : Math.round(ticket * 100)
    };
  });
}

// ================= CAPTAÇÃO: Meta em nível de anúncio + planilha de leads de um lançamento =================
//
// Cada lead da planilha vira orgânico, quente ou frio pelas UTMs: com cara de anúncio do Meta (nome de campanha/conjunto
// com [TAGS], placement do Meta no utm_source ou macro não substituída) é pago, e a temperatura sai das tags [QUENTE]/[Q] e
// [FRIO]/[F] do conjunto (utm_medium) e da campanha (utm_campaign); o resto é orgânico, com a origem em utm_source + utm_medium.
// O criativo do lead é o utm_content (= nome do anúncio). Nome, e-mail e telefone não saem daqui: o e-mail só serve para
// tirar cadastros repetidos (vale o primeiro).
const tempTag = name => {
  const n = decode(name || '');
  if (/\[\s*(Q|QUENTE)\s*\]/i.test(n)) return 'quente';
  if (/\[\s*(F|FRIO)\s*\]/i.test(n)) return 'frio';
  return null;
};
// tags explícitas primeiro: "[FRIO][ENVOL-30D]" é frio, mesmo com "envol" na lista de palavras de público quente
const tempCaptacao = (adsetName, campaignName) => tempTag(adsetName) || tempTag(campaignName) || tempOf(adsetName, campaignName);
const PAID_SOURCE = /^(fb|ig|meta|facebook|instagram|messenger|audience)[_ -]?(ads|stories|feed|reels|mobile|explore|network|instream|search|marketplace|video|profile)/i;
const looksPaid = (src, med, camp) => /\[[^\]]+\]/.test(camp + med) || /\{\{/.test(src + med + camp) || PAID_SOURCE.test(src);

// página de destino como caminho: "/mapa", "/mapa1" (sem domínio, barra final nem parâmetros)
const normPage = p => { const s = String(p || '').trim().toLowerCase().split(/[?#]/)[0].replace(/\/+$/, ''); return s ? (s.startsWith('/') ? s : '/' + s) : null; };
const urlPage = u => { try { return normPage(new URL(u).pathname) || (u ? '/' : null); } catch (e) { return null; } };
// destino do anúncio: link do botão (vídeo/imagem), do carrossel ou do asset feed (anúncio dinâmico)
function adPage(cr) {
  const s = cr.object_story_spec || {};
  const link = (s.video_data && s.video_data.call_to_action && s.video_data.call_to_action.value && s.video_data.call_to_action.value.link)
    || (s.link_data && (s.link_data.link || (s.link_data.call_to_action && s.link_data.call_to_action.value && s.link_data.call_to_action.value.link)))
    || (cr.asset_feed_spec && (cr.asset_feed_spec.link_urls || [])[0] && cr.asset_feed_spec.link_urls[0].website_url);
  return link ? urlPage(link) : null;
}

// Cotação diária `de` → `para` (quantas unidades de `de` valem 1 de `para`), da currency-api (fawazahmed0, dados abertos).
// Fica em out/cache/fx-<de>-<para>.json; os dois últimos dias são buscados de novo (a do dia ainda muda).
// Dia sem cotação usa a do último dia anterior que tiver.
async function fxRates(de, para, dates) {
  const file = path.join(OUT, 'cache', `fx-${de}-${para}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* primeira vez */ }
  const recent = new Date(Date.parse(todaySP()) - 86400000).toISOString().slice(0, 10);
  const f = para.toLowerCase(), t = de.toLowerCase();
  for (const d of dates.filter(d => !cache[d] || d >= recent).sort()) {
    for (const url of [`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${d}/v1/currencies/${f}.json`, `https://${d}.currency-api.pages.dev/v1/currencies/${f}.json`]) {
      try {
        const j = await (await fetch(url)).json();
        if (j && j[f] && j[f][t]) { cache[d] = j[f][t]; break; }
      } catch (e) { /* tenta o espelho */ }
    }
  }
  fs.writeFileSync(file, JSON.stringify(cache));
  const known = Object.keys(cache).sort();
  if (!known.length) throw new Error(`sem cotação ${de}→${para} para converter o gasto`);
  return d => { let k = known[0]; for (const x of known) if (x <= d) k = x; return cache[k]; };
}

// país-alvo da campanha: a última tag do nome ("…[PAG-A][UY]" → "UY")
const campTag = name => { const t = (decode(name || '').match(/\[([^\]]+)\]/g) || []).pop(); return t ? t.slice(1, -1).trim().toUpperCase() : null; };

// ---- Pesquisa de qualificação: cada resposta é ligada ao lead pelo e-mail (o primeiro cadastro dele) e herda temperatura,
//      criativo, conjunto e país da campanha. Só as perguntas fechadas do config saem daqui (nada de texto livre nem e-mail).
//      Nota = soma dos pontos das respostas (config "pontos", casando pelo começo da opção); faixa alta/média/baixa pela nota.
async function fetchPesquisa(leads, leadByEmail) {
  const P = CFG.pesquisa;
  const rows = parseCSV(await (await fetch(sheetCsvUrl(P.planilha), { redirect: 'follow' })).text());
  if (!rows.length || /<html/i.test(rows[0].join(''))) throw new Error('planilha da pesquisa vazia ou inacessível (ela precisa estar como "qualquer pessoa com o link pode ver")');
  const header = rows[0].map(h => h.trim());
  const idx = (...names) => header.findIndex(h => names.some(n => normKey(h) === normKey(n)));
  const cTs = idx('Date', 'Data', 'Data/Hora'), cEmail = idx('email', 'e-mail');
  if (cTs < 0 || cEmail < 0) throw new Error('planilha da pesquisa sem as colunas Date e email');
  const multi = new Set((P.multipla || []).map(normKey));
  const qs = P.perguntas.map(q => ({ q, i: idx(q), multi: multi.has(normKey(q)), options: [] })).filter(x => x.i >= 0);
  const g = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  // "Otro: <texto livre>" vira só "Otro" (o texto pode identificar a pessoa)
  const opt = v => /^otro\b/i.test(v) ? 'Otro' : v;
  const code = (q, v) => { let k = q.options.indexOf(v); if (k < 0) { k = q.options.length; q.options.push(v); } return k; };
  const pontos = Object.entries(P.pontos || {}).map(([q, m]) => ({ q: normKey(q), i: idx(q), m: Object.entries(m).map(([o, p]) => [normKey(o), p]) }));
  // faixas: "alta" é uma nota mínima ou { "minimos": { pergunta: pontos } } — aí é alta quem cumpre TODOS os mínimos
  // (a soma sozinha deixaria passar, por exemplo, quem fatura pouco mas tem negócio antigo); "media" e "baixa" são notas
  // mínimas. Com "baixa" no config, abaixo dela é "nula" — e também é nula quem bate TODAS as respostas de
  // nula.combinacao (pergunta → começo da opção), mesmo com nota maior.
  const faixas = P.faixas || { alta: 6, media: 3 };
  const minimos = faixas.alta && typeof faixas.alta === 'object' ? Object.entries(faixas.alta.minimos || {}).map(([q, p]) => [normKey(q), p]) : null;
  const combNula = faixas.nula && faixas.nula.combinacao ? Object.entries(faixas.nula.combinacao).map(([q, o]) => [idx(q), normKey(o)]) : null;
  const byEmail = new Map();   // a última resposta de cada e-mail vale
  for (const r of rows.slice(1)) {
    const ts = parseTS(g(r, cTs)); const email = g(r, cEmail).toLowerCase();
    if (!ts || ts.date < SINCE) continue;
    byEmail.set(email || Symbol(), { r, ts, email });
  }
  const out = [];   // [data, temperatura, criativo, conjunto, país da campanha, origem orgânica, nota, faixa, respostas…]
  for (const { r, ts, email } of [...byEmail.values()].sort((a, b) => a.ts.date.localeCompare(b.ts.date))) {
    const li = typeof email === 'string' ? leadByEmail.get(email) : undefined;
    const l = li != null ? leads[li] : null;
    const pts = new Map(pontos.map(p => { const v = normKey(g(r, p.i)); const h = p.m.find(([o]) => v.startsWith(o)); return [p.q, h ? h[1] : 0]; }));
    const nota = [...pts.values()].reduce((s, x) => s + x, 0);
    const alta = minimos ? minimos.every(([q, min]) => (pts.get(q) || 0) >= min) : nota >= faixas.alta;
    const nula = faixas.baixa != null && (nota < faixas.baixa || (combNula && combNula.every(([i, o]) => normKey(g(r, i)).startsWith(o))));
    const faixa = nula ? 'nula' : alta ? 'alta' : nota >= faixas.media ? 'media' : 'baixa';
    const ans = qs.map(q => {
      const v = g(r, q.i);
      if (!v) return null;
      return q.multi ? [...new Set(v.split(';').map(s => opt(s.trim())).filter(Boolean))].map(s => code(q, s)) : code(q, opt(v));
    });
    out.push([ts.date, l ? l[2] : 'sem_lead', l ? l[5] : null, l ? l[7] : null, l ? l[8] : null, l ? l[4] : null, nota, faixa, ...ans]);
  }
  // pontuação para o painel explicar a nota
  const regras = Object.entries(P.pontos || {}).map(([q, m]) => ({ q, opcoes: Object.entries(m) }));
  return { cols: ['date', 'temp', 'criativo', 'conjunto', 'paisCampanha', 'origem', 'nota', 'faixa'], perguntas: qs.map(q => ({ q: q.q, multi: q.multi, options: q.options })), rows: out, regras, faixas, acoes: P.acoes || null, notas: P.notas || null, max: regras.reduce((s, x) => s + Math.max(...x.opcoes.map(o => o[1])), 0), semLead: out.filter(x => x[1] === 'sem_lead').length };
}

async function mainCaptacao() {
  const until = todaySP();
  const { campaigns, since: metaSince } = await fetchCampaigns();
  const campIds = campaigns.map(c => c.id);
  const campName = new Map(campaigns.map(c => [c.id, c.name]));

  // [data, campanha, conjunto, anúncio, gasto, impressões, cliques, cliques no link, views da página, leads do Meta, views de 3s]
  const insights = await fetchInsights(campIds, metaSince, until, [['lead', 'offsite_conversion.fb_pixel_lead', 'onsite_web_lead'], ['video_view']]);

  // ---- câmbio: "moeda" no config (ex.: "USD") converte o gasto pela cotação do dia; sem ela, fica na moeda da conta ----
  const contaMoeda = await accountCurrency(ACCOUNT, TOKEN);
  const moeda = (CFG.moeda || contaMoeda).toUpperCase();
  if (moeda !== contaMoeda) {
    const rate = await fxRates(contaMoeda, moeda, [...new Set(insights.map(r => r[0]))]);
    for (const r of insights) r[4] = +(r[4] / rate(r[0])).toFixed(2);
  }

  // ---- Meta: anúncios com miniatura e post do Instagram; a miniatura é baixada uma vez (a URL do Meta expira) ----
  const adsRaw = await graphGetAll(`${ACCOUNT}/ads`, {
    fields: 'id,name,effective_status,adset{id,name},campaign{id},preview_shareable_link,creative.thumbnail_width(480).thumbnail_height(480){thumbnail_url,instagram_permalink_url,object_type,object_story_spec,asset_feed_spec}',
    filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]),
    limit: '100' // com a miniatura, páginas de 500 estouram o limite do Graph
  });
  const THUMBS = path.join(OUT, 'cache', 'thumbs');
  fs.mkdirSync(THUMBS, { recursive: true });
  const ads = [];
  for (const a of adsRaw) {
    const cr = a.creative || {};
    const file = path.join(THUMBS, a.id + '.jpg');
    if (!fs.existsSync(file) && cr.thumbnail_url) {
      try {
        const res = await fetch(cr.thumbnail_url);
        if (res.ok) fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      } catch (e) { console.warn(`[${slug}] miniatura de ${a.name} não baixou: ${e.message}`); }
    }
    const campaignId = a.campaign ? a.campaign.id : null, adsetName = a.adset ? a.adset.name : '';
    ads.push({
      id: a.id, name: a.name, active: a.effective_status === 'ACTIVE', campaignId, adsetName,
      temp: tempCaptacao(adsetName, campName.get(campaignId) || ''), type: cr.object_type || null,
      igUrl: cr.instagram_permalink_url || null, previewUrl: a.preview_shareable_link || null,
      thumb: fs.existsSync(file) ? `thumbs/${a.id}.jpg` : null, page: adPage(cr)
    });
  }
  // temperatura de um criativo pelo nome (o mesmo nome roda em conjuntos quentes e frios: só vale se for um só)
  const tempsByName = new Map();
  for (const a of ads) if (a.temp) (tempsByName.get(normKey(a.name)) || tempsByName.set(normKey(a.name), new Set()).get(normKey(a.name))).add(a.temp);

  // ---- Planilha de leads ----
  const csvText = await (await fetch(SHEET_CSV, { redirect: 'follow' })).text();
  const rows = parseCSV(csvText);
  if (!rows.length || /<html/i.test(rows[0].join(''))) throw new Error('planilha vazia ou inacessível (ela precisa estar como "qualquer pessoa com o link pode ver")');
  const header = rows[0].map(h => h.trim());
  const idx = (...names) => header.findIndex(h => names.some(n => normKey(h) === normKey(n)));
  const col = {
    ts: idx('Date', 'Data', 'Data/Hora'), email: idx('Email', 'E-mail'), pais: idx('pais', 'país', 'country'),
    src: idx('utm_source'), med: idx('utm_medium'), camp: idx('utm_campaign'), cont: idx('utm_content'),
    pagina: idx('pagina', 'página', 'page'), url: idx('page_url', 'url')
  };
  if (col.ts < 0) throw new Error('planilha sem a coluna de data (Date)');
  const g = (r, i) => (i >= 0 && r[i] != null ? decode(String(r[i])).trim() : '');
  const seen = new Set();
  let cadastros = 0;
  const leads = [];   // [data, hora, temperatura, país, origem orgânica, criativo, página, conjunto, país da campanha]
  const leadByEmail = new Map();   // só para cruzar com a pesquisa; o e-mail não sai do refresh
  const parsed = rows.slice(1).map(r => ({ r, ts: parseTS(g(r, col.ts)) })).filter(x => x.ts && x.ts.date >= SINCE)
    .sort((a, b) => (a.ts.date + (a.ts.time || '')).localeCompare(b.ts.date + (b.ts.time || '')));
  for (const { r, ts } of parsed) {
    cadastros++;
    const email = g(r, col.email).toLowerCase();
    if (email) { if (seen.has(email)) continue; seen.add(email); leadByEmail.set(email, leads.length); }
    const src = g(r, col.src), med = g(r, col.med), camp = g(r, col.camp);
    const adName = g(r, col.cont).split('|')[0].trim();
    let temp = 'organico', origem = null, criativo = null;
    if (looksPaid(src, med, camp)) {
      const byName = tempsByName.get(normKey(adName));
      temp = tempCaptacao(med, camp) || (byName && byName.size === 1 ? [...byName][0] : 'pago');
      criativo = adName && !/\{\{/.test(adName) ? adName : null;
    } else {
      origem = [src || 'sem utm_source', med && normKey(med) !== normKey(src) ? med : ''].filter(Boolean).join(' · ');
      if (!src && !med) origem = 'Sem UTM';
    }
    const paid = temp !== 'organico';
    leads.push([ts.date, ts.time, temp, g(r, col.pais) || null, origem, criativo, normPage(g(r, col.pagina)) || urlPage(String(col.url >= 0 && r[col.url] || '')),
      paid && med && !/\{\{/.test(med) ? med : null, paid ? campTag(camp) : null]);
  }

  // o painel começa no primeiro lead ou no primeiro dia de anúncio, o que vier antes (orgânico costuma vir antes do pago)
  const since = leads.length && leads[0][0] < metaSince ? leads[0][0] : metaSince;
  const write = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj));
  write('campaigns.json', { rows: campaigns });
  write('insights.json', { cols: ['date', 'campaignId', 'adsetId', 'adId', 'spend', 'impressions', 'clicks', 'linkClicks', 'pageViews', 'metaLeads', 'views3s'], rows: insights });
  write('ads.json', { rows: ads });
  write('leads.json', { cols: ['date', 'time', 'temp', 'pais', 'origem', 'criativo', 'pagina', 'conjunto', 'paisCampanha'], rows: leads });
  const pesquisa = CFG.pesquisa ? await fetchPesquisa(leads, leadByEmail) : null;
  write('pesquisa.json', pesquisa);
  write('summary.json', {
    updatedAt: new Date().toISOString(), account: ACCOUNT, currency: moeda, contaMoeda,
    since, until, cadastros, lancamento: CFG.lancamento || null, metas: CFG.metas || null
  });
  const n = t => leads.filter(l => l[2] === t).length;
  console.log(`[${slug}] OK`, JSON.stringify({ campaigns: campaigns.length, insightRows: insights.length, ads: ads.length, comMiniatura: ads.filter(a => a.thumb).length, cadastros, leads: leads.length, organico: n('organico'), quente: n('quente'), frio: n('frio'), pagoSemTemperatura: n('pago') }));
}

// ---- Criativos: Meta por anúncio e por dia + vendas da Hotmart (API, ver hotmart.js; plano B: clientes/<cliente>/vendas/
//      hotmart.json do importar-hotmart.js) ou da Payt (postback → Worker, ver payt.js). Venda e anúncio se ligam pelo ID
//      do anúncio que vem no SCK (Hotmart) ou no utm_content (Payt) — nunca pelas conversões do Meta. Gasto, impressões e
//      cliques vêm do Meta, somando todas as contas de `contas` (ou só `conta`). O card agrupa por nome do anúncio.
//      Conta em outra moeda (ex.: USD) tem o gasto convertido para reais pela PTAX de venda do dia (Banco Central). ----
async function mainCriativos() {
  const PLATAFORMA = CFG.vendas === 'payt' ? 'Payt' : 'Hotmart';
  const VENDAS = path.join(DIR, 'vendas', PLATAFORMA.toLowerCase() + '.json');
  const manual = fs.existsSync(VENDAS) ? JSON.parse(fs.readFileSync(VENDAS, 'utf8')) : null;
  const since = CFG.desde || (manual && manual.vendas[0] && manual.vendas[0][1]);
  if (!since) throw new Error(`defina "desde" (AAAA-MM-DD) em clientes/${slug}/config.json`);
  const until = todaySP();
  const ACCOUNTS = [].concat(CFG.contas || CFG.conta);

  // ---- cache entre execuções (out/cache, guardado pelo actions/cache do workflow): métricas do Meta, miniaturas e
  //      vendas só com código/data/anúncio/valor/produto — nada do comprador. Buscar o histórico inteiro a cada 15 min
  //      estoura o limite de chamadas da conta de anúncios. ----
  const CACHE = path.join(OUT, 'cache');
  const THUMBS = path.join(CACHE, 'thumbs');
  fs.mkdirSync(THUMBS, { recursive: true });
  const readCache = name => { try { return JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8')); } catch (e) { return null; } };
  const writeCache = (name, obj) => fs.writeFileSync(path.join(CACHE, name), JSON.stringify(obj));
  const minus = (iso, n) => new Date(Date.parse(iso) - n * 86400000).toISOString().slice(0, 10);
  const daysAgo = n => minus(until, n);
  // janela incremental: os últimos `days` dias até hoje, recuando até `days` dias antes da última coleta que deu
  // certo — se o workflow ficar parado (em 06/10/2026 ficou 4 dias), a próxima execução cobre o buraco
  const windowFrom = (days, lastUntil) => {
    let d = daysAgo(days - 1);
    if (lastUntil && minus(lastUntil, days - 1) < d) d = minus(lastUntil, days - 1);
    return d > since ? d : since;
  };
  const RECENT_DAYS = 7;          // o Meta ainda ajusta os últimos dias: são sempre buscados de novo
  const ADS_MAX_AGE_H = 6;        // lista de anúncios (nomes, posts, miniaturas) muda pouco
  const SALES_RECENT_DAYS = 35;
  const META_CACHE_V = 2;         // v2: + views de 3s e ThruPlays por linha — cache de outra versão é coletado de novo desde `since`   // vendas: a garantia da Hotmart vai até 30 dias — reembolso nessa janela some do painel
  const warnings = [];

  // ---- vendas ----
  let allSales, salesUntil, salesSource, salesFrom = since, salesSince = null;
  if (PLATAFORMA === 'Payt') {
    // o Worker guarda o estado atual de cada transação: busca tudo desde `since` a cada execução (são poucas linhas)
    const cached = readCache('payt-sales.json');
    try {
      const r = await payt.fetchSales(CFG, slug, since);
      if (r.semComissao) warnings.push(`${r.semComissao} venda(s) da Payt sem comissão de produtor no postback — contado o valor total`);
      allSales = r.rows; salesSince = r.firstDay;
      writeCache('payt-sales.json', { since, until, firstDay: r.firstDay, rows: allSales });
      salesUntil = until; salesSource = 'api';
    } catch (e) {
      if (cached && cached.since === since) {
        warnings.push(`vendas da Payt não atualizaram (${e.message}) — usadas as de antes`);
        allSales = cached.rows; salesSince = cached.firstDay; salesUntil = cached.until; salesSource = 'api';
      } else if (manual) {
        warnings.push(`vendas da Payt não atualizaram (${e.message}) — só o histórico importado`);
        allSales = []; salesUntil = manual.ate; salesSource = 'arquivo';
      } else {
        // sem receptor/chave ainda: o painel sai só com o Meta (e um aviso) em vez de derrubar o workflow de todos os clientes
        warnings.push(`vendas da Payt indisponíveis (${e.message}) — painel sem vendas nesta rodada`);
        allSales = []; salesUntil = null; salesSource = 'pendente';
      }
    }
    // histórico importado de um export da Payt (antes do postback existir): o postback manda quando o código se repete
    if (manual) {
      const live = new Set(allSales.map(v => v[0]));
      allSales = manual.vendas.filter(v => !live.has(v[0])).concat(allSales);
      salesSince = manual.desde || salesSince;
    }
  } else {
    const cred = hotmart.credentials(slug);
    const cachedSales = readCache('hotmart-sales.json');
    const salesInc = cachedSales && cachedSales.since === since;
    salesFrom = salesInc ? windowFrom(SALES_RECENT_DAYS, cachedSales.until) : since;
    try {
      if (!cred) throw new Error('sem credenciais HOTMART_*_' + slug.toUpperCase().replace(/-/g, '_'));
      const fresh = await hotmart.fetchSales(cred, salesFrom, until);
      allSales = (salesInc && salesFrom > since ? cachedSales.rows.filter(v => v[1] < salesFrom) : []).concat(fresh);
      writeCache('hotmart-sales.json', { since, until, rows: allSales });
      salesUntil = until; salesSource = 'api';
    } catch (e) {
      if (salesInc) { allSales = cachedSales.rows; salesUntil = cachedSales.until; salesSource = 'api'; }
      else if (manual) { allSales = manual.vendas; salesUntil = manual.ate; salesSource = 'arquivo'; }
      else throw e;
      if (cred) warnings.push(`vendas da Hotmart não atualizaram (${e.message}) — usadas as de ${salesSource === 'api' ? 'antes' : 'clientes/' + slug + '/vendas/hotmart.json'}`);
    }
  }
  // [codigo, data, adId, adName, valorLiquido, produto, origem, contaVenda?] — contaVenda 0 = upsell (só soma faturamento)
  const sales = allSales.filter(v => v[6] === 'meta' && v[1] >= since);

  // ---- Meta, por conta: gasto/impressões/cliques no link/finalizações de compra iniciadas/views de 3s/ThruPlays por anúncio e por dia ----
  const fetchDaily = async (act, token, from, to) => {
    const out = [];
    for (let start = from; start <= to;) {
      const end = new Date(Math.min(Date.parse(to), Date.parse(start) + 29 * 86400000)).toISOString().slice(0, 10);
      const rows = await graphGetAll(`${act}/insights`, {
        level: 'ad', time_increment: '1', fields: 'ad_id,spend,impressions,inline_link_clicks,actions,video_thruplay_watched_actions',
        limit: '100', // com `actions` por dia, páginas de 500 voltam quebradas do Graph
        time_range: JSON.stringify({ since: start, until: end })
      }, token);
      for (const r of rows) {
        // o nome do action_type de checkout varia entre contas — usa o primeiro que existir (como no painel de lançamento)
        const act = types => { for (const t of types) { const a = (r.actions || []).find(x => x.action_type === t); if (a) return Number(a.value || 0); } return 0; };
        // video_view = visualização de 3s (hook rate); ThruPlay = 15s ou o vídeo inteiro, se for mais curto (hold rate)
        const thru = (r.video_thruplay_watched_actions || []).reduce((s, a) => s + Number(a.value || 0), 0);
        out.push([r.date_start, r.ad_id, Number(r.spend || 0), Number(r.impressions || 0), Number(r.inline_link_clicks || 0), act(['omni_initiated_checkout', 'initiate_checkout']), act(['video_view']), thru]);
      }
      start = new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10);
    }
    return out;
  };
  // com uma conta só, os nomes de cache de antes (painéis já no ar continuam incrementais)
  const cacheName = (base, act) => ACCOUNTS.length === 1 ? `${base}.json` : `${base}-${act.replace(/^act_/, '')}.json`;
  const daily = [];        // [data, adId, gasto na moeda da conta, impressões, cliques, checkouts, views 3s, ThruPlays, moeda]
  const statusById = new Map();
  let adsRaw = [];
  let metaStale = false, metaOk = 0;
  const currencies = new Set();
  for (const act of ACCOUNTS) {
    const token = tokenFor(act);
    const cachedDaily = readCache(cacheName('meta-daily', act));
    const incremental = cachedDaily && cachedDaily.since === since && cachedDaily.v === META_CACHE_V && cachedDaily.rows.length;
    // caches antigos não têm `until`: sem ele, conta como coleta de hoje
    const from = incremental ? windowFrom(RECENT_DAYS, cachedDaily.until) : since;
    let rows, currency = cachedDaily && cachedDaily.currency;
    try {
      if (!currency) currency = await accountCurrency(act, token);
      const fresh = await fetchDaily(act, token, from, until);
      rows = (incremental ? cachedDaily.rows.filter(r => r[0] < from) : []).concat(fresh);
      writeCache(cacheName('meta-daily', act), { v: META_CACHE_V, since, until, currency, rows });
      metaOk++;
    } catch (e) {
      // sem Meta nesta rodada: o painel continua com os dados da anterior em vez de derrubar o workflow de todos os clientes
      if (incremental) { warnings.push(`métricas do Meta (${act}) não atualizaram (${e.message}) — mantidos os dados anteriores`); rows = cachedDaily.rows; }
      else if (ACCOUNTS.length > 1) { warnings.push(`métricas do Meta (${act}) indisponíveis (${e.message}) — conta fora do painel nesta rodada`); rows = []; }
      else throw e;
      metaStale = true;
    }
    currency = currency || 'BRL';
    currencies.add(currency);
    for (const r of rows) daily.push([r[0], r[1], r[2], r[3], r[4], r[5], r[6] || 0, r[7] || 0, currency]);

    // ---- nome, miniatura e post do Instagram de cada anúncio (renovado a cada ADS_MAX_AGE_H horas) ----
    let cachedAds = readCache(cacheName('meta-ads', act));
    if (!cachedAds || Date.now() - Date.parse(cachedAds.fetchedAt) > ADS_MAX_AGE_H * 3600000) {
      try {
        const raw = await graphGetAll(`${act}/ads`, {
          fields: 'id,name,preview_shareable_link,creative.thumbnail_width(480).thumbnail_height(480){thumbnail_url,instagram_permalink_url,object_type}',
          limit: '100' // com a miniatura, páginas de 500 estouram o limite do Graph
        }, token);
        cachedAds = { fetchedAt: new Date().toISOString(), rows: raw };
        writeCache(cacheName('meta-ads', act), cachedAds);
      } catch (e) {
        if (!cachedAds && ACCOUNTS.length === 1) throw e;
        warnings.push(`lista de anúncios (${act}) não atualizou (${e.message})${cachedAds ? ' — mantida a anterior' : ''}`);
      }
    }
    if (cachedAds) adsRaw = adsRaw.concat(cachedAds.rows);

    // ---- status de veiculação (ativo/pausado) de cada anúncio: leve, buscado a cada execução ----
    let cachedStatus = readCache(cacheName('meta-status', act));
    try {
      const st = await graphGetAll(`${act}/ads`, { fields: 'id,effective_status' }, token);
      cachedStatus = { fetchedAt: new Date().toISOString(), rows: st.map(a => [a.id, a.effective_status]) };
      writeCache(cacheName('meta-status', act), cachedStatus);
    } catch (e) {
      warnings.push(`status dos anúncios (${act}) não atualizou (${e.message})${cachedStatus ? ' — mantido o anterior' : ''}`);
    }
    for (const [id, st] of (cachedStatus && cachedStatus.rows) || []) statusById.set(id, st);
  }
  if (!metaOk && !daily.length) throw new Error('nenhuma conta do Meta respondeu');

  // ---- câmbio: PTAX de venda do dia (Banco Central) para contas fora do real; fim de semana/feriado usa o último dia útil ----
  const rates = {};
  for (const cur of [...currencies].filter(c => c !== 'BRL')) rates[cur] = await ptax(cur, since, until, readCache, writeCache, warnings);
  const toBRL = (v, cur, d) => cur === 'BRL' ? v : v * rateOn(rates[cur], d);

  const adById = new Map(adsRaw.map(a => [a.id, a]));
  // o nome atual no Meta manda; o do SCK/UTM só vale se o anúncio sumiu da conta (o SCK chega a vir cortado: "AD_copy_14AE29F3-7...")
  const nameOf = (adId, fallback) => adById.has(adId) ? adById.get(adId).name : (fallback || `Anúncio ${adId}`);

  // ---- upsell acompanhado no painel (config "upsell": { "nome": ..., "produtos": [nomes ou códigos] }): venda de upsell
  //      desses produtos ÷ vendas do criativo = taxa de conversão para o upsell ----
  const UPSELL = CFG.upsell && (CFG.upsell.produtos || []).length ? CFG.upsell : null;
  const normP = v => stripAccents(String(v || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const isUpsell = (conta, produto) => conta === 0 && !!UPSELL && UPSELL.produtos.some(p => normP(produto).startsWith(normP(p)));

  // ---- linhas diárias por criativo: [data, nome, gasto, impressões, cliques, vendas, faturamento líquido, checkouts,
  //      views de 3s, ThruPlays, upsells] ----
  const key = (d, n) => d + '\u0000' + n;
  const agg = new Map();
  const row = (d, n) => agg.get(key(d, n)) || agg.set(key(d, n), [d, n, 0, 0, 0, 0, 0, 0, 0, 0, 0]).get(key(d, n));
  const spendByAd = new Map();
  for (const [d, adId, spendRaw, imp, clk, chk, v3s, thru, cur] of daily) {
    const spend = toBRL(spendRaw, cur, d);
    const r = row(d, nameOf(adId));
    r[2] += spend; r[3] += imp; r[4] += clk; r[7] += chk; r[8] += v3s; r[9] += thru;
    spendByAd.set(adId, (spendByAd.get(adId) || 0) + spend);
  }
  for (const [, d, adId, adName, net, produto, , conta] of sales) {
    const r = row(d, nameOf(adId, adName));
    r[5] += conta === 0 ? 0 : 1; r[6] += net; r[10] += isUpsell(conta, produto) ? 1 : 0;
  }
  const rows = [...agg.values()].map(r => [r[0], r[1], +r[2].toFixed(2), r[3], r[4], r[5], +r[6].toFixed(2), r[7], r[8], r[9], r[10]])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const names = new Set(rows.map(r => r[1]));

  // ---- prévia: entre os anúncios de mesmo nome, o que tem post no Instagram e, depois, o que mais gastou ----
  const rank = a => [a.creative && a.creative.instagram_permalink_url ? 1 : 0, spendByAd.get(a.id) || 0];
  const best = new Map();
  for (const a of adsRaw) {
    if (!names.has(a.name)) continue;
    const cur = best.get(a.name);
    const [ig, s] = rank(a);
    if (!cur || ig > rank(cur)[0] || (ig === rank(cur)[0] && s > rank(cur)[1])) best.set(a.name, a);
  }

  // ativo = algum anúncio com esse nome está veiculando (effective_status ACTIVE já considera campanha e conjunto)
  const activeNames = new Set(adsRaw.filter(a => statusById.get(a.id) === 'ACTIVE').map(a => a.name));

  // miniaturas do Meta expiram em dias: baixa uma vez para out/cache/thumbs (a imagem de um anúncio não muda)
  // e o build publica junto da página
  const ads = [];
  for (const [name, a] of best) {
    const cr = a.creative || {};
    const file = path.join(THUMBS, a.id + '.jpg');
    if (!fs.existsSync(file) && cr.thumbnail_url) {
      try {
        const res = await fetch(cr.thumbnail_url);
        if (res.ok) fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      } catch (e) { console.warn(`[${slug}] miniatura de ${name} não baixou: ${e.message}`); }
    }
    const thumb = fs.existsSync(file) ? `thumbs/${a.id}.jpg` : null;
    ads.push({ name, adId: a.id, type: cr.object_type || null, igUrl: cr.instagram_permalink_url || null, previewUrl: a.preview_shareable_link || null, thumb, active: activeNames.has(name) });
  }

  const write = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj));
  write('daily.json', { cols: ['date', 'name', 'spend', 'impressions', 'clicks', 'sales', 'revenue', 'checkouts', 'views3s', 'thruplays', 'upsells'], rows });
  write('ads.json', { rows: ads });
  // updatedAt = quando o Meta respondeu de fato (numa rodada sem Meta, fica o horário do cache)
  const metaAt = metaStale && !metaOk ? (readCache('summary.json') || {}).updatedAt : new Date().toISOString();
  const summary = {
    updatedAt: metaAt || new Date().toISOString(), account: ACCOUNTS.join(','), since, until,
    plataforma: PLATAFORMA, vendasAte: salesUntil, vendasFonte: salesSource, vendasDesde: salesSince,
    cambio: [...currencies].filter(c => c !== 'BRL'), upsell: UPSELL ? UPSELL.nome || 'upsell' : null
  };
  write('summary.json', summary);
  if (metaOk) writeCache('summary.json', summary);
  for (const w of warnings) console.log(`::warning::[${slug}] ${w}`);
  const orphan = sales.filter(v => !adById.has(v[2])).length;
  console.log(`[${slug}] OK`, JSON.stringify({ contas: ACCOUNTS.length, contasOk: metaOk, dias: new Set(rows.map(r => r[0])).size, criativos: names.size, comPrevia: ads.filter(a => a.thumb).length, vendasMeta: sales.length, vendasDeAnuncioForaDaConta: orphan, vendasAte: salesUntil, vendasFonte: salesSource, vendasDesde: salesFrom, cambio: summary.cambio }));
}

async function accountCurrency(act, token) {
  const res = await fetch(`${GRAPH}/${act}?fields=currency&access_token=${token}`);
  const j = await res.json();
  if (j.error) throw new Error(`Graph API ${act}: ${j.error.message}`);
  return j.currency;
}

// PTAX de venda por dia útil, do Banco Central (olinda.bcb.gov.br), guardada no cache: { 'AAAA-MM-DD': cotação }.
// Os últimos 10 dias são sempre buscados de novo (a PTAX do dia sai por volta das 13h).
async function ptax(cur, since, until, readCache, writeCache, warnings) {
  const name = `ptax-${cur}.json`;
  const cached = readCache(name) || { rates: {} };
  const from = Object.keys(cached.rates).length && Object.keys(cached.rates).sort()[0] <= since
    ? new Date(Date.parse(until) - 10 * 86400000).toISOString().slice(0, 10)
    : new Date(Date.parse(since) - 10 * 86400000).toISOString().slice(0, 10); // folga para o 1º dia cair num fim de semana
  const mdy = iso => { const [y, m, d] = iso.split('-'); return `${m}-${d}-${y}`; };
  const url = cur === 'USD'
    ? `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@dataInicial='${mdy(from)}'&@dataFinalCotacao='${mdy(until)}'&$format=json&$select=cotacaoVenda,dataHoraCotacao`
    : `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@moeda='${cur}'&@dataInicial='${mdy(from)}'&@dataFinalCotacao='${mdy(until)}'&$format=json&$filter=tipoBoletim%20eq%20'Fechamento'&$select=cotacaoVenda,dataHoraCotacao`;
  try {
    const j = await (await fetch(url)).json();
    if (!Array.isArray(j.value)) throw new Error('resposta inesperada');
    for (const v of j.value) cached.rates[v.dataHoraCotacao.slice(0, 10)] = v.cotacaoVenda;
    writeCache(name, cached);
  } catch (e) {
    if (!Object.keys(cached.rates).length) throw new Error(`PTAX ${cur} indisponível (${e.message}) e sem cotações guardadas`);
    warnings.push(`PTAX ${cur} não atualizou (${e.message}) — usadas as cotações guardadas`);
  }
  return Object.entries(cached.rates).sort((a, b) => a[0] < b[0] ? -1 : 1);
}

// cotação do dia ou, sem ela (fim de semana, feriado, hoje antes das 13h), a do último dia útil anterior
function rateOn(sorted, d) {
  let r = sorted.length ? sorted[0][1] : null;
  for (const [day, v] of sorted) { if (day > d) break; r = v; }
  if (r == null) throw new Error('sem cotação para converter o gasto');
  return r;
}

const main = CFG.tipo === 'lancamento' ? mainLancamento : CFG.tipo === 'criativos' ? mainCriativos : CFG.tipo === 'captacao' ? mainCaptacao : mainLeads;
main().catch(e => { console.error(`[${slug}] ERRO:`, e.message); process.exit(1); });
