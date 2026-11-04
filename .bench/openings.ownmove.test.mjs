/**
 * Playing your OWN move must continue the line — and a bad move must finally be shown.
 *
 * THE REPORT, IN TWO PARTS:
 *
 *   "i tried your opening and it showd me my move and a suggested move but i played my move. the
 *    app stayed stuck a little bit then it jumped to another position and told me that the line
 *    is finished !"
 *
 *   "in the openings in your openings it never shows me a bad move in the opening and suggest a
 *    good move, it only shows me my good move and suggests another good move".
 *
 * Three mechanisms produced those two sentences, and each is asserted here against the REAL
 * builder and the REAL family parser (the whole `src` tree is compiled — see the harness note in
 * `openingbuilder.playloop`, which this file follows):
 *
 *   1. THE OWN-MOVE BRANCH. A step's own move IS the position's recorded move
 *      (`stepFor` is called with `chosen.playedSan!`), so when the user plays it the remainder of
 *      the line was built on top of exactly that move and there is nothing to re-derive. Section
 *      2 measures that invariant over the corpus: EVERY step with a choice has
 *      `moveSan === choice.playedSan`. The screen's branch is pinned in section 3: the own-move
 *      path must not reach the engine, must advance in place, and must not jump.
 *
 *   2. THE VERDICT JOIN. The family list is painted engine-free, so every step starts `verdict:
 *      null` — the "your good move vs another good move" the user keeps seeing. `publish` records
 *      the analysed positions but deliberately refuses to swap the family in under a live session;
 *      `withVerdicts` is the missing half that attaches them to the line already on the board,
 *      keyed by position, without moving anything. Section 1 proves the join and its identity
 *      contract.
 *
 *   3. THE DEAD END. The old `merged.length === 0` fallback set `stepIdx = steps.length`, which is
 *      the finished state of a line the user never walked — the "jumped to another position and
 *      told me that the line is finished". Section 3 pins that the jump is gone and that the dead
 *      end is reported where the move was made.
 *
 * Run: node .bench/openings.ownmove.test.mjs
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
function ok(cond, label, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}
function head(t) { console.log('\n' + t + '\n' + '-'.repeat(t.length)); }

/* ------------------------------------------------------------------ compile */

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-openownmove');
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

const { buildFamilyLines, withVerdicts } = require(path.join(OUT, 'lib', 'openingBuilder.js'));
const { analysedPositionsFromGames } = require(path.join(OUT, 'lib', 'gameOpenings.js'));
const { openingFromEcoUrl } = require(path.join(OUT, 'lib', 'lichess.js'));

/* ------------------------------------------------------------- fixtures */

function opt(uci, san, cp, lossCp, played = false, note = '') {
  return { uci, san, cp, lossCp, played, book: false, note };
}

function pos(o) {
  return {
    key: o.key,
    fen: o.fen,
    ply: o.ply,
    side: o.side,
    gameId: 'g1',
    gameUrl: '',
    opening: 'London System',
    playedSan: o.playedSan ?? null,
    playedUci: o.playedUci ?? null,
    prevSan: null,
    prefixSan: o.prefixSan ?? [],
    inBook: o.inBook ?? false,
    bookSan: o.bookSan ?? null,
    bookReplies: o.bookReplies ?? [],
    recommendUci: o.recommendUci ?? null,
    recommendSan: o.recommendSan ?? null,
    options: o.options ?? [],
    timesSeen: o.timesSeen ?? 1,
  };
}

const START = new Chess().fen();
const afterE4E5 = (() => { const c = new Chess(); c.move('e4'); c.move('e5'); return c.fen(); })();

/*
 * An ENGINE-FREE family, exactly as the list paints it: for both positions the recommendation IS
 * the played move, so no step carries a choice — the state the report describes ("it only shows me
 * my good move and suggests another good move").
 */
const engineFree = [
  pos({
    key: 'start', fen: START, ply: 0, side: 'w',
    playedSan: 'e4', playedUci: 'e2e4',
    inBook: true, bookSan: 'e4', bookReplies: ['e4'],
    recommendUci: 'e2e4', recommendSan: 'e4',
    options: [opt('e2e4', 'e4', 20, 0, true), opt('d2d4', 'd4', -5, 25), opt('g1f3', 'Nf3', -20, 40)],
  }),
  pos({
    key: 'k2', fen: afterE4E5, ply: 2, side: 'w',
    playedSan: 'Nf3', playedUci: 'g1f3',
    prefixSan: ['e4', 'e5'],
    inBook: true, bookSan: 'Nf3', bookReplies: ['Nf3'],
    recommendUci: 'g1f3', recommendSan: 'Nf3',
    options: [opt('g1f3', 'Nf3', 30, 0, true), opt('b1c3', 'Nc3', 10, 20)],
  }),
];

const families = buildFamilyLines(engineFree, { maxPly: 24, maxAlternates: 8 });
const fam = families[0];
if (!fam) { console.error('fixture family did not build'); process.exit(2); }
const steps = fam.steps;

/* ===========================================================================
 * 1. THE JOIN — verdicts reach a line that is already on the board
 * ======================================================================== */
head('1. THE JOIN — `withVerdicts` attaches analysed positions WITHOUT moving the line');

ok(steps.length >= 3, 'CONTROL: the fixture family has a line to join onto',
  `got ${steps.length} steps`);
const choiceSteps0 = steps.filter((s) => s.choice).length;
ok(choiceSteps0 === 0,
  'CONTROL: the engine-free family has NO choices — the exact state the report describes ("only my good move and another good move")',
  `got ${choiceSteps0}`);

// This is the same position, now as the engine pass returns it: `e4` was a blunder, the book
// wants `d4` and the book's move is the recommendation. This is "shows me a bad move and suggests
// a good move", which the engine-free record cannot say.
const analysedStart = pos({
  key: 'start', fen: START, ply: 0, side: 'w',
  playedSan: 'e4', playedUci: 'e2e4',
  inBook: true, bookSan: 'd4', bookReplies: ['d4'],
  recommendUci: 'd2d4', recommendSan: 'd4',
  options: [
    opt('d2d4', 'd4', 30, 0, false, 'our book move'),
    opt('e2e4', 'e4', -270, 300, true, 'your move'),
    opt('g1f3', 'Nf3', -240, 270),
  ],
});

ok(withVerdicts(steps, []) === steps,
  'no analysed positions -> the SAME array back (identity, so React stays quiet)');
ok(withVerdicts(steps, [pos({ key: 'somewhere-else', fen: START, ply: 9, side: 'w' })]) === steps,
  'CONTROL: a position that matches nothing -> the SAME array back');

const joined = withVerdicts(steps, [analysedStart]);
ok(joined !== steps, 'a matching position DOES produce a new array (the render trigger)');
ok(steps[0].choice === null && steps[0].position.key === 'start' && steps[0].position !== joined[0].position,
  'CONTROL: the input line is not mutated — the old step still has no choice');

const js = joined[0];
ok(js.moveSan === 'e4', 'the step still plays the SAME move — the join moves nothing', js.moveSan);
ok(js.fen === steps[0].fen && js.ply === steps[0].ply && js.side === steps[0].side
  && js.moveUci === steps[0].moveUci && js.isUserMove === steps[0].isUserMove,
  'and nothing else about the step changed: same FEN, ply, side, UCI, ownership');
ok(js.position === analysedStart,
  'the step now carries the ANALYSED record, by reference (no copy that can drift)');
ok(js.choice !== null,
  'a choice EXISTS where the engine-free line had none — the "there is a better move here" question');
ok(js.choice && js.choice.playedSan === js.moveSan,
  'THE INVARIANT THE SCREEN RELIES ON: the choice\'s played move IS the step\'s own move',
  js.choice ? `${js.moveSan} vs ${js.choice.playedSan}` : 'no choice');
ok(js.choice && js.choice.verdict === 'blunder',
  'and the verdict is the MISSING PIECE — "it never shows me a bad move" now has an answer',
  js.choice ? String(js.choice.verdict) : 'no choice');
ok(js.choice && js.choice.lossCp === 300, 'with the measured loss behind it', js.choice ? String(js.choice.lossCp) : '');
ok(js.choice && js.choice.recommendSan === 'd4',
  'and the recommendation the report asks for ("suggest a good move")',
  js.choice ? String(js.choice.recommendSan) : '');
ok(js.choice && /book|engine/i.test(js.choice.why),
  'the sentence under the comparison says where the recommendation comes from', js.choice ? js.choice.why : '');

ok(joined[1] === steps[1],
  'the opponent\'s AUTO step (no position record) is passed through by identity — the walk cannot be disturbed');

// A position whose recommendation IS its played move must stay question-free even after the join:
// swapping in analysed data is not a licence to invent a decision.
const analysedNf3 = pos({
  key: 'k2', fen: afterE4E5, ply: 2, side: 'w',
  playedSan: 'Nf3', playedUci: 'g1f3',
  prefixSan: ['e4', 'e5'],
  inBook: true, bookSan: 'Nf3', bookReplies: ['Nf3'],
  recommendUci: 'g1f3', recommendSan: 'Nf3',
  options: [opt('g1f3', 'Nf3', 30, 0, true), opt('b1c3', 'Nc3', 10, 20)],
});
const joined2 = withVerdicts(steps, [analysedNf3]);
ok(joined2[2].choice === null,
  'CONTROL: a position where he played the recommendation stays question-free');
ok(joined2[2].position === analysedNf3, 'though it still gets the fresher record');

/* ===========================================================================
 * 2. THE INVARIANT — over the REAL corpus, his own move is the line's move
 * ======================================================================== */
head('2. THE OWN-MOVE BRANCH RESTS ON ONE FACT — measure it on the real corpus');

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

const corpusPositions = analysedPositionsFromGames(games, { maxGames: 160, maxPly: 16 });
const corpusFamilies = buildFamilyLines(corpusPositions, { maxPerFamily: 24, maxAlternates: 8 });

let totalSteps = 0;
let positionSteps = 0;
let choiceSteps = 0;
let ownMoveViolations = 0;
let choiceViolations = 0;
let orphanChoices = 0;

for (const family of corpusFamilies) {
  for (const line of [family.steps, ...family.alternates]) {
    for (const s of line) {
      totalSteps++;
      if (s.position) {
        positionSteps++;
        // The step's own move must be the position's recorded move: this is what makes
        // `san === step.moveSan` equivalent to "he played his own move".
        if (s.moveSan !== s.position.playedSan) ownMoveViolations++;
      }
      if (s.choice) {
        choiceSteps++;
        if (!s.position) orphanChoices++;
        if (s.moveSan !== s.choice.playedSan) choiceViolations++;
      }
    }
  }
}

console.log(`  corpus: ${games.length} games · ${corpusPositions.length} positions · ` +
  `${corpusFamilies.length} families · ${totalSteps} steps (${positionSteps} with a position, ` +
  `${choiceSteps} with a choice)`);

ok(totalSteps > 0 && positionSteps > 0, 'CONTROL: the corpus produced steps to measure');
ok(choiceSteps > 0,
  'CONTROL: and produced real DECISIONS — the invariant is not being measured on a choice-free corpus',
  `got ${choiceSteps}`);
ok(ownMoveViolations === 0,
  'EVERY position step plays the position\'s own recorded move (so `san === step.moveSan` means "his move")',
  `${ownMoveViolations} violated`);
ok(choiceViolations === 0,
  'and every decision step\'s own move IS its choice\'s played move — the fact the advance-in-place branch stands on',
  `${choiceViolations} violated`);
ok(orphanChoices === 0,
  'CONTROL: a choice never exists without its position record (the join keys on it)',
  `${orphanChoices} without`);

/* ===========================================================================
 * 3. THE SCREEN — the branch, the join, and the dead end
 * ======================================================================== */
head('3. THE SCREEN — advance in place, join in place, and no jump at the dead end');

const screenSrc = fs.readFileSync(
  path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx'), 'utf8',
);
// Comments blanked, strings kept: probes match CODE, not the prose that explains it.
const code = screenSrc.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

ok(/const playsLineMove = san === step\.moveSan;/.test(code),
  'the handler decides ONCE whether the user played the line\'s own move');

const ownStart = code.indexOf('if (playsLineMove) {');
const ownEnd = code.indexOf('const merged = openFamily', ownStart);
const own = ownStart >= 0 && ownEnd > ownStart ? code.slice(ownStart, ownEnd) : '';
ok(own.length > 0,
  'the own-move branch exists, and the engine branch still follows it (both paths are real)');
ok(!/continueLineWithEngine/.test(own),
  'the own-move branch does NOT go through the engine — his move needs no re-derivation');
ok(/setStepIdx\(i\);/.test(own),
  'it advances the line IN PLACE, which is the fix for "the app stayed stuck"');
ok(/setPendingFen\(null\);/.test(own),
  'and hands the board back to the line it just advanced');

ok(/setPendingFen\(c\.fen\(\)\)/.test(code),
  'the position his move reached is put on the board the moment it is made');
ok(/const boardFen = pendingFen \?\? linePlies\[Math\.min\(stepIdx, linePlies\.length - 1\)\];/.test(code),
  'CONTROL: `boardFen` wears it over the line\'s position — the piece does not snap back');
ok(/interactive=\{!done && !replaying && !awaitingVerdict && pendingFen == null\}/.test(code),
  'and the board refuses a second move while the line is catching up');

ok(!/setStepIdx\(steps\.length\)/.test(code),
  'NOTHING jumps the board to the end of the line any more — the "it jumped and said finished" bug');
ok(/Nothing in your games or our books continues from/.test(code),
  'the dead end is reported where the move was made, instead of faking a finished line');
ok(/const replaysPlayed = merged\.length >= played\.length/.test(code)
  && /if \(!replaysPlayed \|\| merged\.length === played\.length\) \{/.test(code),
  'a continuation that adds NOTHING is a dead end too — the engine-busy truncation ("played two '
  + 'moves and it told me line finished") can no longer fall through to a finished line');

ok(/withVerdicts,/.test(code), 'the screen imports the verdict join');
ok(/const livePositions = useMemo\(/.test(code) && /analysedRef\.current\.get\(openFamilyId\)/.test(code),
  'the live line reads the analysed positions for the OPEN family');
ok(/withVerdicts\(resolvedLine, livePositions\)/.test(code),
  'and the line on the board is the resolved line PLUS those verdicts');
ok(/setVerdictsTick\(\(t\) => t \+ 1\)/.test(code),
  'publish triggers a re-render when verdicts land (the ref alone would not re-render)');

const pubIdx = code.indexOf('const publish = () => {');
const pubBump = code.indexOf('setVerdictsTick', pubIdx);
const pubGuard = code.indexOf('if (sessionLiveRef.current) return;', pubIdx);
ok(pubIdx >= 0 && pubBump > pubIdx,
  'CONTROL: the publish trigger is inside `publish` itself');
ok(pubGuard > 0 && pubBump < pubGuard,
  'and it fires BEFORE the rebuild guard — that is what makes a live session see the verdicts');

/* ------------------------------------------------------------------ report */

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
cleanDir(BUILD_DIR);
