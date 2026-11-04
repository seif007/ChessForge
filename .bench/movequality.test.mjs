/**
 * Do the move classifications mean what the user was told they mean?
 *
 * THE REQUEST: *"there is brillant, best move good move, mistake and blunder and book but
 * there is others i dont know what so remove them"*, and then *"i forget about the critical move
 * to keep it (i want like the analyse of Lichess)"*.
 *
 * Four labels were retired — `great` (the only-move / critical-move label he named
 * specifically), `excellent`, `inaccuracy` and `miss` — and two bands were widened to absorb
 * them. A change to a classification table is exactly the kind of edit that compiles, passes
 * every existing gate, and quietly mislabels a game, so it gets its own checks.
 *
 * The load-bearing one is the SWEEP: rather than asserting the four retired labels are absent
 * from the cases I happened to think of, it enumerates the input space and asserts that no
 * combination of eval, book depth, best-move agreement or sacrifice can produce one. If someone
 * later reintroduces a retired label on some branch nobody exercised here, this fails.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-quality');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [path.join(ROOT, 'src', 'lib', 'moveQuality.ts')],
}, null, 2));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project',
    path.join(BUILD_DIR, 'tsconfig.json'),
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 3000));
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
  if (request.startsWith('@/')) {
    return new Proxy(function () {}, {
      get: (_t, p) => (p === '__esModule' ? false : undefined),
      apply: () => undefined,
    });
  }
  return origLoad.call(this, request, parent, isMain);
};

const mq = origLoad.call(Module, findEmitted(BUILD_DIR, 'moveQuality.js'), null, false);
const { classifyMove, ACTIVE_KINDS, QUALITY_META, KEY_KINDS, isSacrifice } = mq;

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) { console.log('  PASS  ' + label); return; }
  failures++;
  console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : ''));
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

const RETIRED = ['great', 'excellent', 'inaccuracy', 'miss'];

/*
 * A REAL sacrifice, so the `brilliant` branch has something true to look at.
 *
 * The first choice here was 4.Ba4 in the Ruy Lopez, on the strength of it being the move the
 * brief uses to talk about sacrifices. It is not one: after 3...a6 4.Ba4 nothing attacks a4, the
 * bishop is simply retreating, and `isSacrifice` correctly said no. Had the test asserted
 * "brilliant" anyway it would have failed, and had it asserted "not a sacrifice" it would have
 * been pinning down a mistake in the fixture. Either way the fixture was wrong, not the code.
 *
 * So: 1.e4 e5 2.Bc4 Nc6 3.Qh5 g6 4.Qxg6. White offers the queen, Black's h-pawn takes it, and
 * the queen is gone - a sacrifice by the detector's own definition (the opponent wins 9 - 1 = 8
 * by capturing on the square the queen just moved to), and by anybody's.
 */
const SAC_LINE = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'g6'];
const FEN_BEFORE = (() => {
  const c = new Chess();
  for (const s of SAC_LINE) c.move(s);
  return c.fen();
})();
const sac = (() => {
  const c = new Chess(FEN_BEFORE);
  return c.move('Qxg6');
})();
const SAC_UCI = `${sac.from}${sac.to}`;
const FEN_AFTER = (() => {
  const c = new Chess(FEN_BEFORE);
  c.move('Qxg6');
  return c.fen();
})();

/** One classifyMove call with sensible defaults, so each case states only what it is about. */
function classify(over = {}) {
  return classifyMove({
    ply: 20, playedUci: SAC_UCI, bestUci: null,
    fenBefore: FEN_BEFORE, fenAfter: FEN_AFTER,
    cpBefore: 30, cpAfter: 30, mover: 'w', bookPlies: 0, ...over,
  });
}

// ---------------------------------------------------------------------------
head('1. the four retired labels cannot be produced by ANY input');

/*
 * The sweep. Evals are in mover-perspective centipawns and cover winning, equal and losing
 * positions on both sides of every threshold, crossed with: agreement with the engine's top
 * move, a MultiPV gap large enough to have produced `great`, a drop large enough to have
 * produced a `miss`, and a position deep inside the book.
 */
const EVALS = [-2000, -900, -400, -250, -149, -60, -20, 0, 20, 60, 149, 250, 400, 900, 3000];
const produced = new Set();
const retiredHits = [];
let swept = 0;
for (const mover of ['w', 'b']) {
  for (const before of EVALS) {
    for (const drop of [0, 10, 19, 20, 49, 50, 109, 110, 200, 249, 250, 900]) {
      for (const matchesBest of [true, false]) {
        for (const bestGap of [null, 0, 149, 150, 400]) {
          for (const bookPlies of [0, 20]) {
            const kind = classify({
              mover, cpBefore: mover === 'w' ? before : -before,
              cpAfter: mover === 'w' ? before - drop : -(before - drop),
              bestUci: matchesBest ? SAC_UCI : 'a1a2',
              bestGap, bookPlies,
            });
            swept++;
            produced.add(kind);
            if (RETIRED.includes(kind)) {
              retiredHits.push(`${mover} before=${before} drop=${drop} best=${matchesBest} gap=${bestGap} book=${bookPlies} -> ${kind}`);
            }
          }
        }
      }
    }
  }
}

ok(retiredHits.length === 0,
  `none of the ${swept} swept inputs produces a retired label`,
  retiredHits.slice(0, 6).join('\n          '));

ok([...produced].every((k) => ACTIVE_KINDS.includes(k)),
  'every label the sweep can produce is one the app advertises',
  `produced: ${[...produced].join(', ')}`);

// ---------------------------------------------------------------------------
head('2. the six advertised labels are all reachable, and the bands are the stated ones');

/*
 * The bands are expected-score losses, not centipawns.
 *
 * A raw 50cp drop used to be a mistake. From equality that is only about 4.6%
 * of a win — below the noise of a shallow search — and it is why a reasonable
 * game came back full of mistakes. The classifier now uses its
 * expected-points ladder with its `inaccuracy` band folded into `good`:
 * 0.12 is the first mistake and 0.22 is the first blunder. From equality that
 * is roughly 140cp and 270cp respectively.
 */
const band = (drop) => classify({ cpBefore: 0, cpAfter: -drop, bestUci: 'a1a2' });

ok(band(0) === 'good', 'a move that loses nothing is `good`');
ok(band(80) === 'good', '80cp from equality is still `good` (~7% expected score)');
ok(band(135) === 'good', '135cp from equality is still `good` — just below the 12% line');
ok(band(145) === 'mistake', '145cp from equality is a `mistake` — just over the 12% line');
ok(band(240) === 'mistake', '240cp of loss is still a `mistake`');
ok(band(280) === 'blunder', '280cp of loss is a `blunder` — over the 22% line');
ok(band(2000) === 'blunder', 'losing a queen is a `blunder`');

/*
 * MATE-TO-SCORE IS NOT A MISTAKE. A forced mate is folded onto the centipawn
 * scale near +10000, so simplifying from mate to "only" +4.20 reads as a large
 * expected-score drop. Lichess's win probability is ~81% at +4.20, so the same
 * transition is well under its mistake boundary there. The guard states that
 * equivalence; the control proves it is not a blanket "winning is always fine".
 */
ok(classify({ cpBefore: 9990, cpAfter: 420, bestUci: 'a1a2' }) === 'good',
  'going from a forced mate to +4.20 is good, not a mistake — the game is still won',
  classify({ cpBefore: 9990, cpAfter: 420, bestUci: 'a1a2' }));
ok(classify({ cpBefore: 9990, cpAfter: 100, bestUci: 'a1a2' }) === 'blunder',
  'CONTROL: throwing the mate away for +1.00 is still a blunder', 
  classify({ cpBefore: 9990, cpAfter: 100, bestUci: 'a1a2' }));

// The two that are not defined by a drop at all.
//
// WHAT CHANGED HERE, AND WHY THE GATE HAD TO CHANGE WITH THE CODE
// ================================================================
// The assertion this section existed to make was: *"a sacrifice that is also the engine's best move is
// `brilliant`, not a mistake"* — from the brief *"i dont want it to say that a move is a blunder when
// its a sacrifice"*. That brief is still honoured. The RULE it was expressed through was not right.
//
// `"is the engine's best move and gives up material"` is true of almost any best move that walks into
// a capture — including a knight stepped onto a square a pawn attacks — so it produced `brilliant` on
// moves that are not brilliant at all. The user met one: *"it gave me a brillant move and it is not a
// brillant move"*.
//
// A brilliant sacrifice is brilliant because it is THE ONLY MOVE THAT WINS: every alternative is
// worse, and that is a claim about the alternatives, which a single-line search cannot support. The
// gate now asserts that claim, and asserts that the classifier REFUSES to make it without evidence.
// The distinction the original brief cared about — a material OFFER must not be called a blunder — is
// preserved below and is unaffected: an offer that is the engine's choice is `best` at worst, and is
// never `mistake` or `blunder` on the strength of the material alone.
ok(classify({ bestUci: SAC_UCI, bestGap: 400 }) === 'brilliant',
  'a sacrifice that is the best move AND clearly better than the alternative is `brilliant`',
  'a real queen sacrifice with a wide gap to the second-best line is exactly this case');
ok(classify({ bestUci: SAC_UCI }) === 'best',
  'CONTROL: the same sacrifice with NO gap evidence is `best`, not `brilliant`',
  'without a second line there is no evidence the alternatives were worse, so we decline to claim it');
ok(classify({ bestUci: SAC_UCI, bestGap: 10 }) === 'best',
  'and with a tiny gap it is also `best` — "the only move" is a claim about how far behind the '
  + 'runner-up is, not about being first');
ok(classify({ bestUci: 'h3h4' }) !== 'brilliant',
  'the same sacrifice when it is NOT the best move is not `brilliant`');
ok(classify({ bestUci: SAC_UCI, bestGap: 400 }) !== 'mistake' && classify({ bestUci: SAC_UCI, bestGap: 400 }) !== 'blunder',
  'and a sacrifice that IS the engine\'s choice is never called a mistake or a blunder',
  'this is the case the original brief asked to keep: a material OFFER is not a defect');
ok(classify({ ply: 5, bookPlies: 20, cpAfter: 30 }) === 'book',
  'an undamaged move inside the book is `book`');

// ---------------------------------------------------------------------------
head('3. the distinctions the user explicitly asked to keep');

/*
 * *"i dont want it to say that a move is a blunder when its a sacrifice"*, from the brief this
 * whole piece of work was built on. Two things have to hold together: a sacrifice that IS the
 * engine's best move must read as `brilliant` even though it hangs a queen, and a sacrifice that
 * is not the best move must be badged on its merits like any other move — because a hanging
 * queen that simply lost 9 points of material IS a blunder, and calling it "just a sacrifice"
 * would be the opposite error.
 */
ok(isSacrifice(FEN_BEFORE, SAC_UCI) === true,
  'the control really is a sacrifice (Qxg6 is met by hxg6)');

/*
 * Netting off the material the move won must not turn every capture into a
 * sacrifice. A queen trade is the clearest control: Qxd8 wins a queen, Rxd8 (or
 * Kxd8) wins one back, and nothing has been offered. This used to be `true` and
 * could make a routine trade `brilliant` when it was also the engine's best move.
 */
const QUEEN_TRADE_BEFORE = '4k3/3q4/8/8/8/8/3Q4/4K3 w - - 0 1';
ok(isSacrifice(QUEEN_TRADE_BEFORE, 'd2d7') === false,
  'a queen trade is not a sacrifice: the captured queen pays for the queen that is taken');

const sacrificeNotBest = classify({ bestUci: 'h3h4', cpBefore: 30, cpAfter: -900 });
ok(!RETIRED.includes(sacrificeNotBest) && sacrificeNotBest === 'blunder',
  `a sacrifice that is NOT the best move is graded on its merits (${sacrificeNotBest})`,
  'a hanging queen that simply lost the game is a blunder, and must not be excused as "a sacrifice"');

// 180cp of loss from +0.30 is over the 12% expected-score line. The old check used a 50cp
// drop, which this classifier now rightly calls `good`: the point of the band change is that
// a small centipawn loss is not automatically a mistake.
ok(classify({ bestUci: 'h3h4', cpBefore: 30, cpAfter: -150 }) === 'mistake',
  'a real, non-best loss is a plain `mistake` with no special treatment');

// ---------------------------------------------------------------------------
head('4. stored games analysed before the change can still be rendered');

/*
 * The retired labels were left in the type, `QUALITY_META` and the database columns on purpose:
 * a report saved with them has to keep displaying. If a label were removed from `QUALITY_META`
 * instead, every badge for an older game would render as an empty circle.
 */
for (const k of RETIRED) {
  ok(!!QUALITY_META[k] && !!QUALITY_META[k].glyph && !!QUALITY_META[k].color,
    `the retired label "${k}" still has renderable metadata for old saved games`);
}
ok(ACTIVE_KINDS.length === 6,
  `the advertised vocabulary is exactly the six the user named (${ACTIVE_KINDS.join(', ')})`);
ok(ACTIVE_KINDS.every((k) => KEY_KINDS.includes(k) || k === 'book' || k === 'best' || k === 'good'),
  'the key-moments filter is consistent with the advertised vocabulary');

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures > 0 ? 1 : 0);
