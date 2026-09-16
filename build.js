// Monta o dashboard a partir de template.html + out/*.json + brazil.svg
//
//   node build.js          → dashboard.html          (SEM colunas de contato — é o que vai publicado)
//   node build.js --full   → dashboard-completo.html (COM nome/e-mail/telefone/Instagram — só local)
//
// O dashboard publicado é um link compartilhável, por isso a versão padrão não leva
// dado pessoal nenhum embutido: mascarar na tela não bastaria, o valor viajaria no HTML.
const fs = require('fs');
const path = require('path');
const here = __dirname;
const read = f => fs.readFileSync(path.join(here, f), 'utf8');
const json = f => JSON.parse(read(path.join('out', f)));

const FULL = process.argv.includes('--full');
const OUT_FILE = FULL ? 'dashboard-completo.html' : 'dashboard.html';

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const PII = new Set(['nome', 'e-mail', 'email', 'telefone', 'instagram']);

const leadsFile = json('leads.json');
let header = leadsFile.header;
let leads = leadsFile.rows;

if (!FULL) {
  const drop = header.map((h, i) => PII.has(norm(h)) ? i : -1).filter(i => i >= 0);
  const keep = header.map((_, i) => i).filter(i => !drop.includes(i));
  header = keep.map(i => header[i]);
  leads = leads.map(l => ({ ...l, v: keep.map(i => l.v[i]) }));
  console.log('sem contato — colunas removidas:', drop.length);
}

const data = {
  summary: json('summary.json'),
  campaigns: json('campaigns.json').rows,
  insights: json('insights.json'),
  ads: json('ads.json').rows,
  leads,
  leads_header: header,
};

// extrai o conteúdo do <svg> do mapa
const svg = read('brazil.svg');
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();

let html = read('template.html');
html = html.replace('/*__DATA__*/{}', JSON.stringify(data).replace(/<\/script/gi, '<\\/script'));
html = html.replace('<!--__MAP__-->', inner);
fs.writeFileSync(path.join(here, OUT_FILE), html);
console.log(OUT_FILE, fs.statSync(path.join(here, OUT_FILE)).size, 'bytes');
