// Coleta dados do Meta Ads (+ planilha de leads ou vendas da Hubla) de UM cliente e gera os JSONs do dashboard dele.
//
//   node refresh.js <cliente>      ex.: node refresh.js omundoclinico
//
// Lê clientes/<cliente>/config.json e escreve clientes/<cliente>/out/*.json.
// `tipo` no config escolhe o fluxo: ausente/"leads" = Meta + planilha de leads (mainLeads);
// "lancamento" = Meta em nível de anúncio + vendas da Hubla via planilha do webhook (mainLancamento).
// O token NUNCA fica no código: vem de META_TOKEN_<CLIENTE> ou, na falta, de META_TOKEN
// (localmente via arquivo .env, no GitHub Actions via Secret).
const fs = require('fs');
const path = require('path');

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

async function graphGetAll(edge, params) {
  let url = `${GRAPH}/${edge}?${new URLSearchParams({ ...params, access_token: TOKEN, limit: params.limit || '500' })}`;
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
  const campaigns = allCampaigns.filter(c => CAMP_FILTER.test(c.name));
  if (!campaigns.length) throw new Error(`nenhuma campanha bate com o filtro "${CFG.filtroCampanha}" na conta ${ACCOUNT}`);
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
    product: idx('product_id'), uc: idx('utm_campaign'), uct: idx('utm_content')
  };
  for (const k of ['invoice', 'status', 'sale']) if (col[k] < 0) throw new Error(`planilha da Hubla sem a coluna ${k} — use o hubla/webhook-planilha.gs deste repositório`);
  const g = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  const produtos = (CFG.hubla.produtos || []).map(String);

  // última linha de cada fatura = status atual (paid → venda; refunded/chargeback depois → sai)
  const byInvoice = new Map();
  for (const r of rows.slice(1)) { const id = g(r, col.invoice); if (id) byInvoice.set(id, r); }

  const adByName = new Map(ads.map(a => [normKey(a.name), a.id]));
  const adIds = new Set(ads.map(a => a.id));
  const sales = [];
  for (const [invoiceId, r] of byInvoice) {
    if (g(r, col.status).toLowerCase() !== 'paid') continue;
    if (produtos.length && !produtos.includes(g(r, col.product))) continue;
    const date = saleDateSP(g(r, col.sale));
    if (!date) continue;
    const uct = decode(g(r, col.uct)).trim();
    const adId = adIds.has(uct) ? uct : (adByName.get(normKey(uct)) || null);
    sales.push({ date, invoiceId, adId, valueCents: Math.round(Number(g(r, col.total)) || 0), utmCampaign: normKey(g(r, col.uc)) || null, utmContent: uct || null });
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

  // ---- Hubla ----
  const sales = await fetchHublaSales(ads);

  const deliveredAdIds = new Set(insights.map(r => r[3]));
  const soldAdIds = new Set((sales || []).map(s => s.adId).filter(Boolean));
  const activeCampSet = new Set(campaigns.filter(c => c.status === 'ACTIVE').map(c => c.id));
  const keptAds = ads.filter(a => deliveredAdIds.has(a.id) || soldAdIds.has(a.id) || (a.status === 'ACTIVE' && activeCampSet.has(a.campaignId)));

  const write = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj));
  write('campaigns.json', { rows: campaigns });
  write('insights.json', { cols: ['date', 'campaignId', 'adsetId', 'adId', 'spend', 'impressions', 'clicks', 'linkClicks', 'pageViews', 'checkouts'], rows: insights });
  write('ads.json', { rows: keptAds });
  write('sales.json', { rows: sales || [] });
  write('summary.json', {
    updatedAt: new Date().toISOString(), account: ACCOUNT, since, until, hubla: sales !== null,
    counts: { campaigns: campaigns.length, insightRows: insights.length, ads: keptAds.length, sales: sales ? sales.length : null }
  });
  console.log(`[${slug}] OK`, JSON.stringify({ campaigns: campaigns.length, insightRows: insights.length, ads: keptAds.length, sales: sales ? sales.length : 'hubla não configurada' }));
}

const main = CFG.tipo === 'lancamento' ? mainLancamento : mainLeads;
main().catch(e => { console.error(`[${slug}] ERRO:`, e.message); process.exit(1); });
