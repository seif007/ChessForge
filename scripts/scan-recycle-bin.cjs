// Lists what is in the Windows Recycle Bin, and flags anything that looks like a project file.
// The $I record holds the original path as UTF-16LE from offset 28; the bytes live beside it as $R.
const fs = require('fs');
const path = require('path');

const root = 'C:\\$Recycle.Bin';
const out = [];

function walk(dir, depth) {
  if (depth > 2) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    if (!e.name.startsWith('$I')) continue;
    let b;
    try { b = fs.readFileSync(p); } catch { continue; }
    if (b.length < 30) continue;
    const len = b.readInt32LE(24);
    if (len <= 0 || len > 600) continue;
    let orig = '';
    try { orig = b.toString('utf16le', 28, 28 + len * 2).replace(/\0+$/, ''); } catch { /* short read */ }
    const data = path.join(dir, '$R' + e.name.slice(2));
    let size = -1;
    try { size = fs.statSync(data).size; } catch { /* data gone */ }
    out.push({ meta: e.name, orig, size, data });
  }
}

try { walk(root, 0); } catch { /* no access */ }
console.log('items scanned:', out.length);
const hit = out.filter((o) => /harness|build\.mjs|repertoire\.gen|\.bak|chessforge|\.bench|ChessForge/i.test(o.orig));
console.log('relevant to this project:', hit.length);
for (const o of hit) console.log('  ' + o.meta + '  ' + o.size + ' bytes  ' + o.orig);

if (process.argv.includes('--extract')) {
  // Extract to TEMP, never into the project: the recovered paths carry a retired brand name that
  // must not reappear anywhere under src/ or .bench/.
  const t = out.find((z) => /harness\.html$/i.test(z.orig));
  if (!t) { console.log('no harness.html to extract'); process.exit(0); }
  const dest = path.join(process.env.TEMP || '.', 'recovered-harness.html');
  fs.copyFileSync(t.data, dest);
  console.log('extracted ' + t.size + ' bytes -> ' + dest);
}