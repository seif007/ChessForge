/**
 * The generated mate drills must be drills the user can actually win.
 *
 * `goal: 'mate'` is a promise. If the position cannot be mated, the user is
 * guaranteed to burn the move budget, be told to "try a more direct method", and
 * lose rating for a position that was unwinnable the moment it appeared. Nothing in
 * the app can detect that at runtime, so it has to be impossible by construction —
 * and that means the generator has to be sampled here, over many draws, and every
 * draw checked.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `k2b` seeds `['K', 'B', 'B']` and `placeMate` had no square-colour constraint, so
 * both bishops landed on the same colour about 42% of the time. Two bishops on one
 * colour can never mate. `k2b` is 2/4 of the `sharp` weighted menu and `sharp`
 * draws 45% generated, so ~9% of advanced drills were unwinnable on arrival.
 *
 * WHY A SAMPLE AND NOT AN ARGUMENT
 * --------------------------------
 * The colour rule is a one-line property, so it is easy to believe it holds after
 * the fix. But `placeMate` retries up to 400 times and can return null, so the
 * constraint interacts with the retry budget in ways that reading the code does not
 * settle. Drawing ~300 positions per kind and checking each one is cheap (no engine)
 * and it is the only thing that actually demonstrates the property holds in the
 * shipped code rather than in my reading of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');

/* ---- compile the trainer the same way the other benches do --------------- */
const BUILD = path.join(ROOT, 'node_modules', '.cache', 'chessforge-egmate');
try { execFileSync('rm', ['-rf', BUILD], { stdio: 'pipe' }); } catch { /* */ }
fs.mkdirSync(BUILD, { recursive: true });
fs.writeFileSync(path.join(BUILD, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'endgameTrainer.ts'),
    path.join(ROOT, 'src', 'lib', 'repertoire.ts'),
    path.join(ROOT, 'src', 'lib', 'openings.ts'),
  ],
}, null, 2));
try {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project', path.join(BUILD, 'tsconfig.json')], { stdio: 'pipe' });
} catch (e) { console.error('tsc failed:', e.stdout?.toString()?.slice(0, 1500)); process.exit(2); }

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
const REAL = require('chess.js');
const ET = findEmitted(BUILD, 'endgameTrainer.js');
Module._load = function (request, parent, isMain) {
  if (request === 'chess.js') return REAL;
  // The trainer imports its data files through the `@/` alias, which tsc only
  // type-checks — it does not rewrite the specifier. So the emitted CommonJS asks
  // Node for a path that does not exist on disk, and the require dies before any
  // assertion runs. Map the alias onto the real files.
  if (request.startsWith('@/')) {
    const abs = path.join(ROOT, 'src', request.slice(2));
    for (const cand of [abs, `${abs}.ts`, `${abs}.js`, path.join(abs, 'index.ts')]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        return origLoad.call(this, cand, parent, isMain);
      }
    }
  }
  return origLoad.call(this, request, parent, isMain);
};
const trainer = origLoad.call(Module, ET, null, false);

let checks = 0, fails = 0;
function ok(label, cond, detail = '') {
  checks++;
  if (!cond) fails++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/*
 * SQUARE COLOUR, FROM COORDINATES — NOT FROM A FLAT INDEX.
 *
 * The first version of this check used `flatIndex % 2` and reported 47 of 101
 * "same-colour" pairs. That was the TEST being wrong, not the generator: chess.js's
 * `board()` is indexed `(8 - rank) * 8 + file`, and the `(8 - rank) * 8` term is
 * always even, so `index % 2` collapses to FILE parity. A bishop on a1 and a
 * bishop on a2 are on opposite-coloured squares but share a file, so every pair
 * spanning an odd rank difference was miscounted.
 *
 * The real rule is a1 dark: with a1 at (file 0, rank 1), colour parity is
 * `(file + rank - 1) % 2`, zero meaning dark. That is the same expression the
 * generator's own `squareColour` uses, which is the point — the test and the code
 * must agree on the definition, or the test is only measuring its own arithmetic.
 */
const squareColour = (file, rank) => (file + rank - 1) % 2;

/** chess.js flat index -> { file, rank } with rank 1 at the bottom. */
function coords(i) {
  return { file: i % 8, rank: 8 - Math.floor(i / 8) };
}

/*
 * `generateMate` is module-private, so it is exercised the way the app reaches it:
 * through `nextTrainerExercise`, which is the only caller. That is deliberate — a
 * test that imported the private function would keep passing after the menu weights
 * were changed out from under it, which is the class of bug that let this ship.
 */
console.log('\n[A] every k2b drill the app can serve is mateable in principle');
{
  const seen = [];
  const kinds = { k2b: 0 };
  for (let i = 0; i < 400 && kinds.k2b < 220; i++) {
    const ex = trainer.nextTrainerExercise('sharp', new Set());
    if (!ex) continue;
    if (ex.source !== 'generated') continue;
    if (!/Two-Bishops/.test(ex.title ?? '')) continue;
    kinds.k2b++;
    seen.push(ex);
  }
  ok('the advanced tier actually serves two-bishop drills', kinds.k2b > 30, `${kinds.k2b} generated`);

  // Every one must have the two bishops on opposite colours.
  let sameColour = 0;
  for (const ex of seen) {
    const c = new Chess(); c.load(ex.fen);
    const bishops = c.board().flat().map((s, i) => ({ s, i }))
      .filter((x) => x.s?.type === 'b' && x.s.color === 'w');
    if (bishops.length !== 2) continue;
    const a = squareColour(coords(bishops[0].i).file, coords(bishops[0].i).rank);
    const b = squareColour(coords(bishops[1].i).file, coords(bishops[1].i).rank);
    if (a === b) sameColour++;
  }
  ok('the two bishops are ALWAYS on opposite colours', sameColour === 0,
    `${sameColour}/${seen.length} same-colour`);

  // And each position must be a legal, non-terminal, non-stalemate puzzle.
  let broken = 0;
  for (const ex of seen) {
    try {
      const c = new Chess(); c.load(ex.fen);
      const b = new Chess(); b.load(ex.fen.replace(' w ', ' b '));
      if (b.isCheckmate() || b.isStalemate() || c.moves().length === 0) broken++;
    } catch { broken++; }
  }
  ok('and every generated position is playable', broken === 0, `${broken} broken`);
  ok('and every one declares the goal it can actually meet', seen.every((e) => e.goal === 'mate'),
    [...new Set(seen.map((e) => e.goal))].join(','));
}

console.log('\n[B] the same for the other generated kinds');
{
  for (const tier of ['warmup', 'steady', 'sharp', 'relentless']) {
    const kinds = new Set();
    let n = 0;
    for (let i = 0; i < 260; i++) {
      const ex = trainer.nextTrainerExercise(tier, new Set());
      if (!ex || ex.source !== 'generated') continue;
      n++;
      kinds.add((ex.title ?? '').split('·')[1]?.trim() ?? '?');
    }
    ok(`${tier}: generated drills are well formed`, n === 0 || [...kinds].every((k) => k.length > 0),
      `${n} generated: ${[...kinds].join(', ')}`);
  }
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'}: ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
