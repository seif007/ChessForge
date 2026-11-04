/**
 * Post-generation grounding check — port of the prototype's `GroundingGuard.kt`.
 *
 * Verifies that unambiguous MOVE mentions in a narrator's output are backed by
 * the context (legal in the reference position or quoted verbatim in the
 * verified facts).
 *
 * V1 policy: only piece-letter moves (Nf3, Bxc6, Qd5), castlings and
 * promotions are checked — bare squares like "e4" may legitimately be square
 * references ("the e4 pawn") and are therefore allowed. This keeps the false
 * positive rate near zero while catching the dangerous class of hallucinated
 * concrete moves.
 */

import { GroundedContext } from './facts';

const MOVE_TOKEN = /\b(O-O-O|O-O|[KQRBN]x[a-h][1-8]|[KQRBN][a-h][1-8]|[KQRBN][a-h]x[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][1-8]=[QRBN])\b/g;

export interface GuardVerdict {
  ok: boolean;
  violations: string[];
}

/** All move-like tokens in [text] that are neither legal nor fact-backed. */
export function check(text: string, ctx: GroundedContext): GuardVerdict {
  const allowed = new Set<string>(ctx.legalSan);
  for (const f of ctx.facts) {
    for (const m of f.text.matchAll(MOVE_TOKEN)) allowed.add(m[0]);
  }
  // Plans are quoted verbatim by narrators, so their move mentions are
  // backed; summary/detail prose is paraphrased and therefore NOT whitelisted.
  for (const e of ctx.kbHits) {
    for (const m of `${e.whitePlan} ${e.blackPlan}`.matchAll(MOVE_TOKEN)) allowed.add(m[0]);
  }

  const seen = new Set<string>();
  const violations: string[] = [];
  for (const m of text.matchAll(MOVE_TOKEN)) {
    const token = m[0];
    if (!allowed.has(token) && !seen.has(token)) {
      seen.add(token);
      violations.push(token);
    }
  }

  /*
   * MATERIAL / PHASE CLAIMS ARE GROUNDED TOO.
   *
   * The move check catches "Rc1" when c1 is occupied, but the report that
   * started this was subtler: the model (and the template's book fallback)
   * said "the bishop pair" in a position where each side has one bishop, and
   * "King and pawn vs king" in a queen/rook middlegame. Neither is a move, so
   * the old guard passed them.
   *
   * A concept page may legitimately discuss the bishop pair when the student
   * explicitly asked about it; that page is in `kbHits` via the identity
   * matcher. A position explanation does not get that page unless the analyzer
   * found an actual one-sided bishop pair, which is exactly the support this
   * check requires.
   */
  if (BISHOP_PAIR.test(text) && !supported(ctx, 'bishop_pair', /bishop pair/i)) {
    violations.push('bishop pair (not supported by this position)');
  }
  if (KING_AND_PAWN.test(text) && !supported(ctx, 'kpk', /king and pawn/i)) {
    violations.push('king and pawn ending (not supported by this position)');
  }
  return { ok: violations.length === 0, violations };
}

const BISHOP_PAIR = /\bbishop pair\b|\btwo bishops\b/i;
const KING_AND_PAWN = /\bking and pawn(?:s)?\b|\bpawn ending\b/i;

/** A named concept is backed by its curated page or a verified fact. */
function supported(ctx: GroundedContext, name: string, factPattern: RegExp): boolean {
  return ctx.kbHits.some((e) => e.name === name)
    || ctx.facts.some((f) => factPattern.test(f.text));
}

/** True if [text] mentions no unbacked concrete moves. */
export function isGrounded(text: string, ctx: GroundedContext): boolean {
  return check(text, ctx).ok;
}
