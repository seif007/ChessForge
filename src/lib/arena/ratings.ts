/**
 * ChessForge ratings — deliberately unrelated to Lichess.
 *
 * One Elo-style pool per time category. Human games update the human pool and
 * bot games update the bot pool; a bot-vs-bot game never touches the human's
 * rating. K is fixed at 32 because these are local, low-volume pools and a
 * transparent constant is easier to explain than a provisional formula.
 */

import type { ArenaRatings, ArenaTimeCategory } from './types';

export const DEFAULT_RATINGS: ArenaRatings = {
  bullet: 1500,
  blitz: 1500,
  rapid: 1500,
  classical: 1500,
};

export const RATING_CATEGORIES: readonly ArenaTimeCategory[] = [
  'bullet',
  'blitz',
  'rapid',
  'classical',
];

export const RATING_K = 32;

/** The score is 1 for a win, 0.5 for a draw, 0 for a loss. */
export function eloDelta(rating: number, opponentRating: number, score: number, k = RATING_K): number {
  const expected = 1 / (1 + Math.pow(10, (opponentRating - rating) / 400));
  return Math.round(k * (score - expected));
}

export function applyElo(rating: number, opponentRating: number, score: number): number {
  return Math.max(100, rating + eloDelta(rating, opponentRating, score));
}

export function normalizeRatings(partial?: Partial<ArenaRatings> | null): ArenaRatings {
  const clean = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return {
    bullet: clean(partial?.bullet, DEFAULT_RATINGS.bullet),
    blitz: clean(partial?.blitz, DEFAULT_RATINGS.blitz),
    rapid: clean(partial?.rapid, DEFAULT_RATINGS.rapid),
    classical: clean(partial?.classical, DEFAULT_RATINGS.classical),
  };
}

export function ratingFrom(
  ratings: ArenaRatings | undefined,
  category: ArenaTimeCategory,
  fallback: number,
): number {
  const value = ratings?.[category];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function withRating(
  ratings: ArenaRatings | undefined,
  category: ArenaTimeCategory,
  value: number,
): ArenaRatings {
  const base = normalizeRatings(ratings);
  return { ...base, [category]: Math.round(value) };
}

/** A bot's first ChessForge rating starts from its playing strength, not its source Elo. */
export function initialBotRating(profile: { playElo?: number; rating: number }): number {
  return profile.playElo ?? profile.rating;
}
