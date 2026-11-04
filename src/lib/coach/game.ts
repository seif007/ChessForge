/**
 * Whole-game walkthrough facts — the "Coach, explain my game" button.
 *
 * Builds ONE GroundedContext from the app's per-move review data: phase
 * boundaries, per-side error counts, the turning points with their concrete
 * better move, and what the final position actually holds. Narrators only
 * arrange these facts, exactly like the per-move path.
 */

import { analyzeFen, Phase, PositionReport, sideName } from './features';
import {
  FactFactory, featureFacts, GroundedContext, GroundedFact, structureFacts,
} from './facts';
import { KbIndex } from './kb';
import { legalSan } from './san';
import { CoachMoveReview, moverCpAfter, moverCpBefore } from './review';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface GameWalkthroughInput {
  /** Every ply of the game, in order (the app's analysed review). */
  reviews: readonly CoachMoveReview[];
  /** ECO/opening name the app already knows, when available. */
  openingName?: string | null;
  /** PGN result, when available. */
  result?: string | null;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function gradeWord(g: CoachMoveReview['grade']): string {
  return FactFactory.gradeWord(g);
}

/** Per-side error and quality counts from the graded reviews. */
export function errorCounts(reviews: readonly CoachMoveReview[]): {
  w: { inaccuracy: number; mistake: number; blunder: number; best: number; excellent: number };
  b: { inaccuracy: number; mistake: number; blunder: number; best: number; excellent: number };
} {
  const mk = (): { inaccuracy: number; mistake: number; blunder: number; best: number; excellent: number } => (
    { inaccuracy: 0, mistake: 0, blunder: 0, best: 0, excellent: 0 });
  const out = { w: mk(), b: mk() };
  for (const r of reviews) {
    const slot = r.moverIsWhite ? out.w : out.b;
    if (r.grade === 'inaccuracy') slot.inaccuracy += 1;
    else if (r.grade === 'mistake') slot.mistake += 1;
    else if (r.grade === 'blunder') slot.blunder += 1;
    else if (r.grade === 'best') slot.best += 1;
    else if (r.grade === 'excellent') slot.excellent += 1;
  }
  return out;
}

function phaseBoundaries(reviews: readonly CoachMoveReview[]): { openingThrough: number; endgameFrom: number } {
  let openingThrough = 0;
  let endgameFrom = -1;
  for (let i = 0; i < reviews.length; i++) {
    const ph = analyzeFen(reviews[i].fenAfter).phase;
    if (ph === 'opening') openingThrough = i + 1;
    if (ph === 'endgame' && endgameFrom < 0) endgameFrom = i + 1;
  }
  return { openingThrough, endgameFrom };
}

function moveLabel(r: CoachMoveReview): string {
  return r.moverIsWhite ? `${r.moveNumber}.${r.san}` : `${r.moveNumber}...${r.san}`;
}

export function forGame(input: GameWalkthroughInput, kb: KbIndex): GroundedContext {
  const reviews = input.reviews;
  const facts: GroundedFact[] = [];
  const last = reviews.length > 0 ? reviews[reviews.length - 1] : null;
  const finalReport: PositionReport = analyzeFen(last ? last.fenAfter : START_FEN);

  // ---- the game in brief -------------------------------------------------
  const totalMoves = last ? last.moveNumber : 0;
  facts.push({ kind: 'game-summary', text: `The game lasted ${totalMoves} move${totalMoves === 1 ? '' : 's'}.` });
  if (input.result) facts.push({ kind: 'game-summary', text: `Result: ${input.result}.` });
  if (input.openingName) facts.push({ kind: 'game-summary', text: `The game opened as: ${input.openingName}.` });

  const { openingThrough, endgameFrom } = phaseBoundaries(reviews);
  if (openingThrough > 0) {
    const throughMove = reviews[Math.min(openingThrough, reviews.length) - 1].moveNumber;
    facts.push({ kind: 'game-summary', text: `The opening lasted into move ${throughMove}.` });
  }
  if (endgameFrom > 0) {
    const fromMove = reviews[Math.min(endgameFrom, reviews.length) - 1].moveNumber;
    facts.push({ kind: 'game-summary', text: `The endgame began around move ${fromMove}.` });
  }

  const errs = errorCounts(reviews);
  for (const [side, slot] of [['White', errs.w], ['Black', errs.b]] as const) {
    const parts: string[] = [];
    if (slot.inaccuracy > 0) parts.push(`${slot.inaccuracy} inaccurac${slot.inaccuracy === 1 ? 'y' : 'ies'}`);
    if (slot.mistake > 0) parts.push(`${slot.mistake} mistake${slot.mistake === 1 ? '' : 's'}`);
    if (slot.blunder > 0) parts.push(`${slot.blunder} blunder${slot.blunder === 1 ? '' : 's'}`);
    facts.push({
      kind: 'game-summary',
      text: parts.length > 0 ? `${side}'s errors: ${parts.join(', ')}.` : `${side} made no inaccuracies, mistakes or blunders.`,
    });
  }

  // ---- turning points ----------------------------------------------------
  const worst = [...reviews]
    .filter((r) => r.wpLoss >= 0.1)
    .sort((a, b) => b.wpLoss - a.wpLoss)
    .slice(0, 2);
  for (const r of worst) {
    let text = `Turning point: ${moveLabel(r)} was ${gradeWord(r.grade)} - it cost ${r.wpLoss.toFixed(2)} `
      + `winning-chance points (evaluation went from ${FactFactory.evalPhrase(moverCpBefore(r))} to ${FactFactory.evalPhrase(moverCpAfter(r))}).`;
    if (r.bestSan) text += ` The engine preferred ${r.moveNumber}${r.moverIsWhite ? '.' : '...'}${r.bestSan}.`;
    facts.push({ kind: 'game-key', text });
  }
  if (worst.length === 0 && last) {
    facts.push({ kind: 'game-key', text: 'The game had no turning point of a full tenth of a winning chance or more - both sides played steadily.' });
  }

  // ---- where the game ended ---------------------------------------------
  facts.push({ kind: 'phase', text: `Final position: ${capitalize(sideName(finalReport.stm))} to move; ${FactFactory.phaseWord(finalReport.phase)}.` });
  facts.push({ kind: 'material', text: FactFactory.materialPhrase(finalReport) });
  facts.push(...structureFacts(finalReport).slice(0, 2));
  facts.push(...featureFacts(finalReport).slice(0, 3));

  const hits = kb.byHook(FactFactory.hookTokens(finalReport), undefined, 8);
  return {
    fen: finalReport.fen,
    phase: finalReport.phase,
    stm: finalReport.stm,
    facts,
    kbHits: hits,
    legalSan: new Set(legalSan(finalReport.fen)),
  };
}

/** Exported for the coach UI: phase of the position after each ply. */
export function phasesOf(reviews: readonly CoachMoveReview[]): Phase[] {
  return reviews.map((r) => analyzeFen(r.fenAfter).phase);
}

/** Whose move indices (0-based plies) the walkthrough will highlight. */
export function turningPointPlies(reviews: readonly CoachMoveReview[], max = 2): number[] {
  return reviews
    .map((r, i) => [i, r.wpLoss] as const)
    .filter(([, loss]) => loss >= 0.1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([i]) => i);
}
