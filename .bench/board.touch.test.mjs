/**
 * Can the user actually MOVE a piece? — the second half of the user's report.
 *
 * THE COMPLAINT
 * -------------
 * "i click an opening in 'your openings' it take too much time to open then when
 *  I click on a piece to move it it stays blocked and dont move."
 *
 * The first half was a blocked JS thread (measured and fixed — see
 * `perf.openingbuild.mjs`). This file is about the second half, and it is
 * deliberately NOT a model of the responder system. `.bench/dragsim.mjs` models
 * it, and a model can only ever agree with the code by accident. So the handler
 * bodies here are LIFTED OUT OF THE SHIPPED SOURCE and evaluated, the same way
 * `openings.clickandboot.test.mjs` lifts `lineWithDecisions` out of the screen.
 *
 * The rules being tested, straight from `ChessForgeBoard.tsx`:
 *
 *   - the board CAPTURES the gesture, so an enclosing ScrollView cannot take it
 *     and scroll the page instead of moving a piece;
 *   - it refuses termination, so a drag on the board is a chess move;
 *   - a tap on your own piece selects it; a SECOND tap on a legal target moves;
 *   - a drag moves in one gesture;
 *   - the release handler reads `dragFromRef` / `selectedRef`, not state,
 *     because React Native binds the responder ONCE at touch start and the
 *     release handler is the one captured then;
 *   - a move to an ILLEGAL square is not played.
 *
 * §5 is the important one for "it stays blocked": with the engine publishing
 * verdicts into a re-rendered board mid-session, does a touch still produce a
 * move? A handler that read state through a stale closure would work in a test
 * that never re-rendered and fail on the device, which is exactly the class of
 * bug that survived three rounds of device reports.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src', 'components', 'chess', 'ChessForgeBoard.tsx');
const BOARD_SRC = fs.readFileSync(SRC, 'utf8');

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/* ---------------------------------------------- lift the shipped handler body */

const handlersMatch = /useMemo\(\s*\(\) => \(\{([\s\S]*?)\n {4}\}\),/.exec(BOARD_SRC);
if (!handlersMatch) {
  console.error('REGEX MISSED THE GESTURE HANDLERS — every check below would be vacuous');
  process.exit(2);
}
const HANDLERS_SRC = handlersMatch[1];

/**
 * Strip the TypeScript-only syntax from the lifted body.
 *
 * The source is TypeScript and the lifted body is evaluated as JavaScript, so the
 * `as Square` casts have to go — and a cast is erased at compile time anyway, so
 * removing the text is exactly equivalent.
 *
 * ONLY that one construct is removed, and the count is asserted. A general
 * "strip annotations" regex is the obvious thing to reach for and it is wrong:
 * the first version of this file had one that matched `: null` in the shipped
 * ternary `piece.color === b.turn() ? to : null` and produced
 * `? to )` — a mangle of the logic the test exists to check. Narrow beats clever
 * when the thing being tested is the thing being transformed.
 */
const asCount = (HANDLERS_SRC.match(/\bas\s+Square\b/g) ?? []).length;
const otherAs = (HANDLERS_SRC.match(/\bas\s+(?!Square\b)[A-Za-z_$]/g) ?? []).length;
const HANDLERS_JS = HANDLERS_SRC.replace(/\bas\s+Square\b/g, '');

ok('the shipped gesture handler block was found in the source', true,
  `${HANDLERS_SRC.split('\n').length} lines lifted`);
ok('the only TypeScript syntax in it is the erased `as Square` casts',
  otherAs === 0, `${asCount} cast(s), ${otherAs} other 'as'`);

/** Build a board harness around the SHIPPED handler source. */
function makeBoard({ fen, interactive = true, orientation = 'white', onMove }) {
  // The real state and refs the handlers close over.
  let selected = null;
  let dragFrom = null;
  const selectedRef = { current: null };
  const dragFromRef = { current: null };
  const interactiveRef = { current: interactive };
  const onMoveRef = { current: onMove };
  let board = new Chess(fen);
  const boardRef = { get current() { return board; } };
  const setSelected = (sq) => { selected = sq; selectedRef.current = sq; };
  const setDrag = (sq) => { dragFrom = sq; dragFromRef.current = sq; };

  // The real geometry: whole-pixel squares, explicit rank order per orientation.
  const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];
  const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const displayRanks = orientation === 'white' ? RANKS : [...RANKS].reverse();
  const displayFiles = orientation === 'white' ? FILES : [...FILES].reverse();
  const squareSize = 40;
  const pointToSquare = (x, y) => {
    if (squareSize <= 0) return null;
    const col = Math.floor(x / squareSize);
    const row = Math.floor(y / squareSize);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return `${displayFiles[col]}${displayRanks[row]}`;
  };

  /*
   * `isLegalTarget` and `tryUserMove` are lifted too, so the legality rule and
   * the promotion default are the shipped ones.
   *
   * Both are built as CLOSURES over the harness's `boardRef` / `onMoveRef`,
   * because the shipped handlers call them as `isLegalTarget(origin, to)` and
   * `tryUserMove(origin, to)` — two positional arguments. An earlier version
   * declared `isLegalTarget(boardRef, from, to)`, so the handler's two arguments
   * bound to the wrong parameters, `boardRef.current` was a string, the `try`
   * swallowed the TypeError, and the function returned `false` for every move.
   *
   * That is worth stating because it is the most dangerous kind of harness bug:
   * it produced a clean, plausible "nothing is played" result for tap-to-move
   * and drag, which reads exactly like the bug under test.
   */
  const isLegalTarget = new Function('boardRef', `
    return (from, to) => {
      try {
        return boardRef.current
          .moves({ square: from, verbose: true })
          .some((m) => m.to === to);
      } catch {
        return false;
      }
    };
  `)(boardRef);
  const tryUserMove = new Function('onMoveRef', 'board', 'setSelected', 'setDrag', `
    return (from, to) => {
      const cb = onMoveRef.current;
      if (!cb) return false;
      let promotion;
      try {
        const piece = board.get(from);
        if (piece && piece.type === 'p') {
          const rank = to[1];
          if ((piece.color === 'w' && rank === '8') || (piece.color === 'b' && rank === '1')) {
            promotion = 'q';
          }
        }
      } catch { /* fall through without promotion */ }
      const accepted = cb(from, to, promotion);
      setSelected(null);
      setDrag(null);
      return accepted;
    };
  `)(onMoveRef, board, setSelected, setDrag);

  /*
   * THE SHIPPED HANDLERS, verbatim.
   *
   * `HANDLERS_SRC` is the object literal's contents, already including its own
   * closing brace, so wrapping it in `({ ... })` reproduces exactly what the
   * component's `useMemo` builds. `new Function` is used rather than `eval` so
   * the body keeps its own scope and cannot reach the harness's bindings beyond
   * the ones passed in.
   */
  const make = new Function(
    'interactiveRef', 'pointToSquare', 'boardRef', 'setDrag', 'setSelected',
    'dragFromRef', 'selectedRef', 'isLegalTarget', 'tryUserMove',
    `return ({${HANDLERS_JS}});`,
  );
  const handlers = make(
    interactiveRef, pointToSquare, boardRef, setDrag, setSelected,
    dragFromRef, selectedRef, isLegalTarget, tryUserMove,
  );

  return {
    handlers,
    /** One touch: grant at `from`, release at `to`. The RN binding order. */
    touch(from, to) {
      handlers.onResponderGrant({ nativeEvent: { locationX: pt(from).x, locationY: pt(from).y } });
      handlers.onResponderRelease({ nativeEvent: { locationX: pt(to).x, locationY: pt(to).y } });
    },
    setFen(f) { board = new Chess(f); },
    get selected() { return selected; },
    get dragFrom() { return dragFrom; },
  };
}

/** Pixel centre of a square, in board coordinates. */
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const pt = (sq) => ({
  x: FILES.indexOf(sq[0]) * 40 + 20,
  y: RANKS.indexOf(sq[1]) * 40 + 20,
});

/* =========================================================== §1 the tap-to-move */

console.log('\n§1  tap the piece, tap the square');
{
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const moves = [];
  const b = makeBoard({ fen: START, onMove: (f, t) => { moves.push([f, t]); return true; } });

  b.touch('e2', 'e2');
  ok('a tap on your own piece selects it', b.selected === 'e2', `selected ${b.selected}`);

  b.touch('e4', 'e4');
  ok('the second tap on a legal target plays the move',
    moves.length === 1 && moves[0][0] === 'e2' && moves[0][1] === 'e4',
    JSON.stringify(moves));
  ok('the selection is cleared after the move', b.selected === null);
}

/* ================================================================ §2 the drag */

console.log('\n§2  drag the piece in one gesture');
{
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const moves = [];
  const b = makeBoard({ fen: START, onMove: (f, t) => { moves.push([f, t]); return true; } });
  b.touch('g1', 'f3');
  ok('a single drag plays the move',
    moves.length === 1 && moves[0][0] === 'g1' && moves[0][1] === 'f3',
    JSON.stringify(moves));
}

/* ================================================== §3 the board takes the touch */

console.log('\n§3  the board wins the gesture from the ScrollView');
{
  const b = makeBoard({
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    onMove: () => true,
  });
  ok('captures the touch on start (so the page cannot scroll instead)',
    b.handlers.onStartShouldSetResponderCapture({}) === true);
  ok('keeps claiming it while the finger moves (so a drag is not a scroll)',
    b.handlers.onMoveShouldSetResponderCapture({}) === true);
  ok('refuses to hand the gesture over',
    b.handlers.onResponderTerminationRequest({}) === false);

  const locked = makeBoard({
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    interactive: false,
    onMove: () => true,
  });
  ok('a non-interactive board claims nothing (the finished-line view)',
    locked.handlers.onStartShouldSetResponderCapture({}) === false);
}

/* ================================================== §4 illegal targets refused */

console.log('\n§4  an illegal target is refused, and the piece stays put');
{
  const moves = [];
  // White to move, Black pawn on e3: the e2-pawn has NO legal move at all
  // (e3 is occupied and both diagonals are empty), which is the cleanest possible
  // "the board must not accept this" case.
  const BLOCKED = 'rnbqkbnr/pppppppp/8/8/8/4p3/4P3/RNBQKBNR w KQkq - 0 1';
  const b = makeBoard({ fen: BLOCKED, onMove: (f, t) => { moves.push([f, t]); return true; } });

  b.touch('e2', 'e2');
  b.touch('e3', 'e3');
  ok('e2-e3 is occupied by a black pawn, so nothing is played', moves.length === 0,
    JSON.stringify(moves));

  b.touch('e2', 'e3');
  ok('and the refused square is not left as a pending selection', b.selected !== 'e3',
    `selected ${b.selected}`);

  b.touch('g1', 'g1');
  b.touch('f3', 'f3');
  ok('a legal knight move in the same position IS played',
    moves.length === 1 && moves[0][0] === 'g1' && moves[0][1] === 'f3',
    JSON.stringify(moves));
}

/* ============================ §5 the one the device reports: mid-session rerender */

console.log('\n§5  a re-render mid-session must not break the next touch');
{
  /*
   * THE FAILURE THIS PINS.
   *
   * React Native binds a responder ONCE, at touch start, and the handlers that
   * fire on release are the ones captured THEN. A handler that closed over
   * `selected` / `dragFrom` therefore reads the values from before the gesture —
   * so after the screen re-renders mid-session (which the engine does, on every
   * progress tick) the release handler is running a stale closure and the move
   * is silently dropped. The user sees a board that lights up and then does
   * nothing: "it stays blocked and doesn't move".
   *
   * So: play a move, simulate the re-render a publish causes (the handler object
   * is rebuilt from the same source, state is re-read), and then play another.
   * Both must work. A state-closure implementation fails the second one.
   */
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const moves = [];
  const onMove = (f, t) => { moves.push([f, t]); return true; };

  const b1 = makeBoard({ fen: START, onMove });
  b1.touch('e2', 'e2');
  b1.touch('e4', 'e4');
  ok('first move plays', moves.length === 1, JSON.stringify(moves));

  // The publish: new FEN in, new handler object bound (what a re-render does).
  const b2 = makeBoard({ fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', onMove });
  b2.touch('d7', 'd7');
  b2.touch('d5', 'd5');
  ok('a move still plays after the screen re-rendered',
    moves.length === 2 && moves[1][0] === 'd7' && moves[1][1] === 'd5',
    JSON.stringify(moves));

  // And the pathological case: the SAME board object, whose handler closure was
  // created before the state that release needs existed.
  const b3 = makeBoard({ fen: START, onMove });
  const boundAtTouchStart = b3.handlers;          // what RN keeps for this gesture
  b3.setFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  boundAtTouchStart.onResponderGrant({ nativeEvent: { locationX: pt('d7').x, locationY: pt('d7').y } });
  boundAtTouchStart.onResponderRelease({ nativeEvent: { locationX: pt('d5').x, locationY: pt('d5').y } });
  ok('a handler bound before the state existed still plays the move (refs, not state)',
    moves.length === 3 && moves[2][0] === 'd7' && moves[2][1] === 'd5',
    JSON.stringify(moves));
}

/* ============================================ §6 promotion and Black orientation */

console.log('\n§6  promotion, and the board flipped for Black');
{
  // White pawn on the 7th with the 8th square EMPTY — a promotion needs the
  // target square free. (The first version of this case left the black king on
  // e8, which makes e7-e8 an ordinary illegal push, so "no promotion happened"
  // was the correct result and carried no information.)
  const PROMOTE = '6k1/4P3/8/8/8/8/8/4K3 w - - 0 1';
  const moves = [];
  const b = makeBoard({ fen: PROMOTE, onMove: (f, t, p) => { moves.push([f, t, p]); return true; } });
  b.touch('e7', 'e7');
  b.touch('e8', 'e8');
  ok('a promotion defaults to a queen', moves.length === 1 && moves[0][2] === 'q',
    JSON.stringify(moves));

  /*
   * ORIENTATION, PROVED CONTRASTIVELY.
   *
   * Black's board flips both axes, so one physical square is two different chess
   * squares. Asserting a single orientation is easy to get wrong in a way that
   * passes, so this taps the SAME pixel on a White-oriented board and on a
   * Black-oriented one and requires the two to resolve to different chess
   * squares. A board that ignored `orientation` would answer the same twice.
   */
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1';
  const bw = makeBoard({ fen: START, orientation: 'white', onMove: () => true });
  bw.touch('e2', 'e2');
  ok('on a White board that pixel is White\'s e2 pawn and Black is to move, so it is NOT selectable',
    bw.selected === null, `selected ${bw.selected}`);

  const black = [];
  const bb = makeBoard({
    fen: START,
    orientation: 'black',
    onMove: (f, t) => { black.push([f, t]); return true; },
  });
  bb.touch('e2', 'e2');
  ok('on a Black board the SAME pixel is d7 — a black pawn, and Black IS to move',
    bb.selected === 'd7', `selected ${bb.selected}`);

  // And a real Black move, tapped at the pixels d7 and d5 occupy once flipped.
  //
  // The event shape is the NATIVE one, `{ locationX, locationY }`. Passing
  // `{ x, y }` instead is a silent failure with a very misleading symptom:
  // `pointToSquare(undefined, undefined)` has `col = NaN`, every bounds check
  // against NaN is false, and it returns the STRING "undefinedundefined" — a
  // truthy "square" that holds no piece, so the gesture is discarded and the
  // board looks like it ignored the touch. React Native always supplies real
  // numbers, so this is a harness bug, not an app bug; recorded because it
  // produced exactly the "the board does not respond" report being investigated.
  const bp = (sq) => ({
    locationX: 'hgfedcba'.indexOf(sq[0]) * 40 + 20,
    locationY: '12345678'.indexOf(sq[1]) * 40 + 20,
  });
  bb.handlers.onResponderGrant({ nativeEvent: bp('d7') });
  ok('a tap on d7 selects it (the pixel maps to the chess square on a flipped board)',
    bb.selected === 'd7', `selected ${bb.selected}`);
  bb.handlers.onResponderRelease({ nativeEvent: bp('d5') });
  ok('and a Black move plays on the flipped board',
    black.length === 1 && black[0][0] === 'd7' && black[0][1] === 'd5',
    JSON.stringify(black));
}

/* ============================ §7 THE BUG THIS HARNESS CANNOT CATCH BY ITSELF ==
 *
 * Everything above drives the handlers with BOARD-RELATIVE `locationX` /
 * `locationY`, which is what the code assumes. That assumption is the bug, and no
 * amount of driving the handlers here can detect it: React Native reports those
 * coordinates relative to the touch TARGET, and on a real device the target is
 * one of the 64 square `View`s.
 *
 * Confirmed on the device before the fix: tapping `e8` — board-local (470, 1352),
 * inside a square whose top-left is (409, 1290) — was read as `h1`, a white rook
 * with Black to move. The grant handler took the "not one of ours" branch, nothing
 * was selected, and **no square on the board could be moved at all**, because a
 * 123 px square's local coordinates can only ever produce row 0 or 1.
 *
 * So this section asserts the FIX in the source: the squares (and the rank rows)
 * must be `pointerEvents="none"`, so the board is always the touch target and the
 * coordinates the handlers read really are board-relative.
 */
console.log('\n§7  the squares must not be able to become the touch target');
{
  // The square <View> is the one carrying `key={square}`.
  const squareView = /<View\s+key=\{square\}[\s\S]*?>/.exec(BOARD_SRC)?.[0] ?? '';
  ok('the square View is marked pointerEvents="none"', /pointerEvents="none"/.test(squareView),
    squareView ? '' : 'the square <View> was not found in the source');

  const rowView = /<View key=\{`rank-\$\{rank\}`\}[\s\S]*?>/.exec(BOARD_SRC)?.[0] ?? '';
  ok('the rank row View is marked pointerEvents="none"', /pointerEvents="none"/.test(rowView),
    rowView ? '' : 'the rank row <View> was not found');

  // And the guard that turns a bad coordinate into "ignore the touch" rather than
  // into the string "undefinedundefined".
  const fn = /const pointToSquare = useCallback\(([\s\S]*?)\n {4}\[squareSize/.exec(BOARD_SRC)?.[1] ?? '';
  ok('pointToSquare rejects non-finite coordinates',
    /Number\.isFinite/.test(fn), fn ? '' : 'pointToSquare was not found');

  // And a demonstration that the old reading really did break it, so this section
  // is not a ritual assertion: replay the device's tap through both readings.
  const c = new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');
  const squareSize = 123, boardLeft = 40, boardTop = 424;
  const displayFiles = [...'abcdefgh'].reverse();
  const displayRanks = [...'12345678'];
  // `pointToSquare` takes coordinates RELATIVE TO THE BOARD, which is what the
  // fix guarantees by making the board the touch target.
  const read = (x, y) => {
    const col = Math.floor(x / squareSize), row = Math.floor(y / squareSize);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return `${displayFiles[col]}${displayRanks[row]}`;
  };
  // The e8 square's top-left in screen coordinates, and the centre the user pressed.
  const sqLeft = boardLeft + 3 * squareSize, sqTop = boardTop + 7 * squareSize;
  const pressX = sqLeft + 61, pressY = sqTop + 62;
  const asTarget = read(pressX - sqLeft, pressY - sqTop);
  const asBoard = read(pressX - boardLeft, pressY - boardTop);
  ok('the wrong reading sends the e8 tap to h1 (and that is the bug)', asTarget === 'h1',
    `target-relative -> ${asTarget}`);
  ok('the right reading sends the same tap to e8', asBoard === 'e8',
    `board-relative -> ${asBoard}`);
  ok('and h1 is not selectable here (white rook, Black to move), which is why nothing happened',
    (() => {
      const p = c.get('h1');
      return !(p && p.color === c.turn());
    })());
  // The board must be the only thing carrying the responder handlers, and the
  // squares must not be able to become the target.
  // Matched up to the SPREAD rather than to the first `>`, which is inside the
  // `boardWidth > 0` ternary.
  const boardView = /<View\s+style=\{\[styles\.board[\s\S]*?\{\.\.\.gestureHandlers\}\s*>/.exec(BOARD_SRC)?.[0] ?? '';
  ok('the board View is the one carrying the responder handlers',
    /\{\.\.\.gestureHandlers\}/.test(boardView),
    boardView ? '' : 'the board <View> was not found');
  ok('and no square carries them, so the board is always the target',
    !/gestureHandlers/.test(squareView));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'}: ${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
