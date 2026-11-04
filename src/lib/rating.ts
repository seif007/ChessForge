import type { TrainerTier } from './endgameTrainer';

/**
 * Shared Elo-style rating for the training modes.
 *
 * Why not fixed deltas: the previous scheme awarded +12/+6 and took −8
 * regardless of how hard the puzzle was or how much help was used, so the
 * number drifted upward for anyone who simply kept tapping, and hints were
 * free. An Elo update against the exercise's OWN rating fixes all of that at
 * once:
 *
 *  - solving something harder than your rating gains more than solving
 *    something easier, so the rating tracks real ability;
 *  - failing costs you, and the cost is larger against a weak opponent;
 *  - a hint drops the score from 1 to 0.5, which converts a gain into (at best)
 *    nothing and, once you are rated above the exercise, into a loss.
 *
 * Because the served exercise is always drawn from a window around the rating
 * (see `modeWindow`), "advance when correct, drop when wrong" also keeps the
 * difficulty automatically near the user's level.
 */

/** Standard K-factor. 32 is the usual club-level value and moves fast enough
 *  to feel responsive over a training session without being wild. */
export const K_FACTOR = 32;

/** Probability that a player rated `user` scores against `opponent`. */
export function expectedScore(user: number, opponent: number): number {
  return 1 / (1 + Math.pow(10, (opponent - user) / 400));
}

export type AttemptOutcome = {
  /** Solved the puzzle/position. */
  solved: boolean;
  /** At least one wrong move was played. */
  madeMistake: boolean;
  /** The hint was revealed (button or auto-hint after repeated failures). */
  usedHint: boolean;
  /** The solution was revealed / the user gave up. */
  gaveUp?: boolean;
};

/**
 * Convert an attempt into an Elo score in [0, 1].
 *
 *  1.0  clean solve — no wrong move, no hint
 *  0.5  solved, but only with a mistake or a hint
 *  0.0  not solved (gave up, ran out of moves, lost the position)
 */
export function scoreFor(o: AttemptOutcome): number {
  if (!o.solved) return 0;
  if (o.gaveUp) return 0;
  return o.madeMistake || o.usedHint ? 0.5 : 1;
}

/**
 * Rating change for one attempt. `opponent` is the exercise's own rating
 * (puzzle rating, or the engine's Elo for an endgame position).
 *
 * Rounded, and clamped so a result never reports a change of 0 — a visible
 * "+0" reads as a bug to the user even when it is mathematically correct.
 */
export function ratingDelta(
  user: number,
  opponent: number,
  score: number,
  k = K_FACTOR,
): number {
  const raw = k * (score - expectedScore(user, opponent));
  const rounded = Math.round(raw);
  if (rounded !== 0) return rounded;
  if (raw > 0) return 1;
  if (raw < 0) return -1;
  return 0;
}

/** Convenience: outcome -> rating change, in one call. */
export function deltaForAttempt(
  user: number,
  opponent: number,
  outcome: AttemptOutcome,
  k = K_FACTOR,
): { delta: number; score: number } {
  const score = scoreFor(outcome);
  let delta = ratingDelta(user, opponent, score, k);
  // An assisted solve must never pay. The half-score alone is not enough: it
  // still came out positive against a much harder exercise (+13 for a mistake,
  // +15 for a hint at 1500 vs 2100), which contradicts "get lower if he does a
  // mistake/hint". So a solve that needed a wrong move or the hint can only
  // hold or cost — never gain. At or below the user's own level the half-score
  // already makes it a loss, so in practice it shows a small drop.
  if ((outcome.madeMistake || outcome.usedHint) && delta > 0) delta = 0;
  return { delta, score };
}

/**
 * Rating band, shared by the puzzle and endgame screens.
 *
 * These are `TrainerTier`'s four bands, and the EDGES here are the same numbers as `TIER_RATING_BAND`
 * in `endgameTrainer.ts` and as `autoModeFor` in `puzzles.ts`. Three copies of one ladder, and
 * nothing makes them agree — GATE 1e asserts the ids resolve to the same band across the range.
 *
 * A return value is used as a lookup key, so it has to be a `TrainerTier` and not a near-miss: a
 * misspelling here would not throw, it would quietly miss every table it is looked up in.
 */
export function ratingBand(rating: number): TrainerTier {
  if (rating < 1250) return 'warmup';
  if (rating < 1750) return 'steady';
  if (rating < 2250) return 'sharp';
  return 'relentless';
}
