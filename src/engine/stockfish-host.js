/* eslint-disable */
/**
 * Stockfish host page — runs INSIDE a hidden react-native-webview.
 *
 * Why a WebView at all: the Stockfish 18 lite Emscripten loader
 * (`assets/engine/stockfish-18-lite-single.js`) is a browser/Node-targeted build.
 * It branches on `typeof document`, `self.location.origin`, `XMLHttpRequest` and
 * `fetch` — none of which exist in React Native's JS runtime. A WebView gives us
 * a real browser environment, so the UNMODIFIED engine binary runs as-is.
 *
 * Protocol (both directions are single-line JSON strings):
 *   RN -> page : { cmd: 'init' }
 *                { cmd: 'analyse', fen, movetime?, depth?, elo? }
 *                { cmd: 'bestmove', fen, depth?, movetime?, elo? }
 *                { cmd: 'stop' }
 *                { cmd: 'quit' }
 *   page -> RN : { type: 'ready' }
 *                { type: 'info', bestMoveUci, scoreCp, mateIn, depth, pvUci }
 *                { type: 'bestmove', uci }
 *                { type: 'error', message }
 *
 * When `depth` is present the search runs to that depth; when `movetime` is also
 * present it stops at whichever limit lands first (a bounded depth search).
 *
 * The worker section of the loader detects `self.location.hash` and switches to
 * its worker branch, which is exactly the message-passing mode we want.
 */

var engine = null;
var ready = false;
var pending = [];
var lastInfo = null;

/**
 * SEARCH WATCHDOG STATE.
 *
 * `searchOutstanding` is true from the moment a `go` is posted until a `bestmove` comes back.
 * `searchWatch` is the timer that turns "still searching" into "the engine is dead" when the
 * search stops answering entirely.
 *
 * Why the HOST owns this and the app does not: an engine can be alive enough to accept
 * `position`/`go` and still never produce a move — Emscripten heap damage that stops short of
 * throwing, or a `stop` this build cannot honour (there is no virtual clock to interrupt). The
 * app-side grace timer gives up and returns a null eval, but the host stays busy, so every later
 * search is superseded, and nobody recovers until the app is reopened. Rebuilding the engine is
 * the recovery, and it is safe to do here because `markDead` below already proves the path works:
 * it is the same one a crash takes.
 */
var searchOutstanding = false;
var searchWatch = null;

/**
 * How long after a search's own time budget the host waits before declaring the engine dead.
 *
 * MUST OUTLAST THE APP'S OWN GRACE. `ChessEngine.NO_REPLY_GRACE_MS` is 8000 on the RN side: at
 * `movetime + 8s` the app resolves the caller with null and posts `stop`. Rebuilding the engine
 * sooner than that would kill healthy instances that honour `stop` a moment later, so 12s gives
 * the stop round trip twice over before the engine is pronounced dead.
 */
var SEARCH_NO_REPLY_GRACE_MS = 12000;

/**
 * Self-healing state.
 *
 * The Emscripten/wasm engine can die permanently mid-session: after enough
 * pushes its heap is exhausted and every later `ccall` throws
 * "memory access out of bounds" (surfaced as `RuntimeError`). Once that has
 * happened no command works again — `uci` never answers `uciok`, `stop` does
 * nothing — so the only recovery is to build a brand-new engine instance.
 *
 * We cannot merge the (relatively small) wasm heap, but we CAN detect the
 * fatal error and replace the engine, which turns a permanently dead engine
 * into a short hiccup.
 */
var booting = false;
var queued = [];

function isFatal(msg) {
  var s = String(msg || '');
  return s.indexOf('memory access out of bounds') >= 0
    || s.indexOf('RuntimeError') >= 0
    || s.indexOf('abort(') >= 0;
}

function markDead(msg) {
  if (booting) return;
  send({ type: 'log', message: 'engine died, restarting: ' + String(msg).slice(0, 120) });
  ready = false;
  lastInfo = null;
  // The old instance is about to be abandoned — its search will never answer, so the watchdog
  // for it must not fire later and rebuild the healthy replacement.
  searchOutstanding = false;
  if (searchWatch) { clearTimeout(searchWatch); searchWatch = null; }
  try { engine = null; } catch (e) {}
  pending = [];
  boot();
}

function send(obj) {
  try {
    window.ReactNativeWebView.postMessage(JSON.stringify(obj));
  } catch (e) {
    /* host gone */
  }
}

function stripTags(line) {
  return typeof line === 'string' ? line.replace(/<[^>]*>/g, '') : String(line);
}

function parseInfo(line) {
  var depthM = line.match(/\bdepth (\d+)/);
  var cpM = line.match(/score cp (-?\d+)/);
  var mateM = line.match(/score mate (-?\d+)/);
  var pvM = line.match(/\bpv ((?:[a-h][1-8][a-h][1-8][a-z]? ?)+)/);
  var mpvM = line.match(/\bmultipv (\d+)/);
  if (!depthM && !cpM && !mateM) return null;
  var pv = pvM ? pvM[1].trim().split(' ') : [];
  return {
    type: 'info',
    bestMoveUci: pv.length ? pv[0] : null,
    scoreCp: cpM ? parseInt(cpM[1], 10) : null,
    mateIn: mateM ? parseInt(mateM[1], 10) : null,
    depth: depthM ? parseInt(depthM[1], 10) : 0,
    pvUci: pv,
    // Stockfish only emits this when MultiPV > 1; 1 otherwise. Kept so batch
    // tooling can tell several candidate moves apart instead of seeing one.
    multipv: mpvM ? parseInt(mpvM[1], 10) : 1,
  };
}

function boot() {
  if (booting) return;
  booting = true;
  // The page resolves `window.__sfReady` after it has read the wasm and patched
  // `window.Stockfish` (see EngineHost.tsx). It resolves to `false` only when
  // the read failed — in that case the patch still installed `locateFile`, so
  // we start the engine anyway and let the loader try to read the wasm itself.
  Promise.resolve(window.__sfReady).then(function (ok) {
    if (ok === false) {
      send({ type: 'log', message: 'starting engine without wasmBinary (locateFile fallback)' });
    }
    var eng;
    try {
      eng = Stockfish();
    } catch (e) {
      booting = false;
      send({ type: 'error', message: 'Stockfish() threw: ' + (e && e.message) });
      return;
    }
    booting = false;
    wireEngine(eng);
    send({
      type: 'log',
      message: 'engine handle: postMessage=' + typeof (eng && eng.postMessage) +
        ' onmessage=' + typeof (eng && eng.onmessage),
    });
    eng.postMessage('uci');
  }).catch(function (e) {
    booting = false;
    send({ type: 'error', message: 'boot rejected: ' + (e && e.message) });
  });
}

function wireEngine(eng) {
  engine = eng;

  engine.onerror = function (e) {
    var text = stripTags(e && e.data);
    send({ type: 'error', message: 'engine error: ' + text });
    if (isFatal(text)) markDead(text);
  };

  engine.onmessage = function (event) {
    var line = stripTags(event && event.data);
    if (!line) return;

    if (line.indexOf('uciok') === 0) {
      // Wait for readyok before declaring ready.
      engine.postMessage('isready');
      return;
    }
    if (line.indexOf('readyok') === 0) {
      if (!ready) {
        ready = true;
        send({ type: 'ready' });
        // flush anything queued before the engine came up (including commands
        // that arrived while a replacement engine was booting)
        var q = pending.concat(queued);
        pending = [];
        queued = [];
        for (var i = 0; i < q.length; i++) dispatch(q[i]);
      }
      return;
    }
    if (line.indexOf('bestmove') === 0) {
      // The search answered — disarm the watchdog BEFORE anything else, so a timer that was about
      // to fire on its last tick cannot rebuild a healthy engine.
      searchOutstanding = false;
      if (searchWatch) { clearTimeout(searchWatch); searchWatch = null; }
      var m = line.match(/bestmove\s+(\S+)/);
      var uci = m && m[1] !== '(none)' ? m[1] : null;
      // include the last info block so the caller gets eval + bestmove together
      send({ type: 'bestmove', uci: uci, info: lastInfo });
      lastInfo = null;
      return;
    }
    if (line.indexOf('info') === 0) {
      var info = parseInfo(line);
      if (info) {
        lastInfo = info;
        send(info);
      }
      return;
    }
  };
}

function dispatch(msg) {
  if (!engine) return;
  // A crash can surface as a `console.error` instead of an `onerror` event; if
  // the instance is already dead, don't pile more commands onto it.
  if (engine.__dead) {
    queued.push(msg);
    markDead('dead handle');
    return;
  }
  if (msg.cmd === 'stop') {
    engine.postMessage('stop');
    return;
  }
  if (msg.cmd === 'quit') {
    try { engine.postMessage('quit'); } catch (e) {}
    return;
  }
  if (msg.cmd === 'setoption') {
    engine.postMessage(msg.line);
    return;
  }
  if (msg.cmd === 'analyse' || msg.cmd === 'bestmove') {
    lastInfo = null;
    // A running search cannot be interrupted reliably (no virtual clock in this
    // build), so the host never overlaps searches. If one did somehow overlap,
    // the old search's `bestmove` would resolve the new waiter with a stale
    // move — the caller pairs one reply per call, so this ordering is assumed.
    // strength limiting (mirrors lib/engine.ts applyStrength)
    if (msg.elo === null || msg.elo === undefined) {
      engine.postMessage('setoption name UCI_LimitStrength value false');
    } else {
      engine.postMessage('setoption name UCI_LimitStrength value true');
      var elo = Math.max(1320, Math.min(2850, Math.round(msg.elo)));
      engine.postMessage('setoption name UCI_Elo value ' + elo);
    }
    engine.postMessage('position fen ' + msg.fen);
    if (msg.depth) {
      /*
       * A DEPTH SEARCH MAY ALSO CARRY A TIME CAP.
       *
       * UCI stops at whichever limit lands first, so `go depth N movetime M`
       * bounds a caller that budgets its searches one by one — the family check
       * in `gameOpenings.ts` does, because on the phone an unbounded depth-10
       * MultiPV-3 search turned "Checking our ideas here…" into minutes. A
       * request with NO `movetime` is depth-only exactly as before, so callers
       * that want the full search are untouched.
       */
      engine.postMessage(msg.movetime
        ? 'go depth ' + msg.depth + ' movetime ' + msg.movetime
        : 'go depth ' + msg.depth);
    } else {
      engine.postMessage('go movetime ' + (msg.movetime || 300));
    }
    /*
     * ARM THE WATCHDOG AT THE COMMANDED BUDGET, NOT A CONSTANT.
     *
     * The search was commanded `movetime` (300ms default when the line above fell back), plus the
     * host's own grace — armed any tighter it would fire on searches that are working exactly as
     * told.
     */
    searchOutstanding = true;
    if (searchWatch) clearTimeout(searchWatch);
    searchWatch = setTimeout(function () {
      searchWatch = null;
      if (!searchOutstanding) return;
      searchOutstanding = false;
      markDead('a search never answered');
    }, (msg.movetime || (msg.depth ? 0 : 300)) + SEARCH_NO_REPLY_GRACE_MS);
    return;
  }
}

window.onerror = function (message) {
  send({ type: 'error', message: 'window.onerror: ' + message });
  if (isFatal(message)) markDead(message);
};

document.addEventListener('message', function (e) {
  handleFromRN(e.data);
});
window.addEventListener('message', function (e) {
  handleFromRN(e.data);
});

function handleFromRN(raw) {
  var msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (msg.cmd === 'restart') {
    // The app decided the current engine is unusable (a stall, or a user pressed Retry) and asks
    // for a brand-new instance rather than for the old one to be talked back to health. If a boot
    // is already in flight, that boot IS the fresh instance the caller wants — let it land.
    if (booting) {
      send({ type: 'log', message: 'restart skipped - a boot is already in flight' });
      return;
    }
    markDead('restart requested by the app');
    return;
  }
  if (msg.cmd === 'init') {
    /*
     * NEVER ANSWER `ready` WITHOUT AN ENGINE.
     *
     * This used to be `if (initDone) { send ready }` — `initDone` was set on the FIRST init and
     * never cleared by a failed boot, so once `Stockfish()` threw, every later handshake was
     * answered with a lie. The app believed the engine was up, sent searches into a page with no
     * engine, and every one of them timed out: the "engine did not answer" stall, with nothing on
     * the app's side to report because nothing there had failed.
     *
     * The three states are distinguished now: READY answers honestly; a boot in flight stays
     * silent (`ready` follows when it lands); no engine rebuilds, or redoes the handshake in
     * place when an engine exists but lost it.
     */
    if (ready) {
      send({ type: 'ready' });
      return;
    }
    if (booting) return;
    if (engine) {
      engine.postMessage('uci');
      return;
    }
    boot();
    return;
  }
  if (!ready) {
    pending.push(msg);
    return;
  }
  dispatch(msg);
}
