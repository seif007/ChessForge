/**
 * A BOT'S MOVE MUST BE ITS OWN, AND EXPLAINABLE.
 *
 * The mimic scores five engine lines on three signals - engine quality (α),
 * human plausibility (β) and the player's personality (γ) - and the play screen
 * then shows the sentence that decided it. This harness checks the scoring
 * directly, with hand-made profiles where every number is known:
 *
 *   1. THE SLIDER  - α/β/γ always normalize to a real mixture.
 *   2. THE ENGINE  - at α pure, the top line wins; ties and bounds hold.
 *   3. MATE        - a forced mate outweighs any centipawn score.
 *   4. THE BOOK    - a move this player actually chose here beats the engine's
 *                    pick at γ, and the reason says how many times. At MAXIMUM
 *                    mimicry their most played move beats the engine's even
 *                    when the engine never listed it at all.
 *   5. PREFERENCES - a capture-rate fingerprint changes the same capture's
 *                    personality score, not by magic but by the stated rule.
 *   6. THE WINDOW  - the early-queen penalty fires inside its ply window and
 *                    only for a queen that is already off its home rank.
 *   7. THE BRIDGE  - the engine's MultiPV result reaches the scorer with the
 *                    right field names, and a plain best-move result still moves.
 *   8. END TO END  - a profile BUILT from games steers the move, which is what
 *                    proves the two sides agree on what "this position" is.
 *
 * Run: node .bench/bots.mimic.test.mjs
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
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-bots-mimic');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2021', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'bots', 'mimic.ts'),
    path.join(ROOT, 'src', 'lib', 'bots', 'play.ts'),
    path.join(ROOT, 'src', 'lib', 'bots', 'profile.ts'),
    path.join(ROOT, 'src', 'lib', 'lichess.ts'),
    path.join(ROOT, 'src', 'lib', 'openings.ts'),
    path.join(ROOT, 'src', 'lib', 'repertoire.ts'),
  ],
}, null, 2));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project',
    path.join(BUILD_DIR, 'tsconfig.json'),
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 2500));
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
Module._load = function (request, parent, isMain) {
  if (request === 'chess.js') return REAL_CHESS;
  if (request === '@/lib/lichess') {
    return origLoad.call(this, findEmitted(BUILD_DIR, 'lichess.js'), null, false);
  }
  if (request === '@/lib/openings') {
    return origLoad.call(this, findEmitted(BUILD_DIR, 'openings.js'), null, false);
  }
  if (request === '@/lib/repertoire') {
    return origLoad.call(this, findEmitted(BUILD_DIR, 'repertoire.js'), null, false);
  }
  // Any other `@/lib/*` import (sacrifice, accuracy, ...) is emitted next to the
  // rest; resolve it by basename rather than listing every module in the app.
  if (request.startsWith('@/lib/')) {
    const emitted = findEmitted(BUILD_DIR, request.split('/').pop() + '.js');
    if (emitted) return origLoad.call(this, emitted, null, false);
  }
  if (request.startsWith('@/data/')) {
    return origLoad.call(this, path.join(ROOT, 'src', request.slice(2)), parent, isMain);
  }
  return origLoad.call(this, request, parent, isMain);
};

const mimic = origLoad.call(Module, findEmitted(BUILD_DIR, 'mimic.js'), null, false);
const play = origLoad.call(Module, findEmitted(BUILD_DIR, 'play.js'), null, false);
const prof = origLoad.call(Module, findEmitted(BUILD_DIR, 'profile.js'), null, false);
const { selectMove, weightsFromMimicry, normalizeWeights, BOT_MULTIPV } = mimic;
const { botMoveFor, linesFromEval, BOT_MOVE_MOVETIME_MS, botShouldResign, humanThinkDelayMs } = play;

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* ------------------------------------------------------------- fixtures */

const START = new Chess().fen();
const startKey = START.split(' ').slice(0, 4).join(' ');

/** Play a line from the start and return the FEN at the end. */
function fenAfter(moves) {
  const c = new Chess();
  for (const m of moves) c.move(m, { strict: false });
  return c.fen();
}

const emptyStats = () => ({
  total: 0, capture: 0, check: 0, castle: 0, centralPawn: 0, develop: 0, sac: 0,
  byPiece: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
});
const ratesOf = (opening = {}) => ({
  opening: { ...emptyStats(), ...opening },
  middle: emptyStats(),
  end: emptyStats(),
});

/** A profile where every field the scorer reads is set by hand. */
const profileOf = (over = {}) => ({
  id: 'x', name: 'Alpha', source: 'lichess',
  meta: { name: 'Alpha', key: 'Alpha', source: 'lichess' },
  recipe: { kind: 'lichess', query: 'Alpha', games: 10 },
  gamesAnalyzed: 10, rating: 2400, ratingLabel: 'Lichess blitz',
  wins: 5, draws: 3, losses: 2, openings: [],
  style: { aggression: 50, kingSafety: 50, pieceActivity: 50, endgame: 50, castlePly: null, avgGameLength: 30 },
  book: {}, typeRates: ratesOf(), firstMoves: [], repliesToE4: [], repliesToD4: [],
  timeControlMix: [], dateRange: {}, fetchedAt: new Date().toISOString(), createdAt: 1,
  ...over,
});

const line = (uci, scoreCp = 0, mate = null) => ({ multipv: 1, scoreCp, mate, pv: [uci], depth: 12 });
const engine = weightsFromMimicry(0);
const bookish = weightsFromMimicry(1);

/* --------------------------------------------------------------------- 1 */

head('1. the slider makes a real mixture');

const w0 = weightsFromMimicry(0);
const w1 = weightsFromMimicry(1);
const wMid = weightsFromMimicry(0.5);
ok(near(w0.alpha, 1) && near(w0.beta, 0) && near(w0.gamma, 0),
  'slide at 0 is a pure engine', JSON.stringify(w0));
ok(near(w1.alpha, 0.05) && near(w1.beta, 0.15) && near(w1.gamma, 0.8),
  'slide at 1 puts the player FIRST — the engine keeps only a tiebreak', JSON.stringify(w1));
ok(near(wMid.alpha + wMid.beta + wMid.gamma, 1),
  'every slider position sums to one', JSON.stringify(wMid));
ok(near(wMid.alpha, 0.525) && near(wMid.beta, 0.075) && near(wMid.gamma, 0.4),
  'and the mid-point splits them as stated', JSON.stringify(wMid));
ok(w1.gamma >= 0.6 && wMid.gamma < 0.6,
  'the book-candidate window opens only at the top of the slider');

const zero = normalizeWeights({ alpha: 0, beta: 0, gamma: 0 });
ok(zero.alpha === 1 && zero.beta === 0 && zero.gamma === 0,
  'all-zero sliders fall back to the engine instead of dividing by zero');
const half = normalizeWeights({ alpha: 2, beta: 1, gamma: 1 });
ok(near(half.alpha, 0.5) && near(half.beta, 0.25) && near(half.gamma, 0.25),
  'raw sliders normalize to their proportions', JSON.stringify(half));

/* --------------------------------------------------------------------- 2 */

head('2. at the engine setting, the engine\'s move wins');

const topTwo = [line('e2e4', 30), line('d2d4', 20)];
const enginePick = selectMove(topTwo, START, profileOf(), engine);
ok(enginePick?.san === 'e4' && enginePick.engineRank === 0,
  'the top line is the move', JSON.stringify(enginePick));
ok(enginePick?.uci === 'e2e4', 'and the UCI travels with it');
ok(Math.abs(enginePick.scores.s - enginePick.scores.e) < 1e-9,
  'with α pure, the total score is exactly the engine score');

const humanish = [line('a2a3', 0), line('h2h3', 0)];
const humanPick = selectMove(humanish, fenAfter(['e4', 'e5']), profileOf(), { alpha: 0, beta: 1, gamma: 0 });
ok(humanPick?.san === 'a3',
  'with β pure, two featureless moves are decided by engine rank',
  JSON.stringify(humanPick));

const emptyLines = selectMove([], START, profileOf(), engine);
ok(emptyLines === null, 'no lines is no move, not a crash');
const illegal = selectMove([line('e2e5')], START, profileOf(), engine);
ok(illegal === null, 'a line whose first move is illegal is skipped');
const afterIllegal = selectMove([line('e2e5'), line('e2e4', 0)], START, profileOf(), engine);
ok(afterIllegal?.san === 'e4', 'and the next line is then considered');

/* --------------------------------------------------------------------- 3 */

head('3. a forced mate outweighs centipawns');

const mateVsScore = selectMove([line('d2d4', 0, 3), line('e2e4', 500)], START, profileOf(), engine);
ok(mateVsScore?.san === 'd4',
  'the mate line is chosen over a +5.0 line', JSON.stringify(mateVsScore));
ok(mateVsScore?.reason.includes('mate in 3'),
  'and the reason names the mate', mateVsScore?.reason);

const getMated = selectMove([line('e2e4', 0), line('d2d4', 0, -4)], START, profileOf(), engine);
ok(getMated?.san === 'e4',
  'a mate against the bot is not chosen', JSON.stringify(getMated));

/* --------------------------------------------------------------------- 4 */

head('4. the book beats the engine at γ');

const P_BOOK = profileOf({ book: { [startKey]: { e4: 3 } } });
const bookPick = selectMove([line('d2d4', 50), line('e2e4', -30)], START, P_BOOK, { alpha: 0, beta: 0, gamma: 1 });
ok(bookPick?.san === 'e4' && bookPick.engineRank === 1,
  'the move the player played three times here beats the engine\'s pick',
  JSON.stringify(bookPick));
ok(bookPick?.reason === 'Alpha played e4 3× in this exact position',
  'and the reason says exactly how many times', bookPick?.reason);

const P_ONCE = profileOf({ book: { [startKey]: { d4: 1 } } });
const oncePick = selectMove([line('e2e4', 50), line('d2d4', -30)], START, P_ONCE, { alpha: 0, beta: 0, gamma: 1 });
ok(oncePick?.reason === 'in Alpha\'s opening book — played here before',
  'a single previous game gets its own wording', oncePick?.reason);

/*
 * The like-for-like probe: ONE line for the same move, with the book and
 * without it. Comparing chosen moves across two profiles would compare two
 * different feature vectors; the same move isolates the book signal, which is
 * worth exactly the stated 0.7 × (bookSignal − 0.5) = 0.35 at full strength.
 */
const P_NONE = profileOf();
const withBook = selectMove([line('e2e4', 0)], START, P_BOOK, { alpha: 0, beta: 0, gamma: 1 });
const withoutBook = selectMove([line('e2e4', 0)], START, P_NONE, { alpha: 0, beta: 0, gamma: 1 });
ok(near(withBook.scores.p - withoutBook.scores.p, 0.35),
  'a move the player actually played here scores the stated book bonus over the same move without it',
  `${withBook.scores.p} vs ${withoutBook.scores.p}`);
ok(near(bookPick.scores.s, bookPick.scores.p),
  'and at pure γ the total is the personality score');

/* -------------------------------------------------------------------- 4b */

head('4b. maximum mimicry plays the player\'s moves, not the engine\'s');

/*
 * THE DEVICE REPORT: "i puted player personality to maximum but still it
 * doesnt play the moves that players normally play". At the top of the slider
 * the old curve kept β = 0.55 against γ = 0.35, so the engine's favourite
 * out-scored the move the player had played in this exact position. This is
 * that scenario at the numbers the new curve has to win at.
 *
 * Both moves are central pawns opening on the same ply, so their preference
 * scores are identical and cancel; what decides is book EVIDENCE against
 * engine quality. The player's move is the engine's SECOND choice here — the
 * engine disagrees, and maximum mimicry says the player wins anyway.
 */
const P_HABIT = profileOf({ book: { [startKey]: { e4: 23, d4: 17 } } });
const habitPick = selectMove([line('d2d4', 30), line('e2e4', 10)], START, P_HABIT, bookish);
ok(habitPick?.san === 'e4' && habitPick.reason === 'Alpha played e4 23× in this exact position',
  'the player\'s most played move beats the engine\'s favourite at maximum mimicry',
  JSON.stringify(habitPick));

const engineFirst = selectMove([line('d2d4', 30), line('e2e4', 10)], START, P_HABIT, weightsFromMimicry(0));
ok(engineFirst?.san === 'd4',
  'CONTROL: the same position at the engine setting still goes to the engine',
  JSON.stringify(engineFirst));

/*
 * A habit the engine never listed at all. MultiPV is capped at five moves and
 * the player's own move can sit outside that window; at maximum mimicry the
 * book may nominate it as a candidate of its own, scored as the engine's LEAST
 * favourite SHOWN line — the weakest claim available without a search of its
 * own — and ranked at the tail of the plausibility curve.
 */
const P_OUTSIDE = profileOf({ book: { [startKey]: { e4: 9 } } });
const outsidePick = selectMove([line('d2d4', 30), line('g1f3', 20)], START, P_OUTSIDE, bookish);
ok(outsidePick?.san === 'e4' && outsidePick.engineRank === 2,
  'a move the player plays here that the engine never listed can still win',
  JSON.stringify(outsidePick));
ok(outsidePick?.reason === 'Alpha played e4 9× in this exact position',
  'with the reason still counting the games', outsidePick?.reason);

/*
 * ...but only a HABIT, not a one-off. One recorded game is a sample, two is a
 * habit — a single previous game must not push a move past every line the
 * engine actually showed.
 */
const P_SAMPLE = profileOf({ book: { [startKey]: { e4: 1 } } });
const samplePick = selectMove([line('d2d4', 30), line('g1f3', 20)], START, P_SAMPLE, bookish);
ok(samplePick?.san === 'd4',
  'a single previous game does not push a move past the engine\'s whole window',
  JSON.stringify(samplePick));

/*
 * And with no book at all, maximum mimicry must not be random: the engine's
 * own ranking still decides, because there is no evidence to outrank it.
 */
const barePick = selectMove([line('d2d4', 30), line('e2e4', 10)], START, P_NONE, bookish);
ok(barePick?.san === 'd4' && barePick.engineRank === 0,
  'with no history to mimic, maximum mimicry still plays the engine\'s move',
  JSON.stringify(barePick));

/* --------------------------------------------------------------------- 5 */

head('5. a fingerprint changes the same move\'s score');

const captureFen = fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
const captureLine = [line('b5c6', 0)];
const quiet = profileOf();
const sharpshooter = profileOf({ typeRates: ratesOf({ capture: 1 }) });
const quietScore = selectMove(captureLine, captureFen, quiet, { alpha: 0, beta: 0, gamma: 1 });
const sharpScore = selectMove(captureLine, captureFen, sharpshooter, { alpha: 0, beta: 0, gamma: 1 });
ok(sharpScore.scores.p > quietScore.scores.p,
  'a player who captures every move scores a capture higher than a player who never does',
  `${sharpScore.scores.p} vs ${quietScore.scores.p}`);
ok(sharpScore.scores.p > 0.5,
  'and the capture-lover is above the halfway line', String(sharpScore.scores.p));

/* --------------------------------------------------------------------- 6 */

head('6. the early-queen window');

/* 1.e4 e5 2.Qh5 Nc6 3.Qf3 - a queen that already left d1, moving again inside the window. */
const earlyQueenFen = fenAfter(['e4', 'e5', 'Qh5', 'Nc6']);
const early = selectMove([line('h5f3', 0)], earlyQueenFen, profileOf(), { alpha: 0, beta: 1, gamma: 0 });
const calm = selectMove([line('a2a3', 0)], earlyQueenFen, profileOf(), { alpha: 0, beta: 1, gamma: 0 });
ok(early.scores.h < calm.scores.h,
  'a queen wandering on move 3 is less human-plausible than a quiet pawn move',
  `${early.scores.h} vs ${calm.scores.h}`);
ok(near(calm.scores.h - early.scores.h, 0.38 * 0.28, 1e-9),
  'by exactly the stated penalty');

/* The first queen move, from its home square, is not flagged. */
const homeQueen = selectMove([line('d1h5', 0)], fenAfter(['e4', 'e5']), profileOf(), { alpha: 0, beta: 1, gamma: 0 });
const homePawn = selectMove([line('h2h3', 0)], fenAfter(['e4', 'e5']), profileOf(), { alpha: 0, beta: 1, gamma: 0 });
ok(near(homeQueen.scores.h, homePawn.scores.h),
  'a queen still on d1 gets no penalty for moving', `${homeQueen.scores.h} vs ${homePawn.scores.h}`);

/* The same re-move, one ply past the window. */
const lateFen = fenAfter(['e4', 'e5', 'Nc3', 'Nc6', 'Bc4', 'Bc5', 'd3', 'd6', 'Qe2', 'Nf6']);
const late = selectMove([line('e2f3', 0)], lateFen, profileOf(), { alpha: 0, beta: 1, gamma: 0 });
const lateCalm = selectMove([line('a2a3', 0)], lateFen, profileOf(), { alpha: 0, beta: 1, gamma: 0 });
ok(near(late.scores.h, lateCalm.scores.h),
  'past ply ten the wandering queen is no longer flagged',
  `${late.scores.h} vs ${lateCalm.scores.h}`);

/* --------------------------------------------------------------------- 7 */

head('7. the engine bridge');

const mapped = linesFromEval({
  depth: 15,
  lines: [
    { uci: 'e2e4', scoreCp: 25, mateIn: null, pvUci: ['e2e4', 'e7e5'] },
    { uci: 'd2d4', scoreCp: null, mateIn: 4, pvUci: ['d2d4'] },
  ],
});
ok(mapped.length === 2 && mapped[1].mate === 4 && mapped[0].scoreCp === 25,
  'MultiPV lines keep their scores and mates', JSON.stringify(mapped));
ok(mapped[0].multipv === 1 && mapped[1].multipv === 2 && mapped[0].pv[1] === 'e7e5' && mapped[0].depth === 15,
  'index, variation and depth travel through', JSON.stringify(mapped));
ok(mapped[0].mate === null, 'no mate stays no mate');

const fallback = linesFromEval({
  depth: 10, bestMoveUci: 'g1f3', scoreCp: 12, mateIn: null, pvUci: ['g1f3', 'g8f6'],
});
ok(fallback.length === 1 && fallback[0].pv[0] === 'g1f3' && fallback[0].scoreCp === 12,
  'a plain best-move result becomes one line', JSON.stringify(fallback));

const bare = linesFromEval({ depth: 8, bestMoveUci: 'g1f3', pvUci: [] });
ok(bare.length === 1 && bare[0].pv[0] === 'g1f3',
  'and with no variation, the best move is its own variation', JSON.stringify(bare));

ok(linesFromEval({ depth: 0 }).length === 0, 'an empty answer maps to no lines');

const calls = [];
const fakeAnalyse = async (fen, opts) => {
  calls.push({ fen, opts });
  return {
    depth: 12,
    lines: [
      { uci: 'e2e4', scoreCp: 20, mateIn: null, pvUci: ['e2e4'] },
      { uci: 'd2d4', scoreCp: 10, mateIn: null, pvUci: ['d2d4'] },
    ],
  };
};
const played = await botMoveFor(fakeAnalyse, START, profileOf(), engine);
ok(calls.length === 1 && calls[0].opts.multipv === BOT_MULTIPV,
  `the bot asks for ${BOT_MULTIPV} lines`, JSON.stringify(calls[0]?.opts));
ok(calls[0].opts.movetime === BOT_MOVE_MOVETIME_MS && calls[0].opts.elo === null,
  'with the stated thinking time and no artificial rating limit',
  JSON.stringify(calls[0]?.opts));
ok(played?.decision.san === 'e4' && played.lines.length === 2 && played.depth === 12,
  'and the decision comes back with the lines that produced it', JSON.stringify(played?.decision));

const noAnswer = await botMoveFor(async () => ({ depth: 0 }), START, profileOf(), engine);
ok(noAnswer === null, 'an engine that answers nothing produces no move');

const override = [];
await botMoveFor(async (fen, opts) => { override.push(opts); return { depth: 0 }; }, START, profileOf(), engine,
  { movetime: 250 });
ok(override[0].movetime === 250, 'a caller can override the thinking time');

/* --------------------------------------------------------------------- 8 */

head('8. end to end: a profile built from games steers the move');

const buildGames = [
  { pgn: '[White "Alpha"]\n[Black "R1"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 1-0', white: 'Alpha', black: 'R1', source: 'lichess', timeControl: 'blitz' },
  { pgn: '[White "Alpha"]\n[Black "R2"]\n[Result "1-0"]\n\n1. e4 c5 2. Nf3 d6 3. d4 cxd4 1-0', white: 'Alpha', black: 'R2', source: 'lichess', timeControl: 'blitz' },
  { pgn: '[White "Alpha"]\n[Black "R3"]\n[Result "0-1"]\n\n1. d4 d5 2. c4 e6 3. Nc3 Nf6 0-1', white: 'Alpha', black: 'R3', source: 'lichess', timeControl: 'blitz' },
];
const built = await prof.buildBotProfile(buildGames, { name: 'Alpha', key: 'Alpha', source: 'lichess' }, { yieldToUI: async () => {} });
ok(built.book[startKey]?.e4 === 2 && built.book[startKey]?.d4 === 1,
  'the built profile stores the start position under the same key the scorer looks up',
  JSON.stringify(built.book[startKey]));

const full = profileOf({ ...built, id: 'real', name: 'Alpha', rating: 2400 });
const steered = selectMove([line('d2d4', 50), line('e2e4', -30)], START, full, { alpha: 0, beta: 0, gamma: 1 });
ok(steered?.san === 'e4' && steered.reason.includes('played e4 2×'),
  'and that profile steers the choice to the player\'s own move',
  JSON.stringify(steered));

/* --------------------------------------------------------------------- 9 */

head('9. the bot resigns a lost game instead of playing it out');

/*
 * `evalTop` is scored with the BOT to move, and this engine scores from the
 * side to move — so the sign is the bot's own outlook and resigning needs no
 * perspective flip. Thresholds are the difference between "conceding" and
 * "giving up too early".
 */
ok(botShouldResign({ scoreCp: -950, mateIn: null }) === true,
  'a queen down against best play is resignable');
ok(botShouldResign({ scoreCp: null, mateIn: -3 }) === true,
  'a forced mate against the bot is resignable');
ok(botShouldResign({ scoreCp: -450, mateIn: null }) === false,
  'a piece down is not — the bot plays on');
ok(botShouldResign({ scoreCp: null, mateIn: -14 }) === false,
  'and a mate twenty moves away is played out, not conceded');
ok(botShouldResign({ scoreCp: 120, mateIn: null }) === false,
  'a good position is never resignable');
ok(botShouldResign({ scoreCp: null, mateIn: 2 }) === false,
  'and having a mate of your own is not a resignation either');
ok(played?.evalTop.scoreCp === 20 && played?.evalTop.mateIn === null,
  'the move result carries the engine verdict the resignation rule reads',
  JSON.stringify(played?.evalTop));

/* -------------------------------------------------------------------- 10 */

head('10. a human beat: the bot does not answer instantly, except when forced');

/*
 * THE REPORT: *"make the bot take time also thinking not always plays
 * immediately (but not thinking in obvious things too)"*. The delay is a pacing
 * rule scaled by how much there is to choose between.
 */
const FORCED_FEN = '8/8/8/8/8/5k2/6q1/7K w - - 0 1'; // mated: nothing to choose
ok(humanThinkDelayMs(FORCED_FEN) <= 260,
  'a position with no choice gets a token pause, not a fake think',
  String(humanThinkDelayMs(FORCED_FEN)));

let widest = 0;
let narrowest = Infinity;
for (let i = 0; i < 40; i++) {
  const d = humanThinkDelayMs(START);
  widest = Math.max(widest, d);
  narrowest = Math.min(narrowest, d);
}
ok(narrowest >= 900 && widest <= 1450,
  `a 20-move opening takes a human-sized think (${narrowest}..${widest}ms)`);
ok(widest > narrowest,
  'with some jitter, so two moves in a row do not land on the same beat');
ok(humanThinkDelayMs('not a fen') > 0,
  'an unreadable position still pauses instead of snapping');

/* ------------------------------------------------------------------ done */

console.log('');
if (failures === 0) console.log(`ALL CHECKS PASSED  (${checks}/${checks})`);
else console.log(`${failures} of ${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
