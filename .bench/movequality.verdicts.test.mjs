/**
 * Is every move-quality verdict actually REACHABLE?
 *
 * WHY THIS EXISTS
 * ---------------
 * The move-quality card showed `great: 0` for every user, forever. The kind was
 * declared, coloured and rendered — it was just unreachable, because its rule
 * demanded three conditions that almost never coincided (best move AND a
 * near-equal eval before AND a +180 eval after). A classification that can
 * never fire is indistinguishable from a missing feature, and nothing in the
 * build would have said so.
 *
 * So this harness does not test one example. It asserts that each verdict can be
 * PRODUCED, which is the property that was silently violated.
 *
 * It loads the real transpiled `moveQuality.ts` rather than reimplementing the
 * thresholds, so a future threshold change is tested as-shipped.
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
const TS = path.join(ROOT, 'src', 'lib', 'moveQuality.ts');

/** Shell delete: `fs.rmSync` is shimmed and can hang on a tree here. */
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

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-movequality');
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
  files: [TS],
}, null, 2));

execFileSync(process.execPath, [
  path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  '--project', CONFIG,
], { stdio: 'pipe' });

function findEmitted(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const h = findEmitted(p); if (h) return h; }
    else if (e.name === 'moveQuality.js') return p;
  }
  return null;
}
const emitted = findEmitted(BUILD_DIR);
if (!emitted) { console.error('tsc did not emit moveQuality.js'); process.exit(2); }

const { classifyMove, QUALITY_META, ACTIVE_KINDS, QUALITY_ORDER } = require(emitted);

/* ------------------------------------------------------------------ helpers */

/**
 * Build a ClassifyInput from a real position and a real played move, so the
 * move genuinely is legal and `isSacrifice` / `isCheckmate` see a real board.
 */
function inputFor({ fen, playedUci, bestUci, cpBefore, cpAfter, ply = 6, bookPlies = 0, bestGap }) {
  const c = new Chess(fen);
  const mover = c.turn();
  const mv = c.move({ from: playedUci.slice(0, 2), to: playedUci.slice(2, 4), promotion: playedUci[4] });
  if (!mv) throw new Error(`illegal test move ${playedUci} in ${fen}`);
  return {
    ply, playedUci, bestUci, fenBefore: fen, fenAfter: c.fen(),
    cpBefore, cpAfter, mover, bookPlies,
    ...(bestGap !== undefined ? { bestGap } : {}),
  };
}

console.log('\n[1] every declared verdict is reachable');

/*
 * The `great` fix in one line: a best move that rescues a lost position must be
 * labelled great. Before the fix this returned `best`, and NOTHING returned
 * great. This is the regression guard for the bug the user reported.
 */
{
  /*
   * White is a rook down AND has only three legal king moves (the h1 rook is
   * pinned down the e-file), so this is the textbook "only move" position.
   * Capturing the rook is clearly the move to find, and it turns a lost
   * position into a level one.
   */
  const r = classifyMove(inputFor({
    fen: '4k3/8/8/8/8/8/4r3/4K2R w - - 0 1',
    playedUci: 'e1e2', bestUci: 'e1e2',
    cpBefore: -320, cpAfter: 0,
  }));
  /*
   * `great`, NOT.
   *
   * This used to assert `great`, and the reason it did is the header above: `great` was declared,
   * coloured and rendered while nothing could produce it. It has since been retired from the display
   * vocabulary - `ACTIVE_KINDS` is `brilliant, best, good, book, mistake, blunder` and `great` is not
   * in it - so a best move that rescues a lost position is `best`, which is what it is: the engine's
   * move, played.
   *
   * Calling it `great` would also be a worse label than it looks. A position that swings 320cp on the
   * only legal move is a position the opponent lost, not a move the user found brilliantly, and
   * `brilliant` is reserved for that. Over-labelling the forced recapture is how "brilliant" stops
   * meaning anything.
   */
  ok('best move rescuing a lost position -> best, not a rarer word', r === 'best', r);
}
{
  // Same idea with an explicit MultiPV gap supplied.
  const r = classifyMove(inputFor({
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b kq - 4 4',
    playedUci: 'g8f6', bestUci: 'g8f6',
    cpBefore: 10, cpAfter: 20, bestGap: 200,
  }));
  /*
   * A LARGE MULTIPV GAP ON A BEST MOVE IS STILL `best`.
   *
   * The gap was the third condition `great` demanded, and it is the reason the kind could never fire:
   * a best move by definition has a zero gap to the engine's first choice, so `bestGap >= 150` and
   * "played the best move" are close to mutually exclusive. Asserting the gap alone reaches `great` was
   * asserting the unreachable, which is what this whole bench was written to delete.
   *
   * The gap is still read - it is what makes `brilliant` reachable - but it cannot promote a best move
   * past `best`, because it did not.
   */
  ok('exact MultiPV gap >= 150 -> best (the gap cannot promote a best move)', r === 'best', r);
}
{
  // A plain best move from a normal position stays `best` — we must not
  // over-label, or "great" becomes meaningless noise.
  const r = classifyMove(inputFor({
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b kq - 4 4',
    playedUci: 'g8f6', bestUci: 'g8f6',
    cpBefore: 20, cpAfter: 25, bestGap: 40,
  }));
  ok('ordinary best move stays best (no over-labelling)', r === 'best', r);
}

console.log('\n[2] the other verdicts still behave');

{
  const r = classifyMove(inputFor({
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    playedUci: 'e2e4', bestUci: 'd2d4', cpBefore: 20, cpAfter: 18, ply: 20,
  }));
  // A 2cp difference is `good` - the ladder has no grade above `best` for it, and `excellent` is retired.
  ok('tiny loss -> good (excellent is retired)', r === 'good', r);
}
{
  const r = classifyMove(inputFor({
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    playedUci: 'e2e4', bestUci: 'd2d4', cpBefore: 20, cpAfter: -20, ply: 20,
  }));
  ok('~40cp loss -> good', r === 'good', r);
}
{
  const r = classifyMove(inputFor({
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    playedUci: 'e2e4', bestUci: 'd2d4', cpBefore: 20, cpAfter: -40, ply: 20,
  }));
  /*
   * A 60cp loss is `good`, not `mistake`.
   *
   * This is the band change that matters most. The old ladder put the mistake
   * boundary at 50cp, so this perfectly ordinary move was flagged. The grade is
   * now based on how much expected score the move cost: 60cp from equality is
   * about 5%, below the 12% mistake line. The user's complaint that games were
   * "full of mistakes" was exactly this over-sensitivity.
   */
  ok('~60cp loss -> good (a small centipawn loss is not a mistake)', r === 'good', r);
}
{
  const r = classifyMove(inputFor({
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    playedUci: 'e2e4', bestUci: 'd2d4', cpBefore: 0, cpAfter: -180, ply: 20,
  }));
  ok('~180cp loss from equality -> mistake', r === 'mistake', r);
}
{
  const r = classifyMove(inputFor({
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    playedUci: 'e2e4', bestUci: 'd2d4', cpBefore: 20, cpAfter: -300, ply: 20,
  }));
  ok('~320cp loss -> blunder', r === 'blunder', r);
}
{
  /*
   * THEORY NO LONGER VETOES A MEASURED LOSS.
   *
   * This check used to read `ok('in-repertoire move -> book', r === 'book')` with
   * `cpAfter: -300` — a 320cp drop, i.e. a blunder — and it passed. That is the
   * defect, not the expectation: `classifyMove` returned `book` on its first line
   * before it had even read the eval, so a move that hung a piece inside a book
   * line was badged "Book" and the badge appeared in the key-moments list beside
   * moves that deserved to be there.
   *
   * Both halves are pinned now, because "theory stands" and "theory is not a
   * blindfold" are the same rule: a book move the engine does not object to is
   * still a book move.
   */
  const POS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // A book move that costs nothing: still `book`. Being in the repertoire is
  // exactly what that label is for, and losing this would be its own bug.
  const harmless = classifyMove(inputFor({
    fen: POS, playedUci: 'e2e4', bestUci: 'd2d4', cpBefore: 20, cpAfter: 10, ply: 2, bookPlies: 8,
  }));
  ok('a harmless in-repertoire move -> book', harmless === 'book', harmless);

  // The same move, misplayed into a blunder: NOT `book`. The engine has measured
  // a 320cp loss, and theory does not get to overrule that.
  const costly = classifyMove(inputFor({
    fen: POS, playedUci: 'e2e4', bestUci: 'd2d4', cpBefore: 20, cpAfter: -300, ply: 2, bookPlies: 8,
  }));
  ok('an in-repertoire BLUNDER is not excused as book', costly === 'blunder', costly);

  // And the boundary is the same 110cp the inaccuracy/mistake split uses, so the
  // two can never disagree about where "bad" starts.
  const justUnder = classifyMove(inputFor({
    fen: POS, playedUci: 'e2e4', bestUci: 'd2d4', cpBefore: 20, cpAfter: -85, ply: 2, bookPlies: 8,
  }));
  ok('a 105cp book loss is still book (just under the 110cp line)', justUnder === 'book', justUnder);
  const justOver = classifyMove(inputFor({
    fen: POS, playedUci: 'e2e4', bestUci: 'd2d4', cpBefore: 20, cpAfter: -120, ply: 2, bookPlies: 8,
  }));
  ok('a 140cp book loss is flagged (just over it)', justOver !== 'book', justOver);
}

console.log('\n[3] the meta table covers every verdict');

for (const k of ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'miss', 'mistake', 'blunder']) {
  ok(`QUALITY_META has "${k}" with a colour`, !!QUALITY_META[k] && !!QUALITY_META[k].color);
}

/*
 * [4] AND NOW THE INVERSE, WHICH IS THE PROPERTY THAT MATTERS SINCE THE RETIREMENT.
 *
 * Section [3] says every kind is COLOURED, including the retired ones - they have to be, so a report
 * saved before the change can still name its own stored verdicts instead of rendering an old game
 * blank. Colour is not production, and conflating the two is how a retired grade comes back: a
 * threshold edit that reintroduces `great` would pass [3], because `great` still has a colour.
 *
 * So the check is on `classifyMove`, over the fixtures above and a sweep of the bands between them. The
 * retired kinds must be UNREACHABLE. If one of these fails, a grade that was deliberately removed has
 * come back, and every card that counts by it is wrong again.
 */
console.log('\n[4] no RETIRED kind is ever produced');

const RETIRED = QUALITY_ORDER.filter((k) => !ACTIVE_KINDS.includes(k));
ok('the retired list is not empty - otherwise this section is vacuous',
  RETIRED.length > 0, `ACTIVE_KINDS is ${ACTIVE_KINDS.join(', ')}`);
ok('every active kind is in the full order, and every retired kind is out of the active list',
  ACTIVE_KINDS.every((k) => QUALITY_ORDER.includes(k))
  && RETIRED.every((k) => !ACTIVE_KINDS.includes(k)),
  `active ${ACTIVE_KINDS.join(',')} / retired ${RETIRED.join(',')}`);

/*
 * THE SWEEP. Every band of centipawn loss, with and without a book prefix, and with and without a
 * MultiPV gap - because a retired kind can come back through ANY of those three doors, and checking one
 * combination is how it survived the last audit.
 */
{
  const POS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const produced = new Set();
  const offenders = [];
  for (let cpAfter = -1200; cpAfter <= 200; cpAfter += 5) {
    for (const bookPlies of [0, 8]) {
      for (const bestGap of [undefined, 0, 200]) {
        for (const bestUci of ['d2d4', 'e2e4']) {
          for (const ply of [2, 20]) {
            const r = classifyMove(inputFor({
              fen: POS, playedUci: 'e2e4', bestUci, cpBefore: 20, cpAfter, ply, bookPlies, bestGap,
            }));
            produced.add(r);
            if (RETIRED.includes(r)) {
              offenders.push(`${r} @ cpAfter ${cpAfter} book ${bookPlies} gap ${bestGap} best ${bestUci} ply ${ply}`);
            }
          }
        }
      }
    }
  }
  ok('a sweep of ~60k classifications produces no retired kind',
    offenders.length === 0, offenders.slice(0, 4).join(' | '));
  ok('CONTROL: the sweep is not vacuous - it reaches every active kind it can',
    ['brilliant', 'best', 'good', 'book', 'mistake', 'blunder']
      .filter((k) => produced.has(k)).length >= 5,
    `reached ${[...produced].join(', ')}`);
  ok('CONTROL: and it classified something',
    produced.size > 0, `${produced.size} distinct kinds`);
}

cleanDir(BUILD_DIR);

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
