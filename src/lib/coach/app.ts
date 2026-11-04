/**
 * App adapters: the Analyse screen's own review shapes -> the coach's.
 *
 * The coach never grades moves itself (see `review.ts`): the Analyse screen
 * already graded every ply with Stockfish + `classifyMove`, so this module
 * only TRANSLATES a `MoveAnalysis`/`Report` into `CoachMoveReview` /
 * `GameWalkthroughInput`. The win-chance drop is recomputed from the two
 * evals with `winP` so the coach's thresholds and the screen's classifier
 * stay tied to the same model.
 */

import { GameWalkthroughInput } from './game';
import { CoachMoveReview, gradeFromQuality, winP } from './review';

/** Structural shape of the Analyse screen's `MoveAnalysis` (kept loose on purpose). */
export interface AppMoveLike {
  ply: number;
  san: string;
  uci: string | null;
  mover: 'w' | 'b';
  fenBefore: string;
  fenAfter: string;
  cpBefore: number;
  cpAfter: number;
  bestMoveSan: string | null;
  bestMoveUci: string | null;
  kind: string;
  /** Engine PV (UCI) for the position BEFORE the move, when the screen has it. */
  pvUci?: readonly string[];
}

/** Translate one analysed ply into the shape the coach narrates. */
export function reviewFromAppMove(m: AppMoveLike): CoachMoveReview {
  const moverIsWhite = m.mover === 'w';
  const wpLoss = Math.max(0, winP(m.cpBefore, moverIsWhite) - winP(m.cpAfter, moverIsWhite));
  const pv = m.pvUci && m.pvUci.length > 0
    ? [...m.pvUci]
    : (m.bestMoveUci ? [m.bestMoveUci] : []);
  return {
    moveNumber: Math.floor(m.ply / 2) + 1,
    moverIsWhite,
    san: m.san,
    uci: m.uci ?? '',
    fenBefore: m.fenBefore,
    fenAfter: m.fenAfter,
    isCapture: m.san.includes('x'),
    isCheck: m.san.includes('+') || m.san.includes('#'),
    grade: gradeFromQuality(m.kind),
    cpBefore: m.cpBefore,
    cpAfter: m.cpAfter,
    bestSan: m.bestMoveSan,
    pvUci: pv,
    wpLoss,
  };
}

/** Structural shape of the Analyse screen's `Report`. */
export interface AppReportLike {
  moves: readonly AppMoveLike[];
  openingName: string | null;
  result: string;
}

/** Translate a whole analysed game for the walkthrough narrator. */
export function walkthroughFromAppReport(rep: AppReportLike): GameWalkthroughInput {
  return {
    reviews: rep.moves.map(reviewFromAppMove),
    openingName: rep.openingName,
    result: rep.result,
  };
}
