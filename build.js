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
const templateCriativos = read('shared/template-criativos.html');    // Meta por anúncio + vendas da Hotmart + prévias
const templateCaptacao = read('shared/template-captacao.html');      // Meta por anúncio + planilha de leads de lançamento
// a logo vive em shared/logo.svg — trocar o arquivo troca em todas as páginas
const logoSvg = read('shared/logo.svg').replace(/<\?xml[^>]*\?>\s*/, '').replace('<svg ', '<svg class="logo" ').trim();
const mapSvg = read('shared/brazil.svg').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
const PUBLIC = path.join(here, 'public');

function buildClient(slug) {
  const dir = path.join(here, 'clientes', slug);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const json = f => JSON.parse(fs.readFileSync(path.join(dir, 'out', f), 'utf8'));

  if (cfg.tipo === 'criativos') {
    // só agregados por criativo e por dia (vendas, gasto, faturamento) — nada do comprador; as miniaturas vão junto da página
    const data = { summary: json('summary.json'), daily: json('daily.json'), ads: json('ads.json').rows };
    const html = templateCriativos
      .split('{{NOME}}').join(esc(cfg.nome))
      .replace('/*__DATA__*/{}', JSON.stringify(data).replace(/<\/script/gi, '<\\/script'));
    const outDir = path.join(PUBLIC, slug);
    fs.rmSync(path.join(outDir, 'thumbs'), { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, 'thumbs'), { recursive: true });
    // só as miniaturas em uso (o cache do refresh guarda também as de anúncios que saíram do painel)
    for (const a of data.ads) if (a.thumb) fs.copyFileSync(path.join(dir, 'out', 'cache', a.thumb), path.join(outDir, a.thumb));
    fs.writeFileSync(path.join(outDir, 'index.html'), html);
    console.log(`[${slug}] ${path.relative(here, path.join(outDir, 'index.html'))} ${fs.statSync(path.join(outDir, 'index.html')).size} bytes`);
    return;
  }

  if (cfg.tipo === 'captacao') {
    // leads só com data, temperatura, país, origem e criativo (o refresh já deixa nome/e-mail/telefone de fora)
    const data = {
      summary: json('summary.json'),
      campaigns: json('campaigns.json').rows,
      insights: json('insights.json').rows,
      ads: json('ads.json').rows,
      leads: json('leads.json').rows,
      // respostas fechadas da pesquisa já ligadas ao lead (sem e-mail nem texto livre)
      pesquisa: fs.existsSync(path.join(dir, 'out', 'pesquisa.json')) ? json('pesquisa.json') : null,
      // vendas do debriefing: uma linha por compradora, sem nome/e-mail/telefone
      vendas: fs.existsSync(path.join(dir, 'out', 'vendas.json')) ? json('vendas.json') : null,
    };
    const html = templateCaptacao
      .split('{{NOME}}').join(esc(cfg.nome))
      .replace('/*__DATA__*/{}', JSON.stringify(data).replace(/<\/script/gi, '<\\/script'));
    const outDir = path.join(PUBLIC, slug);
    fs.rmSync(path.join(outDir, 'thumbs'), { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, 'thumbs'), { recursive: true });
    for (const a of data.ads) if (a.thumb) fs.copyFileSync(path.join(dir, 'out', 'cache', a.thumb), path.join(outDir, a.thumb));
    fs.writeFileSync(path.join(outDir, 'index.html'), html);
    console.log(`[${slug}] ${path.relative(here, path.join(outDir, 'index.html'))} ${fs.statSync(path.join(outDir, 'index.html')).size} bytes`);
    return;
  }

  if (cfg.tipo === 'lancamento') {
    // vendas não levam dado pessoal (só data, fatura, anúncio e valor) — a mesma página serve para --full
    const data = {
      summary: json('summary.json'),
      campaigns: json('campaigns.json').rows,
      insights: json('insights.json'),
      ads: json('ads.json').rows,
      sales: json('sales.json').rows,
      debrief: json('debrief.json'),
    };
    // perpétuo: não há ingresso — os rótulos do lançamento viram "vendas" e o seletor de evento vira o de produto
    const tpl = !cfg.perpetuo ? templateLancamento : [
      ['Vendas de ingressos e order bump por dia e CPA de ingressos', 'Vendas e CPA por dia'],
      ['Vendas e CPA de ingressos por dia', 'Vendas e CPA por dia'],
      ['Vendas ingressos', 'Vendas'], ['CPA ingressos', 'CPA'],
      ['<span>Ingressos</span>', '<span>Vendas</span>'], [' dos ingressos</span>', ' das vendas</span>'],
      ['aria-label="Evento"', 'aria-label="Produto"'],
    ].reduce((t, [de, para]) => t.split(de).join(para), templateLancamento);
    const html = tpl
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

const cfgOf = d => JSON.parse(fs.readFileSync(path.join(here, 'clientes', d, 'config.json'), 'utf8'));
// "suspenso" no config: a página sai do site (o Actions publica public/ do zero a cada execução)
const clients = (only ? [only] : fs.readdirSync(path.join(here, 'clientes')).filter(d => fs.existsSync(path.join(here, 'clientes', d, 'config.json'))))
  .filter(d => { const s = cfgOf(d).suspenso; if (s) console.log(`[${d}] suspenso desde ${s} — página não publicada`); return !s; });
// Cliente cuja coleta falhou nesta execução fica de fora da publicação em vez de derrubar o
// site inteiro — os outros continuam no ar com os dados que têm.
const falharam = [];
for (const c of clients) {
  try {
    buildClient(c);
  } catch (e) {
    falharam.push(c);
    console.error(`[${c}] sem dados para publicar: ${e.message}`);
  }
}
if (falharam.length) console.error(`clientes fora desta publicação: ${falharam.join(', ')}`);
if (falharam.length === clients.length) { console.error('nenhum cliente pôde ser publicado'); process.exit(1); }
if (!FULL && !only) buildRoot();
