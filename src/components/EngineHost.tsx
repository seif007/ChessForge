'use client';

/**
 * Hidden WebView that hosts the Stockfish engine, plus the wiring that connects
 * it to the `ChessEngine` singleton.
 *
 * Render ONE of these near the app root (AppShell). It is zero-sized and
 * non-interactive.
 *
 * How the wasm reaches the engine
 * -------------------------------
 * The Emscripten loader is inlined verbatim into the page, so it needs no
 * network and no file:// resolution for *itself*. The 7.3 MB wasm, however, is
 * deliberately NOT inlined (see scripts/build-engine-assets.mjs for the build
 * blowups that caused): it ships as a normal Metro asset and we hand the loader
 * a `wasmBinary` that we read from the asset's local URI.
 *
 * We read it inside the page rather than passing bytes across the bridge because
 * the bridge is string-only and base64 would re-introduce the size penalty.
 *
 * IMPORTANT — read it with XMLHttpRequest, not fetch(). `expo-asset` hands us a
 * `file://` URI, and Chromium's fetch() does not implement the file scheme, so
 * `fetch(uri)` always rejects with "Failed to fetch". That single mistake made
 * the engine fail to start on device for the entire life of this port. The page
 * also needs a `file://` baseUrl (see below) or it gets a null origin, from
 * which Chromium blocks file access even via XHR.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, AppState } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewProps, WebViewMessageEvent } from 'react-native-webview';
// `WebViewErrorEvent` lives in lib/WebViewTypes but is NOT re-exported from the
// package root, so it has to be reached via the deep (type-only) path.
import type { WebViewErrorEvent } from 'react-native-webview/lib/WebViewTypes';
import { Asset } from 'expo-asset';

import { getEngine } from '@/lib/engine';
import { STOCKFISH_LOADER_JS, STOCKFISH_HOST_JS } from '@/engine/assets';

/**
 * `react-native-webview` types its default export through the `react-native`
 * package field, so TS lands on `src/WebView.tsx` — the *unsupported-platform*
 * fallback, whose `WebViewProps` intersection collapses React children to
 * `never`. Casting once here (instead of per-prop) keeps the JSX below honest
 * and fully type-checked against the real declarations in `lib/WebViewTypes.d.ts`.
 */
const TypedWebView = WebView as unknown as React.ComponentType<
  WebViewProps & { ref?: React.Ref<WebView> }
>;

/** How many times the wasm asset read is attempted before the host gives up — a foreground return still retries. */
const WASM_ASSET_ATTEMPTS = 3;
/** Base gap between asset attempts; multiplied by the attempt number so later retries breathe more. */
const WASM_ASSET_RETRY_MS = 1200;

/**
 * How the loader exports itself, and why the page needs an adapter.
 *
 * The bundle ends in `function t(){ function e(e){ ... } return e }` and its
 * browser branch does `document.currentScript._exports = t()`. So `_exports` is
 * `e`, the Emscripten module factory:
 *
 *   e(config)  ->  sets the module config, returns a promise that resolves once
 *                  the runtime is up, and assigns `config.processCommand`.
 *
 * It never defines `window.Stockfish`, and it exposes no `postMessage` /
 * `onmessage` in this (non-worker) mode — the web app gets those from a real
 * `new Worker(...)`, which is exactly what the old code here assumed. Chromium
 * refuses to start a Worker from a `file://` URL, so instead the page builds a
 * small adapter that maps the Worker-shaped API the host expects
 * (`onmessage` / `postMessage`) onto `processCommand` + `listener`.
 */

export function EngineHost() {
  const ref = useRef<WebView>(null);
  const sawMessageRef = useRef(false);
  const engine = getEngine();
  const [wasmUri, setWasmUri] = useState<string | null>(null);

  /*
   * RESOLVE THE WASM ASSET — WITH RETRIES, AND ANOTHER CHANCE ON FOREGROUND.
   *
   * This used to be one attempt. If that attempt lost — a transient read failure off disk, a torn
   * asset download, a process reclaimed under memory pressure — the failure was a single
   * `console.error` and the WebView was never mounted AT ALL: `html` stayed null, the component
   * returned an empty View, and the engine's own six-attempt boot chain could never start. Every
   * engine screen then showed its "did not start" copy for a fault that a second read would have
   * fixed, with reopening the app as the only way back.
   *
   * So: a few attempts with a widening gap, and a retry whenever the app comes back to the
   * foreground — the moment a user would try again anyway, and after whatever reclaimed the memory
   * has been relieved. `done` and `inFlight` keep the two paths from stacking downloads.
   */
  useEffect(() => {
    let cancelled = false;
    let done = false;
    let inFlight = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const resolveAsset = async (): Promise<void> => {
      if (cancelled || done || inFlight) return;
      inFlight = true;
      attempts++;
      try {
        const asset = Asset.fromModule(
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('../../assets/engine/stockfish-18-lite-single.wasm'),
        );
        await asset.downloadAsync();
        const uri = asset.localUri ?? asset.uri;
        /*
         * `warn`, not `log`. This is not a style preference: `console.log` is stripped from a release
         * bundle, so when the WebView fails to mount at all — which is what a screen left out of
         * AppShell's `engineNeeded` looks like — every diagnostic below was invisible in the build
         * that ships. This line is the only thing that would have said the asset resolved, and its
         * silence is what made the fault look like a dead engine instead of an unmounted WebView.
         */
        console.warn('[EngineHost] wasm asset resolved:', uri);
        done = true;
        if (!cancelled) setWasmUri(uri);
      } catch (err) {
        console.error(
          `[EngineHost] wasm asset attempt ${attempts}/${WASM_ASSET_ATTEMPTS} failed:`, err,
        );
        if (!cancelled && attempts < WASM_ASSET_ATTEMPTS) {
          retryTimer = setTimeout(() => void resolveAsset(), WASM_ASSET_RETRY_MS * attempts);
        }
      } finally {
        inFlight = false;
      }
    };

    void resolveAsset();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void resolveAsset();
    });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      sub.remove();
    };
  }, []);

  const html = useMemo(() => (wasmUri ? buildEngineHtml(wasmUri) : null), [wasmUri]);

  /**
   * Directory the wasm lives in, used as the page's `baseUrl`.
   *
   * This is load-bearing, not cosmetic: with `source={{ html }}` and no
   * baseUrl the page gets a `null` origin, and Chromium refuses file:// XHR
   * from a null origin. Giving the document a file:// base makes it a file
   * origin, which `allowFileAccessFromFileURLs` then permits to read the
   * neighbouring wasm.
   */
  const baseUrl = useMemo(() => {
    if (!wasmUri) return undefined;
    const cut = wasmUri.lastIndexOf('/');
    return cut > 0 ? wasmUri.slice(0, cut + 1) : undefined;
  }, [wasmUri]);

  useEffect(() => {
    return () => {
      engine.destroy();
    };
  }, [engine]);

  /**
   * Hand the engine its WebView as soon as the page EXISTS — not when it reports it has loaded.
   *
   * `onLoadEnd` was the only thing that ever called `attach`, and on this device it never fired.
   * The WebView is created (`RNCWebViewManagerImpl.createRNCWebViewInstance` is in logcat) and the
   * page is served, but no load-completion callback ever arrives, so:
   *
   *   attach() never ran  ->  the engine's `host` stayed null  ->  `postBoot` returned immediately
   *   on `!this.host`     ->  the `init` handshake was NEVER POSTED ("0 handshake(s) sent")
   *                        ->  the engine never booted          ->  every analyse() timed out
   *
   * That is the whole of the original report. Nothing failed; the handshake simply was never sent,
   * and there was no path that could notice. It is also invisible from the outside, because the
   * engine page never received a command and so had nothing to report either.
   *
   * Posting the handshake does not require a finished load. The page's own bridge queues what it
   * cannot accept yet, and the engine re-posts every 6s if no `ready` arrives — so an early post is
   * merely early, while a post that depends on an event that may never come is fatal.
   *
   * `onLoadEnd` is kept as a second chance, and `attach` is idempotent, so whichever arrives first
   * wins and the other is harmless.
   */
  useEffect(() => {
    if (!html) return;
    const handle = ref.current;
    if (!handle) {
      console.warn('[EngineHost] the page exists but the WebView handle is not attached yet');
      return;
    }
    console.warn('[EngineHost] handing the engine its WebView (on mount, not onLoadEnd)');
    engine.attach(handle);
  }, [html, engine]);

  // Don't mount the WebView until we can give it a wasm URL.
  if (!html) {
    return <View style={styles.hidden} pointerEvents="none" />;
  }

  /*
   * `attach` treats a null handle as "the host went away" and forgets the handshake. Never pass a
   * null through on the way out — `onLoadEnd` on a ref that React has already cleared would tear
   * down a boot that is working perfectly well.
   */
  const attachIfPresent = () => {
    const handle = ref.current;
    if (!handle) {
      console.warn('[EngineHost] onLoadEnd with no WebView handle — leaving the engine alone');
      return;
    }
    console.warn('[EngineHost] onLoadEnd — handing the engine its WebView');
    engine.attach(handle);
  };

  return (
    <View style={styles.hidden} pointerEvents="none">
      <TypedWebView
        ref={ref}
        source={baseUrl ? { html, baseUrl } : { html }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        androidLayerType="hardware"
        onLoadStart={() => console.warn('[EngineHost] the engine page started loading')}
        onLoadEnd={attachIfPresent}
        onMessage={(e: WebViewMessageEvent) => {
          // The page talks unprompted — it reports the loader export, the wasm read and the module
          // coming up, none of which wait to be asked. If the very first one never arrives, the page
          // itself is broken, and this is the only place that says so.
          if (!sawMessageRef.current) {
            sawMessageRef.current = true;
            console.warn('[EngineHost] first message from the engine page:',
              String(e.nativeEvent.data).slice(0, 200));
          }
          engine.handleMessage(e.nativeEvent.data);
        }}
        onError={(e: WebViewErrorEvent) => console.error('[EngineHost] WebView error', e.nativeEvent)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { width: 0, height: 0, opacity: 0, position: 'absolute' },
});

/**
 * Assemble the engine page: loader + wasm bootstrap + host bridge.
 *
 * `wasmUri` is a file:// URL pointing at the packaged .wasm asset.
 */
function buildEngineHtml(wasmUri: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
<script id="sf-loader">
/* ---- Stockfish 18 lite (single-threaded) loader, unmodified ---- */
${STOCKFISH_LOADER_JS}
</script>
<script>
/* ---- capture the module factory the loader parks on its own script tag ---- */
(function () {
  var el = document.getElementById('sf-loader');
  var exp = el ? el._exports : undefined;
  if (typeof exp === 'function') window.__sfFactory = exp;
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'log',
    message: 'loader export: ' + (typeof exp) +
      (typeof exp === 'function' ? ' (factory)' : ' (unusable)'),
  }));
})();
</script>
<script>
/* ---- pull the wasm off disk and inject it via wasmBinary ---- */
(function () {
  window.__sfReady = null;
  window.__sfWasmUri = ${JSON.stringify(wasmUri)};

  function report(msg) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'log', message: msg }));
  }

  function fail(msg) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: msg }));
  }

  /*
   * Read the .wasm as an ArrayBuffer.
   *
   * Chromium's fetch() does NOT support the file:// scheme at all — it
   * rejects with "Failed to fetch" no matter how the WebView is configured.
   * The packaged wasm resolves to exactly such a file:// URI on Android, so
   * the original fetch-based loader could never succeed: the engine silently
   * never started, every analyse() call fell through to its 30 s timeout and
   * returned a null eval, and the UI showed 100% accuracy with no blunder
   * detection and a flat eval graph.
   *
   * XMLHttpRequest DOES support file:// (that is what allowFileAccess plus
   * allowFileAccessFromFileURLs are for), so it is the primary path; plain
   * fetch stays as the fallback for http(s)/data URIs.
   */
  function readViaXhr(uri) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      try {
        xhr.open('GET', uri, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function () {
          // file:// responses report status 0 on success.
          var ok = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300);
          if (ok && xhr.response && xhr.response.byteLength) resolve(xhr.response);
          else reject(new Error('xhr status ' + xhr.status));
        };
        xhr.onerror = function () { reject(new Error('xhr network error')); };
        xhr.ontimeout = function () { reject(new Error('xhr timeout')); };
        xhr.send();
      } catch (e) {
        reject(e);
      }
    });
  }

  function readViaFetch(uri) {
    return fetch(uri).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    });
  }

  // Build the Worker-shaped API the host expects on top of the module factory.
  function patchLoader(buf) {
    var factory = window.__sfFactory;
    if (typeof factory !== 'function') {
      fail('no Stockfish module factory exported by the loader');
      return;
    }

    window.Stockfish = function (opts) {
      var cfg = Object.assign({}, opts || {}, {
        locateFile: function () { return window.__sfWasmUri; },
      });
      if (buf && buf.byteLength) cfg.wasmBinary = new Uint8Array(buf);

      var pending = [];
      var flushTimer = null;
      var moduleReady = false;
      var sentCount = 0;
      var flushedOnce = false;

      /*
       * Everything the host posts is queued and drained from a timer, never
       * dispatched inline. That is a correctness requirement, not a nicety.
       *
       * The engine calls back into JS while a command is still executing: its
       * C++ print() reaches us through cfg.listener, and the host answers
       * "uciok" by posting "isready". Dispatching that straight away means
       * calling ccall() from inside ccall(), i.e. re-entering the Stockfish
       * command loop from within its own output callback. The engine does not
       * survive that: each nested command re-emits uciok, which triggers
       * another nested isready, and the JS stack overflows within about a
       * second ("RangeError: Maximum call stack size exceeded"). Queuing
       * instead guarantees a ccall() never starts until the previous one has
       * fully unwound.
       */
      function schedule() {
        if (flushTimer === null) flushTimer = setTimeout(flushPending, 0);
      }

      /*
       * The loader's own dispatcher is i(cmd), which for a plain go or
       * setoption queues the command and otherwise calls
       * ccall('command', null, ['string'], [cmd], {async: ...}). That
       * dispatcher is only installed by f(), the ready callback the loader
       * wires up in its Node and worker branches — never in the browser branch
       * we are using (there, its handle c is never assigned at all). So we
       * send commands the same way i() does.
       *
       * async is false for every command: IS_ASYNCIFY is never defined in
       * this single-threaded build, so the loader passes false too.
       */
      function sendCommand(cmd) {
        var s = String(cmd);
        if (typeof cfg.processCommand === 'function') {
          cfg.processCommand(s);
          return true;
        }
        if (typeof cfg.ccall === 'function') {
          try {
            cfg.ccall('command', null, ['string'], [s], { async: false });
          } catch (err) {
            // A throw here is the engine failing to accept a command. Report the
            // command and a trimmed stack so the failure is diagnosable from
            // logcat instead of surfacing as a bare "Maximum call stack size
            // exceeded" with no context.
            fail('ccall failed for "' + s.slice(0, 40) + '": ' + (err && err.message) +
              ' | stack: ' + String(err && err.stack).slice(0, 700));
            return false;
          }
          return true;
        }
        return false;
      }

      var api = {
        onmessage: null,
        onerror: null,
        // The host drives the engine through this, exactly as it would a Worker.
        postMessage: function (cmd) {
          pending.push(cmd);
          schedule();
        },
      };

      function deliver(line) {
        if (typeof api.onmessage === 'function') api.onmessage({ data: String(line) });
      }

      // Engine output arrives here: Emscripten routes print/printErr to
      // listener when it is set. (cfg.print/printErr are assigned by the loader
      // itself and forward to listener, so they must not be overwritten.)
      cfg.listener = deliver;

      function flushPending() {
        flushTimer = null;
        if (!moduleReady) {
          if (pending.length) schedule();
          return;
        }
        // Mirror the loader's own guard: it waits for _isReady() before
        // touching the engine.
        if (typeof cfg._isReady === 'function' && !cfg._isReady()) {
          if (pending.length) schedule();
          return;
        }
        // Drain in order. Commands posted from inside sendCommand (the host's
        // reply to uciok, say) land in the pending array and are picked up by
        // the next iteration — after the current ccall has returned.
        while (pending.length) {
          var cmd = pending.shift();
          if (!sendCommand(cmd)) {
            pending.unshift(cmd);
            schedule();
            return;
          }
          sentCount++;
        }
        if (sentCount && !flushedOnce) {
          flushedOnce = true;
          report('engine up — dispatched ' + sentCount + ' command(s), no re-entrant ccall');
        }
      }

      var created;
      try {
        created = factory(cfg);
      } catch (e) {
        fail('Stockfish factory threw: ' + (e && e.message));
        return api;
      }

      // The factory returns a promise that settles when the runtime is up.
      Promise.resolve(created).then(function () {
        moduleReady = true;
        report('module ready (ccall=' + typeof cfg.ccall +
          ' processCommand=' + typeof cfg.processCommand +
          ' _isReady=' + typeof cfg._isReady + ')');
        flushPending();
      }).catch(function (e) {
        fail('engine init rejected: ' + (e && e.message) +
          ' | stack: ' + String(e && e.stack).slice(0, 700));
      });

      return api;
    };

    report('factory wired with ' + (buf && buf.byteLength ? buf.byteLength + ' wasm bytes' : 'no bytes'));
  }

  window.__sfReady = readViaXhr(window.__sfWasmUri)
    .catch(function (xhrErr) {
      report('wasm xhr read failed (' + (xhrErr && xhrErr.message) + ') — retrying with fetch');
      return readViaFetch(window.__sfWasmUri);
    })
    .then(function (buf) {
      patchLoader(buf);
      report('wasm ready: ' + buf.byteLength + ' bytes via ' + window.__sfWasmUri);
      return true;
    })
    .catch(function (e) {
      // Still let the engine try to load the wasm on its own.
      patchLoader(null);
      fail('wasm read failed: ' + (e && e.message) + ' [uri=' + window.__sfWasmUri + ']');
      return false;
    });
})();
</script>
<script>
/* ---- host bridge ---- */
${STOCKFISH_HOST_JS}
</script>
</body>
</html>`;
}
