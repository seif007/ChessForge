/**
 * On-device model manager.
 *
 * The APK stays small: the coach's optional "brain" is a Qwen2.5-Instruct GGUF
 * (Q4_K_M) downloaded once, on Wi-Fi, into the app's documents directory and
 * loaded by llama.rn (CPU). Until then — and whenever loading fails — the
 * coach runs on the deterministic template narrator (see `template.ts`).
 *
 * Everything here is optional by construction: a missing file, a failed
 * download or a runtime that refuses to load all end with `attachRuntime(null)`
 * and the coach answering from the knowledge base as before.
 */

import { Directory, File, Paths } from 'expo-file-system';
import type { LlamaContext } from 'llama.rn';
import Storage from 'expo-sqlite/kv-store';

import { runJob } from '@/lib/background';
import { ChatMessage, CompleteOptions, LocalChatRuntime } from './llm';
import { activeRuntime, attachRuntime } from './session';

export interface CoachModelDef {
  id: string;
  /** Shown in the picker. */
  label: string;
  /** One line of guidance next to the size. */
  note: string;
  fileName: string;
  url: string;
  /** Exact Content-Length of the download, so the UI can show honest sizes. */
  bytes: number;
}

export const COACH_MODELS: readonly CoachModelDef[] = [
  {
    id: 'qwen2.5-0.5b',
    label: 'Qwen 2.5 · 0.5B — quick',
    note: 'Fast answers, smallest download',
    fileName: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
    bytes: 491400032,
  },
  {
    id: 'qwen2.5-1.5b',
    label: 'Qwen 2.5 · 1.5B — sharper',
    note: 'Richer explanations, larger download',
    fileName: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    bytes: 1117320736,
  },
];

const ACTIVE_KEY = 'chessforge.coach.model.v1';
const DIR_NAME = 'coach-models';

function modelsDirectory(): Directory {
  return new Directory(Paths.document, DIR_NAME);
}

export function modelFile(def: CoachModelDef): File {
  return new File(modelsDirectory(), def.fileName);
}

/** Whether the weights for [def] are fully on disk. */
export function isModelInstalled(def: CoachModelDef): boolean {
  try {
    const f = modelFile(def);
    /*
     * EXACT SIZE, NOT "BIG ENOUGH". A download killed halfway leaves a
     * multi-hundred-megabyte file; the old >1 MB test advertised it as
     * installed and offered Use, which can only fail to load. The catalog's
     * `bytes` is the file's real Content-Length, so equality is the honest
     * test and the picker keeps the Download button (which retries with
     * idempotent: true) for a partial file.
     */
    return f.exists && f.size === def.bytes;
  } catch {
    return false;
  }
}

/** Human-readable size, e.g. "469 MB". */
export function formatModelBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Download the weights. `onFraction` is throttled to whole percents. */
export async function downloadModel(
  def: CoachModelDef,
  onFraction?: (pct: number) => void,
): Promise<void> {
  const dir = modelsDirectory();
  if (!dir.exists) dir.create({ intermediates: true });
  let last = -1;
  await File.downloadFileAsync(def.url, modelFile(def), {
    idempotent: true,
    onProgress: ({ bytesWritten, totalBytes }) => {
      const total = totalBytes > 0 ? totalBytes : def.bytes;
      const pct = Math.min(100, Math.round((bytesWritten / total) * 100));
      if (pct !== last) {
        last = pct;
        onFraction?.(pct);
      }
    },
  });
}

export const COACH_MODEL_JOB = 'coach-model';

export interface CoachModelJobResult {
  modelId: string;
  name: string;
}

/**
 * Download and load a model as a module-level job.
 *
 * The old manager awaited `downloadModel` inside the card. The card unmounts
 * when the user visits another tab, so its `pct`/`busy` state vanished and the
 * model picker looked stopped even though the native download was still alive;
 * tapping Download again could start a second writer. The job owns the whole
 * sequence and publishes progress through the same store as the other long
 * tasks. On completion the runtime is attached and the active id persisted, so
 * returning to Bots or Analyse finds the model already narrating.
 */
export function startModelDownload(def: CoachModelDef): Promise<CoachModelJobResult | null> {
  return runJob<CoachModelJobResult>(
    COACH_MODEL_JOB,
    `Downloading ${def.label}`,
    async ({ progress }) => {
      await downloadModel(def, (pct) => {
        progress({
          pct,
          label: `Downloading ${def.label}`,
          detail: `${formatModelBytes(def.bytes)} · ${pct}%`,
        });
      });
      progress({ pct: 100, label: 'Loading the model…' });
      const name = await loadModel(def);
      return { modelId: def.id, name };
    },
    { owner: def.id },
  );
}

/** Delete the weights (the caller must unload first if they are active). */
export function deleteModel(def: CoachModelDef): void {
  const f = modelFile(def);
  if (f.exists) f.delete();
}

/** The llama.rn-backed runtime the coach narrates through. */
class LlamaRuntime implements LocalChatRuntime {
  constructor(
    private readonly context: LlamaContext,
    readonly label: string,
  ) {}

  get ready(): boolean {
    return true;
  }

  async complete(messages: readonly ChatMessage[], opts?: CompleteOptions): Promise<string> {
    const result = await this.context.completion(
      {
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        n_predict: opts?.maxTokens ?? 400,
        temperature: opts?.temperature ?? 0.3,
        top_k: 40,
        top_p: 0.9,
        stop: ['<|im_end|>', '</s>'],
      },
      opts?.onToken ? (data) => { if (data.token) opts.onToken?.(data.token); } : undefined,
    );
    return result.text ?? '';
  }
}

let context: LlamaContext | null = null;

/** Load [def] and make it the active narrator. Returns its display name. */
export async function loadModel(def: CoachModelDef): Promise<string> {
  await unloadModel();
  const file = modelFile(def);
  if (!file.exists) throw new Error(`model file missing: ${def.fileName}`);
  /*
   * THE NATIVE MODULE IS LOADED WHEN A MODEL IS, NOT WHEN THE APP STARTS.
   *
   * A static `import { initLlama } from 'llama.rn'` resolves at module load, and this
   * module is reachable from the coach panel -> Analyse -> the shell. On a build where the
   * native side did not link, that one line would take down the whole app at launch
   * instead of one feature — and the feature is designed to run without it: the template
   * narrator is the default, and everything here is already inside try/catch whose failure
   * path falls back to it. A dynamic import keeps the failure where the handling is.
   */
  const { initLlama } = await import('llama.rn');
  const next = await initLlama({
    model: file.uri,
    n_ctx: 2048,
    // CPU-only: OpenCL on Android is device-dependent and would need the
    // manifest entries from llama.rn's config plugin, which this build does
    // not apply. A 0.5B/1.5B Q4 model answers fast enough without it.
    n_gpu_layers: 0,
    use_mlock: false,
  });
  context = next;
  const name = attachRuntime(
    new LlamaRuntime(next, `${def.label.replace(/ — .+$/, '')} · on device`),
    def.id,
  );
  await Storage.setItem(ACTIVE_KEY, def.id).catch(() => {});
  return name;
}

/** Release the context and fall back to the template narrator. */
export async function unloadModel(): Promise<void> {
  if (context) {
    try {
      await context.release();
    } catch (e) {
      console.warn('[coach] releasing the model failed:', e);
    }
    context = null;
  }
  attachRuntime(null);
  await Storage.removeItem(ACTIVE_KEY).catch(() => {});
}

/**
 * Re-attach the model chosen in an earlier session (called when the coach
 * panel mounts). Never throws: on any failure the template narrator stays.
 */
export async function restoreActiveModel(): Promise<string | null> {
  const id = await Storage.getItem(ACTIVE_KEY).catch(() => null);
  if (!id) return null;
  const def = COACH_MODELS.find((d) => d.id === id);
  if (!def || !isModelInstalled(def)) return null;
  if (activeRuntime() !== null) return def.id; // already loaded this run
  try {
    await loadModel(def);
    return def.id;
  } catch (e) {
    console.warn('[coach] restoring the model failed, using the template:', e);
    return null;
  }
}

let restoreAttempt: Promise<string | null> | null = null;

/**
 * Restore the persisted model at most once per launch.
 *
 * Both entry paths (Bots and Analyse) mount the shared brain card, and the
 * coach game mounts through Bots; without this singleton each mount would ask
 * llama.rn to load the same weights again. A failed attempt settles to null —
 * the template keeps working and the picker can still load a model manually.
 */
export function ensureActiveModel(): Promise<string | null> {
  restoreAttempt ??= restoreActiveModel();
  return restoreAttempt;
}
