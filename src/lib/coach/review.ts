/**
 * Move-review shapes the coach narrates. Port of the prototype's
 * `coach/review/GameReview.kt` types (the app's own analysis pipeline feeds
 * these — the coach never grades moves itself, it explains grades it is given).
 */

export type MoveGrade = 'book' | 'best' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export interface CoachMoveReview {
  moveNumber: number;
  moverIsWhite: boolean;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  isCapture: boolean;
  isCheck: boolean;
  grade: MoveGrade;
  /** White POV, best eval of the position BEFORE the move */
  cpBefore: number;
  /** White POV, best eval of the position AFTER the move */
  cpAfter: number;
  bestSan: string | null;
  /** Engine PV (UCI) for the position before the move */
  pvUci: string[];
  /** Winning-chance drop caused by the move (mover POV, 0..1+) */
  wpLoss: number;
}

export const moverCpBefore = (r: Pick<CoachMoveReview, 'cpBefore' | 'moverIsWhite'>): number =>
  (r.moverIsWhite ? r.cpBefore : -r.cpBefore);

export const moverCpAfter = (r: Pick<CoachMoveReview, 'cpAfter' | 'moverIsWhite'>): number =>
  (r.moverIsWhite ? r.cpAfter : -r.cpAfter);

/**
 * Lichess-style winning chances: cp in [-inf,inf] -> [-1,1].
 * The drop in winning chances from the mover's POV is what determines a grade.
 */
export function winP(cpWhite: number, moverIsWhite: boolean): number {
  const cpMover = Math.max(-3000, Math.min(3000, moverIsWhite ? cpWhite : -cpWhite));
  return 2 / (1 + Math.exp(-0.00368208 * cpMover)) - 1;
}

/** Grade from a winning-chance drop (same thresholds as the prototype). */
export function gradeFromWpLoss(loss: number): MoveGrade {
  if (loss >= 0.3) return 'blunder';
  if (loss >= 0.2) return 'mistake';
  if (loss >= 0.1) return 'inaccuracy';
  if (loss >= 0.02) return 'good';
  return 'excellent';
}

/**
 * The app's move-quality vocabulary is richer than the coach's grades
 * (brilliant/great/miss exist there so the board can decorate moves).
 * This maps display qualities onto the five narration bands.
 */
export function gradeFromQuality(kind: string): MoveGrade {
  switch (kind) {
    case 'book': return 'book';
    case 'brilliant':
    case 'best': return 'best';
    case 'great':
    case 'excellent': return 'excellent';
    case 'good': return 'good';
    case 'inaccuracy': return 'inaccuracy';
    case 'miss':
    case 'mistake': return 'mistake';
    case 'blunder': return 'blunder';
    default: return 'good';
  }
}
