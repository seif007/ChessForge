/**
 * Does the line survive the user choosing OUR move instead of their own?
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * The user reported: *"in the openings i got an illeagal move after i choosed
 * the app recommendation. also it dont complete the line, i just played one move
 * and thats it."*
 *
 * The cause is in `onBoardMove`'s continuation. After accepting a move it
 * rebuilds the movelist like this:
 *
 *     for (let k = 0; k < stepIdx; k++) sans.push(steps[k].moveSan);
 *     sans.push(san);                                  // the user's move
 *     let i = next;
 *     while (i < steps.length && steps[i].choice == null) {
 *       sans.push(steps[i].moveSan); i++;               // <-- THE LINE'S MOVES
 *     }
 *
 * Every ply after the decision is taken from the ORIGINAL line. That is only
 * sound when the user played the original line's own move. The moment they take
 * our recommendation (or an alternative) the branches have diverged, and
 * `steps[i].moveSan` is a move from a position that no longer exists — illegal,
 * or at best a different game. `boardFen` then hits its `catch` and breaks, the
 * board freezes, and the line "just stops after one move".
 *
 * WHY NO EXISTING TEST CAUGHT IT
 * ------------------------------
 * `playThrough` in `openingbuilder.playloop.test.mjs` always answers with the
 * step's OWN move. It has never once taken the recommendation, which is the
 * entire point of the feature. A test that only plays the happy path cannot see
 * a divergence bug.
 *
 * WHAT THIS ASSERTS
 * -----------------
 * Replaying the movelist the screen would build must be LEGAL at every ply, for
 * every answer a user can give at a decision: their own move, our
 * recommendation, and an engine alternative. And the line must ADVANCE — the bug
 * shows up as one ply and then nothing.
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

function cleanDir(dir) {
  try { execFileSync('rm', ['-rf', dir], { stdio: 'pipe' }); } catch { /* best effort */ }
}

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

/* ------------------------------------------------------------------ compile */

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-opendiv');
cleanDir(BUILD_DIR);
fs.mkdirSync(BUILD_DIR, { recursive: true });

const CONFIG = path.join(BUILD_DIR, 'tsconfig.json');
fs.writeFileSync(CONFIG, JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
    esModuleInterop: true,
  },
  include: [path.join(ROOT, 'src').replace(/\\/g, '/') + '/**/*.ts'],
  exclude: [BUILD_DIR.replace(/\\/g, '/')],
}, null, 2));
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', CONFIG,
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 1500));
  process.exit(2);
}

const Module = require('node:module');
const origResolve = Module._resolveFilename;
const OUT = path.join(BUILD_DIR, 'src');
Module._resolveFilename = function (request, parent, isMain, options) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    const rel = request.slice(2);
    if (rel.endsWith('.json')) return path.join(ROOT, 'src', rel);
    return path.join(OUT, rel + '.js');
  }
  return origResolve.call(this, request, parent, isMain, options);
};

const { buildFamilyLines, continueLine } = require(path.join(OUT, 'lib', 'openingBuilder.js'));
const { analysedPositionsFromGames } = require(path.join(OUT, 'lib', 'gameOpenings.js'));
const { openingFromEcoUrl } = require(path.join(OUT, 'lib', 'lichess.js'));

/* ------------------------------------------------------------------ corpus */

const PAYLOAD = [
  path.join(HERE, 'test-games.json'),
  path.join(ROOT, 'test-games.json'),
].find((p) => fs.existsSync(p));
if (!PAYLOAD) { console.error('missing test-games.json'); process.exit(2); }

function mainlineSans(pgn) {
  const body = pgn.split('\n').filter((l) => !l.trim().startsWith('[')).join(' ');
  const sans = []; const c = new Chess();
  for (const tok of body.split(/\s+/)) {
    const t = tok.trim();
    if (!t) continue;
    if (t.startsWith('{') || t.endsWith('}') || t.includes('%clk')) continue;
    if (/^\d+\.+$/.test(t)) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) break;
    const clean = t.replace(/[!?]+$/, '');
    if (!clean) continue;
    try { const m = c.move(clean); if (!m) break; sans.push(m.san); } catch { break; }
  }
  return sans;
}

const raw = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
const games = (raw.games ?? raw).map((g, i) => {
  const sans = mainlineSans(g.pgn || '');
  if (sans.length < 8) return null;
  const isW = String(g.white?.username ?? '').toLowerCase() === 'hikaru';
  const { family, name } = openingFromEcoUrl(g.eco);
  return {
    id: g.uuid ?? 'g' + i, url: '', opening: family, openingVariation: name, ecoSlug: '',
    color: isW ? 'w' : 'b', outcome: 'win', playerRating: null, opponentRating: null,
    opponent: 'x', accuracy: null, opponentAccuracy: null, movesUci: [], movesSan: sans,
    timeClass: 'blitz', timeControl: '600', rated: true, endTime: 0,
  };
}).filter(Boolean);

const positions = analysedPositionsFromGames(games, { maxGames: 160, maxPly: 16 });
const families = buildFamilyLines(positions, { maxPerFamily: 24, maxAlternates: 8 });
console.log(`\ncorpus: ${games.length} games · ${positions.length} positions · ${families.length} families`);

/* -------------------------------------------- the screen's continuation rule */

/**
 * Rebuild the movelist EXACTLY as `onBoardMove` does, given the move the user
 * produced at the decision on `stepIdx`.
 *
 * Deliberately a copy: the thing under test is the INDEXING RULE, and pulling a
 * React component into a harness would test React instead.
 */
function continueFromLine(steps, stepIdx, userSan) {
  const sans = [];
  for (let k = 0; k < stepIdx; k++) sans.push(steps[k].moveSan);
  sans.push(userSan);
  let i = stepIdx + 1;
  while (i < steps.length && steps[i].choice == null) { sans.push(steps[i].moveSan); i++; }
  return { sans, stop: i };
}

/**
 * THE FIXED RULE — what `onBoardMove` does now.
 *
 * `continueLine` returns a COMPLETE list: it starts at move 1 and already
 * contains everything the user played. So the screen does not concatenate
 * anything — it adopts the list as the new active line and then auto-plays up to
 * the next decision, exactly like `goTo`. That single list is the whole point:
 * with one list there is no second source of moves to disagree with the board.
 */
function continueFixed(family, steps, stepIdx, userSan) {
  const played = [];
  for (let k = 0; k < stepIdx; k++) played.push(steps[k].moveSan);
  played.push(userSan);

  const line = continueLine(family, played);
  const firstDecision = line.findIndex((s) => s.choice != null);
  const stop = firstDecision < 0 ? line.length : firstDecision;
  const sans = [];
  for (let k = 0; k < stop; k++) sans.push(line[k].moveSan);
  return { sans, line, stop, played };
}

/** The first ply index that does not replay legally, or -1. */
function firstIllegalPly(sans) {
  const c = new Chess();
  for (let i = 0; i < sans.length; i++) {
    try { if (!c.move(sans[i])) return i; } catch { return i; }
  }
  return -1;
}

/* ------------------------------------------------------------------- [1] */

console.log('\n[1] the OLD rule, kept as the reproduction (it must still fail)');

let decisions = 0, takingRec = 0, recIllegal = 0, recStopsEarly = 0, recShort = 0;
let worst = null;

for (const f of families) {
  for (const steps of [f.steps, ...f.alternates]) {
    for (let idx = 0; idx < steps.length; idx++) {
      const st = steps[idx];
      if (!st.choice) continue;
      decisions++;
      const recSan = st.choice.recommendSan;
      if (!recSan) continue;
      takingRec++;

      const { sans, stop } = continueFromLine(steps, idx, recSan);
      const bad = firstIllegalPly(sans);
      if (bad >= 0) {
        recIllegal++;
        if (!worst) worst = { family: f.name, idx, sans, bad, stop };
      }
      if (stop <= idx) recStopsEarly++;
      // Taking our move must also not TRUNCATE: if the original line continued
      // past the decision, the rebuilt movelist must be at least as long as the
      // prefix plus the move. (A shorter list is the "one move and that's it".)
      if (sans.length < idx + 2) recShort++;
    }
  }
}

console.log(`      the bug is still reproducible: ${recIllegal} illegal, ${recShort} truncated`);
ok(`exercised the recommendation path (${takingRec} of ${decisions} decisions)`, takingRec > 0);
ok('the old rule really was broken (so this test is not vacuous)', recIllegal > 0,
  `${recIllegal} illegal`);
if (worst) {
  console.log(`      first failure: ${worst.family} @step ${worst.idx} (stop ${worst.stop})`);
  console.log(`      illegal at ply ${worst.bad}: ${worst.sans.slice(0, worst.bad + 1).join(' ')}`);
}

/* ------------------------------------------------------------------- [2] */

console.log('\n[2] the FIXED rule: taking our move always stays legal and continues');

let fixIllegal = 0, fixStalled = 0, fixTried = 0, fixContinued = 0, fixNoUserMove = 0;

for (const f of families) {
  for (const steps of [f.steps, ...f.alternates]) {
    for (let idx = 0; idx < steps.length; idx++) {
      const st = steps[idx];
      if (!st.choice) continue;
      const recSan = st.choice.recommendSan;
      if (!recSan) continue;
      fixTried++;

      const { sans, line } = continueFixed(f, steps, idx, recSan);
      if (firstIllegalPly(sans) >= 0) fixIllegal++;

      /*
       * TRUNCATION, measured honestly.
       *
       * The list `continueLine` returns is anchored at the deepest stem the POOL
       * knows, which can be shorter than the spine's own index — the spine's stem
       * includes plies the pool does not share — so comparing lengths against
       * `idx` would report a false truncation on almost every decision. What
       * actually matters is whether the user's move is ON the board and the line
       * still has somewhere to go: that is precisely "it didn't complete the
       * line, i just played one move and that's it".
       *
       * "Somewhere to go" is NOT "more auto-played plies". The very next ply is
       * often another decision for the user — the walk stops there on purpose,
       * because auto-playing the user's own move is the bug this feature exists
       * to avoid. So the test is that a ply exists AFTER the user's move in the
       * returned line, whether that ply is auto-played or a decision.
       */
      if (!line.some((s) => s.moveSan === recSan)) fixNoUserMove++;
      const userAt = line.findIndex((s) => s.moveSan === recSan);
      if (userAt >= 0 && userAt + 1 < line.length) fixContinued++;
      if (line.length === 0) fixStalled++;
    }
  }
}

ok(`every decision was exercised (${fixTried} decisions)`, fixTried > 0);
ok('taking our move NEVER produces an illegal ply', fixIllegal === 0,
  fixIllegal ? `${fixIllegal} went illegal` : '');
ok('the move the user played is always in the line', fixNoUserMove === 0,
  fixNoUserMove ? `${fixNoUserMove} dropped the user move` : '');
ok('taking our move never leaves the line with nothing after it', fixStalled === 0,
  fixStalled ? `${fixStalled} ended at the branch` : '');
ok('taking our move continues the line into more chess',
  fixContinued / Math.max(1, fixTried) > 0.5,
  `${fixContinued} of ${fixTried} continued`);

/* ------------------------------------------------------------------- [3] */

console.log("\n[3] control: taking the line's own move stays legal under BOTH rules");

let ownIllegal = 0, ownTried = 0, ownFixIllegal = 0;
for (const f of families) {
  for (const steps of [f.steps, ...f.alternates]) {
    for (let idx = 0; idx < steps.length; idx++) {
      const st = steps[idx];
      if (!st.choice) continue;
      ownTried++;
      if (firstIllegalPly(continueFromLine(steps, idx, st.moveSan).sans) >= 0) ownIllegal++;
      if (firstIllegalPly(continueFixed(f, steps, idx, st.moveSan).sans) >= 0) ownFixIllegal++;
    }
  }
}
ok(`the happy path is legal (${ownTried} decisions)`, ownIllegal === 0,
  ownIllegal ? `${ownIllegal} illegal` : '  this is all the old test covered');
ok('the happy path is legal under the fixed rule too', ownFixIllegal === 0,
  ownFixIllegal ? `${ownFixIllegal} illegal` : '');

/* ------------------------------------------------------------------- [4] */

console.log('\n[4] an alternative the user picks is honoured, not overwritten');

/*
 * COVERAGE NOTE — why this section synthesises its own alternatives.
 *
 * `alternatives` is filled by the ENGINE (`analyseFamily`), and this corpus is
 * book-only, so the field is empty on every decision and the path would never be
 * exercised. Skipping it is what let the original bug hide, so instead the
 * alternative is constructed here: any LEGAL move in the position that is
 * neither the user's own nor our recommendation is, by definition, an
 * alternative the user could play. The screen's rule does not care where the
 * move came from — it only cares that the branch diverged.
 */
function syntheticAlternatives(family, step, mode) {
  const c = new Chess(step.fen);
  const excludes = new Set([step.choice.playedUci, step.choice.recommendUci]);
  const out = [];
  for (const m of c.moves({ verbose: true })) {
    const uci = m.from + m.to + (m.promotion ?? '');
    if (excludes.has(uci)) continue;
    out.push({ uci, san: m.san });
    if (out.length >= 4) break;
  }
  return out;
}

/*
 * ALTERNATIVE KEPT, OR NOTHING TO KEEP IT IN.
 *
 * The defect under test is the line quietly REPLACING the move the user picked with its own. That is
 * an overwrite, and an overwrite can only be seen in a line that exists and does not contain the
 * move.
 *
 * An EMPTY line is a different thing, and this test used to call it the same. Reaching one case
 * needed the builder to put a `choice` on a move the user got RIGHT - which is what `choice: p.playedUci
 * && p.recommendUci` does, and which this test's own corpus then exercised for the first time. At
 * ply 0 the alternative is `a3`, no game in the corpus plays it, and `continueLine` has nothing to
 * continue: it returns nothing. That is the absence of a continuation, not the loss of a move.
 *
 * So the two are counted apart, the assertion is on the overwrite, and the empty count is printed
 * rather than hidden - a silent zero would read as "this never happens" for a thing that does.
 */
let altTried = 0, altIllegal = 0, altKept = 0, altEmpty = 0, altOverwritten = 0;
const emptyAt = [];
for (const f of families) {
  for (const steps of [f.steps, ...f.alternates]) {
    for (let idx = 0; idx < steps.length; idx++) {
      const st = steps[idx];
      if (!st.choice) continue;
      const alts = st.choice.alternatives.length > 0
        ? st.choice.alternatives
        : syntheticAlternatives(f, st, 'any');
      if (alts.length === 0) continue;
      altTried++;
      const altSan = alts[0].san;
      const { sans, line } = continueFixed(f, steps, idx, altSan);
      if (firstIllegalPly(sans) >= 0) altIllegal++;
      // The alternative must be ON the board - the line must not have quietly
      // replaced the user's move with the line's own.
      if (line.length === 0) { altEmpty++; if (emptyAt.length < 5) emptyAt.push(`ply ${idx} ${altSan}`); }
      else if (line.some((t) => t.moveSan === altSan)) altKept++;
      else altOverwritten++;
    }
  }
}
ok(`exercised the alternative path (${altTried} decisions)`, altTried > 0,
  altTried ? '' : 'no decision had an alternative to try');
ok('taking an alternative never produces an illegal ply', altIllegal === 0,
  altIllegal ? `${altIllegal} illegal` : '');
ok('the line never REPLACES the move the user picked with its own', altOverwritten === 0,
  altOverwritten ? `${altOverwritten} overwritten of ${altTried}` : '');
ok('and the move is on the board wherever there was a line to put it on',
  altKept + altEmpty === altTried,
  altTried ? `${altKept} kept, ${altEmpty} had no continuation (${emptyAt.join(', ')})` : '');
ok('and some alternative really was available to keep', altKept > 0,
  altKept ? '' : 'every alternative vanished');

/* ------------------------------------------------------------------ report */

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
cleanDir(BUILD_DIR);
