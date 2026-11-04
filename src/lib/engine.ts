'use client';

/**
 * Stockfish UCI engine wrapper — React Native port of the web `lib/engine.ts`.
 *
 * The web version spawned `new Worker('/engine/stockfish-18-lite-single.js')`.
 * React Native has no Web Worker, and the Emscripten loader needs a browser
 * environment, so the engine runs inside a hidden WebView (see
 * `src/engine/stockfish-host.js`) and we talk to it over `postMessage`.
 *
 * The PUBLIC API is identical to the web version — `ChessEngine.init()`,
 * `.analyse()`, `.bestMove()`, `.destroy()`, `getEngine()`, `uciToSan()`,
 * `applyUci()` — so ported screens need no changes. Only the transport differs.
 *
 * Usage note: call `attachEngineHost(ref)` from the WebView's `ref` callback
 * (or `onMessage`) before any analysis call.
 */

import { Chess } from 'chess.js';

export type EngineEval = {
  bestMoveUci: string | null;
  scoreCp: number | null; // centipawns from side-to-move perspective
  mateIn: number | null;
  /**
   * Every MultiPV line the engine reported, best first.
   *
   * Only populated when the caller asked for `multipv > 1`. The single-line
   * fields above describe `lines[0]`; this exists so a caller that needs
   * ALTERNATIVES (the game-openings analysis) gets them from the same search
   * instead of paying for a second one per alternative.
   */
  lines?: { uci: string; scoreCp: number | null; mateIn: number | null; pvUci: string[] }[];
  depth: number;
  pvUci: string[];
  /**
   * Which principal variation this report describes — 1 for the engine's top line.
   *
   * THIS FIELD WAS BEING DROPPED, AND IT SILENTLY DISABLED `brilliant` EVERYWHERE.
   *
   * The host page parses Stockfish's `multipv N` prefix and sends it (see `stockfish-host.js`), and
   * both callers that care about alternatives read it: the analyse screen collects lines by index to
   * measure the gap to the runner-up, and `minePuzzles` does the same so it can mine a brilliant at
   * all. But this `info` handler rebuilt `EngineEval` field by field and `multipv` was not in the
   * list, so every partial carried `undefined` and both readers fell back to index 1:
   *
   *     const idx = (ev as { multipv?: number }).multipv ?? 1;   // always 1
   *
   * A single-index map has one entry, `lines.length >= 2` is never true, `bestGap` stays undefined,
   * and `classifyMove` — correctly — refuses to call anything `brilliant` without evidence that it
   * is the only move that wins. So the brilliant rule could never fire, on any screen, for any game.
   *
   * The cast at the call sites was what hid it: it type-checked against a field that did not exist,
   * so the omission looked deliberate rather than fatal.
   */
  multipv?: number;
};

type InfoCallback = (partial: EngineEval) => void;

/** Minimal shape of the react-native-webview instance we depend on. */
export interface WebViewHandle {
  postMessage: (data: string) => void;
}

/** Payload the host page sends back. */
type HostMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'log'; message: string }
  | ({ type: 'info' } & EngineEval)
  | { type: 'bestmove'; uci: string | null; info: EngineEval | null };

/** One outstanding `analyse`/`bestmove` request. */
interface Waiter {
  id: number;
  resolve: (m: HostMessage | null) => void;
  onInfo: InfoCallback | null;
  /** Last `info` block seen for THIS request (not shared between callers). */
  lastInfo: EngineEval | null;
  fen: string;
  opts: { movetime?: number; depth?: number; elo: number | null; multipv?: number };
  /** Hard-timeout handle, cleared when the request settles. */
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

export class ChessEngine {
  private host: WebViewHandle | null = null;
  private initPromise: Promise<void> | null = null;
  private initResolve: (() => void) | null = null;
  private ready = false;

  /**
   * Request ids and the two ends of the pipeline.
   *
   * The old code kept a bare `resolvers` array plus a SINGLE `pendingInfo` slot
   * and a SINGLE `lastInfo` slot. Two consequences, both user-visible:
   *
   *  - `pendingInfo` was overwritten by each new `analyse`, so a running search's
   *    progress was delivered to the *newest* caller instead of its owner, and
   *  - `lastInfo` was cleared by whichever request finished first, so a caller
   *    could read another search's eval.
   *
   * Pairing each waiter with its own info callback and its own last-seen info
   * makes a reply unambiguous no matter how many searches are in play.
   *
   * `running` is the request the host page is searching for right now.
   * `stockfish-host.js` refuses to overlap searches (no virtual clock in that
   * build), so a second `go` issued while one is running would have its
   * `bestmove` stolen by the first search. New requests therefore wait in
   * `queue` until the current one finishes.
   */
  private nextId = 1;
  private running: Waiter | null = null;
  private queue: Waiter[] = [];
  /**
   * True between asking the host to abort a search and the arrival of that
   * search's `bestmove`. Keeps `pump()` from dispatching into the gap.
   */
  private stopping = false;
  /** True once an `init` handshake has been posted for the current host. */
  private bootSent = false;
  /** How many times the boot handshake has been posted for the current host. */
  private bootAttempts = 0;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  /** Independent backstop so a pending `init()` can never be stranded. See `settleInit`. */
  private initDeadline: ReturnType<typeof setTimeout> | null = null;
  /** Have we already complained about analysing with no host? Cleared when a host appears. */
  private reportedNoHost = false;

  /**
   * How long to wait before deciding a boot attempt has failed, and how many
   * attempts to make.
   *
   * The old design was ONE attempt with a 20s give-up. It is the reason a user who
   * downloads this app can get a permanently dead engine: the boot is a WebView
   * fetching a 7.3 MB wasm from a `file://` base, and it can fail for reasons that
   * have nothing to do with the code — the page's inline script not yet registered
   * its message handler when `onLoadEnd` fires, a WebView process reclaimed under
   * memory pressure, a slow first read of the asset off disk. Any one of those loses
   * the single `init`, `bootSent` stays true, and nothing ever retries.
   *
   * What the user then sees is not an engine error. `init()` resolves on the deadline
   * anyway, so `analyse()` is queued to a host that will never answer, each call
   * burns its full 30s timeout and returns a null eval, `scanGame` finds nothing to
   * evaluate and returns null, and every game in the archive is recorded as a silent
   * failure. The scan reports no progress and no reason. That is the report this
   * replaces.
   *
   * Retrying is only safe while no search is in flight: the host treats `init` as a
   * fresh boot and clears its search state, which is the bug the `bootSent` guard
   * was added for. So a retry is skipped whenever one is running, and re-checked
   * after it finishes.
   */
  private static readonly BOOT_ATTEMPT_MS = 6_000;
  private static readonly BOOT_MAX_ATTEMPTS = 6;

  /**
   * How long `init()` waits for a `ready` before resolving anyway with `ready` still false.
   *
   * THIS TIMER MUST NOT DEPEND ON ANYTHING ELSE. That is the whole point of it, and getting it
   * wrong is what broke the engine.
   *
   * `init()` used to carry its own unconditional 20s safety valve, and callers could therefore
   * always count on being told something. That valve was replaced with a give-up branch living
   * INSIDE the boot-retry timer — which reads like an improvement, and is not, because the retry
   * timer is state that other methods clear. `attach()` clears it whenever a host is attached, and
   * clears it a second time when the page it had armed it for turns out to be a different object.
   * Either way the retry chain died silently, and with it the only code that could ever resolve
   * `init()`.
   *
   * The result was measured on a real phone: tap "Analyse more", the button flips to "Stop", the
   * progress row appears and then sits on "Starting up…" for ever. No error, because there was no
   * error to report — nothing had failed, a promise had simply been left unresolved. WebView at
   * 0% CPU, because the engine was never asked anything.
   *
   * So: `init()` owns a deadline that only `init()`, `ready` and `destroy` can clear. The retry
   * chain re-posts the handshake; the deadline guarantees the exit. Neither can strand a caller.
   *
   * 25s, not 36s. A healthy boot is a page load, a 7.3 MB read off local disk, a wasm compile and a
   * UCI handshake — a few seconds. The retry budget is 36s, and a user must never be left staring
   * at a spinner for longer than that waiting to be told the engine is unavailable. If a retry
   * after this deadline does bring the engine up, `ready` flips on its own and the next caller gets
   * a working engine, so cutting the wait short costs nothing.
   */
  private static readonly INIT_DEADLINE_MS = 25_000;

  /**
   * How long a search may exceed its own `movetime` before it is declared unanswered.
   *
   * It only has to cover a search that legitimately overran its budget, plus the round trip. A
   * search that is 8 seconds past its time limit is not going to produce a `bestmove`.
   *
   * It was 30 seconds, which is fine for a single interactive search and catastrophic for a scan: a
   * scan walks dozens of positions per game, so with a dead engine the run spent half an hour per
   * game before recording a failure that was really about the engine. Short enough that a dead
   * engine is obvious in seconds rather than inferred from an absence.
   */
  private static readonly NO_REPLY_GRACE_MS = 8_000;

  /**
   * Hand the engine its WebView. Call this as soon as the WebView mounts; the
   * bridge is usable as soon as `init()` resolves.
   */
  attach(host: WebViewHandle | null): void {
    /*
     * `onLoadEnd` is not a once-per-host event. React re-renders this, the WebView can reload, and
     * `ref.current` can be a fresh object for the same page — so this runs again with a live host
     * while a boot is still pending.
     *
     * The previous version cleared the boot timer on the way in, then handed off to `postBoot()`,
     * which returns immediately when `bootSent` is already true. So a repeat attach DESTROYED the
     * retry chain and did not replace it: nothing was re-posted and, more importantly, nothing was
     * re-armed. That was the hang.
     *
     * So the timer is only ever cleared when the host is genuinely gone, and `postBoot` re-arms
     * unconditionally rather than only on the path that posts.
     */
    const hostChanged = this.host !== host;
    this.host = host;

    if (!host) {
      // The page went away. Forget the handshake, but never strand a pending `init()` — that is
      // the deadline's job now, and it does not care what happened to the host.
      this.bootSent = false;
      this.bootAttempts = 0;
      if (this.bootTimer) {
        clearTimeout(this.bootTimer);
        this.bootTimer = null;
      }
      console.warn('[engine] host detached — the handshake resumes on the next attach');
      return;
    }

    if (this.ready) return;

    if (hostChanged) {
      // A different page object. It has never been told to boot, so it needs the handshake and its
      // own full set of attempts — inheriting the old count could exhaust them before this page has
      // had a fair try.
      this.bootAttempts = 0;
      this.bootSent = false;
    }

    this.postBoot();
  }

  /**
   * Post the boot handshake if it has not been posted, and make sure the retry is armed.
   *
   * The re-arm is deliberately NOT inside the "we just posted" branch. A pending `init()` needs the
   * chain alive for as long as there is a host and no `ready`, whoever noticed the host.
   */
  private postBoot(): void {
    if (this.ready || !this.host) return;
    if (!this.bootSent) {
      this.bootSent = true;
      this.bootAttempts++;
      console.warn(
        `[engine] boot handshake ${this.bootAttempts}/${ChessEngine.BOOT_MAX_ATTEMPTS} sent`,
      );
      this.host.postMessage(JSON.stringify({ cmd: 'init' }));
    }
    this.armBootRetry();
  }

  private armBootRetry(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      if (this.ready) return;
      if (this.bootAttempts >= ChessEngine.BOOT_MAX_ATTEMPTS) {
        console.error(
          `[engine] the engine did not start after ${this.bootAttempts} attempts over `
          + `${(this.bootAttempts * ChessEngine.BOOT_ATTEMPT_MS) / 1000}s — analysis is unavailable `
          + 'until the app is reopened',
        );
        // Release anyone waiting, with `ready` still false so they can tell "booted" from
        // "gave up". The independent deadline in `init()` would release them anyway; doing it here
        // means a caller learns sooner rather than sitting out the remaining seconds.
        this.settleInit('boot retries exhausted');
        return;
      }
      // Never re-boot over a live search: the host clears its state on `init`.
      if (this.running) {
        this.armBootRetry();
        return;
      }
      this.bootSent = false;
      this.postBoot();
    }, ChessEngine.BOOT_ATTEMPT_MS);
  }

  /**
   * Resolve a pending `init()`, exactly once, and disarm both its deadline and the boot retry.
   *
   * The one place a pending `init()` is allowed to end. `ready`, the retry budget and the deadline
   * all come through here, so there is no path that can drop a caller's promise on the floor.
   */
  private settleInit(reason: string): void {
    if (this.initDeadline) {
      clearTimeout(this.initDeadline);
      this.initDeadline = null;
    }
    const resolve = this.initResolve;
    this.initResolve = null;
    this.initPromise = null;
    if (!resolve) return;
    console.warn(`[engine] init settled (${reason}); ready=${this.ready}`);
    resolve();
  }

  /** Handle a message coming from the host page. */
  handleMessage(raw: string): void {
    let msg: HostMessage;
    try {
      msg = JSON.parse(raw) as HostMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'ready':
        if (this.bootTimer) {
          clearTimeout(this.bootTimer);
          this.bootTimer = null;
        }
        this.bootSent = true;
        /*
         * The host re-emits `ready` when it has replaced an engine that died
         * mid-session (wasm heap exhaustion throws `memory access out of
         * bounds`, after which no command is ever answered again). Clearing the
         * cached init promise is what makes the *next* `analyse()` usable: the
         * promise resolved long ago, so without this every later call would
         * short-circuit on a deadline that has already passed and hand back a
         * null eval forever.
         *
         * The reborn engine also has no search in flight, so any book-keeping we
         * still hold about the previous one is stale — release it, or every
         * later `analyse` would wait forever for a `bestmove` that already fired.
         */
        this.ready = true;
        this.initPromise = null;
        this.settleInit('engine reported ready');
        this.stopping = false;
        if (this.running || this.queue.length) {
          const stale = [...this.queue, ...(this.running ? [this.running] : [])];
          this.running = null;
          this.queue = [];
          for (const w of stale) {
            if (w.settled) continue;
            w.settled = true;
            if (w.timer) clearTimeout(w.timer);
            w.resolve(null);
          }
        }
        return;

      case 'error':
        console.error('Engine error:', msg.message);
        return;

      case 'log':
        /*
         * `console.warn`, NOT `console.log` — and that is the whole point of this line.
         *
         * `console.log` is stripped from a release bundle, so every diagnostic the engine page sends
         * was invisible in the build that actually ships. The page reports whether the loader export
         * was usable, whether the wasm was read, and which path it used; all of it went nowhere, which
         * is why a boot failure on a release APK could not be diagnosed from the device at all and had
         * to be reasoned about from the source instead.
         *
         * `warn` and `error` survive stripping. Anything that must be visible in a shipped build is
         * therefore a `warn` or an `error`, and this used to be neither.
         */
        console.warn('[engine]', msg.message);
        return;

      case 'info': {
        const ev: EngineEval = {
          bestMoveUci: msg.bestMoveUci,
          scoreCp: msg.scoreCp,
          mateIn: msg.mateIn,
          depth: msg.depth,
          pvUci: msg.pvUci,
          // Pass the variation index through. See `EngineEval.multipv` for what dropping it did.
          multipv: msg.multipv,
        };
        // deliver to the search that is actually running, and remember it there
        const w = this.running;
        if (w) {
          w.lastInfo = ev;
          w.onInfo?.(ev);
        }
        return;
      }

      case 'bestmove': {
        /*
         * Resolve the request the host was searching for. `stopping` means we
         * asked for an abort, so this reply belongs to an abandoned search:
         * swallow the move, release the pipeline, and let `pump()` start the
         * request that superseded it.
         */
        const w = this.running;
        this.running = null;
        if (this.stopping) {
          this.stopping = false;
          this.pump();
          return;
        }
        if (w) {
          w.resolve(msg);
        }
        // a search just finished — start whatever was waiting behind it
        this.pump();
        return;
      }

      default:
        return;
    }
  }

  /**
   * Resolve once the host page reports the engine ready.
   *
   * Deliberately does NOT re-post `init` on its own: the host treats a second
   * `init` as a fresh boot, so the duplicate cleared its search state and the
   * caller's `analyse` — already queued behind the first `ready` — was answered by
   * nobody. `bootSent` and `postBoot()` own the handshake; this only waits, and
   * gives up with `ready` still false rather than pretending.
   *
   * THE DEADLINE BELOW IS LOAD-BEARING AND MUST NOT BE SHARED WITH THE RETRY CHAIN.
   * It is the only thing that makes `await init()` safe to write, because it resolves on its own
   * schedule regardless of what `attach`, `postBoot` or the WebView have done to the retry state.
   */
  init(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise<void>((resolve) => {
      this.initResolve = resolve;
    });
    if (this.initDeadline) clearTimeout(this.initDeadline);
    this.initDeadline = setTimeout(() => {
      console.error(
        `[engine] init deadline of ${ChessEngine.INIT_DEADLINE_MS / 1000}s passed with no "ready" `
        + `(${this.bootAttempts} handshake(s) sent) — analysis is unavailable. Callers are released `
        + 'with ready=false so they can report it instead of waiting.',
      );
      this.settleInit('deadline');
    }, ChessEngine.INIT_DEADLINE_MS);
    // Kick the page if `attach()` has not already done it.
    this.postBoot();
    return this.initPromise;
  }

  get isReady(): boolean {
    return this.ready;
  }

  private post(obj: Record<string, unknown>): void {
    this.host?.postMessage(JSON.stringify(obj));
  }

  /**
   * Start the next queued search, if the engine is idle.
   *
   * `stockfish-host.js` will not overlap searches, and its own comment warns
   * that an overlap "would resolve the new waiter with a stale move" — so we
   * serialise here, on our side, where we can still attach the right callbacks
   * to the right request.
   *
   * `stopping` covers the gap after we have asked the host to stop: Stockfish's
   * `bestmove` for the aborted search is still on its way, and the host will
   * forward it as the reply to whatever it believes is running. Dispatching the
   * next request in that window would both overlap (the host silently drops it)
   * and let the *old* `bestmove` resolve the *new* waiter.
   */
  private pump(): void {
    if (this.running || this.stopping) return;
    const w = this.queue.shift();
    if (!w) return;
    if (w.settled) { this.pump(); return; }
    this.running = w;
    // MultiPV is set at DISPATCH time, unconditionally — 1 for an ordinary
    // search, N for one that wants alternatives.
    //
    // Setting it only for MultiPV searches (and resetting after) was measured to
    // be not enough: the reset was posted after the search settled, but the next
    // request's `pump()` could reach Stockfish first, so the following ordinary
    // analyse came back with THREE lines instead of one. `.bench/engine.multipv
    // .test.mjs` caught exactly that ("single-line search reported 3 line(s)").
    // Declaring the desired value on every dispatch makes the engine's state a
    // function of the current request rather than of history, so nothing can leak.
    //
    // The host forwards `setoption` straight to Stockfish as a raw UCI line.
    const wantMpv = w.opts.multipv && w.opts.multipv > 1 ? Math.min(5, w.opts.multipv) : 1;
    try {
      this.host?.postMessage(JSON.stringify({
        cmd: 'setoption', line: `setoption name MultiPV value ${wantMpv}`,
      }));
    } catch { /* host gone; the search below will fail cleanly too */ }
    this.host?.postMessage(JSON.stringify({
      cmd: w.opts.depth ? 'bestmove' : 'analyse',
      fen: w.fen,
      movetime: w.opts.movetime,
      depth: w.opts.depth,
      elo: w.opts.elo,
    }));
  }

  /**
   * Drop every outstanding request except `keep`, asking the host to abort the
   * search it is running.
   *
   * Called before a new search starts so a superseded search never delays the
   * one the user is actually looking at: without this, tapping through three
   * off-book moves queues three 420ms searches and the eval bar shows a
   * position from two moves ago.
   *
   * The in-flight request is NOT resolved here — the host still owes us a
   * `bestmove` for it, and clearing `running` early is what made the next
   * dispatch overlap. We mark it abandoned, send `stop`, and let its
   * `bestmove` arrival release the pipeline.
   */
  private cancelOutstanding(keep: Waiter | null): void {
    for (const w of this.queue) {
      if (w.settled) continue;
      w.settled = true;
      if (w.timer) clearTimeout(w.timer);
      w.resolve(null);
    }
    this.queue = [];
    const cur = this.running;
    if (cur && cur !== keep && !cur.settled) {
      // abandon it: keep `running` set so pump() stays blocked, but resolve the
      // caller immediately (it asked for a fresh position anyway)
      cur.settled = true;
      if (cur.timer) clearTimeout(cur.timer);
      cur.resolve(null);
      this.stopping = true;
      this.post({ cmd: 'stop' });
    }
  }

  /**
   * Enrol `waiter` in the pipeline and resolve when it settles.
   *
   * Shared by `analyse` and `bestMove` so the abort/timeout/ordering rules live
   * in exactly one place.
   */
  private enqueue(waiter: Waiter): Promise<HostMessage | null> {
    return new Promise<HostMessage | null>((resolve) => {
      waiter.resolve = resolve;
      /*
       * A NEW request supersedes whatever was in flight. The Course screen fires
       * one of these per off-book move, so without this the queue grows and the
       * board feels progressively more sluggish the longer you explore.
       */
      this.cancelOutstanding(waiter);
      this.queue.push(waiter);
      // Safety valve. A well-behaved host always answers, so this only fires if
      // the WebView died without its `ready` handshake — log loudly, because a
      // silent null eval is indistinguishable from "this position is equal".
      //
      // THE GRACE IS 30s, AND THAT IS HOW A DEAD ENGINE LOOKS LIKE A HANG.
      //
      // A scan walks up to `maxPliesPerGame` positions per game. With 30 seconds of grace on each,
      // one dead engine spends 30s × 40 plies × every game before the first failure is recorded — over
      // half an hour for the run to conclude "nothing usable" from something that had nothing to do
      // with the games. The grace only has to cover a legitimate search that overran its `movetime`;
      // a search that overruns its own time budget by 8 seconds is not going to answer.
      //
      // So the grace is bounded and modest, and it is not per-ply cumulative: a dead engine now
      // surfaces in a few seconds instead of half an hour, which is the difference between a report
      // the user can act on and one that looks like the app is simply broken.
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const qi = this.queue.indexOf(waiter);
        if (qi !== -1) this.queue.splice(qi, 1);
        if (this.running === waiter) {
          this.stopping = true;
          this.post({ cmd: 'stop' });
        }
        console.warn(
          `[engine] no reply after ${(waiter.opts.movetime ?? 0) + ChessEngine.NO_REPLY_GRACE_MS}ms for ` +
            `${waiter.fen.slice(0, 40)} — returning a null eval`,
        );
        resolve(null);
      }, (waiter.opts.movetime ?? 0) + ChessEngine.NO_REPLY_GRACE_MS);
      this.pump();
    });
  }

  /**
   * Analyse a position; returns best move + score. `onInfo` streams progress.
   * Signature-compatible with the web version.
   */
  async analyse(
    fen: string,
    opts: {
      movetime?: number; depth?: number; elo?: number | null; onInfo?: InfoCallback;
      /**
       * Ask Stockfish for N principal variations instead of one.
       *
       * Set via `setoption name MultiPV` before the search, so the engine emits
       * `multipv N` info blocks that the host already parses. This is how the
       * game-openings analysis gets alternatives for free: one MultiPV search
       * yields the best move AND its runners-up, where asking for each
       * alternative separately would be N full searches.
       *
       * The value is re-declared on every dispatch (see `pump`), so an ordinary
       * search always resets it to 1 itself and single-line callers keep the
       * behaviour they expect without this method having to clean up.
       */
      multipv?: number;
    } = {},
  ): Promise<EngineEval> {
    await this.init();
    /*
     * SAY SO WHEN THERE IS NO ENGINE, AT THE POINT OF USE.
     *
     * `AppShell` mounts the WebView host conditionally, which is the right thing to do for memory
     * and a standing invitation for a screen to be left out of that condition. Stats was left out
     * for a long time. The result was not an error, not a failure and not a hang: `init()` found no
     * host, never posted the handshake, and every call below quietly burned its timeout and
     * returned a null eval, so the scan looked broken rather than absent.
     *
     * A caller can only be wrong about this in one direction - asking for an analysis with no engine
     * mounted - so it is worth naming at the moment it happens, while the caller's own context is
     * still on the stack. Reported once per host change, not once per call: a scan makes hundreds.
     */
    if (!this.host && !this.reportedNoHost) {
      this.reportedNoHost = true;
      console.error(
        '[engine] an analysis was requested with no WebView host mounted. The engine cannot answer, '
        + 'and this is NOT a search that timed out - the WebView was never mounted for this screen. '
        + "Check that AppShell's `engineNeeded` includes wherever this was called from.",
      );
    } else if (this.host) {
      this.reportedNoHost = false;
    }

    /*
     * A MOVETIME IS A CAP THE CALLER ASKS FOR, NOT A DEFAULT WE IMPOSE.
     *
     * It used to default to 300ms and ride along on every request — including
     * depth searches, where the host simply ignored it. Making it genuinely
     * optional is what lets a depth search carry a HARD TIME CAP (`go depth N
     * movetime M`, stops at whichever lands first): the caller that budgets its
     * searches passes one, and every caller that does not gets exactly the
     * search it always got. Omitted here means the key never reaches the host.
     */
    const { depth, elo = null, onInfo } = opts;
    const movetime = opts.movetime;
    const multipv = opts.multipv && opts.multipv > 1 ? Math.min(5, opts.multipv) : 1;

    /** Every distinct MultiPV line seen, keyed by its multipv index. */
    const lines = new Map<number, {
      uci: string;
      scoreCp: number | null;
      mateIn: number | null;
      pvUci: string[];
      depth: number;
    }>();

    const collect = (ev: EngineEval) => {
      if (multipv <= 1) return;
      const idx = ev.multipv ?? 1;
      const uci = ev.pvUci?.[0] ?? ev.bestMoveUci;
      if (!uci) return;
      // Keep the DEEPEST report per slot: Stockfish re-emits each line as it
      // deepens, and a shallower duplicate would overwrite a better number.
      //
      // This condition used to read `(ev.depth ?? 0) < 0`, which is never true.
      // Every later info block therefore overwrote the stored line, including a
      // shallower one. The check is now against the depth actually stored.
      const prev = lines.get(idx);
      const depth = ev.depth ?? 0;
      if (prev && depth < prev.depth) return;
      lines.set(idx, { uci, scoreCp: ev.scoreCp, mateIn: ev.mateIn, pvUci: ev.pvUci ?? [], depth });
    };

    const waiter: Waiter = {
      id: this.nextId++,
      resolve: () => {},
      onInfo: (ev) => { collect(ev); onInfo?.(ev); },
      lastInfo: null,
      fen,
      opts: { movetime, depth, elo, multipv },
      timer: null,
      settled: false,
    };

    const result = await this.enqueue(waiter);

    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.settled = true;

    const base: EngineEval = waiter.lastInfo ?? {
      bestMoveUci: null,
      scoreCp: null,
      mateIn: null,
      depth: 0,
      pvUci: [],
    };

    const out: EngineEval = result && result.type === 'bestmove'
      ? {
          ...(result.info ?? base),
          bestMoveUci: result.uci ?? (result.info ?? base).bestMoveUci,
        }
      : base;

    if (multipv > 1) {
      // Best-first by multipv index, which Stockfish guarantees.
      const sorted = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      if (sorted.length) {
        out.lines = sorted;

        /*
         * THE SCALAR FIELDS MUST DESCRIBE LINE 1, NOT "WHICHEVER INFO ARRIVED LAST".
         *
         * Stockfish emits one `info` block per line per depth. The host forwards
         * all of them, and `lastInfo` — which is what `bestmove.info` carries —
         * is simply the last one it saw. In a MultiPV search that is normally
         * line 2, not line 1. `analyse()` used to copy those scalar fields onto
         * the result, while `lines[0]` was correctly the top line. The analysis
         * screen then used `scoreCp`/`mateIn` for accuracy and move grades and
         * `lines` for the brilliant gap, so it was grading every move on the
         * RUNNER-UP's eval while claiming it was the top line.
         *
         * The best move itself was already correct because `bestmove uci` is
         * authoritative. The eval was not. This is why a review could be full of
         * "mistakes" that were not there: the score before a move and the score
         * after it could come from different MultiPV slots.
         *
         * Copy the top line's fields explicitly after sorting. This also makes
         * the timeout path coherent: if no bestmove arrived but line 1 did, the
         * caller gets line 1 rather than the last runner-up.
         */
        const top = sorted[0];
        out.scoreCp = top.scoreCp;
        out.mateIn = top.mateIn;
        out.pvUci = top.pvUci;
        out.depth = top.depth;
        if (!out.bestMoveUci) out.bestMoveUci = top.uci;
      }
    }

    // No reset here on purpose — `pump()` declares MultiPV on every dispatch, so
    // the next ordinary search sets it back to 1 itself. A reset posted from this
    // side raced with that dispatch and lost. See the note in `pump()`.

    return out;
  }

  /** Quick best move query. Supersedes any search already in flight. */
  async bestMove(fen: string, movetime = 250, elo: number | null = null): Promise<string | null> {
    await this.init();
    const waiter: Waiter = {
      id: this.nextId++,
      resolve: () => {},
      onInfo: null,
      lastInfo: null,
      fen,
      opts: { movetime, elo },
      timer: null,
      settled: false,
    };
    const result = await this.enqueue(waiter);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.settled = true;
    if (result && result.type === 'bestmove') return result.uci;
    return null;
  }

  stop(): void {
    // drop every waiting/superseded request, then tell the host to halt
    this.cancelOutstanding(null);
    this.post({ cmd: 'stop' });
  }

  /**
   * THE USER-VISIBLE RECOVERY: throw the engine away and build a fresh one.
   *
   * Written after the round in which the only route out of a stalled engine was "Close the app and
   * open it again" — Stats and Your openings both said so in as many words. That copy is honest
   * about the underlying fact (a rebuilt host is what fixes a dead one) and wrong about the remedy:
   * the host can be rebuilt in place, and now is, from a button.
   *
   * Three things happen, and all three are needed:
   *
   *   1. every outstanding waiter is released with null — a rebuilt engine owes nobody a
   *      `bestmove`, and leaving the old timers armed would fire their warnings over a search that
   *      no longer exists;
   *   2. a pending `init()` is resolved (with `ready` still false) so a caller awaiting the old
   *      engine is not left hanging on it;
   *   3. the host is told `restart`, which replaces the engine instance outright (the host's
   *      `markDead` path — the same one a crash takes), and the handshake is re-posted so `ready`
   *      arrives for the new instance.
   *
   * Deliberately callable when the host is null (the state is still reset, and the next `attach`
   * boots normally) and when the engine is healthy: a second tap finds a boot in flight and the
   * host answers by doing nothing, which is correct.
   */
  restart(reason: string): void {
    console.warn(`[engine] restart requested (${reason})`);
    this.ready = false;
    this.bootSent = false;
    this.bootAttempts = 0;
    this.stopping = false;
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    for (const w of [...this.queue, ...(this.running ? [this.running] : [])]) {
      if (w.timer) clearTimeout(w.timer);
      if (!w.settled) {
        w.settled = true;
        w.resolve(null);
      }
    }
    this.queue = [];
    this.running = null;
    this.settleInit('restarting the engine');
    this.post({ cmd: 'restart' });
    this.postBoot();
  }

  destroy(): void {
    try {
      this.post({ cmd: 'quit' });
    } catch {
      /* ignore */
    }
    for (const w of [...this.queue, ...(this.running ? [this.running] : [])]) {
      if (w.timer) clearTimeout(w.timer);
      if (!w.settled) {
        w.settled = true;
        w.resolve(null);
      }
    }
    this.queue = [];
    this.running = null;
    this.stopping = false;
    this.bootSent = false;
    this.bootAttempts = 0;
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    this.host = null;
    this.ready = false;
    /*
     * Release a pending `init()` instead of dropping it.
     *
     * This used to null `initResolve` and walk away, which left the promise the caller was already
     * awaiting with nobody holding its resolver: that `await` never returned, and because the only
     * other exit was the retry timer this method had just cleared, there was no error and no log
     * either. A caller in an unmount-during-await was simply stuck.
     */
    this.settleInit('engine destroyed');
  }
}

// Singleton per app session
let globalEngine: ChessEngine | null = null;

export function getEngine(): ChessEngine {
  if (!globalEngine) globalEngine = new ChessEngine();
  return globalEngine;
}

/** Convert UCI move to SAN given a position (position BEFORE the move) */
export function uciToSan(fen: string, uci: string): string | null {
  try {
    const c = new Chess(fen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const m = c.move({ from, to, promotion });
    return m.san;
  } catch {
    return null;
  }
}

/** Apply UCI move to a chess.js instance, returns the move or null */
export function applyUci(c: Chess, uci: string) {
  try {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    return c.move({ from, to, promotion });
  } catch {
    return null;
  }
}
