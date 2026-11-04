#!/usr/bin/env node
/**
 * BUILDS `.bench/harness.html` + `.bench/harness.wasm` - the page `engine.multipv.test.mjs` drives.
 *
 * WHY A BUILT PAGE AND NOT THE APP
 * ---------------------------------
 * The gate checks Stockfish's MultiPV for real: three distinct moves, ordered best-first, and a
 * MultiPV=3 search being brought back to 1 by the next dispatch. None of that is reachable by a stub,
 * and none of it is reachable through React Native's JS runtime either - which is why the app runs the
 * engine in a hidden WebView in the first place. So the gate drives a page, and this builds it.
 *
 * WHY THE WASM IS A SIBLING FILE
 * -----------------------------
 * The gate opens the page as file:// and Chrome refuses fetch() on that origin, including with
 * --allow-file-access-from-files. XMLHttpRequest is allowed there, so the 7 MB engine is written beside
 * the page and read with XHR - the same way the app reads it off the asset URI (EngineHost.readViaXhr).
 *
 * It was inlined as base64 first, which put a 9.5 MB string literal in the document. Chrome's parser sat
 * on it long enough that NO script on the page ran and CDP Runtime.evaluate could not execute either, so
 * the gate reported "engine never ready" from a page that was simply never alive. The document is now 22 KB.
 *
 * THE PROTOCOL is the app's own, from src/engine/stockfish-host.js:
 *   in  : { cmd: 'init' } | { cmd: 'setoption', line } | { cmd: 'analyse', fen, depth } | { cmd: 'stop' }
 *   out : { type: 'ready' } | { type: 'info', multipv, pvUci, scoreCp, mateIn, depth }
 *         | { type: 'bestmove', uci, info }
 * `out` is appended to window.__log as JSON strings, which is how the test polls for it.
 *
 * Usage: node scripts/build-engine-harness.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOADER = path.join(ROOT, 'assets', 'engine', 'stockfish-18-lite-single.js');
const WASM = path.join(ROOT, 'assets', 'engine', 'stockfish-18-lite-single.wasm');
const OUT = path.join(ROOT, '.bench', 'harness.html');
const WASM_OUT = path.join(ROOT, '.bench', 'harness.wasm');

for (const p of [LOADER, WASM]) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${path.relative(ROOT, p)} - run scripts/build-engine-assets.mjs first`);
    process.exit(2);
  }
}

const loader = fs.readFileSync(LOADER, 'utf8');
const wasm = fs.readFileSync(WASM);

/* -------------------------------------------------------------------------- */
/* the shim: engine host protocol -> window.__log                              */

const SHIM = `
(function () {
  'use strict';
  // Reuse the log the first script created - overwriting it would discard anything logged during load.
  var log = (window.__log = window.__log || []);

  function emit(o) { log.push(JSON.stringify(o)); }
  window.__sfLog = emit;

  var engine = null;
  var ready = false;
  var queued = [];
  var lastInfo = null;
  var currentFen = 'startpos';
  var lastPV = [];

  /*
   * UCI info LINES, PARSED THE WAY engine.ts READS THEM.
   *
   * The fields below are the ones the gate reads - multipv, pvUci, scoreCp, mateIn, depth - so this is
   * the host's parser rather than a second implementation of it. multipv defaults to 1 when a line
   * omits it, which is what the engine does for a single-PV search and what makes the reset check
   * meaningful: a search left at MultiPV=3 has to be pulled back to 1 by the next dispatch.
   */
  function parseInfo(line) {
    var t = line.trim().split(/\\s+/);
    if (t[0] !== 'info') return;
    var o = { type: 'info' };
    for (var i = 1; i < t.length; i++) {
      var k = t[i];
      if (k === 'depth') o.depth = parseInt(t[++i], 10);
      else if (k === 'multipv') o.multipv = parseInt(t[++i], 10);
      else if (k === 'nodes') o.nodes = parseInt(t[++i], 10);
      else if (k === 'nps') o.nps = parseInt(t[++i], 10);
      else if (k === 'time') o.time = parseInt(t[++i], 10);
      else if (k === 'pv') { o.pvUci = t.slice(i + 1); break; }
      else if (k === 'score') {
        if (t[i + 1] === 'cp') o.scoreCp = parseInt(t[i + 2], 10);
        else if (t[i + 1] === 'mate') o.mateIn = parseInt(t[i + 2], 10);
      }
    }
    if (o.multipv == null) o.multipv = 1;
    if (o.pvUci && o.pvUci.length) { o.bestMoveUci = o.pvUci[0]; lastPV = o.pvUci; lastInfo = o; }
    emit(o);
  }

  function wire(eng) {
    engine = eng;
    eng.onmessage = function (e) {
      var d = e.data;
      if (typeof d !== 'string') return;
      d.split('\\n').forEach(function (line) {
        line = line.trim();
        if (!line) return;
        if (line.indexOf('info ') === 0) parseInfo(line);
        else if (line.indexOf('bestmove ') === 0) {
          var rest = line.split(/\\s+/).slice(1);
          var uci = rest[0] && rest[0] !== '(none)' ? rest[0] : (lastPV[0] || null);
          emit({ type: 'bestmove', uci: uci, info: lastInfo || null });
          lastInfo = null; lastPV = [];
        } else if (line === 'uciok' || line.indexOf('readyok') === 0) {
          ready = true;
          emit({ type: 'ready' });
        }
      });
    };
    eng.onerror = function (e) { emit({ type: 'error', message: String(e && e.message || e) }); };
  }

  /*
   * THE WORKER-SHAPED API, lifted from EngineHost.tsx patchLoader().
   *
   * The loader is an Emscripten module, not a Worker: it has no postMessage. Commands go in through
   * ccall('command', ...) and output comes back through cfg.listener, so the Worker API the host expects
   * has to be BUILT. It is copied rather than reinvented because a second implementation of this would be
   * a second thing to get wrong, and because the app's version has already been debugged on a device.
   *
   * The queue is the part that is a correctness requirement and not a nicety. Stockfish prints from C++
   * while a command is still executing, and the host answers uciok by posting isready - dispatch that
   * straight back and you re-enter the engine command loop from inside its own output callback. Each
   * nested command re-emits uciok, which triggers another nested isready, and the JS stack overflows
   * within about a second. Everything is queued and drained from a timer, so a ccall never starts until
   * the previous one has fully unwound.
   */
  function patchLoader(bin) {
    var factory = window.__sfFactory;
    if (typeof factory !== 'function') {
      emit({ type: 'error', message: 'no Stockfish module factory exported by the loader' });
      return null;
    }
    var api = {
      onmessage: null,
      onerror: null,
      postMessage: function (cmd) { pending.push(cmd); schedule(); },
    };
    var pending = [];
    var flushTimer = null;
    var moduleReady = false;

    function schedule() { if (flushTimer === null) flushTimer = setTimeout(flushPending, 0); }

    function sendCommand(cmd) {
      var s = String(cmd);
      if (typeof cfg.processCommand === 'function') { cfg.processCommand(s); return true; }
      if (typeof cfg.ccall === 'function') {
        try {
          // async is false for every command: IS_ASYNCIFY is never defined in this single-threaded
          // build, so the loader passes false too.
          cfg.ccall('command', null, ['string'], [s], { async: false });
        } catch (err) {
          emit({ type: 'error', message: 'ccall failed for "' + s.slice(0, 40) + '": ' + (err && err.message) });
          return false;
        }
        return true;
      }
      return false;
    }

    function flushPending() {
      flushTimer = null;
      if (!moduleReady) { if (pending.length) schedule(); return; }
      // Mirror the loader's own guard: it waits for _isReady() before touching the engine.
      if (typeof cfg._isReady === 'function' && !cfg._isReady()) { if (pending.length) schedule(); return; }
      while (pending.length) {
        var cmd = pending.shift();
        if (!sendCommand(cmd)) { pending.unshift(cmd); schedule(); return; }
      }
    }

    var cfg = { wasmBinary: bin, locateFile: function () { return 'harness.wasm'; } };
    // Emscripten routes print/printErr to listener when it is set. cfg.print/printErr are assigned by the
    // loader itself and forward to listener, so they must NOT be overwritten.
    cfg.listener = function (line) {
      if (typeof api.onmessage === 'function') api.onmessage({ data: String(line) });
    };

    var created;
    try { created = factory(cfg); } catch (e) {
      emit({ type: 'error', message: 'Stockfish factory threw: ' + (e && e.message) });
      return api;
    }
    Promise.resolve(created).then(function () { moduleReady = true; flushPending(); })
      .catch(function (e) { emit({ type: 'error', message: 'engine init rejected: ' + (e && e.message) }); });
    return api;
  }

  function send(s) { if (engine) engine.postMessage(s); else queued.push(s); }

  function boot() {
    // The wasm comes off disk over XHR, so boot is asynchronous. Commands already queued are held by
    // patchLoader's own queue, so nothing is lost by starting a tick later than asked.
    window.__sfReadWasm().then(function (bin) {
      try {
        wire(patchLoader(bin));
        for (var i = 0; i < queued.length; i++) engine.postMessage(queued[i]);
        queued = [];
        engine.postMessage('uci');
      } catch (e) {
        emit({ type: 'error', message: 'boot: ' + (e && e.message) });
      }
    }).catch(function (e) {
      emit({ type: 'error', message: 'wasm read: ' + (e && e.message) });
    });
  }

  window.addEventListener('message', function (ev) {
    var raw = ev.data;
    if (typeof raw !== 'string') return;
    var m; try { m = JSON.parse(raw); } catch (e) { return; }
    handle(m);
  });

  emit({ type: 'log', message: 'shim installed' });

  /*
   * THE ENGINE BOOTS ITSELF, and that is deliberate.
   *
   * The gate opens the page, waits 1.2 s and dispatches {cmd:'init'}. On a cold profile the document is
   * still parsing at that point, so the command lands on a window with no listener and the engine is
   * never asked to boot - which the gate reports as "engine never ready", indistinguishable from an
   * engine that will not boot.
   *
   * Two things follow, and both are here: the early-command buffer in the first script catches a command
   * that arrives early, and the engine starts on load anyway so the poll finds ready whenever it looks.
   * Booting is idempotent, so a later init is a no-op rather than a second engine.
   *
   * The alternative was to lengthen the gate's wait, which means editing the thing under test to suit
   * the harness.
   */
  var booted = false;
  function bootOnce() { if (booted) return; booted = true; boot(); }

  var early = window.__earlyCmds || [];
  if (early.length) {
    emit({ type: 'log', message: 'replaying ' + early.length + ' command(s) dispatched before load' });
    for (var k = 0; k < early.length; k++) handle(early[k]);
  }
  setTimeout(bootOnce, 0);

  function handle(m) {
    if (!m || !m.cmd) return;
    if (m.cmd === 'init') bootOnce();
    else if (m.cmd === 'setoption') send(m.line);
    else if (m.cmd === 'analyse' || m.cmd === 'bestmove') {
      currentFen = m.fen || 'startpos';
      send('position ' + (currentFen === 'startpos' ? 'startpos' : 'fen ' + currentFen));
      /*
       * THE PRODUCTION DISPATCH, so the gate tests what ships.
       *
       * 'bestmove' is the command engine.ts sends when a depth is set. A depth search may also carry a
       * movetime hard cap (the family check in gameOpenings.ts lives on 'go depth N movetime M'),
       * and a movetime-only request is a plain 'go movetime M'. This used to be 'go depth (m.depth ||
       * 12)' for everything, which would have hidden a cap the production host ignores - the exact
       * class of mismatch this harness exists to catch.
       */
      send(m.depth
        ? 'go depth ' + m.depth + (m.movetime ? ' movetime ' + m.movetime : '')
        : 'go movetime ' + (m.movetime || 300));
    } else if (m.cmd === 'stop') send('stop');
    else if (m.cmd === 'quit') send('quit');
  }
})();
`;

/* -------------------------------------------------------------------------- */

const html = `<!doctype html>
<!-- GENERATED by scripts/build-engine-harness.mjs - do not edit; run the script. -->
<html>
<head><meta charset="utf-8"><title>Stockfish MultiPV harness</title></head>
<body>
<script>
/*
 * EARLY-COMMAND BUFFER - the first script on the page, before the loader is even parsed.
 *
 * See the note on self-booting, in the shim: the gate dispatches {cmd:'init'} 1.2 s after opening the
 * page, which on a cold profile is before this document has finished parsing. Anything sent then is
 * captured here and replayed once the shim installs, so no command is lost to a race with the parser.
 */
window.__earlyCmds = [];
// Created HERE as well as in the shim, and the shim must not replace it.
window.__log = window.__log || [];
window.addEventListener('message', function (ev) {
  if (typeof ev.data !== 'string') return;
  try { var m = JSON.parse(ev.data); } catch (e) { return; }
  if (m && m.cmd) window.__earlyCmds.push(m);
});
</script>
<script>
/*
 * THE WASM, READ FROM A SIBLING FILE WITH XHR.
 *
 * fetch() is refused on a file:// origin; XMLHttpRequest is permitted under
 * --allow-file-access-from-files, which the gate already passes. Inlining it as base64 was tried first
 * and put a 9.5 MB string literal in the document, which stalled the parser so badly that no script ran
 * and CDP could not evaluate anything.
 */
window.__sfReadWasm = function () {
  return new Promise(function (res, rej) {
    var x = new XMLHttpRequest();
    x.open('GET', 'harness.wasm', true);
    x.responseType = 'arraybuffer';
    x.onload = function () {
      if (x.status && x.status !== 200) { rej(new Error('HTTP ' + x.status)); return; }
      res(new Uint8Array(x.response));
    };
    x.onerror = function () { rej(new Error('xhr failed')); };
    x.send();
  });
};
</script>
<script>
/*
 * The Stockfish 18 lite Emscripten loader, UNMODIFIED, wrapped only to catch what it exports.
 *
 * It is a UMD expression statement - !function(){ ... module.exports = factory ... }(); As a bare
 * script the factory is written to nowhere and discarded, so there was nothing to call and the engine
 * never booted.
 *
 * The app solves it differently: EngineHost.tsx loads the loader into a <script id="sf-loader"> and reads
 * el._exports, which needs a real script tag with an id. Handing the loader a module/exports pair to write
 * into is the same capture without depending on that, and it takes the loader's OWN UMD branch rather
 * than guessing one: with both shimmed as objects the first branch wins and module.exports IS the factory.
 */
window.__sfFactory = (function () {
  var module = { exports: {} };
  var exports = module.exports;
  ${loader}
  return (typeof exports.Stockfish === 'function') ? exports.Stockfish : module.exports;
})();
</script>
<script>${SHIM}</script>
</body>
</html>
`;

fs.writeFileSync(OUT, html);
fs.writeFileSync(WASM_OUT, wasm);
console.log(`  wrote ${path.relative(ROOT, OUT)}  ${(html.length / 1024).toFixed(0)} KB`);
console.log(`  wrote ${path.relative(ROOT, WASM_OUT)}  ${(wasm.length / 1024 / 1024).toFixed(1)} MB, read by the page over XHR`);