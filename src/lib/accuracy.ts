/**
 * Shared accuracy maths.
 *
 * WHY THIS IS A MODULE
 * ====================
 * The analysis screen used to own two copies of this arithmetic — one for the
 * eval bar, one for the review — and the review added a third, different rule
 * for turning a centipawn loss into a move label. The formulas are the part of
 * a game review that users compare against Lichess and WintrChess, so they are
 * kept in one place, with the sources named next to them.
 *
 * TWO DIFFERENT CURVES, ON PURPOSE
 * ================================
 *  - `winPercent` is Lichess's published win-probability curve. It is used for
 *    the eval bar and for the per-move/game accuracy score.
 *  - `expectedPoints` is the logistic used by WintrChess's classifier. It is
 *    used to decide whether a move is good, a mistake or a blunder. The two
 *    curves are almost identical over normal evaluations; keeping each
 *    formula with the thing it was published for avoids inventing a third
 *    scale.
 *
 * WHAT IS NOT A CENTIPAWN THRESHOLD
 * =================================
 * A raw centipawn drop is a bad basis for a label. Losing 100cp when you are
 * +9.00 costs almost nothing; the same 100cp from equality is a real error.
 * Both curves above are monotone in centipawns and saturate near the ends, so
 * they measure what the move cost in practical winning chances instead.
 */

export type Colour = 'w' | 'b';

/** The two fields a real engine evaluation must carry at least one of. */
export interface EvalLike {
  scoreCp: number | null;
  mateIn: number | null;
}

/**
 * The fraction of positions that actually carry an engine evaluation.
 *
 * WHY THIS EXISTS: an engine that was never running answers every search with a
 * null eval, and a review built from nulls is not "a game with no mistakes" — it
 * is a review with no evidence. The AGGREGATE symptom was exactly that and it
 * read as a broken classifier: every move scored 0 centipawns of loss, so both
 * players came back at 100% accuracy with the bar pinned at 0.0. The review now
 * refuses to publish a report whose evaluations are mostly missing.
 */
export function evalCoverage(evals: readonly EvalLike[]): number {
  if (evals.length === 0) return 0;
  const real = evals.filter((e) => e.scoreCp != null || e.mateIn != null).length;
  return real / evals.length;
}

/**
 * Below this share of evaluated positions, the numbers are not a review.
 *
 * Half is deliberately generous: a handful of positions can legitimately return
 * no eval (a transient engine hiccup that one retry did not recover), and the
 * remaining evaluations still grade those moves by their neighbours. What must
 * never pass is "most positions have nothing", which produces the misleading
 * 100% / 0.0 output.
 */
export const MIN_EVAL_COVERAGE = 0.5;

/** True when a set of evaluations is complete enough to review the game. */
export function analysisUsable(evals: readonly EvalLike[]): boolean {
  return evalCoverage(evals) >= MIN_EVAL_COVERAGE;
}

/** Lichess's win-probability curve, in percentage points (0..100). */
export function winPercent(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/**
 * Expected score (0..1) for an evaluation from the side being measured.
 *
 * WintrChess uses this logistic with a 0.0035 gradient for its move
 * classification bands. Mate scores are folded onto the centipawn scale by the
 * caller, so a forced mate sits at the top of this curve.
 */
export function expectedPoints(cp: number): number {
  return 1 / (1 + Math.exp(-0.0035 * cp));
}

/** How much expected score a move gave away, from the mover's perspective. */
export function pointLoss(before: number, after: number): number {
  return Math.max(0, expectedPoints(before) - expectedPoints(after));
}

/**
 * Lichess's per-move accuracy, including its +1 "uncertainty bonus".
 *
 * A move that did not lose any win probability is exactly 100, not 99.99.
 * The `+ 1` is part of the published formula and must not be rounded away:
 * without it a perfect game reads as 99.99 instead of 100.
 */
export function moveAccuracy(winDiff: number): number {
  if (winDiff <= 0) return 100;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) - 3.166924740191411;
  return Math.max(0, Math.min(100, raw + 1));
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Lichess's game accuracy: a blend of a volatility-weighted mean and the
 * harmonic mean.
 *
 * The arithmetic mean of per-move accuracies can be flattered by a long tail of
 * quiet moves around one catastrophic move. Lichess divides the game into
 * sliding windows, weights each move by the standard deviation of the win
 * probability in its window, and then averages that weighted mean with the
 * harmonic mean. The harmonic mean is the part that makes a single blunder
 * count; the weighted mean is the part that makes an error in a sharp position
 * count more than the same error in a dead position.
 *
 * `cps` is the evaluation of each position from White's point of view:
 * the position before the first move, then the position after every move. Its
 * length is therefore `moves.length + 1`. `startColor` is the colour that made
 * the first move (White in a normal game, but the function is also correct for
 * a game starting from a Black-to-move position).
 *
 * Lichess's source lives in `modules/analyse/src/main/AccuracyPercent.scala`;
 * the window padding below mirrors its `List.fill(windowSize - 2) ... ::: sliding`
 * construction, which is what aligns one weight with each move.
 */
export function gameAccuracy(
  cps: (number | null)[],
  startColor: Colour,
): { white: number; black: number } {
  const winPercents = cps.map((cp) => (cp == null ? null : winPercent(cp)));
  const positions = winPercents.length;
  if (positions < 2) return { white: 100, black: 100 };

  // Lichess: ((positions - 1) / 10) clamped to 2..8.
  const windowSize = Math.max(2, Math.min(8, Math.floor((positions - 1) / 10)));

  // One window per move. The first `windowSize - 2` moves reuse the opening
  // window; the rest slide one position at a time.
  const windows: (number | null)[][] = [];
  const openingWindow = winPercents.slice(0, windowSize);
  for (let i = 0; i < Math.min(windowSize, positions) - 2; i++) {
    windows.push(openingWindow);
  }
  for (let start = 0; start + windowSize <= positions; start++) {
    windows.push(winPercents.slice(start, start + windowSize));
  }

  const weights = windows.map((window) => {
    const values = window.filter((value): value is number => value != null);
    if (values.length < 2) return null;
    // Lichess squeezes volatility into 0.5..12. A completely quiet window
    // therefore still has a small weight rather than dividing by zero.
    return Math.max(0.5, Math.min(12, standardDeviation(values)));
  });

  const scored: { colour: Colour; accuracy: number; weight: number | null }[] = [];
  for (let i = 0; i + 1 < positions; i++) {
    const before = winPercents[i];
    const after = winPercents[i + 1];
    if (before == null || after == null) continue;

    // A normal game starts with White; a position imported from a Black-to-move
    // start still has to assign the first pair to the side that actually moved.
    const whiteMoved = (i % 2 === 0) === (startColor === 'w');
    const colour: Colour = whiteMoved ? 'w' : 'b';
    const lost = whiteMoved ? before - after : after - before;
    scored.push({ colour, accuracy: moveAccuracy(Math.max(0, lost)), weight: weights[i] ?? null });
  }

  const forColour = (colour: Colour): number => {
    const moves = scored.filter((move) => move.colour === colour);
    if (moves.length === 0) return 100;

    const weighted = moves.filter((move) => move.weight != null);
    const weightedMean = weighted.length > 0
      ? weighted.reduce((sum, move) => sum + move.accuracy * (move.weight as number), 0)
        / weighted.reduce((sum, move) => sum + (move.weight as number), 0)
      // If no window had enough values, fall back to the plain mean rather than
      // claiming a weighted number we could not compute.
      : moves.reduce((sum, move) => sum + move.accuracy, 0) / moves.length;

    const harmonicDenominator = moves.reduce(
      (sum, move) => sum + (move.accuracy <= 0 ? Number.POSITIVE_INFINITY : 1 / move.accuracy),
      0,
    );
    const harmonicMean = harmonicDenominator === Number.POSITIVE_INFINITY
      ? 0
      : moves.length / harmonicDenominator;

    return (weightedMean + harmonicMean) / 2;
  };

  return { white: forColour('w'), black: forColour('b') };
}
