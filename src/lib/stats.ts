'use client';

/**
 * Stats aggregation — client-side port of `src/app/api/stats/route.ts`.
 *
 * The aggregation functions are pure and were moved VERBATIM (tally, per-opening,
 * per-line, color split, deviation spots, trend). Only the data source changed:
 * instead of `db.gameStat.findMany()` we read the same rows from local SQLite.
 */

import { getDatabase } from '@/lib/db';

export interface GameStatRow {
  id: string;
  date: string;
  openingKey: string;
  openingLine: string;
  color: string;
  result: string;
  /**
   * A measured or estimated accuracy, or `null` when none exists.
   *
   * NULL IS NOT ZERO. Lichess does not publish per-game accuracy, and a scan
   * may not have estimated it yet. Storing an absent accuracy as 0 and then
   * averaging makes the reported figure meaningless — that bug produced a
   * displayed "avg accuracy" of 10% for an account whose actual average was
   * 68%. Averaging must therefore skip nulls rather than treat them as zeros.
   */
  accuracy: number | null;
  opponentAccuracy: number | null;
  plies: number;
  brilliant: number;
  great: number;
  bestCount: number;
  excellent: number;
  good: number;
  book: number;
  inaccuracy: number;
  miss: number;
  mistake: number;
  blunder: number;
  deviationPly: number | null;
  deviationMove: string | null;
  /** True once this game has been through our engine pass. */
  analysed: boolean;
  createdAt: string;
}

interface TallyInput {
  result: string;
  /** Null when the game has no accuracy; such rows are excluded from the mean. */
  accuracy: number | null;
  blunder: number;
}

interface AggLine {
  key: string;
  openingKey: string;
  line: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number | null;
  avgAccuracy: number;
  /** How many rows in this group had an accuracy — the mean's denominator. */
  accuracyGames: number;
  avgBlunders: number;
}

/**
 * Mean of the values that actually exist.
 *
 * Accuracy is not always published, and a missing accuracy is not a zero. Using
 * a plain sum/length here is what produced a 10% "average" for an account whose
 * genuine average is 68%: two thirds of its games carry no accuracy, and each
 * one silently contributed 0. Returns null when nothing has a value, so the UI
 * can say "—" instead of inventing 0%.
 */
function meanOfPresent(values: (number | null)[]): number | null {
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    sum += v;
    count++;
  }
  return count > 0 ? sum / count : null;
}

function tally(rows: TallyInput[]): Omit<AggLine, 'key' | 'openingKey' | 'line'> {
  const wins = rows.filter((r) => r.result === 'win').length;
  const losses = rows.filter((r) => r.result === 'loss').length;
  const draws = rows.filter((r) => r.result === 'draw').length;
  const decisive = wins + losses;
  return {
    games: rows.length,
    wins,
    draws,
    losses,
    winRate: decisive > 0 ? wins / decisive : null,
    avgAccuracy: meanOfPresent(rows.map((r) => r.accuracy)) ?? 0,
    accuracyGames: rows.filter((r) => r.accuracy != null).length,
    avgBlunders: rows.length ? rows.reduce((a, r) => a + r.blunder, 0) / rows.length : 0,
  };
}

export interface StatsResult {
  overall: {
    games: number;
    wins: number;
    losses: number;
    draws: number;
    winRate: number | null;
    avgAccuracy: number;
    avgOpponentAccuracy: number;
    /** How many games actually had a published accuracy — the mean's denominator. */
    accuracyGames: number;
    totalBlunders: number;
    totalMistakes: number;
    totalInaccuracies: number;
    totalBrilliants: number;
    totalGreats: number;
    totalMisses: number;
    totalBest: number;
    totalBook: number;
    /** Analysed games that never left the repertoire. */
    onBookGames: number;
    /** How many games have been through the engine pass — the onBook denominator. */
    analysedGames: number;
  };
  openings: (AggLine & { asWhite: number; asBlack: number })[];
  lines: AggLine[];
  colorSplit: (Omit<AggLine, 'key' | 'openingKey' | 'line'> & { color: 'w' | 'b' })[];
  deviations: { move: string; openingKey: string; count: number; wins: number; losses: number }[];
  trend: { date: string; openingKey: string; result: string; accuracy: number | null; color: string }[];
}

/** Read every GameStat row, oldest first (matches the web route's orderBy). */
export async function loadGameStats(): Promise<GameStatRow[]> {
  const db = await getDatabase();
  return db.getAllAsync<GameStatRow>('SELECT * FROM GameStat ORDER BY createdAt ASC');
}

/** Aggregate rows into the shape the Stats screen consumes. */
export function aggregateStats(rows: GameStatRow[]): StatsResult {
  const decisive = rows.filter((r) => r.result === 'win' || r.result === 'loss');

  const overall = {
    games: rows.length,
    wins: rows.filter((r) => r.result === 'win').length,
    losses: rows.filter((r) => r.result === 'loss').length,
    draws: rows.filter((r) => r.result === 'draw').length,
    winRate: decisive.length
      ? rows.filter((r) => r.result === 'win').length / decisive.length
      : null,
    // Both of these skip games with no published accuracy. See meanOfPresent:
    // averaging an absent value as 0 is what produced the bogus 10% figure.
    avgAccuracy: meanOfPresent(rows.map((r) => r.accuracy)) ?? 0,
    avgOpponentAccuracy: meanOfPresent(rows.map((r) => r.opponentAccuracy)) ?? 0,
    accuracyGames: rows.filter((r) => r.accuracy != null).length,
    totalBlunders: rows.reduce((a, r) => a + r.blunder, 0),
    totalMistakes: rows.reduce((a, r) => a + r.mistake, 0),
    totalInaccuracies: rows.reduce((a, r) => a + r.inaccuracy, 0),
    totalBrilliants: rows.reduce((a, r) => a + r.brilliant, 0),
    totalGreats: rows.reduce((a, r) => a + r.great, 0),
    totalMisses: rows.reduce((a, r) => a + r.miss, 0),
    totalBest: rows.reduce((a, r) => a + r.bestCount, 0),
    totalBook: rows.reduce((a, r) => a + r.book, 0),
    /*
     * "On book" must be measured against the games we actually ANALYSED.
     *
     * The previous test was `deviationPly == null`, which is also true of every
     * game that was never scanned — so the stat silently counted the whole
     * library as "stayed in repertoire". The user spotted exactly this: the
     * percentage reflected all their games while only 200 had been analysed.
     * Now only analysed games are eligible, and the denominator says so.
     */
    onBookGames: rows.filter((r) => r.analysed && r.deviationPly == null).length,
    analysedGames: rows.filter((r) => r.analysed).length,
  };

  // per opening
  const byOpening = new Map<string, GameStatRow[]>();
  for (const r of rows) {
    const arr = byOpening.get(r.openingKey) ?? [];
    arr.push(r);
    byOpening.set(r.openingKey, arr);
  }
  const openings = [...byOpening.entries()]
    .map(([key, rs]) => ({
      ...tally(rs),
      key,
      openingKey: key,
      line: '',
      asWhite: rs.filter((r) => r.color === 'w').length,
      asBlack: rs.filter((r) => r.color === 'b').length,
    }))
    .sort((a, b) => b.games - a.games);

  // per line (study) within an opening
  const byLine = new Map<string, GameStatRow[]>();
  for (const r of rows) {
    if (!r.openingLine) continue;
    const k = `${r.openingKey}||${r.openingLine}`;
    const arr = byLine.get(k) ?? [];
    arr.push(r);
    byLine.set(k, arr);
  }
  const lines: AggLine[] = [...byLine.entries()]
    .map(([k, rs]) => ({
      ...tally(rs),
      key: k,
      openingKey: k.split('||')[0],
      line: rs[0].openingLine,
    }))
    .sort((a, b) => b.games - a.games);

  // color split
  const colorSplit = (['w', 'b'] as const).map((c) => ({
    color: c,
    ...tally(rows.filter((r) => r.color === c)),
  }));

  // where the user most often leaves the repertoire
  const devMap = new Map<
    string,
    { move: string; openingKey: string; count: number; wins: number; losses: number }
  >();
  for (const r of rows) {
    if (r.deviationPly == null) continue;
    const k = `${r.openingKey}|${r.deviationPly}|${r.deviationMove ?? '?'}`;
    const cur =
      devMap.get(k) ??
      {
        move: `${Math.floor(r.deviationPly / 2) + 1}${r.deviationPly % 2 === 0 ? '.' : '...'} ${
          r.deviationMove ?? '?'
        }`,
        openingKey: r.openingKey,
        count: 0,
        wins: 0,
        losses: 0,
      };
    cur.count++;
    if (r.result === 'win') cur.wins++;
    if (r.result === 'loss') cur.losses++;
    devMap.set(k, cur);
  }
  const deviations = [...devMap.values()].sort((a, b) => b.count - a.count).slice(0, 8);

  /*
 * THE LAST FIFTEEN GAMES, NEWEST FIRST - AND NOT "THE LAST FIFTEEN ROWS".
 *
 * THE REPORT: *"the refresh added just one game while the user played many other games"*.
 *
 * This was `rows.slice(-15)`, which takes the last fifteen rows and is only the newest fifteen if
 * the caller happens to hand over rows oldest-first. The one caller builds them straight from
 * `games`, and `fetchAllGames` sorts those NEWEST first — so `slice(-15)` returned the account's
 * OLDEST fifteen, and a panel headed "Recent games" was showing games from July 2024.
 *
 * That is worse than a cosmetic sort. It is the one place the screen shows when the user's games
 * happened, so a list of ancient games under that heading reads as "my recent games are missing"
 * — which is exactly the conclusion that had been reached about a refresh that was in fact fetching.
 *
 * So the order is decided HERE, from the row's own date, rather than inherited from whatever order
 * the caller happened to use. A trend that means "recent" has to be recent on its own terms; a
 * library function that is correct only for one caller's sort order is one refactor away from the
 * same bug again.
 */
const trend = [...rows]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 15)
    .map((r) => ({
      date: r.date,
      openingKey: r.openingKey,
      result: r.result,
      accuracy: r.accuracy,
      color: r.color,
    }));

  return { overall, openings, lines, colorSplit, deviations, trend };
}

/** Convenience: read + aggregate in one call (replaces GET /api/stats). */
export async function loadStats(): Promise<StatsResult> {
  return aggregateStats(await loadGameStats());
}
