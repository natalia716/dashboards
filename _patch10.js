const fs = require('fs');
const rep = (p, pairs) => {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error(p + ' missing: ' + a.slice(0, 70)); s = s.replace(a, b); }
  fs.writeFileSync(p, s);
};

rep('refresh.js', [
  [`  let debrief = null;
  if (!HOTMART) try {`,
   `  // debriefing de um lançamento já encerrado fica congelado: o snapshot não é recalculado
  // com o gasto do lançamento seguinte (config: "debrief": { "congelado": true })
  const debriefCongelado = !!(CFG.debrief && CFG.debrief.congelado);
  let debrief = null;
  if (!HOTMART && !debriefCongelado) try {`],
  [`  const snapshot = path.join(DIR, 'debrief.json');
  if (debrief) fs.writeFileSync(snapshot, JSON.stringify(debrief, null, 2) + '\\n');
  else if (fs.existsSync(snapshot)) debrief = JSON.parse(fs.readFileSync(snapshot, 'utf8'));`,
   `  const snapshot = path.join(DIR, 'debrief.json');
  if (debrief) fs.writeFileSync(snapshot, JSON.stringify(debrief, null, 2) + '\\n');
  else if (fs.existsSync(snapshot)) debrief = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  if (debrief && CFG.debrief && CFG.debrief.rotulo) debrief.rotulo = CFG.debrief.rotulo;`],
]);

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
