const fs = require('fs');
const rep = (p, pairs) => {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error(p + ' missing: ' + a.slice(0, 70)); s = s.replace(a, b); }
  fs.writeFileSync(p, s);
};

/* ---------- config: lançamento de outubro/novembro ---------- */
const cfgP = 'clientes/paulo-cobra/config.json';
const cfg = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
cfg.filtroCampanha = 'WORKSHOP|WORKSOP';   // o lançamento novo; "WORKSOP" é um erro de digitação numa das campanhas
cfg.desde = '2026-10-22';                  // início das campanhas = início do período padrão
cfg.ate = '2026-11-11';                    // fim do lançamento
cfg.debrief = {
  congelado: true,                         // o debriefing publicado é o do lançamento anterior
  rotulo: 'Lançamento de setembro/outubro (IVML)',
};
fs.writeFileSync(cfgP, JSON.stringify(cfg, null, 2) + '\n');

/* ---------- refresh.js: respeitar o debriefing congelado ---------- */
rep('refresh.js', [
  [`  let debrief = null;
  try {`,
   `  let debrief = null;
  const congelado = CFG.debrief && CFG.debrief.congelado; // debriefing de um lançamento já encerrado: não recalcular
  try {
    if (congelado) throw new Error('congelado no config — mantém o snapshot do lançamento anterior');`],
  [`  const snapshot = path.join(DIR, 'debrief.json');
  if (debrief) fs.writeFileSync(snapshot, JSON.stringify(debrief, null, 2) + '\\n');
  else if (fs.existsSync(snapshot)) debrief = JSON.parse(fs.readFileSync(snapshot, 'utf8'));`,
   `  const snapshot = path.join(DIR, 'debrief.json');
  if (debrief) fs.writeFileSync(snapshot, JSON.stringify(debrief, null, 2) + '\\n');
  else if (fs.existsSync(snapshot)) debrief = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  if (debrief && CFG.debrief && CFG.debrief.rotulo) debrief.rotulo = CFG.debrief.rotulo;`],
  [`    console.error(\`[\${slug}] debriefing ignorado: \${e.message}\`);`,
   `    console.log(\`[\${slug}] debriefing: \${e.message}\`);`],
]);

/* ---------- template: dizer a que lançamento o debriefing se refere ---------- */
rep('shared/template-lancamento.html', [
  [`    <div class="card-head"><h2 id="h-origem">De onde vieram os compradores</h2></div>`,
   `    <div class="card-head"><h2 id="h-origem">De onde vieram os compradores</h2><span class="right" id="db-rotulo"></span></div>`],
  [`  .card-head h2 { font-size: 16px; }`,
   `  .card-head h2 { font-size: 16px; }
  .card-head .right { color: var(--muted); font-size: 12.5px; font-weight: 500; }`],
  [`    const cruza = d.temWorkshop;`,
   `    $('db-rotulo').textContent = d.rotulo || '';
    const cruza = d.temWorkshop;`],
]);

console.log('ok');
