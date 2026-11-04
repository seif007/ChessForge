/**
 * Does the play loop actually walk a line, and does it STOP where it must?
 *
 * WHY THIS EXISTS
 * ---------------
 * The opening builder's whole promise is a sequence:
 *
 *   "you have to complete the line with him before passing to the next opening"
 *   "whenever you can suggest him to choose the app suggests to him else just
 *    show him the move"
 *
 * That is a state machine over `BuilderStep[]`, and the two ways it silently
 * breaks are opposite each other:
 *
 *   1. **It runs past a decision.** An auto-advance that does not stop on a
 *      `choice` step plays the user's move FOR them and the line finishes
 *      without them ever being asked — the feature looks like it works (the line
 *      completes!) while doing none of the teaching.
 *   2. **It stalls on a non-decision.** Auto-advancing only past steps the user
 *      already confirmed leaves the board waiting forever at a move that has no
 *      question in it.
 *
 * So the walk is reimplemented here EXACTLY as `GameOpeningsScreen.goTo` does it,
 * and asserted against the real family lines from the corpus. It is a deliberate
 * copy: the alternative is a React renderer in a harness, and the thing worth
 * testing is the indexing rule, not React.
 *
 * The rule under test, in one sentence: starting at index `k`, append every
 * successive step whose `choice` is null, and stop at the first step that has
 * one.
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

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-openplay');
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
  /*
   * Compile the WHOLE lib tree, not three files.
   *
   * The earlier version compiled only `openingBuilder`/`gameOpenings`/`lichess`
   * and STUBBED `@/lib/openings` to `bestCoverageAcrossOpenings: () => null`.
   * That stub is what made this harness report 6/163 and, worse, report it for
   * the wrong reason: with no book, `recommendUci` falls back to the user's own
   * move, so NO step ever has a choice and every play-through failed on its
   * first step. The verdict said "the play loop is broken" when the play loop
   * had never been given anything to ask about.
   *
   * Compiling the real tree removes the need to stub the two modules that
   * matter, so the harness now measures the shipped matcher.
   */
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

/*
 * Resolve `@/` to the emitted tree -- to the ORIGINAL for anything tsc does not
 * emit (the `src/data/*.json` repertoires), and to the compiled output for code.
 *
 * A `Module._load` override was used before, which required pre-loading every
 * emitted sibling in exactly the right order and broke if the order changed.
 * Replacing `_resolveFilename` instead is order-independent and lets the whole
 * tree be loaded by the ordinary loader -- including `@/lib/openings` and
 * `@/lib/repertoire`, which is the point of compiling everything.
 */
const OUT = path.join(BUILD_DIR, 'src');
Module._resolveFilename = function (request, parent, isMain, options) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    const rel = request.slice(2);
    if (rel.endsWith('.json')) return path.join(ROOT, 'src', rel);
    return path.join(OUT, rel + '.js');
  }
  return origResolve.call(this, request, parent, isMain, options);
};

const { buildFamilyLines } = require(path.join(OUT, 'lib', 'openingBuilder.js'));
const { analysedPositionsFromGames } = require(path.join(OUT, 'lib', 'gameOpenings.js'));
const { openingFromEcoUrl } = require(path.join(OUT, 'lib', 'lichess.js'));
const { OPENINGS } = require(path.join(OUT, 'lib', 'openings.js'));

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
    // Lichess's `{[%clk ...]}` comments split across whitespace.
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

/* ------------------------------------------------- the walk, copied from the UI */

/**
 * Mirror of `GameOpeningsScreen.goTo` + the auto-advance inside `onBoardMove`.
 *
 * Returns the ply list that would be replayed and the index the board stops on.
 * The board stops on the first step with a `choice`, or at `steps.length` when
 * the line runs out.
 */
function walk(steps, from) {
  const sans = [];
  for (let k = 0; k < from; k++) sans.push(steps[k].moveSan);
  let i = from;
  while (i < steps.length && steps[i].choice == null) { sans.push(steps[i].moveSan); i++; }
  return { sans, stop: i };
}

/** Everything a person could reasonably do here, as a driver. */
function playThrough(steps) {
  const decisionsAsked = [];

  /*
   * Start at the FIRST decision, and note that "no decision at all" is a
   * legitimate line, not an error.
   *
   * The bug this replaces: `Math.max(0, steps.findIndex(...))`. `findIndex`
   * returns -1 when a line has no decisions -- and `Math.max(0, -1)` is 0, so
   * the cursor was forced to index 0 and the loop then evaluated `steps[0]`,
   * found `choice == null`, and reported "stopped on a non-decision step at
   * index 0" for a line that was simply done. The `if (cursor < 0)` guard was
   * written AFTER the coercion, so it could never fire. 156 of 163 checks
   * failed on this one line.
   */
  const first = steps.findIndex((s) => s.choice != null);
  let cursor = first < 0 ? steps.length : first;
  let guard = 0;

  while (cursor < steps.length && guard++ < 200) {
    const st = steps[cursor];
    if (st.choice == null) {
      // The walk should never leave us on a non-decision step.
      return { error: `stopped on a non-decision step at index ${cursor}`, decisionsAsked };
    }
    decisionsAsked.push(cursor);
    // The user answers with one of the moves on offer, then we advance from the
    // NEXT index — the answer itself occupies `cursor`.
    const after = walk(steps, cursor + 1);
    void after;
    cursor = after.stop;
  }
  return { error: null, decisionsAsked };
}

/* ------------------------------------------------------------ [1] the walk stops */

console.log('\n[1] the walk stops at every decision and at nothing else');

let ranPast = 0, stalled = 0, tested = 0;
for (const f of families) {
  for (const steps of [f.steps, ...f.alternates]) {
    if (steps.length === 0) continue;
    tested++;
    const first = steps.findIndex((s) => s.choice != null);
    const start = first < 0 ? steps.length : first;
    const w = walk(steps, start);

    // 1. It must not run PAST a decision: the stop index either has a choice or
    //    is the end of the line.
    if (w.stop < steps.length && steps[w.stop].choice == null) ranPast++;
    // 2. It must not stop BEFORE the first decision when one exists.
    if (first >= 0 && w.stop > first) ranPast++;
    // 3. It must never stall: the stop index must be reachable and the sans list
    //    must match exactly the steps before it.
    if (w.sans.length !== w.stop) stalled++;
    for (let i = 0; i < w.sans.length; i++) {
      if (w.sans[i] !== steps[i].moveSan) { stalled++; break; }
    }
  }
}
ok(`checked ${tested} lines`, tested > 0);
ok('the walk never runs past a decision', ranPast === 0, ranPast ? `${ranPast} overruns` : '');
ok('the walk never stalls or mis-indexes', stalled === 0, stalled ? `${stalled} stalls` : '');

/*
 * ...and a line must actually BE a line.
 *
 * Every assertion above passes on a one-ply line, and that is exactly how a
 * real defect hid here: a strict-prefix match stopped the walk after one ply
 * while all seven checks stayed green. Depth is therefore asserted directly --
 * a family line that teaches an opening has to reach the middlegame-ish plies
 * the user's own games reached.
 */
const depths = families.flatMap((f) => [f.steps, ...f.alternates]).filter((s) => s.length > 0).map((s) => s.length);
const avgDepth = depths.reduce((a, b) => a + b, 0) / Math.max(1, depths.length);
const deep = depths.filter((d) => d >= 10).length;
ok(`lines reach a useful depth (avg ${avgDepth.toFixed(1)} plies)`, avgDepth >= 8,
  `avg ${avgDepth.toFixed(1)} plies`);
ok(`most lines are deep (${deep}/${depths.length} at >= 10 plies)`, deep >= depths.length * 0.5,
  `${deep}/${depths.length}`);

/*
 * ...and the questions must not depend on the engine.
 *
 * The whole feature has to work BEFORE a search runs: the family list is built
 * engine-free and the user starts playing immediately. If the only decisions
 * came from engine verdicts, the first line they opened would be a silent
 * walk-through. Every choice on the reference corpus must therefore come from
 * the shipped book -- the ratio is asserted, not just the existence, so a future
 * change that quietly makes the engine load-bearing fails here.
 */
const allChoices = families.flatMap((f) => [f.steps, ...f.alternates].flat()).filter((s) => s.choice != null);
const bookChoices = allChoices.filter((s) => s.choice.inBook).length;
ok(`decisions come from the book, not the engine (${bookChoices}/${allChoices.length})`,
  allChoices.length > 0 && bookChoices / allChoices.length >= 0.5,
  `${bookChoices} book / ${allChoices.length} total`);

/* --------------------------------------------------- [2] full play-through works */

console.log('\n[2] a line can be played to its end, asking at each decision');

let bad = 0, totalAsked = 0, completed = 0;
for (const f of families) {
  for (const steps of [f.steps, ...f.alternates]) {
    if (steps.length === 0) continue;
    const r = playThrough(steps);
    if (r.error) { bad++; ok(`play-through: ${f.name}`, false, r.error); continue; }
    totalAsked += r.decisionsAsked.length;
    completed++;
    // The number of questions asked must equal the number of decisions in the
    // line — one prompt per divergence, no more and no fewer.
    const declared = steps.filter((s) => s.choice != null).length;
    if (r.decisionsAsked.length !== declared) {
      bad++;
      ok(`decision count: ${f.name}`, false, `asked ${r.decisionsAsked.length} vs ${declared} declared`);
    }
    // Every asked index must really be a choice, and they must be in order.
    for (let i = 1; i < r.decisionsAsked.length; i++) {
      if (r.decisionsAsked[i] <= r.decisionsAsked[i - 1]) {
        bad++; ok(`decision order: ${f.name}`, false, 'not increasing'); break;
      }
    }
  }
}
ok(`every line completes (${completed} lines, ${totalAsked} questions asked)`, bad === 0,
  bad ? `${bad} bad` : '');

/* -------------------------------------------------- [3] no question when there is none */

console.log('\n[3] a move with no alternative is never a question');

/*
 * The forced-divergence positions from the other harness: half agree with our
 * recommendation, half do not. The agreeing half must be SILENT (no choice), the
 * disagreeing half must ASK. If this inverts, the app nags the user about moves
 * where there is nothing to decide.
 */
const forced = positions.map((p, i) => ({
  ...p,
  recommendUci: i % 2 === 0 ? 'zzzz' : p.playedUci,
  recommendSan: i % 2 === 0 ? 'zz' : p.playedSan,
  options: [],
}));
const forcedFams = buildFamilyLines(forced, { maxPerFamily: 24, maxAlternates: 8 });
let askedOnAgreement = 0, silentOnDivergence = 0, agreed = 0, diverged = 0;
for (const f of forcedFams) {
  for (const st of [f.steps, ...f.alternates].flat()) {
    const p = st.position;
    if (!p || !st.isUserMove) continue;
    const agrees = p.recommendUci === p.playedUci;
    if (agrees) {
      agreed++;
      if (st.choice != null) askedOnAgreement++;
    } else {
      diverged++;
      if (st.choice == null) silentOnDivergence++;
    }
  }
}
ok(`agreement is silent (${agreed} agreeing positions)`, askedOnAgreement === 0,
  askedOnAgreement ? `${askedOnAgreement} asked` : '');
ok(`divergence asks (${diverged} diverging positions)`, silentOnDivergence === 0,
  silentOnDivergence ? `${silentOnDivergence} silent` : '');

/* ------------------------------------------------- [4] the board matches the line */

console.log('\n[4] replaying what the walk produced reproduces each step position');

let mismatch = 0, replayed = 0;
for (const f of families) {
  for (const steps of [f.steps, ...f.alternates]) {
    const c = new Chess();
    for (const st of steps) {
      const want = st.fen.split(' ').slice(0, 4).join(' ');
      const have = c.fen().split(' ').slice(0, 4).join(' ');
      if (want !== have) { mismatch++; break; }
      try { c.move(st.moveSan); } catch { mismatch++; break; }
      replayed++;
    }
  }
}
ok(`every step's FEN is what the moves produce (${replayed} plies)`, mismatch === 0,
  mismatch ? `${mismatch} mismatched` : '');

/* ------------------------------------------- [5] the annotation is complete */

console.log('\n[5] every decision carries two drawable arrows and an honest eval');

/*
 * What this pins, and why it is a separate section.
 *
 * The request was "shows him the position + an arrow what he played + an arrow
 * what we recommend (+ a msg ... + alternative choices + engine differences)",
 * and then, seeing a "Show" button in an earlier build, "dont keep anything
 * that says you have to activate the arrows ... because this is a course so no
 * you just show the arrows".
 *
 * So the contract is that the DATA for the annotation is present unconditionally
 * on any decision step — not that the screen happens to render it. If a future
 * change makes `choice.playedUci` null, or points an arrow at an illegal move,
 * the screen would silently draw one arrow or none and still look plausible.
 * That is the failure mode this section exists to catch.
 */

let decisions = 0;
let missingPlayed = 0, missingRec = 0, sameUci = 0, illegalArrow = 0, noWhy = 0;
let scoredOptions = 0, unscoredOptions = 0, badLoss = 0;

for (const f of families) {
  for (const steps of [f.steps, ...f.alternates]) {
    for (const st of steps) {
      if (!st.choice) continue;
      decisions++;

      const { playedUci, recommendUci, why, alternatives } = st.choice;
      if (!playedUci) missingPlayed++;
      if (!recommendUci) missingRec++;
      // A choice only EXISTS when the two differ (that is `stepFor`'s rule), so
      // a decision whose arrows coincide would be one arrow drawn twice.
      if (playedUci && recommendUci && playedUci === recommendUci) sameUci++;
      if (!why || !why.trim()) noWhy++;

      // Both arrow endpoints must be LEGAL in the step's own position. An arrow
      // to an illegal square is worse than no arrow: it teaches a wrong move.
      for (const uci of [playedUci, recommendUci]) {
        if (!uci) continue;
        let legal = false;
        try {
          const c = new Chess(st.fen);
          legal = c.move({
            from: uci.slice(0, 2), to: uci.slice(2, 4),
            promotion: uci.length > 4 ? uci[4] : undefined,
          }) != null;
        } catch { legal = false; }
        if (!legal) illegalArrow++;
      }

      // The engine differences shown next to the alternatives. `NaN` is allowed
      // and means "we did not search this move" — what must NOT happen is a
      // negative or non-monotone loss, which would read as a bug to a player.
      for (const o of alternatives) {
        if (Number.isFinite(o.lossCp)) {
          scoredOptions++;
          if (o.lossCp < 0) badLoss++;
        } else {
          unscoredOptions++;
        }
      }
    }
  }
}

ok(`every decision can draw both arrows (${decisions} decisions)`,
  decisions > 0 && missingPlayed === 0 && missingRec === 0,
  `missing played=${missingPlayed} recommend=${missingRec}`);
ok(`the two arrows never point at the same move`, sameUci === 0,
  sameUci ? `${sameUci} coincident` : '');
ok(`every arrow endpoint is a legal move in its position`, illegalArrow === 0,
  illegalArrow ? `${illegalArrow} illegal` : '');
ok(`every decision explains itself in words`, noWhy === 0,
  noWhy ? `${noWhy} without a reason` : '');
ok(`engine differences are honest (${scoredOptions} scored, ${unscoredOptions} unmeasured)`,
  badLoss === 0, badLoss ? `${badLoss} negative losses` : '');

/* ------------------------------------ [6] nothing asks the user to reveal them */

console.log('\n[6] the screen never gates the annotation behind a control');

/*
 * This is a SOURCE guard, not a behaviour guard, and that is deliberate.
 *
 * The regression it prevents is not a wrong value — it is a wrong SHAPE: an
 * extra "Show" affordance reappearing. Behaviour tests cannot see that, because
 * a hidden-by-default arrow still produces correct `choice` data. The user's
 * instruction was explicit ("dont keep anything that says you have to activate
 * the arrows ... because this is a course so no you just show the arrows"), so
 * the screen source is checked directly for the phrases such a control would
 * carry.
 *
 * Kept narrow on purpose: it looks for the user-facing words, not for the
 * identifier `revealed`, so a future variable with that name is not a failure.
 */
const SCREEN = path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx');
const screenSrcRaw = fs.readFileSync(SCREEN, 'utf8');

/*
 * Strip comments before scanning. The FIRST version of this guard did not, and
 * it failed on the very file it was written to protect — because the doc
 * comments legitimately QUOTE the instruction ("dont keep anything that says
 * you have to activate the arrows") and record that a "Show"/"Hide" bulb was
 * removed. A guard that cannot tell a comment from code reports history as a
 * regression; that is exactly the class of false verdict this file exists to
 * avoid.
 */
const screenSrc = screenSrcRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
  .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (not the `://` in a URL)

const banned = [
  ['a bulb icon', /IconLightbulb/],
  ['a Show/Hide label', /['"`]\s*Show\s*['"`]|['"`]\s*Hide\s*['"`]/],
  ['"tap Show" instruction', /Tap\s+[“"']Show/i],
  ['an "arrows are hidden" message', /arrows are hidden/i],
  ['an "activate the arrows" phrase', /activate the arrows/i],
];
for (const [what, re] of banned) {
  const hit = re.test(screenSrc);
  ok(`no ${what} on the screen`, !hit, hit ? 'found' : '');
}

/*
 * The arrows must be built outside any conditional on a reveal flag, and must
 * cover EVERY move of the user's — not only the ones with a decision to make.
 *
 * This guard used to require `const add = ...` to sit INSIDE `if (choice)`, and
 * that shape turned out to be the bug: a step where the user simply plays his
 * own move (no decision, because our recommendation does not differ from what he
 * played) drew no arrow at all, which is the reported "i see the board but no
 * arrows". So the builder is hoisted out and the assertion now covers both arms.
 */
const addHoisted = /const add = \(uci: string \| null \| undefined, color: string\) => \{/.test(screenSrc);
ok('the arrow builder is declared unconditionally', addHoisted,
  addHoisted ? '' : 'the add() helper is nested inside a conditional');

const forChoice = /if \(choice\) \{\s*add\(choice\.playedUci/.test(screenSrc);
ok('arrows are drawn whenever a choice exists', forChoice,
  forChoice ? '' : 'arrow block is conditional on something else');

/*
 * ...and the user's own move gets one even when there is nothing to decide.
 *
 * This assertion used to require the literal `else if (step?.isUserMove) { add(step.moveUci`. The arm is
 * still there and it still draws the move, but it reads from `userMoveHere` instead, and that is a
 * fix rather than a rename.
 *
 * `activeLine` can arrive from `overrideLine`, `resolveLine`, `lastLineRef` or `alternates[...]`, so
 * `activeLine[stepIdx]` names a move in SOME line, not necessarily in THIS position - the same
 * class of bug that made the arrow point at the wrong move. `userMoveHere` resolves the move by
 * trying to play it on the board's actual FEN and keeping the first candidate that is legal there,
 * so an arrow can only be drawn for a move that exists on the board being shown.
 *
 * Both halves are asserted: the arm exists, and the value it draws from is the validated one.
 */
const forOwnMove = /else if \(userMoveHere\) \{\s*add\(userMoveHere\.moveUci/.test(screenSrc);
ok("the user's own move gets an arrow too", forOwnMove,
  forOwnMove ? '' : 'a non-decision user move would draw no arrow');

const ownMoveValidated = /new Chess\(boardFen\);\s*\n\s*probe\.move\(s\.moveSan\);/.test(screenSrc);
ok('CONTROL: and the move is validated against the board being shown, not read off the line index',
  ownMoveValidated, ownMoveValidated ? '' : 'userMoveHere does not test the move on the live FEN');
ok('CONTROL: it also refuses to answer on the opponent\'s ply',
  /if \(turn !== openFamily\.side\) return null;/.test(screenSrc),
  'an arrow could be drawn on a ply that is not the user\'s');

/* ------------------------------------------------------------------ report */

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
cleanDir(BUILD_DIR);
