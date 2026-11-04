'use client';

/**
 * HINTS THAT DO NOT GIVE THE ANSWER AWAY.
 *
 * The complaint, in the owner's words: *"i clicked on hint and instead of coloring the piece that i
 * should move, it showed me an arrow on where to move it so basically it showed me the solution"*.
 *
 * That is not a nitpick about presentation. A hint's entire value is that it reduces the search
 * space WITHOUT collapsing it. "Which piece do I move?" narrows a position to a handful of candidate
 * moves and leaves the actual decision — the whole decision — to the player. "Here is the move"
 * removes the decision entirely, so the button is not a hint, it is a surrender with a rating cost
 * attached.
 *
 * So a hint here is always the two-step version, and never an arrow:
 *
 *   press 1  ring every piece that has at least one legal move   ("something of yours can go")
 *   press 2  dot where those pieces may go                        ("here is the shape of the move")
 *
 * Press 2 still does not say WHICH piece, and never where it should go. A player who has been ringed
 * every piece and dotted every destination still has to find the move — which is the part worth
 * training.
 *
 * The arrow is still available where it is not a spoiler: `GameOpeningsScreen` draws "what we
 * recommend" while you are reading a study, and the analyse screen's engine line is opt-in behind
 * its own toggle. Those are labelled as answers and are meant to be answers.
 */

import { Chess, type Square } from 'chess.js';

/**
 * THE ONE PIECE THAT SOLVES THIS, and nothing else.
 *
 * THE REPORT: *"when i click hint only colour the piece that i should move"* and *"when i clicked on hint
 * it selected 2 pieces so fix it"* — after an earlier narrowing to "pieces that can capture or check"
 * still rang two.
 *
 * Two is still a question, not an answer: "which of these?" is the same problem the hint exists to
 * shrink, one step smaller. The user asked for the piece, and on BOTH puzzle tabs the app knows which
 * piece it is:
 *
 *   - a live puzzle carries `solutionSan[step]`
 *   - a mined one carries `bestUci`
 *
 * So this is a read of data the screen already has. It costs no engine, and it does not need to invent
 * a heuristic about which move is "interesting" — the capture/check narrowing was a guess about a
 * position, and a guess that was wrong often enough to be reported twice.
 *
 * It is still a HINT and not the answer: it names the PIECE and never the square it goes to. The
 * destination is press 2, which is the same two-step contract as before.
 *
 * A move that is illegal in the position given yields an empty list rather than a throw. A hint that
 * cannot render is worse than no hint, and the caller draws nothing.
 */
export function solvingPiece(fen: string, san: string | null | undefined): string[] {
  if (!san) return [];
  try {
    const board = new Chess(fen);
    const move = board.move(san);
    if (!move) return [];
    return [move.from];
  } catch {
    return [];
  }
}

/**
 * Every square holding a piece of the side to move that has at least one legal move.
 *
 * A pinned piece with no legal move is excluded on purpose. Ringing it would be telling the player
 * to consider a move that does not exist, and in a pinned-piece tactic that is exactly the piece
 * they must learn to ignore.
 */
/**
 * The pieces a hint should ring, narrowed to the ones that can actually DO something.
 *
 * THE COMPLAINT: *"in puzzles from my games when i click hint it still select all my pieces"*.
 *
 * The old rule was "every piece with a legal move", which is correct as a statement about legality
 * and useless as a hint. In an ordinary middlegame position almost every piece has a legal move, so the
 * hint ringed the whole army and narrowed nothing - the player was told "something of yours can go",
 * which they could see without pressing anything. A hint that cannot be wrong is not information.
 *
 * So it is narrowed to the moves that change the position in a way a player can see: a CAPTURE, or a
 * move that gives CHECK. In a mined puzzle - which is a position where something went wrong - that is
 * usually a handful of pieces, and usually the right handful.
 *
 * AND IT STILL NEVER NAMES A MOVE. Which piece can capture is not which piece should. That line is the
 * whole point of the module and it is unchanged: press 2 still dots destinations without saying which
 * ringed piece is the one.
 *
 * When nothing captures and nothing checks - a genuinely quiet position - there is no narrower honest
 * answer, so it falls back to the legal-move set. Reporting "no useful candidate" would be a second
 * way of telling the player nothing.
 */
export function movableSquares(fen: string): string[] {
  try {
    const board = new Chess(fen);
    const movable: string[] = [];
    const pointed: string[] = [];
    for (const row of board.board()) {
      for (const cell of row) {
        // chess.js types a cell as `{ square, type, color }` with `type` a PieceSymbol, so an empty
        // square arrives as `null`/`undefined` rather than a blank symbol. Guard both anyway: the
        // cost is nil and a hint that rings empty squares would be worse than no hint.
        if (!cell) continue;
        if (cell.color !== board.turn()) continue;
        const moves = board.moves({ square: cell.square as Square, verbose: true });
        if (moves.length === 0) continue;
        movable.push(cell.square);
        // A capture or a check is a move that does something visible. `captured` is set by chess.js
        // for a capture; a check has to be detected by making the move and asking.
        if (moves.some((m) => m.captured)) { pointed.push(cell.square); continue; }
        const checks = moves.some((m) => {
          const probe = new Chess(board.fen());
          try { probe.move({ from: m.from, to: m.to, promotion: m.promotion }); } catch { return false; }
          return probe.isCheck();
        });
        if (checks) pointed.push(cell.square);
      }
    }
    return pointed.length > 0 ? pointed : movable;
  } catch {
    return [];
  }
}

/**
 * Every legal destination of the given pieces, de-duplicated.
 *
 * Two pieces can often reach the same square (a discovered line, or simply a fork target), and the
 * dots are drawn per SQUARE, so the union is what the board needs.
 */
export function targetSquares(fen: string, froms: string[]): string[] {
  try {
    const board = new Chess(fen);
    const out = new Set<string>();
    for (const from of froms) {
      for (const m of board.moves({ square: from as Square, verbose: true })) out.add(m.to);
    }
    return [...out];
  } catch {
    return [];
  }
}

/** Is it the side to move's turn at all? A hint on a finished position is meaningless. */
export function hasLegalMoves(fen: string): boolean {
  try {
    return new Chess(fen).moves().length > 0;
  } catch {
    return false;
  }
}
