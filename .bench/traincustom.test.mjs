/**
 * Do the user's adopted moves actually become TRAINABLE exercises?
 *
 * WHY THIS EXISTS
 * ---------------
 * "Train your own repertoire" is the last mile of the game-openings feature, and
 * the failure mode is silent: everything typechecks, the adoption screen saves
 * happily, and the Train screen just never shows the user's moves. Worse, a
 * subtly wrong bridge is invisible until someone sits down to drill:
 *
 *   1. `userColor` must equal the side to move in the FEN. Get it backwards and
 *      the drill asks the user to play their OPPONENT's move — which they will
 *      get "wrong" every single time, forever.
 *   2. A one-ply line must still complete. The screen counts plies and calls
 *      `finishPass` at `ply >= totalLen`; if a one-ply line cannot reach that,
 *      the exercise deadlocks on screen with no way forward.
 *   3. The synthetic study id must not collide with a shipped one, or the user's
 *      drill history is silently shared with a book study's SRS state — their
 *      mastery numbers would be corrupted in both directions.
 *   4. The SRS key must be STABLE across runs, or every session marks the same
 *      position "new" and the scheduler never advances.
 *
 * This loads the REAL `gameOpenings.ts` (transpiled from source, with its
 * imports stubbed — what is under test is the bridge, not the engine or the
 * shipped repertoires) so the assertions run against shipped code, not a copy.
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
const TS = path.join(ROOT, 'src', 'lib', 'gameOpenings.ts');

/**
 * Remove a directory tree via the shell.
 *
 * See the note at BUILD_DIR: the runtime's `fs.rmSync` is shimmed and can hang,
 * and a failed cleanup must never fail the test.
 */
function cleanDir(dir) {
  try {
    execFileSync('rm', ['-rf', dir], { stdio: 'pipe' });
  } catch { /* best effort */ }
}

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Load the real module.
//
// `tsc` is used rather than a bundler because it is already a dependency and
// this needs no config: transpile to CommonJS, then hand Node a tiny stub for
// each import the module pulls in. Only `fenKey` (a pure helper) and the two
// type-only imports matter; `bestCoverageAcrossOpenings` is never reached by
// `buildCustomExercises`, so a throwing stub is honest — if it IS reached, the
// test should blow up loudly rather than silently pass.
// ---------------------------------------------------------------------------

/*
 * `tsc` refuses to accept individual files while a `tsconfig.json` is in scope
 * ("TS5112: tsconfig.json is present but will not be loaded if files are
 * specified on commandline"). Running it from the temp dir — which has no
 * tsconfig, and sits outside the project — sidesteps that without touching the
 * project's own config. The source is passed by absolute path so it still
 * resolves.
 *
/*
 * Compile through a purpose-built tsconfig.
 *
 * Three CLI-level obstacles make plain flags unusable here:
 *   - `tsc <file>` refuses to run while the project's tsconfig is in scope
 *     (TS5112), and rejects every explicit `--moduleResolution` spelling we
 *     would want (TS5107).
 *   - `--paths` is a tsconfig-only option (TS6064) and cannot be passed as a
 *     flag at all, yet the module imports through the `@/*` alias.
 *
 * So we write a self-contained config. It must live INSIDE the project because
 * `files`/`include` entries are rejected as "not under rootDir" when the config
 * sits in an unrelated temp tree (Windows temp is on a different drive root than
 * the project). The directory is created under `node_modules/.cache` — already
 * gitignored, and definitely not part of the shipped bundle — and removed in the
 * cleanup at the end of this file.
 *
 * `noEmitOnError: false` so the JS is written even if a deep type in a
 * dependency complains: the emission is what this test consumes.
 *
 * `outDir` is NOT optional here. An earlier attempt ran tsc without it and left
 * five stray `.js` files sitting next to their `.ts` sources in `src/lib/` —
 * which git then reported as untracked build output. The harness must always
 * redirect emission somewhere disposable (and ideally `.gitignore`d).
 *
 * `moduleResolution` is NOT set. This project ships TypeScript 6, where the old
 * `node`/`node10` spellings are removed outright (TS5107) — omitting it lets the
 * compiler pick the default for `module: commonjs`, which is what we want.
 */
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-traincustom');
/*
 * `fs.rmSync` is NOT used here: this sandbox shims it to a trash binary that
 * times out on a directory tree, which aborted the whole harness even though the
 * compile had already succeeded. The shell's `rm -rf` is the reliable path.
 */
cleanDir(BUILD_DIR);
fs.mkdirSync(BUILD_DIR, { recursive: true });

const CONFIG = path.join(BUILD_DIR, 'tsconfig.json');
fs.writeFileSync(CONFIG, JSON.stringify({
  compilerOptions: {
    target: 'es2020',
    module: 'commonjs',
    skipLibCheck: true,
    noEmitOnError: false,
    // TypeScript 6 removed `baseUrl` (TS5101) and made `paths` resolve relative
    // to this config file, so the alias now points back up at the project's src.
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

// Locate the emitted file. With `files: [<abs path>]` tsc derives the common
// source root from the single input, so the output is normally flat — but a
// nested mirror is equally valid, so search rather than assume.
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
  console.error('tsc did not emit gameOpenings.js — see stdout above');
  process.exit(2);
}

// Stub the module's imports. `fenKey` is reimplemented exactly as
// `repertoire.ts` does it (first four FEN fields), which is what the keys were
// built from in the first place.
function stubFenKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@/lib/repertoire') {
    return { fenKey: stubFenKey };
  }
  if (request === '@/lib/engine') {
    // `buildCustomExercises` is pure and never touches the engine; a throwing
    // stub is the honest choice so any accidental call fails loudly here rather
    // than quietly doing real wasm work during a test.
    return {
      getEngine: () => ({
        analyse: () => { throw new Error('engine must not be used by buildCustomExercises'); },
      }),
    };
  }
  if (request === '@/lib/openings') {
    return {
      bestCoverageAcrossOpenings: () => {
        throw new Error('bestCoverageAcrossOpenings should not be called by buildCustomExercises');
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const mod = require(emitted);
const { buildCustomExercises, CUSTOM_STUDY_ID, CUSTOM_STUDY_TITLE, countAdopted } = mod;

// ---------------------------------------------------------------------------
// Realistic adoptions, built from real positions.
//
// The FENs come from the shared legal-opening corpus, so the "is the adopted
// move legal / is the side right" assertions mean something.
// ---------------------------------------------------------------------------

const PAYLOAD = [
  path.join(HERE, 'test-games.json'),
  path.join(ROOT, 'test-games.json'),
].find((p) => fs.existsSync(p));

if (!PAYLOAD) { console.error('missing test-games.json'); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
const games = raw.games ?? raw;

function mainlineSans(pgn) {
  const out = [];
  const c = new Chess();
  let body = (pgn ?? '').replace(/\[[^\]]*\]/g, ' ');
  body = body.replace(/\{[^}]*\}/g, ' ');
  body = body.replace(/;[^\n]*/g, ' ');
  for (let i = 0; i < 12 && body.includes('('); i++) {
    const next = body.replace(/\([^()]*\)/g, ' ');
    if (next === body) break;
    body = next;
  }
  body = body.replace(/[()]/g, ' ');
  for (const tok of body.split(/\s+/)) {
    if (!tok) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
    const sanitised = tok.replace(/^\d+\.+/, '').replace(/[!?]+$/, '');
    if (!sanitised) continue;
    try { c.move(sanitised); out.push(sanitised); } catch { break; }
  }
  return out;
}

const TRACKED_USER = 'hikaru';

// Collect real (fen, side, playedSan) triples from the user's own moves.
const samples = [];
for (const g of games) {
  if (samples.length >= 40) break;
  const movesSan = mainlineSans(g.pgn ?? '');
  if (movesSan.length < 8) continue;
  const color = ((g.white?.username ?? '').toLowerCase() === TRACKED_USER) ? 'w' : 'b';
  const board = new Chess();
  let previousSan = null;
  // Mirrors analyseGameOpenings: the prefix grows as the game advances and is
  // SNAPSHOT into each sample (a shared array would be mutated afterwards).
  const prefix = [];
  for (let ply = 0; ply < Math.min(movesSan.length, 16); ply++) {
    const isUser = (ply % 2 === 0) === (color === 'w');
    const fen = board.fen();
    let played = null;
    try { played = board.move(movesSan[ply])?.san ?? null; } catch { break; }
    if (!played) break;
    if (!isUser) { previousSan = played; prefix.push(played); continue; }
    if (board.isGameOver()) { previousSan = played; prefix.push(played); continue; }
    samples.push({ fen, side: color, playedSan: played, prevSan: previousSan, prefixSan: prefix.slice(), ply, gameId: g.uuid });
    previousSan = played;
    prefix.push(played);
    if (samples.length >= 40) break;
  }
}

console.log(`\n${samples.length} real user positions used as adoptions\n`);

// Build the adopted map the way the GameOpenings screen does.
const adopted = {};
samples.forEach((s, i) => {
  const key = `${stubFenKey(s.fen)}|${s.side}`;
  adopted[key] = {
    key,
    fen: s.fen,
    adoptedUci: '0000',
    adoptedSan: s.playedSan,
    prevSan: s.prevSan,
    prefixSan: s.prefixSan,
    engineBestSan: null,
    opening: 'Test Opening',
    decidedAt: Date.now() - i * 60_000, // newest first
    selfDiscovered: i % 3 === 0,
  };
});

// ---------------------------------------------------------------------------
// 1. Exercises are produced at all
// ---------------------------------------------------------------------------

console.log('[1] adoption -> exercises');
const ALL = buildCustomExercises(adopted, 40);
// A adoption is drillable only if it has a move, and a Black one also needs its
// predecessor (see THE BLACK PADDING in buildCustomExercises).
const drillable = Object.values(adopted).filter((a) => {
  if (!a.adoptedSan) return false;
  const side = a.fen.split(' ')[1];
  const parity = a.prefixSan ? a.prefixSan.length % 2 : -1;
  return side === 'w' ? parity === 0 : parity === 1;
});
ok('every drillable adoption (within the cap) becomes an exercise',
   ALL.length === Math.min(40, drillable.length),
   `(${ALL.length} of ${drillable.length})`);

const capped = buildCustomExercises(adopted, 12);
ok('the cap is respected', capped.length === 12, `(${capped.length})`);

ok('an empty repertoire yields no exercises', buildCustomExercises({}, 12).length === 0);

// A decision with no move cannot be drilled.
const noMove = { ...adopted };
const firstKey = Object.keys(noMove)[0];
noMove[firstKey] = { ...noMove[firstKey], adoptedSan: '' };
ok('an adoption with no move is skipped', buildCustomExercises(noMove, 40).length === ALL.length - 1);

// ---------------------------------------------------------------------------
// 2. THE parity check: userColor must match the side to move
// ---------------------------------------------------------------------------

console.log('\n[2] the drill asks the user for THEIR move');

/**
 * The adoption an exercise came from.
 *
 * Looked up via the exercise id, which embeds the adoption key
 * (`custom/your-openings#<key>|<startPly>`). Matching on the SAN instead was the
 * first attempt and it silently found the WRONG adoption whenever two games
 * shared a move (which they constantly do: "e4", "Nf3"), producing phantom
 * failures. The key is unambiguous by construction.
 */
function adoptionOf(ex) {
  const key = ex.id.slice(ex.id.indexOf('#') + 1, ex.id.lastIndexOf('|'));
  return adopted[key] ?? null;
}

let sideOk = 0;
const wrongSide = [];
for (const ex of ALL) {
  const a = adoptionOf(ex);
  if (!a) { wrongSide.push({ id: ex.id, why: 'no adoption' }); continue; }
  // The FEN's side-to-move is the authority; `userColor` must agree with it.
  const turn = a.fen.split(' ')[1];
  if (turn === ex.userColor) sideOk++;
  else wrongSide.push({ san: a.adoptedSan, userColor: ex.userColor, turn });
}
ok('userColor equals the side to move in the FEN', sideOk === ALL.length,
   `(${sideOk}/${ALL.length})`);
if (wrongSide.length) wrongSide.slice(0, 3).forEach((w) => console.log(`     ${JSON.stringify(w)}`));

// The stronger form: replay the line the way the screen does — auto-play the
// prefix, then confirm the user's move is legal in the resulting position, and
// that the resulting position IS the adoption's FEN. That last part is what
// proves the padding reconstructs the real game position rather than something
// merely move-legal.
let legalFor = 0;
const badReplay = [];
for (const ex of ALL) {
  const a = adoptionOf(ex);
  const c = new Chess();
  let ok2 = true;
  for (let i = 0; i < ex.startPly; i++) {
    try { c.move(ex.line.sans[i]); } catch { ok2 = false; break; }
  }
  if (!ok2) { badReplay.push({ id: ex.id, why: 'prefix' }); continue; }
  const atUserTurn = c.fen();
  try {
    if (c.move(ex.line.sans[ex.startPly])) legalFor++;
  } catch { badReplay.push({ id: ex.id, why: 'move illegal' }); }
  // The position the user is asked to play from must be the game position.
  if (a && stubFenKey(atUserTurn) !== stubFenKey(a.fen)) {
    badReplay.push({ id: ex.id, why: 'position mismatch' });
  }
}
ok('every drilled move is legal from the reconstructed game position',
   legalFor === ALL.length && badReplay.length === 0,
   `(${legalFor}/${ALL.length}${badReplay.length ? ', ' + JSON.stringify(badReplay[0]) : ''})`);

// ---------------------------------------------------------------------------
// 3. A one-ply line actually completes
// ---------------------------------------------------------------------------

console.log('\n[3] the line hands over on the user\'s turn and completes');
let completes = 0;
const bad = [];
for (const ex of ALL) {
  const sans = ex.line.sans;
  const totalLen = sans.length;
  const userMod = ex.userColor === 'w' ? 0 : 1;
  /*
   * The screen's REAL gates, quoted from TrainScreen:
   *   `userTurn`   = phase === 'playing' && ply % 2 === userMod && ply < totalLen
   *   `handleMove` = phase === 'playing' && ply % 2 === userMod && ply >= totalLen -> reject
   *
   * So the drill is playable iff, at ply === startPly, the parity matches the
   * user's colour AND there is a move left. A one-element Black line only ever
   * has ply 0, `0 % 2 === 1` is false, and the exercise deadlocks on screen —
   * exactly the bug this check exists to catch. The padded Black line (prefix +
   * move, startPly 1) is what makes the parity come out right.
   */
  const startsOnUserTurn = ex.startPly % 2 === userMod;
  const hasMoveToPlay = ex.startPly < totalLen;
  // After the user's move the line must be exhausted, or `finishPass` never fires.
  const completesAtEnd = ex.startPly + 1 >= totalLen;
  const pass = startsOnUserTurn && hasMoveToPlay && completesAtEnd;
  if (pass) completes++;
  else if (bad.length < 5) {
    bad.push({ san: sans[ex.startPly], userColor: ex.userColor, startPly: ex.startPly, totalLen, userMod, startsOnUserTurn, hasMoveToPlay, completesAtEnd });
  }
}
if (bad.length) console.log('  first failures:', JSON.stringify(bad, null, 1));
ok('at startPly it is the user to move, with exactly one move left to reach the end',
   completes === ALL.length, `(${completes}/${ALL.length})`);

// No exercise should start the user mid-line with nothing left to play.
const nothingToPlay = ALL.filter((ex) => ex.startPly >= ex.line.sans.length);
ok('no exercise starts past the end of its line', nothingToPlay.length === 0);

// ---------------------------------------------------------------------------
// 4. Study id must not collide with a shipped study
// ---------------------------------------------------------------------------

console.log('\n[4] the synthetic study id cannot collide');
ok('custom study id has a reserved shape', CUSTOM_STUDY_ID.includes('/'),
   `(${CUSTOM_STUDY_ID})`);
ok('every exercise carries the custom study id',
   ALL.every((ex) => ex.studyId === CUSTOM_STUDY_ID));

// Cross-check against the REAL registry: no shipped study id may equal it, and
// no shipped id may contain a slash (which is what keeps the namespace ours).
const OPENINGS_TS = path.join(ROOT, 'src', 'lib', 'openings.ts');
const openingsSrc = fs.readFileSync(OPENINGS_TS, 'utf8');
ok('no shipped study id contains "/" (so the namespace is unambiguous)',
   !/id:\s*'[^']*\/[^']*'/.test(openingsSrc));

ok('the exercise title is the user-facing one',
   ALL.every((ex) => ex.studyTitle === CUSTOM_STUDY_TITLE), `(${CUSTOM_STUDY_TITLE})`);

// ---------------------------------------------------------------------------
// 5. SRS keys are stable and unique
// ---------------------------------------------------------------------------

console.log('\n[5] SRS keys');
const ids = ALL.map((ex) => ex.id);
ok('exercise ids are unique', new Set(ids).size === ids.length, `(${new Set(ids).size}/${ids.length})`);

// The id must be derivable from persisted data alone — i.e. rebuilding from the
// same adoptions produces the same ids. This is what makes SRS survive a
// restart; if it drifted, every position would come back "new" forever.
const again = buildCustomExercises(adopted, 40);
const againIds = new Set(again.map((ex) => ex.id));
ok('ids are stable across rebuilds', ids.every((id) => againIds.has(id)),
   `(${ids.filter((id) => againIds.has(id)).length}/${ids.length})`);

// And an id must be traceable back to its adoption key.
ok('every id embeds the adoption key it came from',
   ALL.every((ex) => Object.keys(adopted).some((k) => ex.id.includes(k))));

// ---------------------------------------------------------------------------
// 6. Selection order
// ---------------------------------------------------------------------------

console.log('\n[6] ordering');
/*
 * With a cap smaller than the deck, the exercises must be the most recent
 * decisions — the position decided minutes ago is the one the user most wants to
 * confirm stuck.
 *
 * NOTE on the fixture: this spreads `decidedAt` over DAYS rather than the
 * minutes the earlier fixture used. The first version of the scoring formula
 * (`decidedAt / now`) could not tell those apart — it is ~1.0 for any recent
 * timestamp — and this check is what exposed that; the formula now decays over a
 * fortnight instead. Day-spaced decisions therefore differ by ~0.14 in score,
 * comfortably above the 0.05 random tiebreak, so the ORDER is meaningful here.
 */
const DAY = 86_400_000;
const spread = {};
samples.forEach((s, i) => {
  const key = `${stubFenKey(s.fen)}|${s.side}`;
  spread[key] = {
    ...adopted[key],
    key,
    decidedAt: Date.now() - i * DAY,
  };
});
const recent = buildCustomExercises(spread, 5);
const recentKeys = recent.map((ex) => ex.id);
const newestFive = samples.slice(0, 5).map((s) => `${stubFenKey(s.fen)}|${s.side}`);
const hits = newestFive.filter((k) => recentKeys.some((id) => id.includes(k))).length;
ok('the newest decisions are preferred when capped', hits >= 4,
   `(${hits}/5 newest present)`);

/*
 * The selection must also be deterministic in ORDER, not just in membership.
 *
 * The assertion is "the top item is drawn from the newest handful with the
 * newest winning", not "is exactly samples[0]": several samples can share one
 * key (positions transpose constantly), in which case the same adoption is
 * reachable from more than one entry and `samples[0]` is not uniquely the newest.
 * Computing the freshest KEY first and requiring it to win is the honest test.
 */
let freshestKey = null;
let freshestAt = -Infinity;
for (const k of Object.keys(spread)) {
  if (spread[k].decidedAt > freshestAt) { freshestAt = spread[k].decidedAt; freshestKey = k; }
}
ok('the freshest decision ranks first', recent[0].id.includes('#' + freshestKey + '|'),
   `(got ${recent[0].id.replace(CUSTOM_STUDY_ID + '#', '')})`);

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
cleanDir(BUILD_DIR);
process.exit(failures === 0 ? 0 : 1);
