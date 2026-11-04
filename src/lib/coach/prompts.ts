/**
 * Prompt templates for the on-device/Qwen narrator — port of the prototype's
 * `QwenPrompts`. Small models need tight, directive prompts with explicit
 * grounding rules; these produce the system + user contents.
 *
 * Rule 6 is the app-specific "chess only" contract: off-topic questions are
 * also blocked BEFORE the model is ever asked (see `topic.ts`), so a reply
 * that ignores this rule is still never generated.
 */

import { GroundedContext } from './facts';
import { FactFactory } from './facts';
import type { KbEntry } from './kb';
import { CoachMoveReview } from './review';
import { ChatHistory } from './template';

export const QwenPrompts = {
  system(): string {
    return [
      'You are a friendly chess coach inside a mobile app. You explain moves, mistakes and plans.',
      'You are given VERIFIED FACTS produced by a Stockfish-powered analyzer and a knowledge base.',
      'Strict rules:',
      '1. Use ONLY the provided facts. Every move, evaluation and structural claim you make must come from them.',
      '2. Never invent moves, opening names, player names or history.',
      '3. Be concrete and encouraging. Prefer short sentences.',
      '4. Answer in under 120 words unless the student asks for more.',
      '5. If the facts do not answer the question, say so instead of guessing.',
      '6. Do not mention the bishop pair, two bishops, a pawn ending, or a king-and-pawn ending unless the facts or excerpts explicitly say it applies here.',
      '7. You only ever discuss chess. If the student asks about anything else, apologize in one short sentence and say you can only help with chess.',
    ].join('\n');
  },

  factBlock(ctx: GroundedContext): string {
    const lines: string[] = ['VERIFIED FACTS:'];
    for (const f of ctx.facts) lines.push(`- [${f.kind}] ${f.text}`);
    if (ctx.kbHits.length > 0) {
      lines.push('KNOWLEDGE BASE EXCERPTS:');
      for (const e of ctx.kbHits.slice(0, 4)) {
        let line = `- ${e.title}: ${e.summary}`;
        const plan = QwenPrompts.planFor(ctx, e);
        if (plan.length > 0) line += ` Plan: ${plan}`;
        lines.push(line);
      }
    }
    return lines.join('\n');
  },

  /**
   * The plan of [entry] for the side to move.
   *
   * Most pages are keyed by colour: White's plan and Black's plan. The pages
   * for the isolated queen's pawn and the hanging pawns are keyed by ROLE
   * instead — the attacker's plan and the defender's plan — because the
   * weakness belongs to one side and the other side attacks it. Choosing by
   * colour there told the side holding the weak pawn to attack it.
   */
  planFor(ctx: GroundedContext, entry: KbEntry): string {
    const roleAttacker = ctx.structureAttacker;
    if (roleAttacker !== null && (entry.name === 'iqp' || entry.name === 'iq_pawn'
      || entry.name === 'hanging_pawns')) {
      return ctx.stm === roleAttacker ? entry.whitePlan : entry.blackPlan;
    }
    return ctx.stm === 0 ? entry.whitePlan : entry.blackPlan;
  },

  explainMovePrompt(ctx: GroundedContext, mr: CoachMoveReview): string {
    return `${QwenPrompts.factBlock(ctx)}\n\n`
      + 'TASK: In two or three short paragraphs, explain to the student why the move was '
      + `${FactFactory.gradeWord(mr.grade)} and what to learn from it. `
      + "Mention the engine's preferred move and the key positional fact.";
  },

  explainPositionPrompt(ctx: GroundedContext): string {
    return `${QwenPrompts.factBlock(ctx)}\n\n`
      + 'TASK: In two or three short paragraphs, explain this position to the student: material, structure, '
      + 'the most important feature, and a concrete plan for the side to move.';
  },

  gamePrompt(ctx: GroundedContext): string {
    return `${QwenPrompts.factBlock(ctx)}\n\n`
      + 'TASK: Walk the student through their game like a coach: the opening idea, what happened in the middlegame, '
      + 'the turning points with the concrete better move, and what to remember for the endgame. '
      + 'Use the facts for every move, evaluation and claim.';
  },

  hintPrompt(ctx: GroundedContext, san: string): string {
    return `${QwenPrompts.factBlock(ctx)}\n\n`
      + `TASK: The engine's chosen move in this position is ${san}. In two or three short sentences, `
      + 'explain why it is a good move using only the facts, and name one thing to watch afterwards. '
      + 'Do not suggest any other move.';
  },

  followUpPrompt(ctx: GroundedContext, question: string, history: ChatHistory = []): string {
    let text = QwenPrompts.factBlock(ctx);
    if (history.length > 0) {
      text += '\n\nEARLIER CONVERSATION:\n';
      for (const [q, a] of history.slice(-3)) {
        text += `Student: ${q}\n`;
        text += `Coach: ${a.split('\n')[0] ?? a}\n`;
      }
    }
    text += `\n\nSTUDENT'S QUESTION: ${question}`;
    text += '\nAnswer using only the facts above.';
    return text;
  },
};
