/**
 * IS THE "CHECKING OUR IDEAS HERE…" PASS FINITE?
 *
 * WHY THIS EXISTS
 * ---------------
 * The device report was *"i tried your openings and it took too much in
 * 'checking our ideas here' then i get stuck there i cant play any move"*. The
 * check is the family pass in `gameOpenings.ts`: up to 24 positions, one
 * depth-10 MultiPV-3 search each, plus a second probe search per position. The
 * host page used to IGNORE `movetime` whenever a depth was set, so every one of
 * those searches ran to completion — minutes on a phone — and nothing on the
 * screen could move until the whole pass ended.
 *
 * Three properties make the pass finite, and all three live in this module:
 *
 *   1. The caller's `movetime` must reach EVERY search, the main MultiPV one
 *      AND the played-move probe. Drop it in either place and the pass is
 *      unbounded again. The probe may use a SMALLER cap (`probeMovetime`) —
 *      it ranks nothing, so it does not need the main search's budget — but it
 *      must never fall back to running unbounded.
 *   2. A host that answers nothing must end the pass. `engine.analyse` returns
 *      null when its safety timer fires; three of those in a row means the
 *      WebView is not coming back, and the pass must stop asking rather than
 *      spend `3 × (movetime + 8s)` more on dead air.
 *   3. That counter must RESET after a real answer, or two early silences would
 *      poison the rest of a healthy pass.
 *
 * This drives the REAL `analyseFamily` (transpiled from source, engine stubbed)
 * because that is the exact call the screen makes — what is under test is the
 * plumbing, not the engine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TS = path.join(ROOT, 'src', 'lib', 'gameOpenings.ts');

/** Remove a directory tree via the shell (the runtime's fs.rmSync is shimmed and can hang). */
function cleanDir(dir) {
  try {
    execFileSync('rm', ['-rf', dir], { stdio: 'pipe' });
  } catch { /* best effort */ }
}

let checks = 0, failures = 0;
/**
 * `ok(cond, label, detail)` — condition FIRST in this file (the traincustom gate puts the label
 * first; both spellings exist in the suite and the call sites here are the authority).
 */
function ok(cond, label, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Load the real module through a purpose-built tsconfig, same shape as the
// traincustom gate: tsc rejects individual files while the project's tsconfig
// is in scope, `--paths` is tsconfig-only, and the output must be redirected to
// a disposable directory or it lands as stray .js files next to the sources.
// ---------------------------------------------------------------------------

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-gameopenings-cap');
cleanDir(BUILD_DIR);
fs.mkdirSync(BUILD_DIR, { recursive: true });

const CONFIG = path.join(BUILD_DIR, 'tsconfig.json');
fs.writeFileSync(CONFIG, JSON.stringify({
  compilerOptions: {
    target: 'es2020',
    module: 'commonjs',
    skipLibCheck: true,
    noEmitOnError: false,
    paths: { '@/*': ['../../../src/*'] },
    rootDir: ROOT,
    outDir: BUILD_DIR,
  },
  files: [TS],
}, null, 2));

execFileSync(process.execPath, [
  path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  '--project', CONFIG,
], { stdio: 'pipe' });

function findEmitted(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findEmitted(p);
      if (hit) return hit;
    } else if (entry.name === 'gameOpenings.js') {
      return p;
    }
  }
  return null;
}
const emitted = findEmitted(BUILD_DIR);
if (!emitted) {
  console.error('tsc did not emit gameOpenings.js');
  cleanDir(BUILD_DIR);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Stub the imports this module reads at runtime.
// ---------------------------------------------------------------------------

/*
 * The engine stub records EVERY request and answers from a script. `'info'`
 * returns a two-line MultiPV reply whose moves do NOT include the played move,
 * so the played-move probe fires for every position — one candidate position
 * therefore costs exactly two searches, and both of them must carry the cap.
 */
let calls = [];
let script = [];
const engineStub = {
  analyse: async (fen, opts = {}) => {
    calls.push({ fen, depth: opts.depth, multipv: opts.multipv, movetime: opts.movetime });
    const kind = script.length ? script.shift() : 'info';
    if (kind === 'throw') throw new Error('engine down');
    if (kind === 'silent') return null;
    return { lines: [{ uci: 'd2d4', scoreCp: 20 }, { uci: 'g1f3', scoreCp: 10 }] };
  },
};

const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@/lib/engine') {
    return { getEngine: () => engineStub };
  }
  if (request === '@/lib/repertoire') {
    return { fenKey: (fen) => fen.split(' ').slice(0, 4).join(' ') };
  }
  if (request === '@/lib/openings') {
    // Only the derive path uses these, and this gate always passes positions.
    const nope = () => { throw new Error('openings helpers must not be reached by analyseFamily'); };
    return { bestCoverageAcrossOpenings: nope, bestOpeningForLine: nope, bookHere: nope };
  }
  return origLoad.apply(this, arguments);
};

const mod = require(emitted);
const { analyseFamily } = mod;

// ---------------------------------------------------------------------------
// Fixtures: real positions (the start position), played move e4.
// ---------------------------------------------------------------------------

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function candsOf(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      key: 'k' + i,
      fen: START,
      ply: 0,
      side: 'w',
      game: { id: 'g' + i, url: 'https://example.invalid/' + i, opening: 'Test Opening' },
      playedSan: 'e4',
      playedUci: 'e2e4',
      inBook: true,
      bookSan: 'e4',
      bookReplies: ['e4'],
      prevSan: null,
      prefixSan: [],
      timesSeen: 1,
    });
  }
  return out;
}

const silent = (n) => Array(n).fill('silent');
const info = (n) => Array(n).fill('info');

// ---------------------------------------------------------------------------
// 1. The cap reaches every search — main AND probe.
// ---------------------------------------------------------------------------

console.log('\n[1] the family pass searches under the caller\'s time cap');
calls = []; script = [];
const res1 = await analyseFamily(candsOf(2), { depth: 10, multipv: 3, movetime: 777 });
ok(calls.length === 4,
   'two positions x (main search + played-move probe) = four searches',
   `(${calls.length})`);
ok(calls.length > 0 && calls.every((c) => c.movetime === 777),
   'EVERY search — the MultiPV one and the probe — carries the cap',
   calls.length ? JSON.stringify(calls[0]) : '(none)');
ok(calls.filter((c) => c.multipv === 3).length === 2
   && calls.filter((c) => c.multipv === 1).length === 2,
   'the main searches are MultiPV 3 and the probes are single-line');
ok(calls.every((c) => c.depth === 10),
   'and the depth travels with the cap — the host stops at whichever lands first');
ok(res1.length === 2,
   'both positions came back analysed', `(${res1.length})`);

// ---------------------------------------------------------------------------
// 1b. The probe can be given a smaller budget than the main search.
// ---------------------------------------------------------------------------

console.log('\n[1b] the played-move probe has its own, smaller budget');
calls = []; script = [];
const res1b = await analyseFamily(candsOf(2), {
  depth: 10, multipv: 3, movetime: 777, probeMovetime: 222,
});
ok(calls.length === 4,
   'still two searches per position — the cheaper probe does not skip the comparison',
   `(${calls.length})`);
ok(calls.filter((c) => c.multipv === 3).every((c) => c.movetime === 777),
   'the MultiPV search keeps the main cap');
ok(calls.filter((c) => c.multipv === 1).every((c) => c.movetime === 222),
   'the played-move probe uses the smaller cap instead of inheriting the main one',
   JSON.stringify(calls.filter((c) => c.multipv === 1)));
ok(res1b.length === 2,
   'and both positions still come back with their played move scored', `(${res1b.length})`);

// ---------------------------------------------------------------------------
// 2. No cap means the depth-only shape is untouched.
// ---------------------------------------------------------------------------

console.log('\n[2] without a cap the requests keep the depth-only shape');
calls = []; script = [];
await analyseFamily(candsOf(1), { depth: 10, multipv: 3 });
ok(calls.length === 2 && calls.every((c) => c.movetime === undefined),
   'an absent cap stays absent — the host search is depth-only exactly as before',
   calls.length ? JSON.stringify(calls[0]) : '(none)');

// ---------------------------------------------------------------------------
// 3. Three silent searches end the pass instead of grinding on.
// ---------------------------------------------------------------------------

console.log('\n[3] a host that answers nothing ends the pass after three tries');
calls = []; script = silent(10);
const res3 = await analyseFamily(candsOf(10), { depth: 10, multipv: 3, movetime: 777 });
ok(calls.length === 3,
   'the silent engine is asked exactly three times, then the pass stops',
   `(${calls.length} searches, not 10)`);
ok(res3.length === 0,
   'and the report comes back EMPTY — the screen can say so instead of hanging');

// ---------------------------------------------------------------------------
// 4. The silence counter resets after a real answer.
// ---------------------------------------------------------------------------

console.log('\n[4] an answer between silences resets the run');
/*
 * Two silent positions, then one that answers, then two more silent, then one
 * that answers. Without the reset the third silence (the fourth candidate)
 * would end a pass that is mostly healthy; with it, all six are searched.
 */
calls = []; script = ['silent', 'silent', ...info(2), 'silent', 'silent', ...info(2)];
const res4 = await analyseFamily(candsOf(6), { depth: 10, multipv: 3, movetime: 777 });
ok(calls.length === 8,
   'all six positions were searched (2 silent + 2 answering + 2 silent + 2 answering searches)',
   `(${calls.length})`);
ok(res4.length === 2,
   'and the two positions that answered came back', `(${res4.length})`);

// ---------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
cleanDir(BUILD_DIR);
process.exit(failures === 0 ? 0 : 1);
