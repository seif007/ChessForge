/**
 * GATE — MultiPV results must describe LINE 1, not the last line the host saw.
 *
 * THE REPORT
 * ==========
 * *"i analysed a game and it is full of mistakes + the acc is not correct + the moves icons has
 * mistakes."*
 *
 * THE CAUSE
 * =========
 * `engine.analyse()` asks Stockfish for two lines because the review needs the gap to the
 * runner-up to tell `brilliant` from `best`. Stockfish sends one `info` block per line per depth,
 * and the host forwards them all. `bestmove.info` carries whichever block arrived last — normally
 * line 2. The old code copied that block's `scoreCp`/`mateIn` onto the result, while `lines[0]`
 * was correctly the top line.
 *
 * The analysis screen then used the scalar `scoreCp` for both sides of every move's accuracy and
 * grade, and `lines` for the brilliant gap. It was grading the runner-up's evaluation while
 * displaying the best line. A two-line search could therefore produce a different score before
 * and after a move that had not changed the position at all, which is exactly the kind of phantom
 * centipawn loss that turns a whole game orange.
 *
 * WHAT THIS GATE DRIVES
 * =====================
 * The real `ChessEngine` class, with a fake WebView that answers a MultiPV search in the same
 * order the shipped host does: line 1, line 2, then `bestmove` carrying line 2 as `info`.
 * It is a behavioural test — no source matching for the assertion that matters.
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TARGET = join(ROOT, 'src', 'lib', 'engine.ts');
const TEMP = join(HERE, '.engine-analysis-under-test.cjs');

let passed = 0;
const failures = [];
const ok = (cond, label, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
};
const head = (title) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);

const src = readFileSync(TARGET, 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
writeFileSync(TEMP, js, 'utf8');

const realWarn = console.warn;
const realError = console.error;
console.warn = () => {};
console.error = () => {};

let ChessEngine;
try {
  ({ ChessEngine } = await import(`file:///${TEMP.replace(/\\/g, '/')}`));
} catch (err) {
  console.warn = realWarn;
  console.error = realError;
  console.error(`could not load ${TARGET}: ${err && err.message}`);
  process.exit(1);
}

function fakeHost() {
  const posts = [];
  return {
    posts,
    postMessage(raw) { posts.push(JSON.parse(raw)); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const info = (multipv, scoreCp, depth, uci) => ({
  type: 'info',
  bestMoveUci: uci,
  scoreCp,
  mateIn: null,
  depth,
  pvUci: [uci, 'g8f6'],
  multipv,
});

async function bootEngine() {
  const engine = new ChessEngine();
  const host = fakeHost();
  engine.attach(host);
  engine.handleMessage(JSON.stringify({ type: 'ready' }));
  return { engine, host };
}

/* ===========================================================================
 * 1. A TWO-LINE SEARCH: the scalar fields belong to line 1.
 * ========================================================================== */
head('1. MultiPV two: scalar eval and PV are line 1, not the last info block');

{
  const { engine, host } = await bootEngine();
  const seen = [];
  const resultPromise = engine.analyse(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    { movetime: 50, multipv: 2, onInfo: (ev) => seen.push(ev) },
  );
  await sleep(10);

  const line1 = info(1, 25, 12, 'g1f3');
  const line2 = info(2, -80, 12, 'd2d4');
  engine.handleMessage(JSON.stringify(line1));
  engine.handleMessage(JSON.stringify(line2));
  // The real host attaches its last-seen info block to `bestmove`; that is line 2 here.
  engine.handleMessage(JSON.stringify({
    type: 'bestmove', uci: 'g1f3', info: line2,
  }));

  const result = await resultPromise;
  ok(result.scoreCp === 25,
    'the returned score is line 1 (25), not the last info block (-80)',
    `got ${result.scoreCp}`);
  ok(result.mateIn === null && result.pvUci[0] === 'g1f3',
    'the returned mate score and PV describe line 1 as well',
    `mate=${result.mateIn} pv=${result.pvUci?.join(' ')}`);
  ok(result.bestMoveUci === 'g1f3',
    'the authoritative bestmove uci is preserved');
  ok(result.lines?.length === 2
    && result.lines[0].scoreCp === 25
    && result.lines[1].scoreCp === -80,
    'both MultiPV lines are still reported, best first',
    JSON.stringify(result.lines));
  ok(seen.length === 2,
    'the streaming callback still received both lines',
    `received ${seen.length}`);
  ok(host.posts.some((p) => p.cmd === 'setoption' && /MultiPV value 2/.test(p.line)),
    'the request really declared MultiPV 2 (otherwise the fixture is not exercising the bug)');
  engine.destroy();
}

/* ===========================================================================
 * 2. A SHALLOWER DUPLICATE MUST NOT OVERWRITE A DEEPER LINE.
 * ========================================================================== */
head('2. The deepest report wins inside each MultiPV slot');

{
  const { engine } = await bootEngine();
  const resultPromise = engine.analyse(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    { movetime: 50, multipv: 2 },
  );
  await sleep(10);

  engine.handleMessage(JSON.stringify(info(1, 40, 10, 'g1f3')));
  engine.handleMessage(JSON.stringify(info(1, 18, 13, 'g1f3')));
  engine.handleMessage(JSON.stringify(info(2, -70, 13, 'd2d4')));
  // A late, shallower line-1 block — the old `< 0` depth check would accept it.
  engine.handleMessage(JSON.stringify(info(1, 99, 7, 'g1f3')));
  engine.handleMessage(JSON.stringify({ type: 'bestmove', uci: 'g1f3', info: info(2, -70, 13, 'd2d4') }));

  const result = await resultPromise;
  ok(result.scoreCp === 18,
    'line 1 keeps its depth-13 score, not the late depth-7 duplicate',
    `got ${result.scoreCp}`);
  ok(result.lines?.[0]?.scoreCp === 18,
    'and `lines[0]` agrees with the scalar score');
  engine.destroy();
}

/* ===========================================================================
 * 3. THE FIX IS PRESENT IN THE SOURCE, NOT ONLY IN THIS FIXTURE'S PATH.
 * ========================================================================== */
head('3. Source guards');

const tight = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(/const top = sorted\[0\];/.test(tight),
  'the result copies scalar fields from `sorted[0]`');
ok(/out\.scoreCp = top\.scoreCp;/.test(tight)
  && /out\.mateIn = top\.mateIn;/.test(tight)
  && /out\.pvUci = top\.pvUci;/.test(tight),
  'score, mate and PV are all taken from the top line');
ok(/if \(prev && depth < prev\.depth\) return;/.test(tight),
  'the per-slot depth comparison is against the stored depth, not against zero');

for (const f of [TEMP]) { try { unlinkSync(f); } catch { /* best effort */ } }
console.warn = realWarn;
console.error = realError;

console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
  console.log('FAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
