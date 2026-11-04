/**
 * GATE — the review's accuracy and move bands must match the published models.
 *
 * THE REPORT
 * ==========
 * *"i analysed a game and it is full of mistakes + the acc is not correct + the moves icons has
 * mistakes."*
 *
 * Three separate failures can produce that sentence:
 *
 *   1. the eval fed to the classifier came from MultiPV line 2 (see analysis.multipv.test.mjs);
 *   2. a 50cp drop was called a mistake, which is about 4.6% of a win and below search noise;
 *   3. the game accuracy was a plain mean, which dilutes one real blunder across a game.
 *
 * This gate pins the maths for 2 and 3 against Lichess and WintrChess, and checks the terminal
 * score handling that made a mating move look like a loss.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BUILD = join(ROOT, 'node_modules', '.cache', 'chessforge-analysis-accuracy');

let passed = 0;
const failures = [];
const ok = (cond, label, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
};
const head = (title) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);

try { rmSync(BUILD, { recursive: true, force: true }); } catch { /* best effort */ }
mkdirSync(BUILD, { recursive: true });
writeFileSync(join(BUILD, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    rootDir: join(ROOT, 'src', 'lib'), outDir: BUILD,
  },
  files: [join(ROOT, 'src', 'lib', 'accuracy.ts'), join(ROOT, 'src', 'lib', 'moveQuality.ts')],
}, null, 2));

execFileSync(process.execPath, [
  join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', join(BUILD, 'tsconfig.json'),
], { stdio: 'pipe' });

const accuracy = require(join(BUILD, 'accuracy.js'));
const quality = require(join(BUILD, 'moveQuality.js'));
const {
  winPercent, expectedPoints, pointLoss, moveAccuracy, gameAccuracy,
  evalCoverage, analysisUsable, MIN_EVAL_COVERAGE,
} = accuracy;
const { classifyMove, ACTIVE_KINDS } = quality;

/* ===========================================================================
 * 1. The two curves.
 * ========================================================================== */
head('1. Win% and expected-points curves');

ok(Math.abs(winPercent(0) - 50) < 1e-9, 'winPercent(0) is exactly 50%', String(winPercent(0)));
ok(Math.abs(winPercent(100) - 59.103) < 0.01,
  'winPercent(+1.00) matches Lichess (~59.10%)',
  String(winPercent(100)));
ok(winPercent(1000) > 97 && winPercent(-1000) < 3,
  'the curve saturates at the ends', `${winPercent(-1000)}..${winPercent(1000)}`);
ok(winPercent(200) > winPercent(100) && winPercent(-200) < winPercent(-100),
  'the curve is monotone');

ok(Math.abs(expectedPoints(0) - 0.5) < 1e-12, 'expectedPoints(0) is exactly 0.50');
ok(expectedPoints(100) > expectedPoints(0) && expectedPoints(-100) < expectedPoints(0),
  'expected points are monotone in centipawns');
ok(Math.abs(pointLoss(0, -100) - (0.5 - expectedPoints(-100))) < 1e-12,
  'pointLoss is the mover-perspective difference between two expected scores');

/* ===========================================================================
 * 2. Per-move accuracy: Lichess's formula, including the +1 bonus.
 * ========================================================================== */
head('2. Per-move accuracy');

ok(moveAccuracy(0) === 100,
  'a move that loses no win probability scores exactly 100 (the +1 bonus is not lost)',
  String(moveAccuracy(0)));
ok(Math.abs(moveAccuracy(10) - 64.5798) < 0.01,
  'a 10-point win% drop scores ~64.58, as Lichess publishes',
  String(moveAccuracy(10)));
ok(moveAccuracy(20) < moveAccuracy(10) && moveAccuracy(50) < moveAccuracy(20),
  'a larger drop always scores lower');
ok(moveAccuracy(-5) === 100,
  'a move that improves the position is capped at 100, not above it');
ok(moveAccuracy(1000) === 0, 'a catastrophic drop is floored at 0');

/* ===========================================================================
 * 3. Game accuracy: volatility-weighted mean blended with the harmonic mean.
 * ========================================================================== */
head('3. Game accuracy');

const clean = gameAccuracy([0, 20, 10, 30, 20], 'w');
ok(clean.white > 95 && clean.black > 95,
  'a game of small swings scores in the 90s for both sides',
  `${clean.white.toFixed(2)} / ${clean.black.toFixed(2)}`);

/*
 * White hangs a queen from equality on move 3; Black never errs. The old
 * plain-mean calculation would average the 0 with three 100s and call it 75%.
 * Lichess's harmonic blend must make the single disaster dominate White's score.
 */
const oneBlunder = gameAccuracy([0, 0, 0, -1000, -1000], 'w');
ok(oneBlunder.white < 25,
  'one queen blunder from equality collapses the blunderer\'s accuracy',
  String(oneBlunder.white));
ok(oneBlunder.black === 100,
  'the opponent who did nothing wrong still scores 100',
  String(oneBlunder.black));

/*
 * A game that starts with Black to move: the first pair belongs to Black, not
 * to White. This is the `startColor` branch, and getting it wrong would swap
 * the two players' scores in imported positions.
 */
// Black moves first and hands White a winning position, so the centipawn score
// goes UP from White's point of view. The old fixture used -1000, which means
// Black improved — correctly a 100% move — and was testing the wrong sign.
const blackFirst = gameAccuracy([0, 1000, 1000, 1000], 'b');
ok(blackFirst.black < 25 && blackFirst.white === 100,
  'a Black-to-move game assigns the first move to Black',
  `${blackFirst.white} / ${blackFirst.black}`);

ok(gameAccuracy([0, 0], 'w').white === 100 && gameAccuracy([0, 0], 'w').black === 100,
  'a two-position game is well-defined and perfect');

/* ===========================================================================
 * 4. The classifier's bands are expected-score bands, not 50cp bands.
 * ========================================================================== */
head('4. Good / mistake / blunder');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const classify = (cpAfter) => classifyMove({
  ply: 20, playedUci: 'e2e4', bestUci: 'd2d4',
  fenBefore: START, fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  cpBefore: 0, cpAfter, mover: 'w', bookPlies: 0,
});

ok(classify(-100) === 'good', '100cp from equality is good (~8% expected score)');
ok(classify(-135) === 'good', '135cp is still good, just below the 12% line');
ok(classify(-145) === 'mistake', '145cp is a mistake, just over the 12% line');
ok(classify(-240) === 'mistake', '240cp is still a mistake');
ok(classify(-280) === 'blunder', '280cp is a blunder, over the 22% line');
ok(classify(-2000) === 'blunder', 'losing a queen is a blunder');

/*
 * THE MATE-TO-SCORE TRANSITION.
 *
 * The review folds a forced mate onto the centipawn scale near +10000. When a
 * winning combination simplifies into a position that is "only" +4.20, the raw
 * expected-points difference is large enough to print "mistake" on a move in a
 * game the player is still winning. Lichess's win-probability curve is much
 * flatter there (100% to ~81%), which is under its mistake boundary. The
 * classifier now keeps the same verdict as Lichess for that transition.
 *
 * `classify` here takes the position AFTER the move as a centipawn value from
 * the mover's perspective, with the mover on white.
 */
const classifyFromMate = (cpAfter) => classifyMove({
  ply: 40, playedUci: 'e2e4', bestUci: 'd2d4',
  fenBefore: START, fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  cpBefore: 9990, cpAfter, mover: 'w', bookPlies: 0,
});
ok(classifyFromMate(420) === 'good',
  'from a forced mate to +4.20 is good — still a won game',
  classifyFromMate(420));
ok(classifyFromMate(100) === 'blunder',
  'CONTROL: throwing the mate away for +1.00 is a blunder',
  classifyFromMate(100));

/*
 * A mating move is best even when the engine returned no `bestmove` at all.
 * This is the icon bug that used to appear on the last move of a game: without
 * a matching bestmove, a checkmate fell through the eval ladder, and the final
 * position's mate score could be read with the wrong sign.
 */
const FOOLS_MATE_BEFORE = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 3';
const fools = new Chess(FOOLS_MATE_BEFORE);
fools.move('Qh4');
ok(new Chess(fools.fen()).isCheckmate(), 'the checkmate fixture really is checkmate');
const mateKind = classifyMove({
  ply: 3, playedUci: 'd8h4', bestUci: null,
  fenBefore: FOOLS_MATE_BEFORE, fenAfter: fools.fen(),
  cpBefore: 0, cpAfter: -10000, mover: 'b', bookPlies: 0,
});
ok(mateKind === 'best',
  'a checkmating move is `best` even with no reported bestmove (not `good` or `blunder`)',
  mateKind);

/* ===========================================================================
 * 5. The screen uses the shared maths and handles terminal positions.
 * ========================================================================== */
head('5. Screen wiring');

const screen = readFileSync(join(ROOT, 'src', 'components', 'screens', 'AnalysisScreen.tsx'), 'utf8');
const screenTight = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(/import \{ gameAccuracy, winPercent, analysisUsable \} from '@\/lib\/accuracy';/.test(screen),
  'the analysis screen imports the shared accuracy module');
ok(!/function winPercent\(/.test(screenTight) && !/function moveAccuracy\(/.test(screenTight),
  'the screen no longer keeps private copies of the formulas');
ok(/const cps: \(number \| null\)\[\] = moves\.length > 0\s*\n\s*\? \[moves\[0\]\.cpBefore, \.\.\.moves\.map\(\(m\) => m\.cpAfter\)\]/.test(screen),
  'the game-accuracy input is initial eval + one eval after every move');
ok(/const accuracy = gameAccuracy\(cps, moves\[0\]\?\.mover \?\? 'w'\);/.test(screen),
  'the screen calls the Lichess-style game accuracy, not a plain mean');
ok(/if \(mateIn === 0\) \{[\s\S]*?cp = -10000;/.test(screenTight),
  'mate 0 is read as the side to move being mated, not as a win for that colour');
ok(/function terminalEval\(fen: string\): EngineEval \| null/.test(screenTight)
  && /if \(!board\.isGameOver\(\)\) return null;/.test(screenTight),
  'terminal positions are answered by the board instead of being searched');
ok(/const turn = turnOf\(fens\[i\]\);/.test(screenTight)
  && /const nextTurn = turnOf\(fens\[i \+ 1\]\);/.test(screenTight)
  && !/const turn: 'w' \| 'b' = i % 2 === 0/.test(screenTight),
  'the mover comes from each FEN, not from an even/odd index, so a Black-to-move start is graded correctly');
ok((screen.match(/new Chess\(report\.startFen\)/g) ?? []).length === 2,
  'review and branch replay both start from the PGN\'s own FEN');
ok(/const standardStart = positionKey\(fens\[0\]\) === positionKey\(new Chess\(\)\.fen\(\)\)/.test(screenTight)
  && /const hit = standardStart \? bestCoverageAcrossOpenings\(sans\) : null;/.test(screenTight),
  'opening-book matching is skipped for a non-standard start instead of naming a line the game never played');

const evalBar = readFileSync(join(ROOT, 'src', 'components', 'chess', 'EvalBar.tsx'), 'utf8');
ok(/import \{ winPercent \} from '@\/lib\/accuracy';/.test(evalBar)
  && /export \{ winPercent \} from '@\/lib\/accuracy';/.test(evalBar),
  'the eval bar uses the same win% curve as the review');

ok(ACTIVE_KINDS.join(',') === 'brilliant,best,good,book,mistake,blunder',
  'the displayed vocabulary is unchanged (no retired label came back)',
  ACTIVE_KINDS.join(','));

try { rmSync(BUILD, { recursive: true, force: true }); } catch { /* best effort */ }

try { rmSync(BUILD, { recursive: true, force: true }); } catch { /* best effort */ }

/* ===========================================================================
 * 6. NO EVIDENCE, NO REVIEW.
 *
 * THE REPORT: *"i tried analysing a game and it is 100% acc for both and always
 * 0.0 in eval bar while the game has a lot of errors"*. That is what a review
 * built from NULL evaluations looks like: every move loses 0 centipawns, so both
 * players score 100 and the bar never moves. The screen now refuses to publish a
 * report whose evals are mostly missing, and this is the test for that rule.
 * ========================================================================== */
head('6. An empty engine answer cannot be published as a perfect game');

ok(evalCoverage([]) === 0, 'no evals is no coverage');
ok(evalCoverage([{ scoreCp: null, mateIn: null }]) === 0,
  'a position with neither a score nor a mate counts as un-evaluated');
ok(evalCoverage([{ scoreCp: 0, mateIn: null }]) === 1,
  'a real 0.00 evaluation IS an evaluation — it must not be mistaken for missing');
ok(evalCoverage([{ scoreCp: null, mateIn: 3 }]) === 1,
  'a mate score with no centipawn value counts as evaluated');
ok(Math.abs(evalCoverage([{ scoreCp: null, mateIn: null }, { scoreCp: 20, mateIn: null }]) - 0.5) < 1e-9,
  'coverage is the share of positions that carry an evaluation');

ok(analysisUsable(Array.from({ length: 10 }, () => ({ scoreCp: 10, mateIn: null }))),
  'a fully evaluated game is usable');
ok(!analysisUsable(Array.from({ length: 10 }, () => ({ scoreCp: null, mateIn: null }))),
  'a game the engine never answered is NOT usable — this is the 100%/0.0 bug');
ok(!analysisUsable([{ scoreCp: 20, mateIn: null }, { scoreCp: null, mateIn: null }, { scoreCp: null, mateIn: null }, { scoreCp: null, mateIn: null }]),
  'and one real evaluation among mostly nulls is still not a review');
ok(MIN_EVAL_COVERAGE > 0 && MIN_EVAL_COVERAGE <= 1, 'the coverage floor is a real fraction');

console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
  console.log('FAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
