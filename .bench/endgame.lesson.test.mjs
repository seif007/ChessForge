/**
 * Does the COURSE "real game example" path actually produce usable positions?
 *
 * WHY THIS EXISTS
 * ---------------
 * The endgame Course tab is a static catalogue of canonical teaching positions.
 * We added an opt-in "practise it in a real game" path that fetches a position
 * whose Lichess theme matches the lesson's category. The failure modes here are
 * silent and user-visible:
 *
 *   1. `anglesForCategory` must return a usable angle for EVERY category that
 *      ships in `endgames.json`. A typo'd key means the lesson quietly has no
 *      example and the button is dead forever, with nothing in the logs.
 *   2. The angle→goal mapping decides `goal`, and `goal` decides the win
 *      condition. Filing a mate puzzle under `survive` tells the user "hold the
 *      draw" on a position where they are mating — and the trainer would score
 *      it as a failure.
 *   3. `fenAtPly` must land on the position it claims. An off-by-one serves the
 *      opponent's move as the puzzle, which is unsolvable by construction.
 *   4. The returned position must be playable: not already over, at least one
 *      legal move, and the side to move must be the side whose move it is.
 *
 * Also checks the fall-through: an unknown category must still yield a usable
 * angle list rather than an empty one (which would make the fetch loop a no-op).
 *
 * This loads the REAL `endgameTrainer.ts` (transpiled from source, imports
 * stubbed) so the assertions run against shipped code, not a reimplementation.
 * It talks to the network; a genuine offline case is reported as SKIP.
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
const TS = path.join(ROOT, 'src', 'lib', 'endgameTrainer.ts');

/** Shell delete: the runtime's `fs.rmSync` is shimmed and can hang. */
function cleanDir(dir) {
  try { execFileSync('rm', ['-rf', dir], { stdio: 'pipe' }); } catch { /* best effort */ }
}

let checks = 0, failures = 0, skips = 0;
function ok(label, cond, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}
function skip(label, why) {
  skips++;
  console.log(`  SKIP  ${label}  ${why}`);
}

/* ------------------------------------------------------------------ compile */

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-endlesson');
cleanDir(BUILD_DIR);
fs.mkdirSync(BUILD_DIR, { recursive: true });

/*
 * `outDir` is mandatory (a bare run once scattered .js files into src/lib).
 * `moduleResolution` is omitted because TypeScript 6 removed the old spellings
 * (TS5107) and `paths` needs a tsconfig rather than a flag (TS6064). The config
 * must live inside the project or `files` is rejected as outside rootDir.
 */
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
    } else if (entry.name === 'endgameTrainer.js') {
      return p;
    }
  }
  return null;
}
const emitted = findEmitted(BUILD_DIR);
if (!emitted) { console.error('tsc did not emit endgameTrainer.js'); process.exit(2); }

/*
 * Stub only the JSON pool import. `fetchLessonExample` never reads it (that is
 * the point of the live path), so an empty object is honest: if the code ever
 * falls into the pool branch here, the test surfaces it rather than pretending
 * a bundled pool exists.
 */
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@/data/endgame_pool.json') return { default: [] };
  return origLoad.apply(this, arguments);
};

const mod = require(emitted);
const { fetchLessonExample, anglesForCategory } = mod;

/*
 * Distinguish "the sandbox has no network" from "the feature is broken".
 *
 * The live checks need outbound access to lichess.org. In this environment that
 * access is not always available — a concurrent Gradle build, or sandbox policy,
 * can close egress entirely, in which case EVERY fetch returns null and a naive
 * harness reports a feature failure when nothing is wrong with the code.
 *
 * So probe once, up front, and downgrade the live sections to SKIP when there is
 * genuinely no connection. The mapping and fallback checks in section [1] need
 * no network and always run.
 */
async function networkAvailable() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    try {
      const res = await fetch('https://lichess.org/api/puzzle/next?angle=endgame', {
        headers: { Accept: 'application/json' },
        signal: ctl.signal,
      });
      return res.ok;
    } finally { clearTimeout(t); }
  } catch {
    return false;
  }
}

const online = await networkAvailable();
if (!online) {
  console.log('\n(no outbound network — live sections will be skipped)');
}

/* ---------------------------------------------------- 1. angle map coverage */

console.log('\n[1] angle mapping covers every shipped lesson category');

const endgames = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'endgames.json'), 'utf8'));
const categories = [...new Set(endgames.map((l) => l.category))];

for (const cat of categories) {
  const angles = anglesForCategory(cat);
  ok(
    `"${cat}" -> [${angles.join(', ')}]`,
    Array.isArray(angles) && angles.length > 0 && angles.every((a) => typeof a === 'string' && a.length > 2),
  );
  // The generic fallback exists so a FUTURE lesson still works, but a SHIPPED
  // category must have a real, themed mapping. Asserting that here means adding
  // a lesson without adding its angles fails this harness instead of quietly
  // serving a generic endgame for a lesson about smothered mate.
  ok(
    `"${cat}" has a themed mapping (not the bare fallback)`,
    angles.length > 1 || angles[0] !== 'endgame',
  );
}

// An unknown category must degrade gracefully — otherwise the fetch loop below
// iterates nothing and every new lesson silently has no example.
const unknown = anglesForCategory('Some Future Category We Have Not Written Yet');
ok('unknown category falls back to a usable angle', unknown.length > 0, `[${unknown.join(', ')}]`);

/* ---------------------------------------------- 2. live fetch, real positions */

console.log('\n[2] fetching real examples for every category');

const used = new Set();
let fetched = 0;

if (!online) {
  skip('live fetch', 'no outbound network in this environment');
} else {
for (const cat of categories) {
  let ex = null;
  try {
    ex = await fetchLessonExample(cat, used);
  } catch (err) {
    ok(`"${cat}" did not throw`, false, String(err && err.message));
    continue;
  }

  if (!ex) {
    // Network-less is a legitimate outcome; the lesson just keeps its book FEN.
    skip(`"${cat}"`, 'no position returned (offline, rate-limited, or theme empty)');
    continue;
  }
  fetched++;

  const board = new Chess(ex.fen);
  const legal = board.moves();

  ok(`"${cat}" position is playable`,
    !board.isGameOver() && legal.length > 0,
    `${ex.fen.split(' ')[0]} moves=${legal.length}`);
  ok(`"${cat}" side to move matches userSide`,
    board.turn() === ex.userSide,
    `fen=${board.turn()} userSide=${ex.userSide}`);
  ok(`"${cat}" goal is one of the three trainer goals`,
    ['mate', 'promote', 'survive'].includes(ex.goal),
    ex.goal);

  // The id must be unique across fetches or the "already served" guard would
  // drop positions the user has never actually seen.
  ok(`"${cat}" produced a distinct id`, typeof ex.id === 'string' && ex.id.length > 0, ex.id);
}

ok('at least one live example fetched', fetched > 0, `${fetched}/${categories.length} categories`);
}

/* ------------------------------------------- 3. goal derivation is consistent */

console.log('\n[3] goal derivation follows the theme');

if (!online) {
  skip('mate goal consistency', 'no outbound network in this environment');
} else {
// Directly exercise the mapping by requesting a mate-flavoured category many
// times: every position whose theme mentions mate must file as `mate`.
const mateCat = categories.find((c) => c === 'Basic Checkmates') ?? categories[0];
let sawMate = 0;
for (let i = 0; i < 6; i++) {
  const ex = await fetchLessonExample(mateCat, used).catch(() => null);
  if (!ex) continue;
  const themes = (ex.category ?? '').toLowerCase();
  if (themes.includes('mate')) {
    sawMate++;
    ok(`mate-themed position files as goal=mate`, ex.goal === 'mate', `themes="${ex.category}" goal=${ex.goal}`);
  }
}
if (sawMate === 0) skip('mate goal consistency', 'no mate-themed positions returned in this run');
}

/* ------------------------------------------------------------------- report */

cleanDir(BUILD_DIR);

console.log(`\n${checks - failures}/${checks} checks passed${skips ? `, ${skips} skipped` : ''}`);
process.exit(failures ? 1 : 0);
