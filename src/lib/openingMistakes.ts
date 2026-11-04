'use client';

/**
 * OPENING MISTAKES FROM THE USER'S OWN GAMES.
 *
 * The request: *"try to give me examples from my games in 'your openings' where i made a mistake or
 * blunder on the opening and tell me that i made a mistake/blunder and shows me what to play
 * instead"*.
 *
 * There is already a deck of exactly these positions — `minePuzzles` walks the user's own games and
 * keeps the ones where they dropped something — so this does not need a second engine pass or a new
 * scan. It needs to answer three questions the raw deck cannot:
 *
 *  1. WHICH of those positions belong to the opening? `minePuzzles` deliberately walks up to ply 40,
 *     so its deck is mostly middlegame. An opening screen showing a move-30 tactic is answering a
 *     question nobody asked.
 *  2. WHICH opening is this position actually in? The deck carries the game's opening family name,
 *     which is the position's STARTING family, not necessarily the family the mistake happened in.
 *  3. WHAT should the user be told? "You blundered" is not a lesson on its own. It needs the move
 *     they should have played, and — because the sign of the eval was the thing that was broken —
 *     whether they were winning when they threw it away.
 *
 * On (3) specifically: `missedWin` is now meaningful. It could not be before the eval-sign fix, when
 * a Black player's 400cp mistake was classified as "good" and the whole notion of a blunder in a
 * Black game was unreachable.
 */

import type { MinedPuzzle } from '@/lib/gameScan';

/**
 * How deep into a game still counts as "the opening".
 *
 * 20 plies is 10 moves each — past every phase of the opening, and before the middlegame tactics that
 * make up most of the mined deck. Chosen to be generous enough to include the moves where an opening
 * is actually lost (a bad pawn break, an early queen sortie, missing a developing move) and tight
 * enough to exclude "and then 20 moves later he hangs a queen".
 */
export const OPENING_MAX_PLY = 20;

export interface OpeningMistake {
  /** Stable across rescans, so "seen" state survives. Same id shape as the mined puzzle. */
  id: string;
  /** Where it happened, as the user would say it. */
  gameUrl: string;
  /** Opening family name as recorded on the game. */
  opening: string;
  /** The move the user played, in SAN. */
  playedSan: string;
  /** The move they should have played instead. */
  bestSan: string;
  /** What to call it, in the user's own words: a blunder, or a chance they was winning and dropped. */
  kind: 'blunder' | 'missed-win';
  /** Centipawns lost, mover's scale. Drives the ordering. */
  lossCp: number;
  /** Opening-relative move number, for "move 7" rather than "ply 12". */
  moveNumber: number;
}

/**
 * Turn the mined deck into per-opening mistake lists.
 *
 * Grouped by the game's own opening-family name rather than by any book lookup, for a reason worth
 * stating: the alternative is to classify each position against 1,204 studies, and a study match at
 * move 6 is a statement about a transposition that the user cannot check and does not need. The
 * family the game was played in is the one they will recognise from their own history.
 *
 * Sorted worst loss first within each family, because the most expensive mistake in an opening is the
 * one worth seeing.
 */
export function openingMistakesByFamily(
  puzzles: readonly MinedPuzzle[],
  maxPly: number = OPENING_MAX_PLY,
): Map<string, OpeningMistake[]> {
  const byFamily = new Map<string, OpeningMistake[]>();

  for (const p of puzzles) {
    if (p.ply > maxPly) continue;
    // `brilliant` is in the deck now, at the user's request, but it is not a mistake and must never
    // appear on a screen titled "where you went wrong".
    if (p.theme === 'brilliant') continue;
    if (!p.opening) continue;

    const family = p.opening;
    const list = byFamily.get(family) ?? [];
    list.push({
      id: p.id,
      gameUrl: p.gameUrl,
      opening: family,
      playedSan: p.playedSan,
      bestSan: p.bestSan,
      kind: p.theme === 'missed-win' ? 'missed-win' : 'blunder',
      lossCp: p.lossCp,
      moveNumber: Math.floor(p.ply / 2) + 1,
    });
    byFamily.set(family, list);
  }

  for (const [family, list] of byFamily) {
    list.sort((a, b) => b.lossCp - a.lossCp);
    byFamily.set(family, list);
  }
  return byFamily;
}

/**
 * A one-line description of what went wrong, phrased for the person who did it.
 *
 * The two cases are kept apart because they call for different reactions. A blunder in a lost
 * position is a slip. A missed win is the expensive one — the game was still there and it was
 * thrown away — and leading with the number is what makes that land.
 */
export function describeOpeningMistake(m: OpeningMistake): string {
  const pawns = (m.lossCp / 100).toFixed(1);
  if (m.kind === 'missed-win') {
    return `You were winning here and played ${m.playedSan}. ${m.bestSan} kept it — you gave up ${pawns}.`;
  }
  return `You played ${m.playedSan} here. ${m.bestSan} was the move — it cost ${pawns}.`;
}
