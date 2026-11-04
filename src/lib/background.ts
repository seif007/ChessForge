/**
 * Background jobs that outlive the screen that started them.
 *
 * React Native unmounts the inactive tab when the user navigates away. Any
 * async loop owned by that component keeps running, but its progress and its
 * result disappear with the component: returning shows an idle screen, and a
 * second tap can start the same expensive work again. This store is the missing
 * owner.
 *
 * A job is a module-level promise plus a small observable state record. The
 * work never touches component state; callers start it and subscribe to the
 * state. Completion writes the result (bot profile, cached games, mined deck,
 * loaded model) to its normal persistent store before the job says `done`, so a
 * screen that mounts later reads the same truth from disk.
 *
 * Deliberately not a queue: one job per id, and starting the same id while it
 * is running returns the in-flight promise. Cancel is cooperative via the
 * provided AbortSignal; native downloads that cannot observe it still finish.
 */

import { useSyncExternalStore } from 'react';

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface JobProgress {
  /** Whole percent, 0..100. */
  pct: number;
  /** One short line, safe to render directly. */
  label: string;
  detail?: string;
  /** True when the work cannot estimate a fraction yet (bar should not claim 0%). */
  indeterminate?: boolean;
}

export interface JobState<T> {
  id: string;
  title: string;
  /** The account / model / query this job belongs to, when that matters. */
  owner: string | null;
  status: JobStatus;
  progress: JobProgress;
  result: T | null;
  error: string | null;
  /** The original error, for typed cases such as `OtbAmbiguityError`. */
  errorData: unknown;
  startedAt: number;
  finishedAt: number | null;
}

export interface JobContext {
  readonly signal: AbortSignal;
  /** Report progress. Late reports after cancellation are ignored. */
  progress(p: JobProgress): void;
}

type Work<T> = (ctx: JobContext) => Promise<T>;

const jobs = new Map<string, JobState<unknown>>();
const running = new Map<string, {
  promise: Promise<unknown>;
  controller: AbortController;
  owner: string | null;
}>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function jobState<T>(id: string): JobState<T> | null {
  return (jobs.get(id) as JobState<T> | undefined) ?? null;
}

export function useJob<T>(id: string): JobState<T> | null {
  return useSyncExternalStore(
    subscribeJobs,
    () => jobState<T>(id),
    () => jobState<T>(id),
  );
}

export function isJobRunning(id: string): boolean {
  return running.has(id);
}

/**
 * Start (or join) one named job.
 *
 * Returns the result on success and `null` on failure/cancellation; the state
 * carries the error. A caller that navigated away does not need the promise at
 * all, so it can `void runJob(...)` without risking an unhandled rejection.
 */
export function runJob<T>(
  id: string,
  title: string,
  work: Work<T>,
  opts: { owner?: string | null } = {},
): Promise<T | null> {
  const existing = running.get(id);
  if (existing) {
    /*
     * Same job, same owner: join it. A different owner (a second Lichess
     * account, a different model) must not silently receive the first job's
     * result; the caller can see that the id is busy and explain it.
     */
    if (opts.owner != null && existing.owner != null && existing.owner !== opts.owner) {
      return Promise.resolve(null);
    }
    return existing.promise as Promise<T | null>;
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const owner = opts.owner ?? null;
  const initial: JobState<T> = {
    id,
    title,
    owner,
    status: 'running',
    progress: { pct: 0, label: 'Starting…' },
    result: null,
    error: null,
    errorData: null,
    startedAt,
    finishedAt: null,
  };
  jobs.set(id, initial as JobState<unknown>);
  emit();

  const update = (patch: Partial<JobState<T>>) => {
    const current = jobs.get(id);
    if (!current || current.status !== 'running') return;
    jobs.set(id, { ...(current as JobState<T>), ...patch });
    emit();
  };

  const promise = (async (): Promise<T | null> => {
    try {
      const result = await work({
        signal: controller.signal,
        progress: (p) => {
          update({
            progress: {
              pct: Math.max(0, Math.min(100, Math.round(p.pct))),
              label: p.label,
              ...(p.detail != null ? { detail: p.detail } : {}),
              ...(p.indeterminate ? { indeterminate: true } : {}),
            },
          });
        },
      });
      /*
       * LEAVE `running` BEFORE PUBLISHING THE TERMINAL STATE.
       *
       * A screen's completion effect often calls `clearJob` immediately after
       * applying the result. If the id were still in `running`, clearJob would
       * refuse (by design: never remove running work), the receipt would stay,
       * and the next mount would replay it. The terminal state is a receipt,
       * not a running job.
       */
      running.delete(id);
      update({
        status: 'done',
        progress: { pct: 100, label: 'Done' },
        result,
        finishedAt: Date.now(),
      });
      return result;
    } catch (e) {
      const aborted = controller.signal.aborted
        || (typeof e === 'object' && e != null && (e as { name?: string }).name === 'AbortError');
      const message = aborted
        ? 'Cancelled.'
        : friendlyError(e);
      running.delete(id);
      update({
        status: aborted ? 'cancelled' : 'error',
        error: message,
        errorData: e,
        finishedAt: Date.now(),
      });
      return null;
    } finally {
      // Defensive: the branches above normally removed it already.
      running.delete(id);
    }
  })();

  running.set(id, { promise, controller, owner });
  return promise;
}

export function cancelJob(id: string): void {
  running.get(id)?.controller.abort();
}

/**
 * Wait for an in-flight job to observe cancellation and settle.
 *
 * `cancelJob` is a signal, not a wait: the work still has to leave the engine,
 * finish its current write, or reach its next `signal.aborted` check. Deletion
 * uses this so it can clear storage *after* that work has stopped, rather than
 * racing a late `saveScanState` or `saveBot`.
 */
export function waitForJob(id: string): Promise<void> {
  const active = running.get(id);
  if (!active) return Promise.resolve();
  return active.promise.then(() => undefined, () => undefined);
}

/** Test/reset helper: forget a finished job. Never removes a running one. */
export function clearJob(id: string): void {
  if (running.has(id)) return;
  if (jobs.delete(id)) emit();
}

function friendlyError(e: unknown): string {
  const raw = typeof e === 'object' && e != null && typeof (e as { message?: unknown }).message === 'string'
    ? (e as { message: string }).message
    : '';
  return raw.trim().length > 0 ? raw : 'Something went wrong.';
}
