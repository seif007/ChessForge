/*
 * ARE "FROM YOUR GAMES" PUZZLES ACTUALLY PUZZLES?
 *
 * The report: *"the puzzles from the user games in our app dont seem like they are puzzle, but
 * just a mistake and what to play instead and that's it."* The old miner stored one engine move,
 * the screen compared one move, and the puzzle ended. That is a quiz about a mistake, not a
 * forced line.
 *
 * This gate exercises the pure line rules with a fake analyser: replay, odd-length trimming,
 * first-move and later-move uniqueness, and the legacy one-move fallback. It also checks that the
 * miner and the screen are wired to those rules, because a correct helper nobody calls would not
 * change a single puzzle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-minedpuzzle');

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', moduleResolution: 'node', skipLibCheck: true,
    noEmitOnError: false, esModuleInterop: true, rootDir: ROOT, outDir: BUILD_DIR,
    ignoreDeprecations: '6.0',
  },
  files: [path.join(ROOT, 'src', 'lib', 'puzzleLine.ts')],
}, null, 2));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project', path.join(BUILD_DIR, 'tsconfig.json'),
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 2000));
  process.exit(2);
}

const line = require(path.join(BUILD_DIR, 'src', 'lib', 'puzzleLine.js'));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let checks = 0;
let failures = 0;
function ok(cond, label, detail = '') {
  checks += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures += 1;
}
function head(t) {
  console.log(`\n${'-'.repeat(78)}\n${t}\n${'-'.repeat(78)}`);
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PV3 = ['e2e4', 'e7e5', 'g1f3'];
const PV5 = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];

/** A fake MultiPV report: the first line is the answer, the second is the runner-up. */
function report(best, score, secondScore) {
  return {
    bestMoveUci: best,
    scoreCp: score,
    mateIn: null,
    lines: [
      { uci: best, scoreCp: score, mateIn: null, pvUci: [] },
      { uci: 'a2a3', scoreCp: secondScore, mateIn: null, pvUci: [] },
    ],
  };
}

head('1. A PV REPLAYS INTO A LEGAL LINE, AND ONLY ODD PLIES ARE A PUZZLE');
{
  const three = line.replayPuzzlePv(START, PV3, 5);
  ok(three.length === 3 && three.map((m) => m.san).join(' ') === 'e4 e5 Nf3',
    'three plies replay as e4 e5 Nf3');
  ok(three[2].fenAfter.split(' ')[1] === 'b',
    'the final position has the opponent to move, because the solver made the last move');

  const five = line.buildPuzzleSolution(START, PV5, 5);
  ok(five.length === 5 && five[4].san === 'Bb5',
    'a five-ply PV becomes a five-ply puzzle');

  const even = line.buildPuzzleSolution(START, ['e2e4', 'e7e5'], 5);
  ok(even.length === 0,
    'a PV that ends on the opponent reply is not a complete puzzle');

  const truncated = line.buildPuzzleSolution(START, ['e2e4', 'e7e5', 'e2e4'], 5);
  ok(truncated.length === 0,
    'an illegal later move stops the replay; the legal prefix is too short to be a puzzle');

  const one = line.buildPuzzleSolution(START, ['e2e4'], 5);
  ok(one.length === 0, 'a one-move answer is explicitly not a mined puzzle');
}

head('2. THE FIRST MOVE AND EVERY LATER SOLVER MOVE MUST BE UNIQUE');
{
  const three = line.replayPuzzlePv(START, PV3, 5);
  const good = async (fen) => {
    if (fen === three[1].fenAfter) return report('g1f3', 220, 20);
    throw new Error(`unexpected position ${fen}`);
  };

  const cooked = await line.cookMinedLine(START, PV3, 'e2e4', good, { firstGap: 220 });
  ok(cooked.length === 3 && cooked[0].uci === 'e2e4' && cooked[2].san === 'Nf3',
    'a unique first move and a unique follow-up produce the full line');

  const weakFirst = await line.cookMinedLine(START, PV3, 'e2e4', good, { firstGap: 100 });
  ok(weakFirst.length === 0, 'a first move with no gap to its runner-up is rejected');

  const wrongFirst = await line.cookMinedLine(START, PV3, 'd2d4', good, { firstGap: 220 });
  ok(wrongFirst.length === 0, 'a PV that starts with a different move is rejected');

  const ambiguousFollowUp = await line.cookMinedLine(START, PV3, 'e2e4', async (fen) => {
    if (fen === three[1].fenAfter) return report('g1f3', 220, 200);
    throw new Error(`unexpected position ${fen}`);
  }, { firstGap: 220 });
  ok(ambiguousFollowUp.length === 0,
    'if the second solver move has an equally good alternative, there is no multi-move puzzle');

  const five = line.replayPuzzlePv(START, PV5, 5);
  const laterAmbiguous = await line.cookMinedLine(START, PV5, 'e2e4', async (fen) => {
    if (fen === five[1].fenAfter) return report('g1f3', 260, 20);
    if (fen === five[3].fenAfter) return report('f1b5', 260, 240);
    throw new Error(`unexpected position ${fen}`);
  }, { firstGap: 260 });
  ok(laterAmbiguous.length === 3 && laterAmbiguous[2].san === 'Nf3',
    'a non-unique third solver move trims to the already-verified three-ply line');

  const laterUnique = await line.cookMinedLine(START, PV5, 'e2e4', async (fen) => {
    if (fen === five[1].fenAfter) return report('g1f3', 260, 20);
    if (fen === five[3].fenAfter) return report('f1b5', 260, 20);
    throw new Error(`unexpected position ${fen}`);
  }, { firstGap: 260 });
  ok(laterUnique.length === 5 && laterUnique[4].san === 'Bb5',
    'a unique third solver move keeps the five-ply line');
}

head('3. LEGACY ONE-MOVE RECORDS READ BUT ARE NOT PLAYABLE');
{
  const old = { bestUci: 'e2e4', bestSan: 'e4' };
  const fallback = line.puzzleSolution(old);
  ok(fallback.length === 1 && fallback[0].san === 'e4',
    'the old record still has a readable fallback for code that must not crash');
  ok(line.isMinedPuzzlePlayable(old) === false,
    'but it is not offered as a puzzle - that is the format the user rejected');

  const modern = { solution: line.buildPuzzleSolution(START, PV3, 5) };
  ok(line.isMinedPuzzlePlayable(modern) === true,
    'a three-ply line is playable');
  ok(line.isMinedPuzzlePlayable({ solution: modern.solution.slice(0, 2) }) === false,
    'an even two-ply record is not playable');
}

head('4. THE MINER AND THE SCREEN ACTUALLY USE THESE RULES');
{
  const scan = read('src', 'lib', 'gameScan.ts');
  ok(/cookMinedLine\(/.test(scan) && /search\.pvUci/.test(scan),
    'the miner cooks the engine PV into a line');
  ok(/solutionVersion: 2/.test(scan) && /solution,/.test(scan),
    'and stores the multi-move solution with a version marker');
  ok(/MIN_PUZZLE_START_CP/.test(scan) && /MIN_PUZZLE_ONLY_MOVE_CP/.test(scan),
    'the start-position and only-move gates are named constants, not inline magic');
  ok(/theme !== 'brilliant' && cpBeforeMover/.test(scan),
    'a brilliant is kept even when it starts from a worse position - the only move is the puzzle');
  ok(/alreadyMined/.test(scan) && /solutionVersion === 2/.test(scan),
    'a verified line already in the deck is not searched again on the next import batch');

  const screen = read('src', 'components', 'screens', 'PuzzlesScreen.tsx');
  ok(/puzzleSolution\(puzzle\)/.test(screen) && /solution\[step\]/.test(screen),
    'the screen plays the current step of the stored line');
  ok(/playOpponentReply/.test(screen) && /setPlayedSans/.test(screen),
    'opponent replies are auto-played and the line is shown as it grows');
  ok(/isMinedPuzzlePlayable/.test(screen),
    'and the retired one-move records are filtered out of the deck');

  const plan = read('src', 'lib', 'scanPlan.ts');
  ok(/isMinedPuzzlePlayable/.test(plan)
    && /const playable = all\.filter\(isMinedPuzzlePlayable\)/.test(plan),
    'the capped merge prefers real lines, so legacy records cannot hide them');
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
