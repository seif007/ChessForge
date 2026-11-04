/**
 * The coach orchestrator — port of the prototype's `Coach.kt`.
 *
 * Pipeline (the core contract):
 *   review data + analyzer  ->  FactFactory -> GroundedContext -> narrator -> guard -> student
 *   knowledge base          ->                                                  (template or LLM)
 *
 * The narrator is pluggable: [TemplateNarrator] (default, deterministic,
 * offline) today; a local-model narrator uses the same GroundedContext via
 * [QwenPrompts]. Any narrator output that fails the guard is replaced by the
 * safe template narration, so the student never sees unverified concrete moves.
 */

import { FactFactory, GroundedContext } from './facts';
import { forGame, GameWalkthroughInput } from './game';
import { check as guardCheck } from './guard';
import { KbIndex } from './kb';
import { CoachMoveReview } from './review';
import { CoachNarrator, ChatHistory, TemplateNarrator } from './template';
import { CHESS_ONLY_APOLOGY, isChessRelated } from './topic';

export class Coach {
  constructor(
    private readonly kb: KbIndex,
    private readonly narrator: CoachNarrator = TemplateNarrator,
  ) {}

  get narratorName(): string {
    return this.narrator.name;
  }

  /** Explain a graded move from a game review ("why was this a mistake?"). */
  async explainMove(mr: CoachMoveReview): Promise<string> {
    const ctx = FactFactory.forMove(mr, this.kb);
    return this.guarded(ctx, () => this.narrator.explainMove(ctx, mr));
  }

  /** Explain a position from its FEN ("what is going on here?"). */
  async explainPosition(fen: string, moves: readonly string[] = []): Promise<string> {
    const ctx = withGameMoves(FactFactory.forPositionFen(fen, this.kb), moves);
    return this.guarded(ctx, () => this.narrator.explainPosition(ctx));
  }

  /**
   * Explain the engine's recommended move for [fen] (the move is ground truth).
   *
   * HINTS ARE LATENCY-SENSITIVE. The engine move is already verified and the
   * deterministic narrator only arranges the position facts around it, so a
   * local Qwen round-trip buys nothing except several seconds of "thinking".
   * The model is still the narrator for chat and full position explanations;
   * a hint never waits for it, even when a 1.5B model is loaded.
   */
  async explainHint(fen: string, san: string): Promise<string> {
    const ctx = FactFactory.forPositionFen(fen, this.kb);
    return this.guarded(
      ctx,
      () => TemplateNarrator.explainHint(ctx, san),
      () => TemplateNarrator.explainHint(ctx, san),
    );
  }

  /** Walk the student through an entire game from the analysed review. */
  async explainGame(input: GameWalkthroughInput): Promise<string> {
    const ctx = forGame(input, this.kb);
    return this.guarded(ctx, () => this.narrator.explainGame(ctx));
  }

  /**
   * Multi-turn follow-up Q&A about [fen]. [history] carries prior
   * (question, answer) pairs; LLM narrators include the last turns in their
   * prompt, the template narrator uses it to avoid repeating itself.
   */
  async ask(
    question: string,
    fen: string,
    history: ChatHistory = [],
    moves: readonly string[] = [],
  ): Promise<string> {
    if (!isChessRelated(question, this.kb)) return CHESS_ONLY_APOLOGY;
    const base = withGameMoves(FactFactory.forPositionFen(fen, this.kb), moves);

    /*
     * ONLY EXPLICITLY NAMED BOOK ENTRIES ENTER THE CONTEXT.
     *
     * The old path ran `kb.search(question)` and merged its top three hits.
     * `search` scores summary/detail prose, so "Explain this position" returned
     * the bishop pair and King-and-pawn-vs-king purely because they contain the
     * word "position"; the template then printed them under "From the coach's
     * book". The board had one bishop each and was a middlegame. The same path
     * attached an English Opening plan (Rc1, b4 against c5) to a QGD position.
     *
     * `findMentioned` matches identity fields only (title/name/aka), so a
     * generic request contributes no book pages. The analyzer's hook-based hits
     * in `base` remain, and those are derived from this exact position.
     */
    const named = this.kb.findMentioned(question, 3);
    const ctx: GroundedContext = named.length === 0
      ? base
      : { ...base, kbHits: mergeByName([...named, ...base.kbHits]) };

    /*
     * A request to explain the position is not a request for a random book
     * page. Route it through the same position narrator the Analyse button
     * uses: overview, structure, verified features, plan/teaching.
     */
    if (isPositionExplanation(question)) {
      return this.guarded(ctx, () => this.narrator.explainPosition(ctx));
    }

    return this.guarded(
      ctx,
      () => this.narrator.answer(ctx, question, history),
      // If a model answer is rejected, explain the actual position rather than
      // falling back to a book list that may not belong to it.
      () => TemplateNarrator.explainPosition(ctx),
    );
  }

  private async guarded(
    ctx: GroundedContext,
    produce: () => Promise<string>,
    fallback: () => Promise<string> = () => TemplateNarrator.explainPosition(ctx),
  ): Promise<string> {
    let text: string;
    try {
      text = await produce();
    } catch (e) {
      console.warn('[coach] narrator failed, using the template:', e);
      return fallback();
    }
    const verdict = guardCheck(text, ctx);
    if (verdict.ok) return text;
    // The student must never see unverified concrete moves: replace the draft
    // with the deterministic narration from the same facts.
    console.warn('[coach] draft rejected by the grounding guard:', verdict.violations.join(', '));
    return fallback();
  }
}

function mergeByName<T extends { name: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (seen.has(it.name)) continue;
    seen.add(it.name);
    out.push(it);
  }
  return out;
}

/**
 * Is this a request to explain the board, rather than a request about a
 * named concept? "Explain the bishop pair" stays a concept question; "explain
 * this position" and "what is going on here" get the position narrator.
 */
function isPositionExplanation(question: string): boolean {
  const q = question.toLowerCase();
  const asksToExplain = /\b(explain|describe|summari[sz]e|analy[sz]e|assess|review)\b/.test(q);
  const namesPosition = /\b(position|board)\b/.test(q);
  if (asksToExplain && namesPosition) return true;
  if (/\bwhat(?:'s| is)\s+(?:going on|happening)\b/.test(q)) return true;
  if (/\b(?:position|board)\s+(?:explanation|overview|summary)\b/.test(q)) return true;
  return false;
}

/**
 * Add the moves that produced the position to the grounded context.
 *
 * The FEN says what is on the board; it does not say how the game got there.
 * Chat questions such as "why did I play that?" or "what was the last move?"
 * need the latter. The moves come from chess.js's history, so they are SAN and
 * the guard treats them as already-played, fact-backed moves.
 */
function withGameMoves(ctx: GroundedContext, moves: readonly string[]): GroundedContext {
  if (moves.length === 0) return ctx;
  const recent = moves.slice(-12);
  const last = moves[moves.length - 1];
  return {
    ...ctx,
    facts: [
      ...ctx.facts,
      {
        kind: 'game-context',
        text: `Moves already played: ${recent.join(' ')}. Last move: ${last}.`,
      },
    ],
  };
}
