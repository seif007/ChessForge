/**
 * "i can no longer click and move pieces in your openings"
 *
 * A regression the user hit on device, caused by ONE change: recording every move
 * the user plays, so the Train drill would have a repertoire to work from.
 *
 * IT PRESENTED AS "THE BOARD DOES NOT RESPOND", WHICH IS THE HARDEST KIND OF REPORT
 * ------------------------------------------------------------------------------
 * Three unrelated things were each sufficient to cause it, and none of them looks
 * like a touch bug from the outside:
 *
 *   1. `saveAdoption` did a full read-modify-write of the ENTIRE custom repertoire,
 *      once per ply. A 12-ply line meant 12 rewrites of a document that grows with
 *      every decision the user has ever made.
 *   2. It returned a freshly-parsed object, assigned straight to `setRepertoire`, so
 *      the whole screen re-rendered on every ply — WHILE THE USER WAS DRAGGING A
 *      PIECE. That is the touch failure: not "slow", but the gesture interrupted by
 *      a re-render with no business happening between picking a piece up and putting
 *      it down.
 *   3. The "Saved X to your repertoire" toast fired on every ply. It is
 *      `position: absolute`, `left: 14, right: 14`, opaque, and had NO
 *      `pointerEvents` — so a passive label became a touch target across the lower
 *      part of the screen for most of the line. Harmless once per decision; not
 *      harmless once per ply.
 *
 * WHY THESE ARE ASSERTED AS SHAPES
 * --------------------------------
 * A test that counted storage calls could not tell a debounce from a bug, and one
 * that asserted "no state change" would forbid the flush that makes recording work
 * at all. What matters is: moves are QUEUED, the write happens in ONE place, the
 * state changes ONCE per batch, and the toast cannot be touched.
 *
 * And the change that caused all this must not be lost either — so the queue call in
 * the plain (no-choice) branch is pinned too. Batch too hard and the trainer goes
 * back to telling the user he has not practiced anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREEN = path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx');
const raw = fs.readFileSync(SCREEN, 'utf8');

let checks = 0, fails = 0;
function ok(label, cond, detail = '') {
  checks++;
  if (!cond) fails++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/*
 * MATCH CODE, NOT PROSE.
 *
 * The comment above `queueAdoption` describes the per-ply write at length — it
 * literally contains "await saveAdoption(...)". Regexing the raw source therefore
 * finds the bug report instead of the bug, which is the same trap as the endgame
 * live-position test and the Train picker test. Comments are stripped first.
 */
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

console.log('\n§1  the play loop must not write per ply');
ok('the screen no longer calls the single-line saveAdoption', !/\bsaveAdoption\s*\(/.test(code),
  'a per-ply read-modify-write of the whole repertoire is the regression');
ok('it uses the batched saveAdoptions instead', /\bsaveAdoptions\s*\(/.test(code));
ok('moves are queued in a ref, not written inline', /pendingRef\.current\.push\(/.test(code));
ok('and the batch is flushed on a short debounce, so an abandoned line still records',
  /flushTimerRef\.current = setTimeout/.test(code));
ok('a failed write puts its batch back rather than losing the user\'s moves',
  /pendingRef\.current = \[\.\.\.batch, \.\.\.pendingRef\.current\]/.test(code));
ok('a re-entrant flush cannot double-write', /flushingRef\.current = true/.test(code));

console.log('\n§2  the toast must never be a touch target');
const toastJsx = /\{justSaved \? \([\s\S]{0,1200}?<\/View>\s*\)\s*:\s*null\}/.exec(raw)?.[0] ?? '';
ok('the "Saved to your repertoire" toast was found', toastJsx.length > 0,
  toastJsx.length ? '' : 'REGEX MISSED IT — did the markup change?');
ok('it carries pointerEvents="none"', /pointerEvents="none"/.test(toastJsx),
  toastJsx.length ? toastJsx.replace(/\s+/g, ' ').slice(0, 100) : '');
ok('the toast style is absolutely positioned and full width (which is why it bit)',
  /position:\s*'absolute'/.test(code) && /left:\s*14,\s*right:\s*14/.test(code));

console.log('\n§3  exactly one state change per batch');
{
  const flush = /const flushAdoptions[\s\S]*?flushingRef\.current = false;[\s\S]*?\n  \}, \[\]/.exec(code)?.[0] ?? '';
  ok('the flush body was found', flush.length > 0);
  ok('setRepertoire is called inside the flush', /setRepertoire\(/.test(flush));
  // Boot + flush + account switch. Anything more means a per-move render crept back.
  const sites = (code.match(/setRepertoire\(/g) ?? []).length;
  ok('and there are only a handful of call sites in the whole screen', sites <= 3, `${sites} sites`);
  const handler = /const onBoardMove[\s\S]*?\n  \}, \[/.exec(code)?.[0] ?? '';
  ok('onBoardMove itself never calls setRepertoire', handler.length > 0 && !/setRepertoire\(/.test(handler),
    'a state change inside the move handler is the re-render-mid-gesture bug');
}

console.log('\n§4  the recording must still happen for every move');
{
  const handler = /const onBoardMove[\s\S]*?\n  \}, \[/.exec(raw)?.[0] ?? '';
  ok('the board-move handler was found', handler.length > 0);

  /*
   * `onBoardMove` calls `adopt()`, not `queueAdoption()` — the first version of this
   * check looked for `queueAdoption(` in the handler, failed, and would have had me
   * "fix" working code. The chain that matters is: handler -> `adopt` -> `queueAdoption`
   * -> ref -> one batched write. So each link is asserted where it is defined.
   */
  const sites = handler.match(/\badopt\(/g) ?? [];
  ok('the handler records in BOTH branches (no-choice AND choice)', sites.length >= 2,
    `${sites.length} record sites in onBoardMove — one is the plain line move, one is the decision`);

  const adopt = /const adopt = useCallback[\s\S]*?\n  \}, \[/.exec(code)?.[0] ?? '';
  ok('`adopt` was found', adopt.length > 0);
  ok('and it delegates to the queue rather than writing', /queueAdoption\(/.test(adopt));

  /*
   * The plain (no-choice) branch specifically: this is the one that used to record
   * nothing, and the whole reason the Train pipeline was empty after a finished line.
   *
   * This was a 2500-CHARACTER WINDOW, and it was reporting a false failure for years without anyone
   * noticing why: the branch carries two long explanatory comments, and the `adopt(` call sits at
   * offset 5000. The window could not reach it, so the check could only ever fail - and its own
   * comment said brace-balancing TSX by regex "is not worth doing properly", which is exactly how a
   * check that can never pass gets mistaken for a check that found a bug.
   *
   * It is worth doing properly. `blockAt` walks the braces while skipping line comments, block comments
   * and quoted strings, so it returns the branch itself and not the first inner `if`. The other
   * assertions in this file that take a window have the same weakness and are named below.
   */
  const blockAt = (src, from) => {
    if (from < 0) return '';
    const start = src.indexOf('{', from);
    if (start < 0) return '';
    let depth = 0;
    let i = start;
    while (i < src.length) {
      const c = src[i];
      const two = src.slice(i, i + 2);
      if (two === '/*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
      if (two === '//') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
      if (c === '"' || c === "'" || c === '`') {
        const q = c; i += 1;
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; }
        i += 1; continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}') { depth -= 1; if (depth === 0) return src.slice(from, i + 1); }
      i += 1;
    }
    return src.slice(from);
  };

  const at = handler.indexOf('if (!choice) {');
  ok('the no-choice branch was located', at >= 0);
  const branch = blockAt(handler, at);
  ok('and the branch was extracted whole, not sampled',
    branch.length > 0 && branch.trimEnd().endsWith('}'),
    `${branch.length} chars`);
  const recordsPlain = /\bvoid adopt\(|\badopt\(/.test(branch);
  ok('the no-choice branch records plain line moves', recordsPlain,
    branch.replace(/\s+/g, ' ').slice(0, 110));
  ok('CONTROL: the extraction really does span the whole branch',
    /\bvoid adopt\(|adopt\(/.test(branch) && branch.length > 2500,
    `branch is ${branch.length} chars - a 2500-char window could not have covered it`);
}

console.log('\n§5  the board itself is unchanged and still the touch target');
{
  const board = fs.readFileSync(path.join(ROOT, 'src', 'components', 'chess', 'ChessForgeBoard.tsx'), 'utf8');
  ok('the square View is still pointerEvents="none"', /pointerEvents="none"/.test(board));
  ok('the rank row is still pointerEvents="none"', /style=\{styles\.row\} pointerEvents="none"/.test(board));
  ok('pointToSquare still rejects non-finite coordinates', /Number\.isFinite/.test(board));
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'}: ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
