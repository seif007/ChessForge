/**
 * Material offers, measured after the move rather than guessed from the SAN.
 *
 * A sacrifice is not "a capture that looks bad". It is a move after which the
 * opponent can win material and the mover either cannot recapture or chooses
 * not to. That definition is deliberately narrow and mechanical:
 *
 *   - play the move;
 *   - ask every legal opponent capture what it wins;
 *   - allow the mover the best immediate recapture on that square;
 *   - net the material the move itself won against what the opponent wins.
 *
 * The result is in pawns. A pawn offer is worth 1, a knight offer 3. This is
 * the signal both the Gambit personality and the `brilliant` classifier read,
 * so a gambit and a badge cannot disagree about whether material was offered.
 *
 * It is still a static heuristic: it sees the first capture, not the whole
 * combination. That is why `brilliant` asks for at least two pawns *and* the
 * engine's second-best gap, while the personality layer is allowed to notice a
 * one-pawn gambit. Those are different claims and use different thresholds.
 */

import { Chess } from 'chess.js';

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const valueOf = (piece: string | undefined): number => (piece ? PIECE_VALUE[piece] ?? 0 : 0);

function uciParts(uci: string): { from: string; to: string; promotion?: string } | null {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(uci)) return null;
  return {
    from: uci.slice(0, 2).toLowerCase(),
    to: uci.slice(2, 4).toLowerCase(),
    promotion: uci.length > 4 ? uci[4].toLowerCase() : undefined,
  };
}

/**
 * How much material (in pawns) the opponent can win by force after `uci`.
 *
 * `0` means no profitable capture is available. The move's own capture is
 * netted off, so an equal queen trade is not a queen sacrifice. Pawns are
 * included because a gambit is precisely a pawn offer; the `brilliant`
 * classifier adds its own two-pawn floor.
 */
export function sacrificeValue(fenBefore: string, uci: string): number {
  const parts = uciParts(uci);
  if (!parts) return 0;

  let board: Chess;
  let mv: ReturnType<Chess['move']> | null;
  try {
    board = new Chess(fenBefore);
    mv = board.move(parts);
  } catch {
    return 0;
  }
  if (!mv) return 0;

  const gained = valueOf(mv.captured);
  const afterFen = board.fen();
  const after = new Chess(afterFen);
  let worstNet: number | null = null;

  for (const reply of after.moves({ verbose: true })) {
    if (!reply.captured) continue;

    const lost = valueOf(reply.captured);
    let bestRecapture = 0;
    try {
      const recaptureBoard = new Chess(afterFen);
      recaptureBoard.move({
        from: reply.from,
        to: reply.to,
        promotion: reply.promotion,
      });
      for (const back of recaptureBoard.moves({ verbose: true })) {
        // Only an immediate recapture of the piece that just captured counts.
        // A capture somewhere else is a different combination, not the price
        // of this offer.
        if (back.to === reply.to && back.captured) {
          bestRecapture = Math.max(bestRecapture, valueOf(back.captured));
        }
      }
    } catch {
      bestRecapture = 0;
    }

    const netForMover = gained + bestRecapture - lost;
    if (worstNet === null || netForMover < worstNet) worstNet = netForMover;
  }

  return worstNet === null ? 0 : Math.max(0, -worstNet);
}

/** True when the move offers at least `minPawns` of material. */
export function isMaterialSacrifice(fenBefore: string, uci: string, minPawns = 1): boolean {
  return sacrificeValue(fenBefore, uci) >= minPawns;
}
