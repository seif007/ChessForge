'use client';

/**
 * Lichess games → the `GameStatRow` shape the Stats screen already consumes.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * Stats used to be derived from games the user imported and analyzed in-app:
 * every field on `GameStatRow` (brilliant / miss / blunder counts, per-move
 * quality) came from an engine pass we ran ourselves. The user asked to switch
 * the DATA SOURCE to a Lichess account without changing what the screen shows,
 * so this module is the adapter.
 *
 * The catch: **Lichess publishes no move-quality data and no per-game
 * accuracy** in the public game feed. It gives us the moves and the result —
 * nothing about individual moves, and no accuracy number.
 *
 * So the quality fields split into two groups:
 *
 *   FREE (from the API)          background (ours), from the moves
 *   ---------------------------  -----------------------------------------
 *   result, color, date          book  (left our repertoire)
 *   openingKey / openingLine     deviationPly / deviationMove
 *   plies                        brilliant, great, best, excellent, good,
 *                                inaccuracy, miss, mistake, blunder
 *                                accuracy, when a scan can estimate it
 *
 * `accuracy` stays null when no estimate exists, rather than being averaged in
 * as a 0 — a zero would drag the "avg accuracy" stat down and look like a bug.
 *
 * The heavy analysis is deliberately NOT here: this module is pure and takes the
 * already-computed verdicts, so it is cheap to unit-test and the scanning itself
 * can be paged, cancelled and resumed by the caller.
 */

import type { LichessGame } from '@/lib/lichess';
import type { GameStatRow } from '@/lib/stats';

/** Per-move verdict the engine pass produces for one of the user's moves. */
export interface MoveVerdict {
  ply: number;               // 0-based ply of the USER's move
  kind: string;              // QualityKind from lib/moveQuality
}

/** The result of scanning one game with our engine. */
export interface ScannedGame {
  /** Quality tallies for the user's moves, keyed by QualityKind. */
  counts: Record<string, number>;
  /** Plies where the user left the book, if we matched a repertoire. */
  deviationPly: number | null;
  deviationMove: string | null;
  /** True when the game never left the repertoire tree. */
  onBook: boolean;
  /** Only set when a scan can estimate accuracy. */
  estimatedAccuracy: number | null;
}

/**
 * Map a quality tally onto the columns of `GameStatRow`.
 *
 * The row's columns are the schema's, not ours: `bestCount` is spelled that way
 * because `best` is awkward in SQL, and the move-quality card reads the totals
 * by name.
 */
export function emptyCounts(): Record<string, number> {
  return {
    brilliant: 0, great: 0, best: 0, excellent: 0,
    good: 0, book: 0, inaccuracy: 0, miss: 0, mistake: 0, blunder: 0,
  };
}

function n(counts: Record<string, number>, kind: string): number {
  const v = counts[kind];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

/**
 * The slice of a scan record this adapter needs.
 *
 * Only `depthReached` is required beyond `ScannedGame`, and it lives on the
 * record (not the base type) because it is a resumption detail. Typing it as a
 * structural subset keeps the caller free to pass a full `ScanRecord`.
 */
export type ScannedGameLike = ScannedGame & { depthReached?: number };

/**
 * Build one `GameStatRow` from a Lichess game plus its engine verdict.
 *
 * `scanned` may be null when the game has not been analyzed yet (e.g. the user
 * only wants win rates and stopped the scan early). In that case the quality
 * columns stay at 0 and `onBook` is false — the win-rate and opening halves of
 * the Stats screen are still correct, and the quality block simply reads empty
 * rather than fabricating numbers.
 */
export function toGameStatRow(
  game: LichessGame,
  scanned: ScannedGameLike | null,
  username: string,
): GameStatRow {
  const counts = scanned ? scanned.counts : emptyCounts();

  /*
   * Preserve "no accuracy" as null. Lichess does not publish a per-game
   * accuracy, so a value only exists when a scan can estimate it. Substituting
   * 0 would make the screen's average collapse and would look like a bug.
   *
   * The engine estimate is only used when it exists; it currently never does
   * (the scan sets it to null), so in practice the accuracy block is empty and
   * the screen says so.
   */
  const accuracy = game.accuracy ?? scanned?.estimatedAccuracy ?? null;

  // The opponent's accuracy is not published when ours is not, so mirror ours
  // rather than inventing a different number.
  const opponentAccuracy = game.accuracy != null ? (game.opponentAccuracy ?? null) : accuracy;

  return {
    id: game.id,
    date: isoDate(game.endTime),
    openingKey: game.opening,
    openingLine: game.openingVariation,
    color: game.color,
    result: game.outcome,
    accuracy,
    opponentAccuracy,
    plies: game.movesSan.length,
    brilliant: n(counts, 'brilliant'),
    great: n(counts, 'great'),
    bestCount: n(counts, 'best'),
    excellent: n(counts, 'excellent'),
    good: n(counts, 'good'),
    book: n(counts, 'book'),
    inaccuracy: n(counts, 'inaccuracy'),
    miss: n(counts, 'miss'),
    mistake: n(counts, 'mistake'),
    blunder: n(counts, 'blunder'),
    deviationPly: scanned ? scanned.deviationPly : null,
    deviationMove: scanned ? scanned.deviationMove : null,
    /*
     * Whether this game has been through our engine. `deviationPly == null` is
     * NOT a substitute: it is equally null for a game that was never scanned, so
     * "on book" would count unscanned games as repertoire-faithful.
     */
    analysed: scanned != null && (scanned.depthReached ?? 0) > 0,
    createdAt: isoDate(game.endTime),
  };
}

/** The client normalises Lichess timestamps to unix SECONDS; the row wants a date string. */
function isoDate(endTime: number): string {
  if (!Number.isFinite(endTime) || endTime <= 0) return '';
  // seconds -> ms. Guard the unit: a value this large is already milliseconds.
  const ms = endTime > 1e12 ? endTime : endTime * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ filters */

export interface GameFilter {
  /** Include bullet games. Default false — bullet is mostly noise. */
  includeBullet?: boolean;
  /** Include unrated/casual games. Default false. */
  includeUnrated?: boolean;
}

/**
 * Which games are worth learning from.
 *
 * Defaults follow the user's explicit choice: **rated rapid and blitz only**.
 * Bullet games are dominated by time pressure rather than chess understanding,
 * so their "blunders" would generate poor puzzles and would skew the per-opening
 * win rates; unrated games are often casual experiments.
 *
 * Daily games are kept: they are rated, slow, and the strongest signal we get.
 */
export function keepGame(game: LichessGame, filter: GameFilter = {}): boolean {
  if (!filter.includeUnrated && !game.rated) return false;
  if (!filter.includeBullet && game.timeClass === 'bullet') return false;
  // A game with no moves is a stub (aborted seek) — nothing to learn from.
  if (game.movesSan.length < 4) return false;
  return true;
}

/** Apply a filter and return the games in the order given. */
export function filterGames(
  games: LichessGame[],
  filter: GameFilter = {},
): LichessGame[] {
  return games.filter((g) => keepGame(g, filter));
}
