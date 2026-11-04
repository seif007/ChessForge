/**
 * LLM narrators — port of the prototype's `LlmProviders.kt`, adapted to React
 * Native fetch and to an on-device runtime interface.
 *
 * Everything is grounded BY CONSTRUCTION: the prompt is built from the
 * [GroundedContext] via [QwenPrompts], the draft is checked by the grounding
 * guard, and on ANY transport failure, timeout, empty answer or rejected draft
 * the narrator falls back to [TemplateNarrator]. The coach works fully offline.
 */

import { GroundedContext } from './facts';
import { check as guardCheck } from './guard';
import { QwenPrompts } from './prompts';
import { CoachMoveReview } from './review';
import { CoachNarrator, ChatHistory, TemplateNarrator } from './template';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
  /** Streaming hook for narrators that support it. */
  onToken?: (token: string) => void;
}

/**
 * The seam a local model runtime plugs into (llama.cpp via llama.rn, ExecuTorch,
 * or a llama.cpp server on the dev machine). The coach never talks to a model
 * beyond this interface, so the whole feature is testable with a fake runtime.
 */
export interface LocalChatRuntime {
  /** Display name, e.g. "Qwen2.5-0.5B · on device". */
  readonly label: string;
  /** Whether a model file is loaded and ready to generate. */
  readonly ready: boolean;
  complete(messages: readonly ChatMessage[], opts?: CompleteOptions): Promise<string>;
}

/** Shared grounding discipline for every LLM narrator. */
abstract class LlmNarrator implements CoachNarrator {
  constructor(protected readonly fallback: CoachNarrator = TemplateNarrator) {}

  abstract get name(): string;

  protected abstract complete(system: string, user: string): Promise<string | null>;

  async explainMove(ctx: GroundedContext, mr: CoachMoveReview): Promise<string> {
    return this.draft(
      ctx,
      () => this.complete(QwenPrompts.system(), QwenPrompts.explainMovePrompt(ctx, mr)),
      () => this.fallback.explainMove(ctx, mr),
    );
  }

  async explainPosition(ctx: GroundedContext): Promise<string> {
    return this.draft(
      ctx,
      () => this.complete(QwenPrompts.system(), QwenPrompts.explainPositionPrompt(ctx)),
      () => this.fallback.explainPosition(ctx),
    );
  }

  async explainHint(ctx: GroundedContext, san: string): Promise<string> {
    return this.draft(
      ctx,
      () => this.complete(QwenPrompts.system(), QwenPrompts.hintPrompt(ctx, san)),
      () => this.fallback.explainHint(ctx, san),
    );
  }

  async explainGame(ctx: GroundedContext): Promise<string> {
    return this.draft(
      ctx,
      () => this.complete(QwenPrompts.system(), QwenPrompts.gamePrompt(ctx)),
      () => this.fallback.explainGame(ctx),
    );
  }

  async answer(ctx: GroundedContext, question: string, history: ChatHistory = []): Promise<string> {
    return this.draft(
      ctx,
      () => this.complete(QwenPrompts.system(), QwenPrompts.followUpPrompt(ctx, question, history)),
      () => this.fallback.answer(ctx, question, history),
    );
  }

  /** Returns null when the call fails or the draft is ungrounded (caller falls back). */
  private async draft(
    ctx: GroundedContext,
    produce: () => Promise<string | null>,
    fallback: () => Promise<string>,
  ): Promise<string> {
    try {
      const text = await produce();
      if (text != null && text.length > 0) {
        const verdict = guardCheck(text, ctx);
        if (verdict.ok) return text;
        console.warn('[coach-llm] draft rejected by the grounding guard:', verdict.violations.join(', '));
      }
    } catch (e) {
      console.warn('[coach-llm] call failed, using the template narration:', e);
    }
    return fallback();
  }
}

/** Narrator over an on-device runtime (see `model/`). */
export class LocalModelNarrator extends LlmNarrator {
  constructor(private readonly runtime: LocalChatRuntime, fallback: CoachNarrator = TemplateNarrator) {
    super(fallback);
  }

  get name(): string {
    return this.runtime.label;
  }

  protected async complete(system: string, user: string): Promise<string | null> {
    if (!this.runtime.ready) return null;
    const text = await this.runtime.complete(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      /*
       * 300 is enough for the "under 120 words" contract and saves real time on
       * a phone CPU. Hints do not use the model at all (see `Coach.explainHint`);
       * this cap is for chat and position explanations.
       */
      { maxTokens: 300, temperature: 0.3 },
    );
    return text.trim().length > 0 ? text.trim() : null;
  }
}

export interface ChatCompletionConfig {
  /** e.g. http://127.0.0.1:8080/v1 (a llama.cpp server running the same GGUF) */
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/**
 * Any OpenAI-compatible chat-completions endpoint. Two uses:
 *  - a local llama.cpp server on the dev machine, for prompt/quality work
 *  - a cloud "deep dive" behind an explicit user toggle (off by default)
 */
export class ChatCompletionNarrator extends LlmNarrator {
  constructor(private readonly cfg: ChatCompletionConfig, fallback: CoachNarrator = TemplateNarrator) {
    super(fallback);
  }

  get name(): string {
    return `${this.cfg.model} · endpoint`;
  }

  protected async complete(system: string, user: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 30000);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: this.cfg.maxTokens ?? 400,
          temperature: this.cfg.temperature ?? 0.3,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[coach-llm] endpoint returned HTTP ${res.status}`);
        return null;
      }
      const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = json?.choices?.[0]?.message?.content;
      return typeof content === 'string' && content.trim().length > 0 ? content.trim() : null;
    } finally {
      clearTimeout(timer);
    }
  }
}
