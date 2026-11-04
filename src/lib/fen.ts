/**
 * The side to move, read off a FEN without building a board.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three screens need one bit from a position during RENDER - whose turn it is -
 * and all three were getting it by constructing a whole `Chess`:
 *
 *     const turn = new Chess(fen).turn();
 *
 * `new Chess(fen)` parses the entire position: piece placement, castling
 * rights, the en-passant square, both counters, and it builds a move generator
 * behind them. A FEN's second field already holds the answer, so the whole
 * board is thrown away to read one character.
 *
 * That is fine once. It is not fine in a render body: Analyse re-renders on
 * every engine evaluation it receives (several a second while a search runs),
 * and the puzzle board re-renders on every touch and every opponent reply - so
 * the board was built again for each of those frames, on the JS thread, to
 * answer a question the string had already answered. It is the same rule the
 * openings screen wrote down for itself ("never derive state with a `new
 * Chess()` replay per value"), applied to the one case where the value is a
 * field of the FEN.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not validate. `new Chess(fen)` throws on malformed input; this reads
 * field 2 and says `'w'` when there is nothing there. Every call site passes a
 * FEN the app itself produced (a board, a stored position, a line step), so
 * validation would only add a parse back. Where a FEN arrives from outside,
 * the caller validates it first - which is what `new Chess` is for.
 */

/** The side to move. `'w'` when the FEN is empty, which is the board's default. */
export type Turn = 'w' | 'b';

export function turnOf(fen: string | null | undefined): Turn {
  if (!fen) return 'w';
  // 'w' or 'b' is the second space-separated field; anything else is not a FEN,
  // and 'w' is the safe default for a caller that is only colouring the board.
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}
