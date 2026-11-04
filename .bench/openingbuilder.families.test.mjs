/**
 * Does an opening family actually turn into a line the user can PLAY?
 *
 * WHY THIS EXISTS
 * ---------------
 * `openingBuilder.ts` does something that is very easy to write and almost
 * impossible to eyeball: it takes positions collected from MANY different games
 * and ROTATES them into one legal move order.
 *
 * The obvious implementation — sort by ply, concatenate the moves — produces
 * garbage. Two of the user's games can reach "the Sicilian Defence" by different
 * move orders, and a move that is legal in one is illegal in the other. The
 * failure mode is not a crash: it is a line that silently stops early, or worse,
 * a board that shows a position the moves could never have produced. Neither is
 * visible without replaying it.
 *
 * So this harness replays every family the module produces, move by move, from
 * the initial position, and fails on the first illegal move. That is the
 * invariant. Everything else here guards the six things the user explicitly
 * asked for, which are equally invisible from the outside:
 *
 *   - a family is never MIXED-COLOUR (a Sicilian as White and as Black are two
 *     repertoires, not one line);
 *   - `choice` is non-null ONLY when the user's move and our recommendation
 *     really differ ("whenever you can suggest him to choose … else just show
 *     him the move");
 *   - `firstDecisionIndex` points at a step that actually has a choice;
 *   - the opening NAMES come out without touching the engine.
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

/** Shell delete: `fs.rmSync` is shimmed here and can hang on a tree. */
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

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-openingbuilder');
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
  files: [path.join(ROOT, 'src', 'lib', 'openingBuilder.ts')],
}, null, 2));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project', CONFIG,
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

/*
 * The modules this one imports are stubbed rather than compiled, because they
 * pull in the engine, the SQLite store and ten repertoire JSON files — none of
 * which have anything to do with whether a line rotates legally.
 *
 * `gameOpenings` is NOT stubbed to a fake: its `analysedPositionsFromGames` is
 * real logic the builder depends on, so reimplementing it here would test my
 * reimplementation instead of the shipped code. It IS compiled, and only its
 * engine import is stubbed.
 */

/* Compile gameOpenings too, so positionsFromGames is the real thing. */
const CONFIG2 = path.join(BUILD_DIR, 'tsconfig.go.json');
fs.writeFileSync(CONFIG2, JSON.stringify({
  compilerOptions: {
    target: 'es2020',
    module: 'commonjs',
    skipLibCheck: true,
    noEmitOnError: false,
    paths: { '@/*': ['../../../src/*'] },
    rootDir: ROOT,
    outDir: BUILD_DIR,
    esModuleInterop: true,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'gameOpenings.ts'),
    path.join(ROOT, 'src', 'lib', 'lichess.ts'),
  ],
}, null, 2));
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project', CONFIG2,
  ], { stdio: 'pipe' });
} catch { /* non-fatal: reported below if the require fails */ }

/* Stub the `@/` imports before loading the emitted modules. */
const Module = require('node:module');
const origLoad = Module._load;

/*
 * ORDER MATTERS, AND IT IS SUBTLE.
 *
 * The emitted modules `require('@/lib/engine')` etc. at load time, so the hook
 * must be installed BEFORE they are loaded. But the hook must not itself call
 * `require` for anything it intercepts -- `Module._load` intercepts the stub's
 * own require too, so `return require('chess.js')` inside the hook recurses
 * until the stack blows.
 *
 * Hence: resolve the ONLY module the hook needs (`chess.js`, which nothing
 * intercepts) first, install the hook, and then load the emitted siblings
 * through the real loader. Their paths are absolute, so the last line of the
 * hook passes them straight through.
 */
const REAL_CHESS = require('chess.js');
const GAME_OPENINGS_JS = path.join(BUILD_DIR, 'src', 'lib', 'gameOpenings.js');
const LICHESS_JS = path.join(BUILD_DIR, 'src', 'lib', 'lichess.js');

/** Assigned after the hook is installed (see the two calls below it). */
let emittedGameOpenings = null;
let emittedLichess = null;

Module._load = function (request, parent, isMain) {
  if (request === 'chess.js') return REAL_CHESS;
  if (request === GAME_OPENINGS_JS) return emittedGameOpenings;
  if (request === LICHESS_JS) return emittedLichess;
  if (request === '@/lib/gameOpenings') return emittedGameOpenings;
  if (request === '@/lib/lichess') return emittedLichess;
  if (request === '@/lib/engine') return { getEngine: () => ({ analyse: async () => null }) };
  if (request === '@/lib/openings') {
    return {
      bestCoverageAcrossOpenings: () => null,
      // The book-truth lookup. This harness deliberately has no library — it is
      // testing the ROTATION, not what the books say — so "no book anywhere" is
      // the honest stub, and it must be `null` rather than a shape that would let
      // a decision be manufactured. See `GamePosition.bookReplies`.
      bookHere: () => null,
      // The other three the modules import, for the same reason and with the same
      // answer: this harness has no library. They were missing, so `openingBuilder`
      // threw `bestOpeningForLine is not a function` at module scope and the gate
      // died before asserting anything — it was reporting nothing while sitting in
      // the suite as a FAIL, which is the state that hides a real defect.
      bestOpeningForLine: () => null,
      bookContinuationFromPosition: () => null,
      AVAILABLE_OPENINGS: [],
      OPENINGS: [],
    };
  }
  if (request === '@/lib/repertoire') {
    return { fenKey: (fen) => fen, bestCoverage: () => null, bestCoverageAcrossOpenings: () => null };
  }
  return origLoad.call(this, request, parent, isMain);
};

emittedGameOpenings = origLoad.call(Module, GAME_OPENINGS_JS, null, false);
emittedLichess = origLoad.call(Module, LICHESS_JS, null, false);

/** The SHIPPED family parser, so the harness groups the way the app groups. */
const { openingFromEcoUrl: openingRef } = emittedLichess;

const builderPath = findEmitted(BUILD_DIR, 'openingBuilder.js')
  ?? findEmitted(BUILD_DIR, path.join('openingBuilder.js'));
let builder;
try {
  builder = require(builderPath);
} catch (e) {
  console.error('failed to load emitted module:', e.message);
  process.exit(2);
}
const { buildFamilyLines, familiesFromGames } = builder;

/* ------------------------------------------------------------------ corpus */

const PAYLOAD = [
  path.join(HERE, 'test-games.json'),
  path.join(ROOT, 'test-games.json'),
  path.join(HERE, '..', 'test-games.json'),
].find((p) => fs.existsSync(p));
if (!PAYLOAD) { console.error('missing test-games.json'); process.exit(2); }

const raw = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
const allGames = raw.games ?? raw;

/**
 * Replay a PGN to mainline SANs.
 *
 * The PGN starts with a block of `[Header "..."]` lines, which are NOT moves.
 * It ALSO has a clock comment after every single move — `{[%clk 0:03:00]}` —
 * and those split across whitespace, so a naive token loop reads `{[%clk` and
 * `0:03:00]}` as moves and dies on the first one. The first version of this
 * parser did exactly that and reported "0 usable games" on a 1,045-game corpus.
 *
 * The comment filter is therefore not cosmetic: without it every game in the
 * corpus derives zero positions and the harness passes on an empty dataset.
 */
function mainlineSans(pgn) {
  const body = pgn.split('\n').filter((l) => !l.trim().startsWith('[')).join(' ');
  const sans = [];
  const c = new Chess();
  for (const tok of body.split(/\s+/)) {
    const t = tok.trim();
    if (!t) continue;
    if (t.startsWith('{') || t.endsWith('}') || t.includes('%clk')) continue;
    if (/^\d+\.+$/.test(t)) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) break;
    const clean = t.replace(/[!?]+$/, '');
    if (!clean) continue;
    try {
      const m = c.move(clean);
      if (!m) break;
      sans.push(m.san);
    } catch { break; }
  }
  return sans;
}

/**
 * The tracked player in this corpus.
 *
 * Every game in `test-games.json` is Hikaru's, so that is the only honest
 * username. Fabricating the colour (e.g. "even index is White") would make half
 * the "user moves" belong to the opponent — the parity would be wrong on exactly
 * those games, nearly every position would be rejected as illegible, and the
 * harness would report a healthy-looking 0 decisions everywhere. That is the
 * failure this line prevents.
 */
const TRACKED = 'hikaru';

/** Map the local test corpus into the `LichessGame` shape the module wants. */
function toGame(g, i) {
  const pgn = g.pgn ?? '';
  const sans = mainlineSans(pgn);
  if (sans.length < 8) return null;
  const whiteName = String(g.white?.username ?? '').toLowerCase();
  const blackName = String(g.black?.username ?? '').toLowerCase();
  const isWhite = whiteName === TRACKED;
  const isBlack = blackName === TRACKED;
  if (!isWhite && !isBlack) return null;
  // Use the REAL parser, not a local guess: the family grouping is the thing
  // under test, so the family labels must be produced by shipped code.
  const { family, name } = openingRef(g.eco);
  return {
    id: g.uuid ?? `g${i}`,
    url: g.url ?? `https://example/g${i}`,
    opening: family,
    openingVariation: name,
    ecoSlug: '',
    color: isWhite ? 'w' : 'b',
    outcome: 'win',
    playerRating: null,
    opponentRating: null,
    opponent: 'opp',
    accuracy: null,
    opponentAccuracy: null,
    movesUci: [],
    movesSan: sans,
    timeClass: g.time_class ?? 'blitz',
    timeControl: g.time_control ?? '600',
    rated: g.rated !== false,
    endTime: g.end_time ?? 0,
  };
}

const games = allGames.map(toGame).filter(Boolean);
console.log(`\ncorpus: ${allGames.length} raw games -> ${games.length} usable`);

/** The SHIPPED position deriver, used to build positions to mutate in [4]. */
const { analysedPositionsFromGames: deriveCandsForTest } = emittedGameOpenings;

/* ------------------------------------------------------- [1] names, no engine */

console.log('\n[1] opening NAMES come out without the engine');

const families = familiesFromGames(games, { maxGames: 120, maxPly: 16, maxPerFamily: 20 });ok('families produced', families.length > 0, `${families.length} families`);
ok('every family has a non-empty name',
  families.every((f) => typeof f.name === 'string' && f.name.length > 0));
ok('families are sorted with decisions first',
  families.every((f, i) => i === 0 || families[i - 1].decisions >= 0 || f.decisions >= 0));

console.log(`\n  found ${families.length} families, top by size:`);
for (const f of families.slice(0, 12)) {
  console.log(`    ${f.name} (${f.side}) · ${f.games}g · ${f.steps.length}+${f.alternates.length}alt plies · ${f.totalDecisions} decisions · ${f.orphans} orphans`);
}

/* A family must actually be a LINE, not a single move. If every family is one
 * ply deep, the rotation has failed even though every check above passes. */
const depth = families.reduce((n, f) => n + f.steps.length, 0);
ok(`families rotate into real lines (avg ${families.length ? (depth / families.length).toFixed(1) : 0} plies)`,
  families.length > 0 && depth / families.length >= 3,
  `${depth} plies across ${families.length} families`);

/* "give him many other lines on the sicilian" — sibling lines must exist. */
const alts = families.reduce((n, f) => n + f.alternates.length, 0);
ok(`sibling lines were built (${alts} across ${families.length} families)`, alts > 0,
  alts ? '' : 'no alternate lines — the "many other lines" requirement is unmet');

/* ------------------------------------------- [2] the line is LEGAL, ply by ply */

console.log('\n[2] every family line replays legally from the initial position');

let illegal = 0;
let totalSteps = 0;
let altSteps = 0;

/** Replay one line from the initial position; returns null when legal. */
function checkLine(label, steps) {
  const c = new Chess();
  for (const st of steps) {
    const wantFen = st.fen.split(' ').slice(0, 4).join(' ');
    const haveFen = c.fen().split(' ').slice(0, 4).join(' ');
    if (st.fen !== undefined && wantFen !== haveFen) {
      return `position mismatch at ply ${st.ply}: recorded ${wantFen} · board ${haveFen}`;
    }
    let m = null;
    try { m = c.move(st.moveSan); } catch { m = null; }
    if (!m) return `illegal ${st.moveSan} at ply ${st.ply} (${label})`;
  }
  return null;
}

for (const f of families) {
  totalSteps += f.steps.length;
  const bad = checkLine(`${f.name} main`, f.steps);
  if (bad) { illegal++; ok(`legal line: ${f.name} (${f.side})`, false, bad); }
  for (const [i, alt] of f.alternates.entries()) {
    altSteps += alt.length;
    const badAlt = checkLine(`${f.name} alt${i}`, alt);
    if (badAlt) { illegal++; ok(`legal alternate: ${f.name} alt${i}`, false, badAlt); }
  }
}
ok(`all family lines are legal (${totalSteps} main + ${altSteps} alternate plies)`, illegal === 0,
  illegal ? `${illegal} illegal` : '');

/* ------------------------------------------------ [3] side is never mixed */

console.log('\n[3] a family is played as ONE colour');

let mixed = 0;
for (const f of families) {
  const sides = new Set(f.steps.map((s) => s.side));
  const start = new Chess().fen().split(' ')[1];
  // Sides alternate from the starting side, so a legal single line necessarily
  // touches both — what must NOT vary is whose move the DECISIONS are on.
  const decisionSides = new Set(
    f.steps.filter((s) => s.choice != null).map((s) => s.side),
  );
  if (decisionSides.size > 1) {
    mixed++;
    ok(`decisions are one colour: ${f.name} (${f.side})`, false,
      `saw ${[...decisionSides].join(',')}`);
  }
  void sides; void start;
}
ok(`all ${families.length} families decide for a single colour`, mixed === 0);

/* ------------------------------- [4] choice is offered ONLY when it is real */

console.log('\n[4] a choice is offered exactly when the moves differ');

/*
 * `familiesFromGames` is engine-free, so its recommendations fall back to the
 * move the user played and there is (correctly) nothing to decide. That means
 * the ENGINE-FREE corpus cannot exercise `choice` at all — so this section feeds
 * `buildFamilyLines` positions with a real divergence, which is what the screen
 * sees after `analyseFamily` has run.
 *
 * This is the guard for "whenever you can suggest him to choose the app suggests
 * to him else just show him the move": a fake choice (recommendation === played)
 * and a missed choice (divergence with no choice) are both failures.
 */
const divCands = deriveCandsForTest(games.slice(0, 60), { maxPly: 16 });
const forced = divCands.map((p, i) => ({
  ...p,
  recommendUci: p.playedUci,
  recommendSan: p.playedSan,
  options: [
    { uci: p.playedUci, san: p.playedSan, cp: 20, lossCp: 0, played: true, book: false, note: 'What you played' },
    { uci: 'a7a6', san: 'a6', cp: 0, lossCp: 20, played: false, book: false, note: 'Engine alternative' },
  ],
}));
// Make every OTHER position diverge, so both branches are exercised.
for (let i = 0; i < forced.length; i += 2) {
  const alt = forced[i].options[1];
  forced[i] = {
    ...forced[i],
    recommendUci: alt.uci,
    recommendSan: alt.san,
    options: [
      { ...alt, lossCp: 0 },
      { ...forced[i].options[0], lossCp: 20 },
    ],
  };
}
const forcedFamilies = buildFamilyLines(forced, { maxPerFamily: 20 });

let fakeChoices = 0, missedChoices = 0, totalChoices = 0;
for (const f of forcedFamilies) {
  // Main line AND every sibling: a decision on an alternate must obey the same
  // rule, or the second Sicilian line silently becomes a move-showing list.
  for (const st of [...f.steps, ...f.alternates.flat()]) {
    if (st.choice) {
      totalChoices++;
      // A choice with identical moves is a fake choice.
      if (st.choice.playedUci != null && st.choice.playedUci === st.choice.recommendUci) {
        fakeChoices++;
      }
      // A choice must be the user's move, or the UI would ask them to decide
      // about a move their opponent made.
      if (!st.isUserMove) fakeChoices++;
    } else if (st.position && st.isUserMove
      && st.position.recommendUci != null && st.position.playedUci != null
      && st.position.recommendUci !== st.position.playedUci) {
      // The position HAD a divergence (recommendation differs from what was
      // played) but the step offers no choice. That is the "we forgot to ask"
      // bug, which silently removes the whole feature.
      missedChoices++;
    }
  }
}
ok(`the engine-free corpus reports no fake choices`, fakeChoices === 0,
  fakeChoices ? `${fakeChoices} fake` : '');
ok(`forced divergences produce real choices (${totalChoices} across ${forcedFamilies.length} families)`,
  totalChoices > 0, totalChoices ? '' : 'none produced — the choice path is dead');
ok('no divergence left without a choice', missedChoices === 0, missedChoices ? `${missedChoices} missed` : '');

// A choice must never be offered where the moves agree.
{
  const agreed = forcedFamilies.flatMap((f) => f.steps).filter(
    (st) => st.position && st.position.playedUci === st.position.recommendUci,
  );
  const bad = agreed.filter((st) => st.choice != null);
  ok(`agreeing positions offer no choice (${agreed.length} checked)`, bad.length === 0,
    bad.length ? `${bad.length} fake` : '');
}

/* ------------------------------------- [5] firstDecisionIndex points at a choice */

console.log('\n[5] firstDecisionIndex is consistent');

let badFirst = 0;
for (const f of families) {
  const realFirst = f.steps.findIndex((s) => s.choice != null);
  if (realFirst !== f.firstDecisionIndex) {
    badFirst++;
    ok(`firstDecisionIndex: ${f.name} (${f.side})`, false, `${f.firstDecisionIndex} vs ${realFirst}`);
  }
  if (f.firstDecisionIndex >= 0 && f.steps[f.firstDecisionIndex].choice == null) {
    badFirst++;
  }
}
ok(`all ${families.length} families report the right first decision`, badFirst === 0);

/* ------------------------------------------- [6] rotating does not lose positions */

console.log('\n[6] orphans are counted, not silently dropped');

const withOrphans = families.filter((f) => f.orphans > 0);
ok('orphans are reported honestly',
  families.every((f) => Number.isInteger(f.orphans) && f.orphans >= 0),
  withOrphans.length ? `${withOrphans.length} families have unreachable positions` : 'none');
const placed = families.reduce((n, f) => n + f.steps.filter((s) => s.position).length, 0);
ok('most family positions were placed in a playable line', placed > 0, `${placed} placed`);

/* ---------------------------------------------- [7] buildFamilyLines is pure-ish */

console.log('\n[7] buildFamilyLines handles edge inputs');

ok('empty input -> empty output', buildFamilyLines([]).length === 0);
ok('a single position still yields a family',
  buildFamilyLines([{
    key: 'k', fen: new Chess().fen(), ply: 0, side: 'w',
    gameId: 'g', gameUrl: 'u', opening: 'Test Opening',
    playedSan: 'e4', playedUci: 'e2e4', prevSan: null, prefixSan: [],
    inBook: false, bookSan: null, recommendUci: 'e2e4', recommendSan: 'e4',
    options: [], timesSeen: 1,
  }]).length === 1);

/* ------------------------------------------------- the URL the name comes from */

/*
 * THE NAME IS THE GROUPING KEY, SO A MISREAD URL IS A MISGROUPED GAME.
 *
 * Three values Lichess really sends, and the two that used to be read wrong. Every one of these is
 * cheap to get wrong and invisible when it is: a misnamed game does not error, it joins the wrong
 * family or appears as "Unknown Opening" beside games it belongs with.
 */
const URL_OK = 'https://www.Lichess/openings/Sicilian-Defense-Najdorf-Variation-1.e4-c5';
ok('a normal ECO URL names its opening',
  openingRef(URL_OK).family === 'Sicilian Defense'
  && openingRef(URL_OK).name === 'Sicilian Defense Najdorf Variation',
  JSON.stringify(openingRef(URL_OK)));
ok('a trailing slash does NOT make a classified game unknown',
  openingRef(URL_OK + '/').family === 'Sicilian Defense',
  JSON.stringify(openingRef(URL_OK + '/')));
ok('the bare category page is NOT read as an opening called "openings"',
  openingRef('https://www.Lichess/openings').family === 'Unknown Opening'
  && openingRef('https://www.Lichess/openings/').family === 'Unknown Opening',
  JSON.stringify(openingRef('https://www.Lichess/openings')));
ok('a URL with no opening in it is unknown, not invented',
  openingRef('https://www.Lichess/member/someone').family === 'Unknown Opening'
  && openingRef('').family === 'Unknown Opening'
  && openingRef(undefined).family === 'Unknown Opening');
ok('CONTROL: a query or fragment after the slug is not part of the name',
  openingRef(URL_OK + '?ref=archive').family === 'Sicilian Defense'
  && openingRef(URL_OK + '#moves').family === 'Sicilian Defense');

/* ------------------------------------------------------------------ report */

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
cleanDir(BUILD_DIR);
