// Monta o site estático em public/:
//
//   node build.js                → todos os clientes + página raiz   (SEM colunas de contato — é o que vai publicado)
//   node build.js <cliente>      → só esse cliente
//   node build.js <cliente> --full → clientes/<cliente>/dashboard-completo.html (COM contato — só local, nunca publicar)
//
// Cada cliente sai em public/<cliente>/index.html → dash.atodigital.com.br/<cliente>
// O publicado é um link aberto, por isso a versão padrão não leva dado pessoal nenhum embutido.
const fs = require('fs');
const path = require('path');
const here = __dirname;
const read = f => fs.readFileSync(path.join(here, f), 'utf8');

const args = process.argv.slice(2);
const FULL = args.includes('--full');
const only = args.find(a => !a.startsWith('--')) || null;

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const PII = new Set(['nome', 'e-mail', 'email', 'telefone', 'instagram', 'whatsapp', 'celular', 'cpf']);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const template = read('shared/template.html');                       // Meta + leads (planilha)
const templateLancamento = read('shared/template-lancamento.html');  // Meta + vendas (Hubla)
// a logo vive em shared/logo.svg — trocar o arquivo troca em todas as páginas
const logoSvg = read('shared/logo.svg').replace(/<\?xml[^>]*\?>\s*/, '').replace('<svg ', '<svg class="logo" ').trim();
const mapSvg = read('shared/brazil.svg').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
const PUBLIC = path.join(here, 'public');

function buildClient(slug) {
  const dir = path.join(here, 'clientes', slug);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const json = f => JSON.parse(fs.readFileSync(path.join(dir, 'out', f), 'utf8'));

  if (cfg.tipo === 'lancamento') {
    // vendas não levam dado pessoal (só data, fatura, anúncio e valor) — a mesma página serve para --full
    const data = {
      summary: json('summary.json'),
      campaigns: json('campaigns.json').rows,
      insights: json('insights.json'),
      ads: json('ads.json').rows,
      sales: json('sales.json').rows,
    };
    const html = templateLancamento
      .split('{{NOME}}').join(esc(cfg.nome))
      .replace('/*__DATA__*/{}', JSON.stringify(data).replace(/<\/script/gi, '<\\/script'));
    const outFile = FULL ? path.join(dir, 'dashboard-completo.html') : path.join(PUBLIC, slug, 'index.html');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html);
    console.log(`[${slug}] ${path.relative(here, outFile)} ${fs.statSync(outFile).size} bytes`);
    return;
  }

  const leadsFile = json('leads.json');
  let header = leadsFile.header;
  let leads = leadsFile.rows;
  if (!FULL) {
    const keep = header.map((h, i) => PII.has(norm(h)) ? -1 : i).filter(i => i >= 0);
    header = keep.map(i => header[i]);
    leads = leads.map(l => ({ ...l, v: keep.map(i => l.v[i]) }));
  }

  const data = {
    summary: json('summary.json'),
    campaigns: json('campaigns.json').rows,
    insights: json('insights.json'),
    ads: json('ads.json').rows,
    leads,
    leads_header: header,
    etapas: (cfg.etapas || []).map(e => ({ key: e.key, label: e.label })),
    perguntas: cfg.perguntas || [],
  };

  let html = template
    .split('{{NOME}}').join(esc(cfg.nome))
    .split('{{PLANILHA_URL}}').join(`https://docs.google.com/spreadsheets/d/${cfg.planilha.id}/edit`)
    .replace('/*__DATA__*/{}', JSON.stringify(data).replace(/<\/script/gi, '<\\/script'))
    .replace('<!--__MAP__-->', mapSvg)
    .replace('<!--__LOGO__-->', logoSvg);

  let outFile;
  if (FULL) {
    outFile = path.join(dir, 'dashboard-completo.html');
  } else {
    fs.mkdirSync(path.join(PUBLIC, slug), { recursive: true });
    outFile = path.join(PUBLIC, slug, 'index.html');
  }
  fs.writeFileSync(outFile, html);
  console.log(`[${slug}] ${path.relative(here, outFile)} ${fs.statSync(outFile).size} bytes${FULL ? ' (COM contato — não publicar)' : ''}`);
}

function buildRoot() {
  fs.mkdirSync(PUBLIC, { recursive: true });
  const root = read('shared/root.html').replace('<!--__LOGO__-->', logoSvg);
  fs.writeFileSync(path.join(PUBLIC, 'index.html'), root);
  fs.writeFileSync(path.join(PUBLIC, '404.html'), root);
  if (fs.existsSync(path.join(here, 'CNAME'))) fs.copyFileSync(path.join(here, 'CNAME'), path.join(PUBLIC, 'CNAME'));
  fs.writeFileSync(path.join(PUBLIC, '.nojekyll'), '');
}

const clients = only ? [only] : fs.readdirSync(path.join(here, 'clientes')).filter(d => fs.existsSync(path.join(here, 'clientes', d, 'config.json')));
for (const c of clients) buildClient(c);
if (!FULL && !only) buildRoot();
