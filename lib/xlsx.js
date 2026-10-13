// Leitor mínimo de .xlsx (sem dependências): devolve cada aba como array de objetos
// com as chaves vindas da primeira linha. Suficiente para os exports da Hubla.
//
//   const { lerXlsx } = require('./lib/xlsx');
//   const abas = lerXlsx('arquivo.xlsx');   // [{ nome, linhas: [{Coluna: valor}] }]
const fs = require('fs');
const zlib = require('zlib');

const dec = s => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&');

// --- ZIP: lê o diretório central e descomprime as entradas (deflate ou stored) ---
function unzip(buf) {
  const eocd = (() => { for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i; return -1; })();
  if (eocd < 0) throw new Error('não parece um .xlsx (fim do zip não encontrado)');
  let off = buf.readUInt32LE(eocd + 16);
  const total = buf.readUInt16LE(eocd + 10);
  const files = {};
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compSize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}

const colLetras = ref => ref.replace(/\d+/g, '');
const colIndice = letras => [...letras].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

function lerAba(xml, shared) {
  const linhas = [];
  for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of r[1].matchAll(/<c r="([A-Z]+\d+)"(?:[^>]*t="([^"]+)")?[^>]*>(?:<v>([^<]*)<\/v>|<is>([\s\S]*?)<\/is>)?/g)) {
      const tipo = c[2], bruto = c[3];
      let v = '';
      if (c[4] != null) v = [...c[4].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join('');
      else if (bruto != null) v = tipo === 's' ? (shared[+bruto] || '') : bruto;
      cells[colIndice(colLetras(c[1]))] = dec(v).trim();
    }
    linhas.push(cells);
  }
  if (!linhas.length) return [];
  const head = linhas[0].map(h => (h || '').trim());
  return linhas.slice(1).map(cs => {
    const o = {};
    head.forEach((h, i) => { if (h) o[h] = cs[i] != null ? cs[i] : ''; });
    return o;
  }).filter(o => Object.values(o).some(v => v !== ''));
}

function lerXlsx(caminho) {
  const files = unzip(fs.readFileSync(caminho));
  const sharedXml = files['xl/sharedStrings.xml'] ? files['xl/sharedStrings.xml'].toString('utf8') : '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => dec([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  const wb = files['xl/workbook.xml'].toString('utf8');
  const rels = files['xl/_rels/workbook.xml.rels'] ? files['xl/_rels/workbook.xml.rels'].toString('utf8') : '';
  const alvo = {};
  for (const m of rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) alvo[m[1]] = m[2].replace(/^\/?xl\//, '');
  const abas = [];
  let i = 0;
  for (const m of wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    i++;
    const path = 'xl/' + (alvo[m[2]] || `worksheets/sheet${i}.xml`);
    if (!files[path]) continue;
    abas.push({ nome: dec(m[1]), linhas: lerAba(files[path].toString('utf8'), shared) });
  }
  return abas;
}

module.exports = { lerXlsx };
