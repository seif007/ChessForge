'use client';

/**
 * Themed chess board — React Native port of the web `components/chess/ChessForgeBoard.tsx`.
 *
 * Why hand-rolled instead of `react-native-chessboard`:
 *  - The web board draws HINT ARROWS (react-chessboard v5 does this natively).
 *    `react-native-chessboard` has no arrow API, so we would need a Skia/SVG
 *    layer anyway.
 *  - It also draws per-square overlay nodes (analysis classification badges).
 *  - Piece rendering must match the web exactly (the same glyphs on the same
 *    green/cream squares), and a sprite-sheet library would diverge.
 * A 8x8 grid of Views + one SVG overlay layer gives complete visual control and
 * avoids a beta dependency (react-native-chessboard is 0.3.0-beta.1).
 *
 * Feature parity with the web version:
 *  - click-to-move AND drag-and-drop
 *  - legal-move dots (ring for captures, filled dot for quiet moves)
 *  - last-move highlight
 *  - hint arrows with arrowheads
 *  - square overlay nodes
 *  - board orientation (white/black) with notation
 *  - auto-queen promotion
 *
 * Prop signature is IDENTICAL to the web component, so ported screens work
 * unchanged.
 */

import React, { useMemo, useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, type GestureResponderHandlers } from 'react-native';
import Svg, { Line, Circle, Polygon, G } from 'react-native-svg';
import { Chess, type Square } from 'chess.js';
import { colors, radii } from '@/theme/tokens';
import { PieceSvg, pieceKey } from './pieces';

export interface BoardArrow {
  startSquare: string;
  endSquare: string;
  color: string;
}

interface Props {
  fen: string;
  orientation?: 'white' | 'black';
  interactive?: boolean;
  onMove?: (from: Square, to: Square, promotion?: string) => boolean;
  lastMove?: { from: string; to: string } | null;
  arrows?: BoardArrow[];
  /**
   * A move the user played that the engine judged BAD, as UCI.
   *
   * Drawn in the danger colour, and the two squares it touched are tinted, so a
   * blunder is visible ON THE BOARD rather than only in a sentence under it. The
   * request was explicit: "showed in the board that it is a mistake". Without a
   * distinct treatment the "what you played" arrow looks the same whether the user
   * found a subtle improvement or dropped a queen.
   */
  blunder?: string | null;
  /**
   * HINT LAYER — squares to RING, i.e. the pieces that have a legal move.
   *
   * This exists because the hint used to be an arrow from the answer's origin to its destination,
   * which is the solution, not a hint (see `@/lib/hint`). Ring every movable piece instead: the
   * player still has to work out which one moves and where.
   */
  hintFrom?: string[];
  /**
   * HINT LAYER — squares to DOT, i.e. where the pieces in `hintFrom` may legally go.
   *
   * The second press of a hint, and still not the answer: it shows the SHAPE of the move without
   * naming it. Deliberately the same size and weight as the ordinary legal-move dots, so a hint
   * does not look like a different kind of information from the normal selection.
   */
  hintTo?: string[];
  /** Per-square overlay nodes (e.g. classification badges) drawn on top of pieces. */
  squareOverlays?: Record<string, React.ReactNode>;
  boardSizeClass?: string;
  /** Explicit pixel size; when omitted the board fills its container width. */
  size?: number;
}

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];

/**
 * Pieces are rendered as cburnett SVG artwork (see ./pieces), matching the web
 * app's react-chessboard default set. The previous implementation drew Unicode
 * glyphs (U+2654..U+265F), which Android renders as flat monochrome text.
 */

/** Web used `darkSquareStyle: #4a6f5c`, `lightSquareStyle: #dfe9db`. */
const DARK = '#4a6f5c';
const LIGHT = '#dfe9db';

/** Same layer order as the web: selection ring, legal dots, last move. */
const SEL_BG = 'rgba(212, 175, 55, 0.35)';
const SEL_BORDER = 'rgba(212, 175, 55, 0.6)';
const LAST_BG_FROM = 'rgba(212, 175, 55, 0.28)';
const LAST_BG_TO = 'rgba(212, 175, 55, 0.38)';
const CAPTURE_DOT = 'rgba(220, 80, 80, 0.42)';
const QUIET_DOT = 'rgba(30, 120, 80, 0.38)';
/** A move the engine judged a mistake or worse. */
const BLUNDER_FROM = 'rgba(220, 80, 80, 0.30)';
const BLUNDER_TO = 'rgba(220, 80, 80, 0.45)';
/**
 * Hint ring + fill.
 *
 * Deliberately NOT the gold of the old hint arrow, and deliberately not the selection colours: gold
 * on this board means "this is the move we recommend", which is exactly the thing a hint must not
 * say. A cool blue reads as "look here", not "play this", and stays clear of the red blunder tint
 * so a hint on a position you got wrong cannot be mistaken for the mistake.
 */
const HINT_RING = 'rgba(58, 134, 255, 0.95)';
const HINT_BG = 'rgba(58, 134, 255, 0.20)';

export function ChessForgeBoard({
  fen,
  orientation = 'black',
  interactive = true,
  onMove,
  lastMove,
  arrows = [],
  blunder = null,
  hintFrom = [],
  hintTo = [],
  squareOverlays = {},
  size,
}: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const [availWidth, setAvailWidth] = useState(size ?? 0);

  /**
   * Live mirrors of the state the gesture handlers need.
   *
   * React Native negotiates a responder ONCE per touch: the handlers that fire
   * for `onResponderRelease` are the ones captured when the touch *started*.
   * `onResponderGrant` calls `setDragFrom(sq)`, but that re-render does not —
   * and cannot — re-bind the already-active responder. So the release handler
   * was reading `dragFrom === null` from the pre-touch render, taking the final
   * `else` branch, and silently dropping every dragged move. That is the "I try
   * to move a piece and nothing happens" bug.
   *
   * Refs are stable across renders, so reading through them always sees the
   * current value regardless of which render the closure came from.
   */
  const dragFromRef = useRef<string | null>(null);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  /**
   * The click-to-move selection, readable from the one-shot gesture handlers.
   *
   * Same reason as `dragFromRef`: the release handler runs from the closure that
   * was live when the touch STARTED, so it cannot see a `setSelected` from this
   * touch. Without a ref the second tap of a click-to-move found `selected` null
   * and did nothing.
   */
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const setDrag = useCallback((sq: string | null) => {
    dragFromRef.current = sq;
    setDragFrom(sq);
  }, []);

  /**
   * Square size is floored to a whole pixel and the board is sized as
   * `squareSize * 8`.
   *
   * This matters: with `flexWrap` and a fractional square size (e.g. 44.625),
   * eight squares no longer sum to exactly the container width, so the eighth
   * square wraps onto the next line. That produced the broken, uneven grid.
   * Using whole pixels makes the row width exact, and explicit row Views
   * (below) remove the wrap entirely.
   */
  const squareSize = availWidth > 0 ? Math.floor(availWidth / 8) : 0;

  // Sets, so the 64 squares do not each do an array scan on every render.
  const hintFromSet = useMemo(() => new Set(hintFrom), [hintFrom]);
  const hintToSet = useMemo(() => new Set(hintTo), [hintTo]);
  const boardWidth = squareSize * 8;

  /**
   * Board display order depends on orientation.
   *
   * `RANKS` is already top-to-bottom for White (`['8',...,'1']`), so White must
   * use it as-is and Black gets the reverse. Reversing for White put rank 1 at
   * the top — the board rendered upside down for every White-to-play position.
   */
  const displayRanks = orientation === 'white' ? RANKS : [...RANKS].reverse();
  const displayFiles = orientation === 'white' ? FILES : [...FILES].reverse();

  const board = useMemo(() => {
    try {
      return new Chess(fen);
    } catch {
      return new Chess();
    }
  }, [fen]);

  /** Live handle on the parsed position — the one-shot gesture handlers need it. */
  const boardRef = useRef(board);
  boardRef.current = board;

  const legalTargets = useMemo(() => {
    const from = selected || dragFrom;
    if (!from || !interactive) return new Map<string, boolean>();
    try {
      // reuse the already-parsed board rather than re-parsing the FEN
      const map = new Map<string, boolean>();
      for (const m of board.moves({ square: from as Square, verbose: true })) {
        map.set(m.to, Boolean(m.captured));
      }
      return map;
    } catch {
      return new Map<string, boolean>();
    }
  }, [selected, dragFrom, board, interactive]);

  const tryUserMove = useCallback(
    (from: string, to: string): boolean => {
      const cb = onMoveRef.current;
      if (!cb) return false;
      // auto-queen promotion (training app: queen is virtually always correct)
      let promotion: string | undefined;
      try {
        const piece = board.get(from as Square);
        if (piece && piece.type === 'p') {
          const rank = to[1];
          if ((piece.color === 'w' && rank === '8') || (piece.color === 'b' && rank === '1')) {
            promotion = 'q';
          }
        }
      } catch {
        /* fall through without promotion */
      }
      const accepted = cb(from as Square, to as Square, promotion);
      setSelected(null);
      setDrag(null);
      return accepted;
    },
    [setDrag, board],
  );


  /**
   * Is `to` a legal destination for the piece on `from`, in the CURRENT position?
   *
   * Asked of the board directly rather than of the `legalTargets` memo. The memo
   * is derived from the last render's selection, and the release handler of a
   * fast tap can run before the re-render that would have refreshed it — so a
   * click-to-move could be judged against the previous selection's targets.
   */
  const isLegalTarget = useCallback((from: string, to: string): boolean => {
    try {
      return boardRef.current
        .moves({ square: from as Square, verbose: true })
        .some((m) => m.to === to);
    } catch {
      return false;
    }
  }, []);

  /**
   * Map a touch point to a board square, honouring orientation.
   *
   * THE COORDINATES MUST BE BOARD-RELATIVE, AND THAT IS NOT FREE
   * -------------------------------------------------------
   * `onResponderGrant` gives `nativeEvent.locationX/locationY`, and React Native
   * computes those **relative to the touch TARGET — the deepest view under the
   * finger — not relative to the view whose responder handler is running.**
   *
   * The board is a grid of 64 plain `View`s, so the target is always one of those
   * squares. Reading its local coordinates as if they were the board's maps every
   * tap to a square near the top-left corner: tapping `e8` (board-local 470,1352)
   * inside a square that starts at (409,1290) yields (61,62), which is `h1`.
   * `h1` holds a white rook and it is Black to move, so `onResponderGrant` takes
   * the "not one of ours" path, nothing is selected, and the touch is discarded.
   *
   * **That is the whole of "you can't move any piece"** — and it is why no square
   * on the board can be selected regardless of which one you press: the local
   * coordinates of a 123 px square can only ever produce row 0 or 1, so the
   * interpretation is always somewhere in the first two ranks.
   *
   * It survived several rounds of device reports because every one of them was
   * read as a ScrollView/responder/arrow problem, and because the source-level
   * benches model the coordinates as board-relative — which is exactly the
   * assumption that is wrong. `.bench/board.touch.test.mjs` pins the fix by
   * asserting the squares are `pointerEvents="none"`.
   *
   * The fix is to make the squares untouchable so the board is always the target.
   * They have no gestures of their own; everything is handled one level up.
   * `pageX/pageY` + `measure` would also work and would not depend on this, at
   * the cost of an async measure on every board mount.
   */
  const pointToSquare = useCallback(
    (x: number, y: number): string | null => {
      if (squareSize <= 0) return null;
      /*
       * Belt and braces: a non-finite coordinate would make every bounds check
       * below compare against NaN, which is false for all of them, and the
       * function would return the string "undefinedundefined" — a truthy "square"
       * holding no piece. The gesture would then be dropped silently, which looks
       * precisely like a dead board. Reject it instead.
       */
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const col = Math.floor(x / squareSize);
      const row = Math.floor(y / squareSize);
      if (col < 0 || col > 7 || row < 0 || row > 7) return null;
      const file = displayFiles[col];
      const rank = displayRanks[row];
      if (!file || !rank) return null;
      return `${file}${rank}`;
    },
    [squareSize, displayFiles, displayRanks],
  );

  /** Centre of a square in board coordinates (for arrows). */
  const squareCenter = useCallback(
    (square: string): { x: number; y: number } | null => {
      if (squareSize <= 0) return null;
      const file = square[0];
      const rank = square[1];
      const col = displayFiles.indexOf(file);
      const row = displayRanks.indexOf(rank);
      if (col < 0 || row < 0) return null;
      return {
        x: col * squareSize + squareSize / 2,
        y: row * squareSize + squareSize / 2,
      };
    },
    [squareSize, displayFiles, displayRanks],
  );

  /**
   * Gesture handlers, deliberately created ONCE, and CAPTURED on the board.
   *
   * Everything they need is read through refs at the moment of the event:
   *  - `dragFromRef` / `selectedRef` — see the notes above; the closure must not
   *    capture state, because it is the one bound when the touch started
   *  - `boardRef` — so the move is validated against the CURRENT position
   *  - `interactiveRef` — so a prop change mid-gesture is honoured
   *
   * Creating this object per render is what made the drag silently no-op: the
   * object identity changes, but the responder React Native already started
   * keeps calling the first one it was handed.
   *
   * WHY `...Capture` AND NOT PLAIN `onStartShouldSetResponder`
   * ---------------------------------------------------------
   * The squares used to be `Pressable`s, and this screen sits inside a
   * `ScrollView`. React Native resolves the non-capture `onStartShouldSetResponder`
   * from the DEEPEST target outward, so the square's own Pressable responder won
   * every touch and none of the handlers below ever ran. Two things followed:
   *
   *   - dragging a piece did nothing at all, and
   *   - a `Pressable` does not refuse termination, so as soon as the finger moved
   *     the enclosing ScrollView claimed the gesture and THE PAGE SCROLLED. That
   *     is the user's "i tried a move and ... then nothing changed": he swiped a
   *     piece, the screen scrolled, and the position was never touched.
   *
   * The capture variants run root-down, so the board is asked FIRST and wins.
   * The squares are plain `View`s now (a responder they cannot install), and
   * `onResponderTerminationRequest` refuses to hand the gesture on — which is
   * what makes a drag on the board a chess move rather than a scroll.
   */
  const gestureHandlers: GestureResponderHandlers = useMemo(
    () => ({
      onStartShouldSetResponderCapture: () => interactiveRef.current,
      onMoveShouldSetResponderCapture: () => interactiveRef.current,
      onStartShouldSetResponder: () => interactiveRef.current,
      onMoveShouldSetResponder: () => interactiveRef.current,
      onResponderGrant: (evt) => {
        if (!interactiveRef.current) return;
        const sq = pointToSquare(evt.nativeEvent.locationX, evt.nativeEvent.locationY);
        if (!sq) return;
        const b = boardRef.current;
        const piece = b.get(sq as Square);
        if (piece && piece.color === b.turn()) {
          // Own piece: begin a drag, and select it so a press that does not move
          // leaves it selected for a second tap.
          setDrag(sq);
          setSelected(sq);
          return;
        }
        /*
         * Not one of ours — so this may be the SECOND tap of a click-to-move.
         * The pending selection is deliberately left alone here; the release
         * handler is what decides whether the touch landed on a legal target.
         * Clearing it here is what made click-to-move work only for drags.
         */
        setDrag(null);
      },
      onResponderRelease: (evt) => {
        const to = pointToSquare(evt.nativeEvent.locationX, evt.nativeEvent.locationY);
        const from = dragFromRef.current;
        const pending = selectedRef.current;
        setDrag(null);
        if (!to) {
          setSelected(null);
          return;
        }
        const origin = from ?? pending;
        if (origin && origin !== to && isLegalTarget(origin, to)) {
          // A completed drag, or the second tap of a click-to-move.
          tryUserMove(origin, to);
          return;
        }
        if (origin === to) {
          // Pressed the piece itself: keep it selected for the second tap.
          setSelected(to);
          return;
        }
        // A press somewhere else: select it if it holds a piece of ours.
        const b = boardRef.current;
        const piece = b.get(to as Square);
        setSelected(piece && piece.color === b.turn() ? to : null);
      },
      onResponderTerminate: () => setDrag(null),
      onResponderTerminationRequest: () => false,
    }),
    // `tryUserMove`, `pointToSquare`, `isLegalTarget` and `setDrag` are all
    // stable (ref-backed or empty-dep), so this object is created once.
    [pointToSquare, tryUserMove, isLegalTarget, setDrag],
  );

  return (
    <View
      style={styles.wrapper}
      onLayout={(e) => {
        if (!size) setAvailWidth(e.nativeEvent.layout.width);
      }}
    >
      <View
        style={[styles.board, boardWidth > 0 ? { width: boardWidth, height: boardWidth } : null]}
        {...gestureHandlers}
      >
        {/* squares + pieces — one View per rank.
            flexWrap is deliberately avoided here: with a fractional square size
            the eight squares do not sum to the container width exactly and the
            last one wraps onto the next line, which is what produced the broken,
            uneven grid. Explicit rows make the layout deterministic. */}
        {displayRanks.map((rank, row) => (
          // Also `pointerEvents="none"`, for the same reason as the squares: every
          // point inside the board is covered by a square, so the row is never the
          // target in practice — but a row that CAN be one is a latent version of
          // the same bug. The board must be the only touchable thing in here.
          <View key={`rank-${rank}`} style={styles.row} pointerEvents="none">
            {displayFiles.map((file, col) => {
            const square = `${file}${rank}`;
            const isDark = (row + col) % 2 === 1;
            const piece = board.get(square as Square);
            const isSelected = selected === square || dragFrom === square;
            const isLegal = legalTargets.has(square);
            const isCapture = legalTargets.get(square);
            const isLastFrom = lastMove?.from === square;
            const isLastTo = lastMove?.to === square;
            // The blunder mark is independent of the last-move highlight: the two
            // say different things ("the move you just made" vs "that move was
            // wrong"), and a blunder is usually NOT the last move on the board — the
            // user has often already answered it.
            const isBlunderFrom = !!blunder && blunder.slice(0, 2) === square;
            const isBlunderTo = !!blunder && blunder.slice(2, 4) === square;
            const isHintFrom = hintFromSet.has(square);
            const isHintTo = hintToSet.has(square);

            let bg: string = isDark ? DARK : LIGHT;
            if (isLastFrom) bg = LAST_BG_FROM;
            if (isLastTo) bg = LAST_BG_TO;
            if (isBlunderFrom) bg = BLUNDER_FROM;
            if (isBlunderTo) bg = BLUNDER_TO;
            // A hint ring is a BORDER, not a fill. Filling the square would read as "this square is
            // selected" — i.e. as if the player had already picked this piece — which is the one
            // thing a hint must not do.
            if (isHintFrom) bg = HINT_BG;

            return (
              /*
               * A plain View, NOT a Pressable.
               *
               * A Pressable installs its own responder on a view deeper than the
               * board, and React Native asks the deepest target first — so it won
               * every touch, the board's drag handlers never ran, and because a
               * Pressable happily yields the gesture the enclosing ScrollView
               * scrolled the page instead of the piece being moved. The board
               * captures the gesture itself now (see `gestureHandlers`), so the
               * squares only need to draw.
               */
              <View
                key={square}
                /*
                 * `pointerEvents="none"` IS LOAD-BEARING — SEE `pointToSquare`.
                 *
                 * Without it, this square is the touch TARGET, and React Native
                 * reports `locationX/locationY` relative to the target rather than
                 * to the responder view, so the board reads every tap as if it had
                 * landed near its own top-left corner. No square can then be
                 * selected and no piece can be moved.
                 *
                 * The squares only draw. The board handles the gesture.
                 */
                pointerEvents="none"
                style={[
                  styles.square,
                  {
                    width: squareSize || undefined,
                    height: squareSize || undefined,
                    backgroundColor: bg,
                    borderColor: isHintFrom ? HINT_RING : isSelected ? SEL_BORDER : 'transparent',
                    borderWidth: isSelected || isHintFrom ? 2 : 0,
                  },
                  isSelected ? { backgroundColor: SEL_BG } : null,
                ]}
              >
                {/* legal-move indicator, drawn beneath the piece */}
                {(isLegal || isHintTo) && squareSize > 0 ? (
                  <View
                    style={[
                      styles.legalDot,
                      {
                        width: isCapture ? squareSize * 0.62 : squareSize * 0.3,
                        height: isCapture ? squareSize * 0.62 : squareSize * 0.3,
                        borderRadius: squareSize,
                        backgroundColor: isCapture ? CAPTURE_DOT : QUIET_DOT,
                        // A hint dot is the ordinary dot in the ordinary colour. The whole point of
                        // the two-step hint is that it looks like what the board already shows when
                        // you select a piece, so it informs without announcing itself.
                        opacity: isLegal ? 1 : 0.75,
                      },
                    ]}
                  />
                ) : null}

                {piece ? (
                  <PieceSvg
                    piece={pieceKey(piece.color as 'w' | 'b', piece.type)}
                    size={squareSize || 30}
                  />
                ) : null}

                {/* per-square overlay (classification badge) */}
                {squareOverlays[square] ? (
                  <View style={styles.overlay} pointerEvents="none">
                    {squareOverlays[square]}
                  </View>
                ) : null}

                {/* notation */}
                {col === 0 ? (
                  <Text allowFontScaling={false} style={[styles.rankLabel, { color: isDark ? LIGHT : DARK }]}>
                    {rank}
                  </Text>
                ) : null}
                {row === 7 ? (
                  <Text allowFontScaling={false} style={[styles.fileLabel, { color: isDark ? LIGHT : DARK }]}>
                    {file}
                  </Text>
                ) : null}
              </View>
            );
            })}
          </View>
        ))}

        {/* arrows — one SVG layer above the pieces, below overlays */}
        {squareSize > 0 && arrows.length > 0 ? (
          <Svg
            style={StyleSheet.absoluteFill}
            width={boardWidth}
            height={boardWidth}
            pointerEvents="none"
          >
            {arrows.map((a, i) => {
              const from = squareCenter(a.startSquare);
              const to = squareCenter(a.endSquare);
              if (!from || !to) return null;
              const dx = to.x - from.x;
              const dy = to.y - from.y;
              const len = Math.sqrt(dx * dx + dy * dy) || 1;
              const ux = dx / len;
              const uy = dy / len;
              const shaft = squareSize * 0.16;
              const head = squareSize * 0.34;
              const headW = squareSize * 0.34;
              // stop the shaft short so the head tip lands on the target centre
              const tipX = to.x;
              const tipY = to.y;
              const baseX = to.x - ux * head;
              const baseY = to.y - uy * head;
              const startX = from.x + ux * shaft;
              const startY = from.y + uy * shaft;
              const px = -uy;
              const py = ux;
              return (
                <G key={`arrow-${i}`} opacity={0.88}>
                  <Line
                    x1={startX}
                    y1={startY}
                    x2={baseX}
                    y2={baseY}
                    stroke={a.color}
                    strokeWidth={shaft}
                    strokeLinecap="round"
                  />
                  <Polygon
                    points={[
                      `${tipX},${tipY}`,
                      `${baseX + px * headW * 0.5},${baseY + py * headW * 0.5}`,
                      `${baseX - px * headW * 0.5},${baseY - py * headW * 0.5}`,
                    ].join(' ')}
                    fill={a.color}
                  />
                </G>
              );
            })}
          </Svg>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { width: '100%', alignItems: 'center' },
  board: {
    // Rows are laid out explicitly (see the render), so the board itself only
    // needs clipping + the rounded frame.
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: DARK,
  },
  row: {
    flexDirection: 'row',
  },
  square: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  legalDot: {
    position: 'absolute',
  },
  overlay: {
    position: 'absolute',
    right: '2%',
    bottom: '1%',
    width: '34%',
    height: '34%',
  },
  rankLabel: {
    position: 'absolute',
    top: 1,
    left: 3,
    fontSize: 9,
    fontWeight: '700',
    opacity: 0.75,
  },
  fileLabel: {
    position: 'absolute',
    bottom: 0,
    right: 3,
    fontSize: 9,
    fontWeight: '700',
    opacity: 0.75,
  },
});
