// Leitor mínimo de .xlsx (zip + XML), sem dependência: devolve a primeira aba como matriz de textos.
// Serve também para o "sales_history_*.xls" da Hotmart, que na verdade é um .xlsx.
const fs = require('fs');

function readXlsx(file) {
  const zlib = require('zlib');
  const buf = fs.readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error(`${file}: não é um .xlsx válido`);
  const entries = {};
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0, n = buf.readUInt16LE(eocd + 10); i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    entries[name] = () => (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d)).replace(/&amp;/g, '&');
  const texts = s => unxml([...s.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''));
  const shared = entries['xl/sharedStrings.xml'] ? [...entries['xl/sharedStrings.xml']().matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1])) : [];
  const sheetName = Object.keys(entries).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  const col = letters => [...letters].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const rows = [];
  for (const m of entries[sheetName]().matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, letters, rowNum, attrs, inner = ''] = m;
    const type = (attrs.match(/t="(\w+)"/) || [])[1];
    const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    const val = type === 's' ? shared[Number(v)] : type === 'inlineStr' ? texts(inner) : v != null ? unxml(v) : '';
    (rows[Number(rowNum) - 1] = rows[Number(rowNum) - 1] || [])[col(letters)] = val;
  }
  return rows.filter(Boolean);
}

module.exports = { readXlsx };
