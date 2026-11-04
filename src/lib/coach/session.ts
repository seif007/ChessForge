/**
 * The one coach the UI talks to.
 *
 * The narrator tier can change at runtime (the model manager attaches an
 * on-device runtime once its weights are downloaded), so screens must never
 * capture a `Coach` instance in state — they call `activeCoach()` at the
 * moment they need it.
 *
 * Listeners exist for the other half of that promise: a screen that is already
 * on screen when the tier changes (the Bots card and the Analyse panel are
 * both mounted across a download) re-renders with the new narrator name
 * instead of showing a stale "Rulebook (offline)".
 */

import { Coach } from './coach';
import { createCoach } from './knowledge';
import { LocalChatRuntime, LocalModelNarrator } from './llm';

let runtime: LocalChatRuntime | null = null;
let modelId: string | null = null;
let coach: Coach = createCoach();

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export interface CoachSession {
  /** Display name of the narrator currently answering, e.g. "Rulebook (offline)". */
  narrator: string;
  /** Catalog id of the loaded model, or null when the rulebook is narrating. */
  modelId: string | null;
}

export function coachSession(): CoachSession {
  return { narrator: coach.narratorName, modelId };
}

/** Subscribe to narrator changes. Returns the unsubscribe function. */
export function subscribeCoach(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Attach (or detach with `null`) the on-device model runtime.
 * Returns the new narrator tier's display name for the UI to show.
 */
export function attachRuntime(rt: LocalChatRuntime | null, id: string | null = null): string {
  runtime = rt;
  modelId = rt ? id : null;
  coach = rt ? createCoach(new LocalModelNarrator(rt)) : createCoach();
  emit();
  return coach.narratorName;
}

export function activeRuntime(): LocalChatRuntime | null {
  return runtime;
}

export function activeCoach(): Coach {
  return coach;
}
