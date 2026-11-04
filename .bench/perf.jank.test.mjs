/**
 * JANK — the work the app paid for on every frame, and no longer does.
 *
 * THE REPORT: *"the app is slow now ... page transitions, and when i open an opening"*.
 *
 * Two of the costs behind a complaint like that are invisible in a screenshot and
 * reproducible here, because neither is about a device: they are work done in a RENDER
 * that does not depend on the render.
 *
 *   1. Building a chess board to read one field of a FEN. `new Chess(fen).turn()` parses
 *      the whole position — placement, castling, en passant, counters — and three of them
 *      sat in render bodies: the Analyse review (which re-renders on every engine
 *      evaluation, several times a second while a search runs) and the puzzle board
 *      (which re-renders on every touch and every reply). A FEN's second field is the
 *      answer, and this file pins both the answer and how much cheaper it is.
 *
 *   2. The clock. `const now = Date.now()` in HomeScreen's render body was a dependency
 *      of both due-count memos AND of `buildDailyPlan`, so every memo recomputed on every
 *      render — the memo arrays were correct and could never hit. The four store-wide
 *      counts below them were not memoised at all.
 *
 * And the background: the one component that paints under every screen was rebuilding
 * its 28 rings during render and re-rendering with the shell on every tab tap. Android
 * then alpha-blended 28 large translucent circles on every frame that redrew the window.
 * A static background is the textbook case for a hardware texture; the shell that
 * re-renders around it is the textbook case for `memo`.
 *
 * WHAT THIS GATE CAN AND CANNOT SEE. It cannot measure a frame. It can measure the two
 * functions (above), and it can hold the four structural facts the fixes rest on, each
 * one chosen so the reverted code fails it: the ring geometry is at module scope, the
 * component is memoised and rasterised, the clock is state, and no render path builds a
 * board to ask whose turn it is. That is the honest boundary — with the numbers printed
 * so a regression shows up as a number as well as a failure.
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
const SRC = path.join(ROOT, 'src');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-perfjank');

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [path.join(SRC, 'lib', 'fen.ts')],
}, null, 2));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project',
    path.join(BUILD_DIR, 'tsconfig.json'),
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

const { turnOf } = require(findEmitted(BUILD_DIR, 'fen.js'));

console.log('1. TURN FROM A FEN — SAME ANSWER AS THE BOARD, WITHOUT THE BOARD');
console.log('   ------------------------------------------------------------');

/*
 * The corpus is played out rather than typed in, so it covers both colours, both
 * castling states and both en-passant states without anyone having to remember what
 * a FEN's fourth and fifth fields look like.
 */
const FENS = [];
{
  const c = new Chess();
  FENS.push(c.fen());
  for (const san of [
    'e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6',
    'Be3', 'e5', 'Nb3', 'Be6', 'f3', 'Be7', 'Qd2', 'O-O', 'O-O-O', 'Nbd7',
  ]) {
    c.move(san);
    FENS.push(c.fen());
  }
}
ok('the corpus has both colours to move',
  FENS.some((f) => new Chess(f).turn() === 'w') && FENS.some((f) => new Chess(f).turn() === 'b'),
  `${FENS.length} FENs`);

const mismatched = FENS.filter((f) => turnOf(f) !== new Chess(f).turn());
ok('turnOf agrees with chess.js on every position reached',
  mismatched.length === 0,
  mismatched.slice(0, 2).join(' | '));

ok('and it defaults to White rather than throwing on empty input',
  turnOf(null) === 'w' && turnOf(undefined) === 'w' && turnOf('') === 'w');

/* ------------------------------------------------------------------ the cost */

const N = 3000;

/**
 * Best of three rounds, not one shot.
 *
 * A single loop is at the mercy of whatever else the machine is doing (this gate's first
 * run measured the cheap path at 38 microseconds a call — exactly the cost of the expensive
 * one, which is how a stall disguises itself as a result). The minimum is the round least
 * disturbed by the operating system, which is the steady-state cost we care about. The
 * threshold is 5x against a measured ~190x, so even a laptop having a bad day cannot make
 * this flaky in the direction that matters.
 */
function bestOf(rounds, fn) {
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t = process.hrtime.bigint();
    for (let i = 0; i < N; i++) fn(i);
    best = Math.min(best, Number(process.hrtime.bigint() - t));
  }
  return best;
}

{
  // Warm both paths so this measures steady-state cost, not the first-call JIT.
  for (let i = 0; i < 300; i++) { turnOf(FENS[i % FENS.length]); new Chess(FENS[i % FENS.length]).turn(); }
}
const turnNs = bestOf(3, (i) => turnOf(FENS[i % FENS.length]));
const boardNs = bestOf(3, (i) => new Chess(FENS[i % FENS.length]).turn());

const ratio = boardNs / turnNs;
console.log(`   ${N} calls x3: turnOf ${(turnNs / N).toFixed(0)} ns/call, new Chess(...).turn() ${(boardNs / N).toFixed(0)} ns/call  (${ratio.toFixed(0)}x)`);
ok('reading the field is at least 5x cheaper than building the board',
  ratio >= 5,
  `${ratio.toFixed(1)}x — if this is close to 1 the render-path fix buys nothing`);

console.log('\n2. NO RENDER PATH BUILDS A BOARD TO ASK WHOSE TURN IT IS');
console.log('   -----------------------------------------------------');

/** Every `.ts`/`.tsx` under a directory, so a new screen is covered without being named. */
function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/*
 * The rule is the CALL SHAPE, not the file list: `new Chess(fen).turn()` is always this
 * cost, wherever it is written. `turnOf(...)` is the substitution. A file that keeps the
 * board for real work (moving pieces, replaying a line) is untouched — `new Chess(` is
 * everywhere and is fine; it is the throwaway board that is not.
 *
 * COMMENTS ARE NOT CODE, and this repository writes comments that QUOTE the line a fix
 * replaced. Scanning raw text finds those receipts and calls the fix the offender, which
 * is how this gate first failed on its own explanation. So the scan strips comments first.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // `(^|[^:])` keeps a URL's `//` from swallowing the rest of the line.
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const COMPONENT_FILES = sourceFiles(path.join(SRC, 'components'));
const offenders = [];
for (const file of COMPONENT_FILES) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const re = /new Chess\([^)]*\)\.turn\(\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    offenders.push(`${path.relative(SRC, file)}: ${m[0]}`);
  }
}
ok('no component builds a throwaway board just to read whose turn it is',
  offenders.length === 0,
  offenders.slice(0, 4).join(' | '));

ok('CONTROL: the scan is reading real files, so a clean result means something',
  COMPONENT_FILES.length > 10 && COMPONENT_FILES.some((f) => fs.readFileSync(f, 'utf8').includes('new Chess(')),
  `${COMPONENT_FILES.length} component files scanned`);

/*
 * And the substitution is actually deployed: a rule with no callers is a comment. The
 * Analyse review and the puzzle board are the two that were paying it per frame.
 */
const ANALYSIS = fs.readFileSync(path.join(SRC, 'components', 'screens', 'AnalysisScreen.tsx'), 'utf8');
const PUZZLES = fs.readFileSync(path.join(SRC, 'components', 'screens', 'PuzzlesScreen.tsx'), 'utf8');
ok('the Analyse review reads the turn with turnOf',
  /const turnAtView = turnOf\(/.test(ANALYSIS));
ok('and so does the puzzle board',
  /const turn = turnOf\(/.test(PUZZLES));

console.log('\n3. THE BACKGROUND DOES NOT REBUILD ITSELF WITH THE SHELL');
console.log('   ---------------------------------------------------');

const BG = fs.readFileSync(path.join(SRC, 'components', 'AppBackground.tsx'), 'utf8');
ok('the ring geometry is built at module scope, once',
  /^const EMERALD_RINGS = glowRings\(/m.test(BG) && /^const PINK_RINGS = glowRings\(/m.test(BG));
ok('the component is memoised, so a tab tap does not re-render it',
  /export const AppBackground = memo\(/.test(BG));
ok('the static stack is rasterised instead of blended every frame',
  /renderToHardwareTextureAndroid/.test(BG) && /shouldRasterizeIOS/.test(BG));
/*
 * CONTROL, and it is the exact regression: the ring list used to be built during render
 * with `Array.from({ length: RINGS }).map(...)` inside the component. The checks above
 * pass on the fixed file; this one slices the file at the component and fails if any ring
 * geometry is computed inside it again.
 */
const BG_BODY = BG.slice(BG.indexOf('export const AppBackground'));
ok('CONTROL: no ring geometry is computed inside the component',
  BG_BODY.length > 0 && !BG_BODY.includes('Array.from'),
  'the per-render shape was Array.from({ length: RINGS }) in the render body');

console.log('\n4. THE HOME CLOCK DOES NOT INVALIDATE EVERY MEMO ON EVERY RENDER');
console.log('   --------------------------------------------------------------');

const HOME = fs.readFileSync(path.join(SRC, 'components', 'screens', 'HomeScreen.tsx'), 'utf8');
ok('the clock is state, refreshed on a coarse interval',
  /const \[now, setNow\] = useState\(\(\) => Date\.now\(\)\)/.test(HOME)
  && /setInterval\(\(\) => setNow\(Date\.now\(\)\), 60_000\)/.test(HOME));
ok('CONTROL: the per-render clock is gone',
  !/^  const now = Date\.now\(\);$/m.test(HOME),
  '`const now = Date.now()` in the body is what made every memo miss');
for (const [name, dep] of [['startedCount', 'studies'], ['masteredCount', 'studies'], ['puzzlesSolved', 'puzzles'], ['endgamesDone', 'endgames']]) {
  const re = new RegExp(`const ${name} = useMemo\\(\\s*\\n?\\s*\\(\\) => [^,]*,\\s*\\n?\\s*\\[${dep}\\],`);
  ok(`${name} is memoised on the store map it reads`, re.test(HOME));
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
