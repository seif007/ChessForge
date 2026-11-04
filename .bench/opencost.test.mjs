/**
 * How long does opening an opening actually take, and where does the time go?
 *
 * THE REPORT: *"when i open an opening in 'your openings' it take too much time"*.
 *
 * The prime suspect is my own change. `bookContinuationFromPosition` builds a POSITION index the
 * first time an opening is opened, and it does it synchronously: for every study, every line
 * (mainline plus variations), a chess.js board walked ply by ply calling `fen()` at each one.
 * The archive comment on `COVERAGE_MAX_PLY` records exactly what that class of eager index cost
 * before — 8 seconds and 37 MB — and I put a new one on the same path.
 *
 * So this measures it rather than assuming. It reports the index build per opening, and the
 * lookups, separately, because they have different fixes: a slow build is a caching or
 * deferral problem, and slow lookups are an indexing problem.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// A throwaway compile cache, wiped and rebuilt on every run, so it is named after the app like
// everything else. GATE 1h flagged the old name here, which is the gate doing its job on a file
// I had written minutes earlier.
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-perf');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'openings.ts'),
    path.join(ROOT, 'src', 'lib', 'repertoire.ts'),
    path.join(ROOT, 'src', 'lib', 'gameOpenings.ts'),
    path.join(ROOT, 'src', 'lib', 'openingBuilder.ts'),
  ],
}, null, 2));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project',
    path.join(BUILD_DIR, 'tsconfig.json'),
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 2000));
  process.exit(2);
}

function findEmitted(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const h = findEmitted(p, name); if (h) return h; }
    else if (e.name === name) return p;
  }
  return null;
}

const Module = require('node:module');
const origLoad = Module._load;
const REAL_CHESS = require('chess.js');
const J = (n) => findEmitted(BUILD_DIR, n + '.js');
const stub = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : stub), apply: () => stub });

Module._load = function (request, parent, isMain) {
  if (request === 'chess.js') return REAL_CHESS;
  if (request === '@/lib/engine') return { getEngine: () => ({ bestMove: () => null }), uciToSan: () => null };
  const map = {
    '@/lib/repertoire': 'repertoire', '@/lib/openings': 'openings',
    '@/lib/gameOpenings': 'gameOpenings', '@/lib/openingBuilder': 'openingBuilder',
  };
  if (map[request]) return origLoad.call(this, J(map[request]), null, false);
  if (request.startsWith('@/data/')) return origLoad.call(this, path.join(ROOT, 'src', request.slice(2)), parent, isMain);
  if (request.startsWith('@/')) return new Proxy(function () {}, { get: (_t, p) => (p === '__esModule' ? false : stub), apply: () => stub });
  return origLoad.call(this, request, parent, isMain);
};

const openings = origLoad.call(Module, J('openings'), null, false);
const { OPENINGS } = openings;

console.log(`  node ${process.version}, ${OPENINGS.length} openings registered\n`);

// The reported case first, then a spread, so this is not a one-opening measurement.
const SAMPLE = ['sicilian', 'london-system', 'queens-gambit', 'indian-defense', 'sicilian-najdorf', 'italian-opening'];

console.log('  position-index build, per opening (synchronous, on the UI thread):');
console.log('  ' + 'opening'.padEnd(22) + 'studies  lines  positions     build');
const rows = [];
for (const id of SAMPLE) {
  const entry = OPENINGS.find((o) => o.id === id && o.available && o.repertoire);
  if (!entry) { console.log('  ' + id.padEnd(22) + '(not available)'); continue; }
  const { allStudies, buildPositionIndex } = origLoad.call(Module, J('repertoire'), null, false);
  const studies = allStudies(entry.repertoire);
  const t0 = process.hrtime.bigint();
  const idx = buildPositionIndex(studies);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let lines = 0;
  const rep = origLoad.call(Module, J('repertoire'), null, false);
  for (const s of studies) lines += rep.collectStudyLines(s).length;
  rows.push({ id, studies: studies.length, lines, positions: idx.size, ms });
  console.log('  ' + id.padEnd(22)
    + String(studies.length).padStart(6)
    + String(lines).padStart(7)
    + String(idx.size).padStart(11)
    + (ms.toFixed(0) + ' ms').padStart(9));
}

const worst = rows.slice().sort((a, b) => b.ms - a.ms)[0];
const totalPositions = rows.reduce((a, r) => a + r.positions, 0);
const totalMs = rows.reduce((a, r) => a + r.ms, 0);
console.log(`\n  slowest: ${worst.id} at ${worst.ms.toFixed(0)} ms for ${worst.positions} positions`);
console.log(`  this sample: ${totalPositions} positions, ${totalMs.toFixed(0)} ms total`);
console.log(`  a full-library build would be roughly ${(totalMs / 6 * OPENINGS.filter((o) => o.available && o.repertoire).length / 1000).toFixed(1)} s`);

// And the lookups themselves, which is the other half of the cost.
console.log('\n  lookup cost, after the index exists:');
const probeResults = [];
{
  const { bookContinuationFromPosition } = openings;
  /*
   * THE PROBE POSITIONS ARE TAKEN FROM A SHIPPED LINE, NOT TYPED IN BY HAND.
   *
   * They used to be hand-written: the Najdorf mainline for `sicilian` and a London line for
   * `london-system`. Both reported `0/200 hit`, and both were RIGHT - the lookup returns null for a
   * position we do not teach, and the Najdorf mainline is not one of our lines. But the gate read
   * that as a cost measurement and said nothing, so a benchmark of nothing looked exactly like a
   * fast benchmark.
   *
   * A probe is only meaningful if it is a position the book actually contains, so it is cut out of
   * the real line: play a few moves of it, then ask for the continuation. If the book does not know
   * the position, the assertion below fails loudly instead of the number quietly meaning nothing.
   */
  const SAMPLE_LINES = {
    sicilian: ['e4', 'c5', 'Nf3', 'd6', 'c4'],
    'london-system': ['d4', 'd5', 'Nf3', 'Nf6', 'Bf4'],
  };
  for (const [id, sans] of Object.entries(SAMPLE_LINES)) {
    const c = new Chess();
    for (const s of sans) c.move(s);
    bookContinuationFromPosition(c.fen(), id);          // warm the index
    const N = 200;
    const t0 = process.hrtime.bigint();
    let hits = 0;
    for (let i = 0; i < N; i++) if (bookContinuationFromPosition(c.fen(), id)) hits++;
    const per = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    probeResults.push({ id, per, hits, N });
    console.log(`  ${id.padEnd(22)} ${per.toFixed(3)} ms per lookup  (${hits}/${N} hit)`);
  }
}

/*
 * ASSERTIONS. LIKE THE OLDER PARSER GATES, THIS FILE ONLY PRINTED, AND EXITED 0.
 *
 * Its subject is the report "when i open an opening in 'your openings' it take too much time", so the
 * numbers it produced were the whole point and nothing was allowed to object to them.
 */
let checks = 0;
let failures = 0;
function check(cond, label) {
  checks += 1;
  if (cond) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}`); }
}

console.log('');
const slowest = probeResults.slice().sort((a, b) => b.per - a.per)[0];
check(rows.length > 0, `at least one opening could be indexed (${rows.length} of the sample)`);
check(totalPositions > 0, `the position index is not empty (${totalPositions} positions)`);
check(probeResults.some((p) => p.hits > 0),
  'at least one probe position is one the book ACTUALLY teaches - without this the timings below '
  + 'measure a lookup that returns nothing');
// The whole complaint was opening time. A position walk happens per ply while a line is drawn, so a
// millisecond-scale lookup is what keeps the screen from stuttering; anything in the tens means the
// index is being rebuilt rather than read.
check(slowest && slowest.per < 2,
  `the slowest lookup stays under 2 ms (${slowest ? `${slowest.id} at ${slowest.per.toFixed(3)} ms` : 'none'})`);
check(worst && worst.ms < 3000,
  `the slowest index build stays under 3 s (${worst ? `${worst.id} at ${worst.ms.toFixed(0)} ms` : 'none'})`);

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
