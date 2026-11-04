/**
 * GATE 1r — a move is classified from a WHITE-PERSPECTIVE eval, or it is not classified at all.
 *
 * WHAT THIS EXISTS BECAUSE OF
 * ==========================
 * Two reports that looked unrelated:
 *
 *   *"you keep refering for my moves as blender while they are not"*
 *   *"the puzzles should be about a blunder or a missed win not just random positions"*
 *
 * One cause. `classifyMove` documents its inputs as white-perspective and applies `MOVER()` itself:
 *
 *     cpBefore: number;   // White-perspective cp BEFORE the move
 *     cpAfter:  number;   // White-perspective cp AFTER the move
 *
 *     const MOVER = (cp, mover) => (mover === 'w' ? cp : -cp);
 *
 * Both callers in `gameScan.ts` passed the MOVER's perspective instead. The engine reports from the
 * side to move, and at `fenBefore` that is the mover, so the value is already the mover's — and
 * `classifyMove` then negates it again for Black. Every Black game was classified on an inverted
 * eval. Measured against the real classifier:
 *
 *     the mover is +30 and drops to -370 — a 400cp mistake
 *       as White, mover-perspective == white-perspective  ->  blunder   (correct)
 *       as Black,  mover-perspective (what the code sent) ->  good      (WRONG)
 *       as Black,  white-perspective (what it wants)      ->  blunder   (correct)
 *
 * And a clean move? Black's came back `good` too, so the failure was not "everything is a blunder" —
 * it was that `drop = max(0, before - after)` collapses to zero for every real Black mistake. Half the
 * archive was graded as if nothing had ever gone wrong: no blunders, no mistakes, and a mined puzzle
 * deck with almost nothing in it but `brilliant`, which the same inversion made look free.
 *
 * WHY THIS RUNS THE REAL FUNCTION
 * ===============================
 * The bug is a SIGN, and a sign cannot be checked by reading source. Every line of the old code was
 * individually reasonable — the comment above the negation even claimed, wrongly, that the
 * mover-perspective convention was "the convention `classifyMove` expects". So this transpiles both
 * modules and calls them, and asserts the verdict for a known event.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const require_ = createRequire(import.meta.url);

let passed = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('   PASS  ' + msg); }
  else { failures.push(msg); console.log('   FAIL  ' + msg + (detail ? `\n          ${detail}` : '')); }
}
function head(t) { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }

/*
 * `moveQuality.ts` now imports `./accuracy`, so both files have to land in the
 * same temp directory with the names the emitted require() expects. Writing
 * them beside the test as `.mq-under-test.cjs` worked when chess.js was the
 * only dependency; a sibling `accuracy.cjs` would not satisfy `require('./accuracy')`
 * because Node does not append `.cjs` for an extensionless specifier.
 */
const TMP = mkdtempSync(join(HERE, '.qualitysign-'));
function load(relPath, outName) {
  const src = readFileSync(join(ROOT, relPath), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const out = join(TMP, outName);
  writeFileSync(out, js, 'utf8');
  return out;
}

// Load the classifier's siblings first so the emitted `moveQuality.js` can
// resolve its relative imports against files that already exist in TMP.
load('src/lib/accuracy.ts', 'accuracy.js');
load('src/lib/sacrifice.ts', 'sacrifice.js');
const mqPath = load('src/lib/moveQuality.ts', 'moveQuality.js');
const { classifyMove } = require_(mqPath);

const scanSrc = readFileSync(join(ROOT, 'src', 'lib', 'gameScan.ts'), 'utf8');
const tight = scanSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ===========================================================================
 * 1. THE SIGN. A known event, classified for both colours.
 * =========================================================================== */
head('1. A 400cp MISTAKE IS A BLUNDER FOR BOTH COLOURS');

// Any legal position; only the numbers matter to the classifier.
const FEN_BEFORE = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 3';
const FEN_AFTER = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR w KQkq - 0 3';
const base = {
  ply: 10, playedUci: 'd8d5', bestUci: 'd8f7', fenBefore: FEN_BEFORE, fenAfter: FEN_AFTER, bookPlies: 0,
};

/** The mover is +30 and gives it away, ending at -370. */
const MOVER_VIEW = { cpBefore: 30, cpAfter: -370 };
/** The same event as WHITE-PERSPECTIVE numbers, which is what the function documents. */
const WHITE_VIEW = { cpBefore: -30, cpAfter: 370 };

const asWhite = classifyMove({ ...base, ...MOVER_VIEW, mover: 'w' });
const blackMoverView = classifyMove({ ...base, ...MOVER_VIEW, mover: 'b' });
const blackWhiteView = classifyMove({ ...base, ...WHITE_VIEW, mover: 'b' });

ok(asWhite === 'blunder', 'the same mistake as White is a blunder', `got ${asWhite}`);
ok(blackWhiteView === 'blunder',
    'CONTROL: the same mistake as Black, in WHITE-perspective numbers, is a blunder',
    `got ${blackWhiteView}`);
ok(blackMoverView !== blackWhiteView,
    'CONTROL: passing the mover\'s perspective instead INVERTS the verdict for Black',
    `mover-view gave ${blackMoverView}, white-view gave ${blackWhiteView}`);

/* ===========================================================================
 * 2. THE CALLERS. Both must convert, and exactly once.
 * =========================================================================== */
head('2. BOTH CALLERS PASS WHITE-PERSPECTIVE NUMBERS');

// How many times each site converts. One is correct; two is the bug; zero means it hands the
// mover's own view straight to a function that does its own conversion.
const cvt = (re) => (tight.match(re) || []).length;

ok(/const cpBefore = userIsWhite \? cpBeforeMover : -cpBeforeMover;/.test(tight),
    'CONTROL: cpBefore is converted to white-perspective before it reaches the classifier');
ok(cvt(/const cpBefore = userIsWhite \? cpBeforeMover : -cpBeforeMover;/g) === 2,
    'and BOTH scanGame and minePuzzles do it — a fix in only one would leave the other inverted',
    `found ${cvt(/const cpBefore = userIsWhite \? cpBeforeMover : -cpBeforeMover;/g)}`);

ok(cvt(/cpAfter = raw == null \? null : \(userIsWhite \? -raw : raw\);/g) === 2,
    'CONTROL: the searched cpAfter is converted the same way, at BOTH sites — a correct cpBefore '
    + 'beside an unconverted cpAfter is still an inverted drop',
    `found ${cvt(/cpAfter = raw == null \? null : \(userIsWhite \? -raw : raw\);/g)}`);

// The mate branch was already white-perspective, which is why the file could look self-consistent.
ok(/cpAfter = userIsWhite \? 10000 : -10000;/.test(tight),
    'the mate branch agrees with the conversion, so the two halves of the same function no longer '
    + 'disagree about which perspective they are in');

/* ===========================================================================
 * 3. `brilliant` IS REACHABLE AGAIN.
 * =========================================================================== */
head('3. THE MULTIPV INDEX REACHES THE CLASSIFIER');

const engineSrc = readFileSync(join(ROOT, 'src', 'lib', 'engine.ts'), 'utf8');
const engineTight = engineSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

ok(/multipv\?: number;/.test(engineSrc),
    'EngineEval carries the variation index');
ok(/multipv: msg\.multipv,/.test(engineTight),
    'CONTROL: the info handler passes it through — it used to rebuild the eval field by field and '
    + 'omit this one, so every reader fell back to index 1');

ok(/multipv: 2/.test(tight),
    'CONTROL: mining asks for two lines, because `brilliant` needs the gap to the runner-up and '
    + 'cannot be detected without it');
ok(/const bestGap = gapBetween\(/.test(tight) && /bestGap,\s*\n\s*\}\)/.test(tight),
    'and the measured gap is handed to the classifier rather than left undefined');
ok(/function gapBetween\([\s\S]*?\): number \| undefined \{[\s\S]*?return undefined;/.test(tight),
    'CONTROL: an unmeasured gap is `undefined`, not 0 — "we did not look" and "they were level" '
    + 'must not collapse, or every brilliant in the deck is suppressed');

/* --------------------------------------------------------------------------- */
console.log('\n' + '-'.repeat(60));
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
} else {
  console.log(`${passed}/${passed} passed`);
}
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failures.length ? 1 : 0);
