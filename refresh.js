// Coleta dados do Meta Ads + planilha de leads e gera JSONs para o banco do dashboard.
// Uso: node refresh.js  → escreve out/summary.json, out/campaigns.json, out/insights.json, out/ads.json, out/leads.json
const fs = require('fs');
const path = require('path');

// O token NUNCA fica no código: vem da variável de ambiente META_TOKEN
// (localmente via arquivo .env, no GitHub Actions via Secret). Assim o repositório pode ser versionado.
loadDotEnv();
const TOKEN = process.env.META_TOKEN;
if (!TOKEN) { console.error('ERRO: defina META_TOKEN (arquivo .env ou variável de ambiente)'); process.exit(1); }
const ACCOUNT = process.env.META_ACCOUNT || 'act_324960456064551';

function loadDotEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const SHEET_CSV = 'https://docs.google.com/spreadsheets/d/1eS5K9xgeiBzMxia6k1bZczrQ_9r8RLRGmzF-WAXwKH0/export?format=csv';
const GRAPH = 'https://graph.facebook.com/v21.0';
const SINCE = '2026-01-01'; // início da janela de dados

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

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
    if (lastErr) throw new Error(`Graph API ${edge}: ${lastErr.message} [page ${rows.length} rows so far; url=${url.slice(0, 220)}]`);
    rows.push(...(j.data || []));
    url = j.paging && j.paging.next ? j.paging.next : null;
  }
  return rows;
}

function todaySP() {
  // data de hoje no fuso America/Sao_Paulo
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
function toUF(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (UF_CODES.has(s.toUpperCase())) return s.toUpperCase();
  const norm = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');
  return UF[norm] || null;
}

// ---------- Data/Hora flexível ----------
function parseTS(v) {
  if (!v) return null;
  const s = String(v).trim();
  // ISO
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { date: s, time: null };
  // dd/mm/yyyy [hh:mm]
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

// Etapa do funil a partir do nome da campanha (ou do utm_campaign do lead).
// Reconhece PRE-VENDA e LOTE01/02/03 escritos de qualquer forma: "LOTE 01", "LOTE-1", "lote1"…
function stageOf(name) {
  if (!name) return null;
  let s = String(name);
  try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { /* mantém */ }
  const flat = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const lote = flat.match(/LOTE0*([123])/);
  if (lote) return 'LOTE0' + lote[1];
  if (flat.includes('PREVENDA')) return 'PRE-VENDA';
  return null;
}

function normKey(v) {
  // normaliza nomes de campanha/utm para matching (decodifica URL, tira acento, minúsculo, colapsa espaços)
  if (!v) return '';
  let s = String(v);
  try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { /* mantém */ }
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function main() {
  const until = todaySP();

  // ---- Meta: campanhas ----
  const campaigns = (await graphGetAll(`${ACCOUNT}/campaigns`, {
    fields: 'id,name,status,objective,start_time,stop_time,daily_budget'
  })).map(c => ({
    id: c.id, name: c.name, status: c.status, objective: c.objective,
    start: c.start_time ? c.start_time.slice(0, 10) : null,
    stop: c.stop_time ? c.stop_time.slice(0, 10) : null,
    dailyBudget: c.daily_budget ? Number(c.daily_budget) / 100 : null
  }));

  // ---- Só o projeto IVC: define as campanhas e a janela de datas a buscar ----
  const ivcCampaigns = campaigns.filter(c => /ivc/i.test(c.name));
  const ivcCampIds = ivcCampaigns.map(c => c.id);
  if (!ivcCampIds.length) throw new Error('nenhuma campanha com "IVC" no nome foi encontrada na conta');
  // busca só desde a primeira campanha IVC (mantém a coleta leve — roda a cada 15 min)
  const firstStart = ivcCampaigns.map(c => c.start).filter(Boolean).sort()[0] || SINCE;
  const since = firstStart < SINCE ? SINCE : firstStart;

  // ---- Meta: insights diários por anúncio ----
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
      filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: ivcCampIds }])
    });
    for (const r of rows) {
      const act = t => {
        const a = (r.actions || []).find(x => x.action_type === t);
        return a ? Number(a.value || 0) : 0;
      };
      insights.push([r.date_start, r.campaign_id, r.adset_id, r.ad_id,
        Number(r.spend || 0), Number(r.impressions || 0), Number(r.clicks || 0), Number(r.inline_link_clicks || 0),
        act('landing_page_view')]);
    }
    winStart = new Date(winEnd.getTime() + 86400000);
  }

  // ---- Meta: anúncios (nomes, público, permalink do Instagram) ----
  const adsRaw = await graphGetAll(`${ACCOUNT}/ads`, {
    fields: 'id,name,status,adset{id,name},campaign{id},creative{instagram_permalink_url}',
    filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: ivcCampIds }])
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
  const header = rows[0].map(h => h.trim());
  const idx = name => header.findIndex(h => normKey(h) === normKey(name));
  const col = {
    ts: idx('Data/Hora'), status: idx('Status'), mql: idx('MQL'), pagina: idx('Página'),
    area: idx('Área de formação'), esp: idx('Especialidade'), papel: idx('Papel na clínica'),
    estado: idx('Estado'), cidade: idx('Cidade'), fat: idx('Faturamento mensal'), desafio: idx('Principal desafio'),
    us: idx('utm_source'), um: idx('utm_medium'), uc: idx('utm_campaign'), ut: idx('utm_term'), uct: idx('utm_content')
  };
  const g = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  // `v` guarda a linha crua na ordem das colunas da planilha (a aba "Respostas" mostra isso);
  // os campos derivados alimentam KPIs, mapa e gráficos.
  const leads = rows.slice(1).map(r => {
    const ts = parseTS(g(r, col.ts));
    const uc = g(r, col.uc);
    return {
      v: header.map((_, i) => g(r, i)),
      date: ts ? ts.date : null, time: ts ? ts.time : null,
      status: g(r, col.status) || null, mql: isMQL(g(r, col.mql)),
      area: g(r, col.area) || null, especialidade: g(r, col.esp) || null, papel: g(r, col.papel) || null,
      uf: toUF(g(r, col.estado)), estadoRaw: g(r, col.estado) || null, cidade: g(r, col.cidade) || null,
      faturamento: g(r, col.fat) || null, desafio: g(r, col.desafio) || null,
      stage: stageOf(uc) || stageOf(g(r, col.pagina)),
      utmCampaign: normKey(uc) || null,
      utmAdset: normKey(g(r, col.um)) || null,
      utmAd: normKey(g(r, col.uct)) || null
    };
  }).filter(l => l.date); // ignora linhas sem data

  // ---- Consolida o recorte IVC (a API já filtrou; aqui só anexa a etapa do funil) ----
  const ivc = ivcCampaigns.map(c => ({ ...c, stage: stageOf(c.name) }));
  const ivcIds = new Set(ivc.map(c => c.id));
  const ivcInsights = insights.filter(r => ivcIds.has(r[1]));
  const ivcAds = ads.filter(a => ivcIds.has(a.campaignId));

  // ---- Filtra para o que tem veiculação na janela (ou está ativo) ----
  const deliveredAdIds = new Set(ivcInsights.map(r => r[3]));
  const activeCampSet = new Set(ivc.filter(c => c.status === 'ACTIVE').map(c => c.id));
  const keptCampaigns = ivc;
  const keptAds = ivcAds.filter(a => deliveredAdIds.has(a.id) || (a.status === 'ACTIVE' && activeCampSet.has(a.campaignId)));

  // ---- Saída ----
  const write = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj));
  write('campaigns.json', { rows: keptCampaigns });
  write('insights.json', { cols: ['date', 'campaignId', 'adsetId', 'adId', 'spend', 'impressions', 'clicks', 'linkClicks', 'pageViews'], rows: ivcInsights });
  write('ads.json', { rows: keptAds });
  write('leads.json', { header, rows: leads });
  write('summary.json', {
    updatedAt: new Date().toISOString(), account: ACCOUNT, since, until,
    counts: { campaigns: keptCampaigns.length, insightRows: ivcInsights.length, ads: keptAds.length, leads: leads.length }
  });
  console.log('OK', JSON.stringify({ campaigns: keptCampaigns.length, insightRows: ivcInsights.length, ads: keptAds.length, leads: leads.length }));
  for (const f of ['campaigns', 'insights', 'ads', 'leads', 'summary']) {
    console.log(f, fs.statSync(path.join(OUT, f + '.json')).size, 'bytes');
  }
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
