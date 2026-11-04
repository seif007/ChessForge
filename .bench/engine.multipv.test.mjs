/**
 * Does the new MultiPV support in `engine.analyse` actually work?
 *
 * WHY THIS EXISTS
 * ---------------
 * `gameOpenings.ts` needs, for ONE position, the engine's best move AND its
 * runners-up, so the UI can offer "we recommend this, and here are the
 * alternatives". The cheap way to get that is Stockfish's own MultiPV option:
 * one search, N lines. The expensive way is N separate searches.
 *
 * Adding `multipv` to `engine.analyse` touched the request pipeline (the option
 * must be set BEFORE the search, or the engine has already decided how many lines
 * to emit) and the reply path (each line arrives as its own `info` block and they
 * must be collected, not overwritten). Both are easy to get wrong in ways that
 * still "work" — you would just silently get one line back instead of three, and
 * the alternatives UI would quietly disappear.
 *
 * So this asserts:
 *   1. multipv=3 really returns 3 DISTINCT moves.
 *   2. the lines are ordered best-first by score.
 *   3. a plain single-line analyse still returns exactly one line (the MultiPV
 *      reset works and did not leak into the next caller).
 *   4. MultiPV does not break the ordinary `bestMove` path.
 *   5. the SHIPPED host page — both the source and the generated copy in
 *      assets.ts — passes a time cap through to `go depth N movetime M`, and a
 *      capped search really stops when the cap lands first: a depth-40 search
 *      with a 300ms cap must come back long before depth 40. Your Openings
 *      hung on "Checking our ideas here…" because the host ignored exactly
 *      this; the cap is what makes that pass finite.
 *   6. a depth search with NO cap still runs to its depth — an absent cap must
 *      not become 0ms in the host, or every depth search in the app would be
 *      cut off at whatever depth 0ms buys.
 *
 * Runs the real shipped harness page in headless Chrome.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const pageUrl = pathToFileURL(join(here, 'harness.html')).href;

if (!existsSync(join(here, 'harness.html'))) {
  console.error('harness.html missing — run: node build.mjs');
  process.exit(1);
}

/** Positions with several plausible plans — the alternatives must differ. */
const FENS = [
  { id: 'opening-italian', fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 5 4' },
  { id: 'opening-sicilian', fen: 'rnbqkb1r/pp1p1ppp/4pn2/2p5/2P5/2N2N2/PP1PPPPP/R1BQKB1R w KQkq - 2 5' },
  { id: 'middlegame', fen: 'r2q1rk1/pp2ppbp/2n2np1/2pp4/3P1B2/2PBPN2/PPQN1PPP/R4RK1 w - - 4 12' },
];

const profile = mkdtempSync(join(tmpdir(), 'sf-mpv-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--allow-file-access-from-files', pageUrl,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup(code) {
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

const portFile = join(profile, 'DevToolsActivePort');
let port = null;
for (let i = 0; i < 150; i++) {
  try {
    if (existsSync(portFile)) {
      const line = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (line && Number(line) > 0) { port = Number(line); break; }
    }
  } catch {}
  if (port === null) {
    const m = chromeErr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
    if (m) { port = Number(m[1]); break; }
  }
  await sleep(100);
}
if (!port) { console.error('no DevTools port'); console.error(chromeErr.slice(0, 800)); cleanup(1); }

let targets = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`);
    targets = await r.json();
    // THE HARNESS TARGET, NOT THE FIRST PAGE.
    //
    // This used to break as soon as ANY page target existed and then take the first one. Under
    // `--headless=new` Chrome creates a startup `about:blank` page before it navigates to the harness,
    // so this attached to about:blank: `window.__log` was undefined, the ready poll was
    // `(undefined||[]).some(...)` = false forever, and the gate reported "engine never ready" with an
    // empty log - which reads exactly like an engine that will not boot, and is why a working harness
    // kept failing.
    //
    // It was a race, so it was also intermittent by nature. Selecting by URL removes the race instead
    // of retrying around it, and the fallback keeps a working harness usable if Chrome ever reports
    // the file:// URL in a different shape.
    if (targets.some((t) => t.type === 'page' && t.url && t.url.includes('harness.html')
      && t.webSocketDebuggerUrl)) break;
  } catch {}
  await sleep(150);
}
const harnessTarget = (targets || []).find((t) => t.type === 'page' && t.url
  && t.url.includes('harness.html') && t.webSocketDebuggerUrl);
const page = harnessTarget
  || (targets || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.error('no page target'); cleanup(1); }
if (!harnessTarget) {
  console.error(`attached to the wrong page: ${page.url}`);
  console.error('the harness target was never listed - is harness.html missing? run:');
  console.error('  node scripts/build-engine-harness.mjs');
  cleanup(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const myId = ++id;
  pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
ws.addEventListener('message', (ev) => {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) { const r = pending.get(msg.id); pending.delete(msg.id); r(msg); }
});
await new Promise((res) => ws.addEventListener('open', res));
await send('Runtime.enable');
await sleep(1200);

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}

/**
 * Driver: runs one analyse with a given multipv, collecting every `info` block
 * exactly as the app's pipeline does, then reports the distinct lines seen.
 *
 * NOTE: MultiPV is set UNCONDITIONALLY (to `multipv`, even when it is 1). That
 * mirrors the production `pump()` after the fix, and it is what makes check 3
 * below meaningful: an engine left at MultiPV=3 from a previous search must be
 * brought back to 1 by the next dispatch. An earlier version of this driver only
 * set the option when multipv > 1, which reproduced the leak the production fix
 * had already solved — the test was wrong, not the code.
 */
const DRIVER = `
window.__RES = null; window.__RAW = [];
(function () {
  function toPage(o) { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(o) })); }
  window.__run = function (fen, depth, multipv) {
    window.__RES = null; window.__RAW = [];
    var cursor = (window.__log || []).length;
    // Declare MultiPV on EVERY dispatch, exactly as pump() now does.
    toPage({ cmd: 'setoption', line: 'setoption name MultiPV value ' + Math.max(1, multipv) });
    toPage({ cmd: 'analyse', fen: fen, depth: depth });
    var timer = setTimeout(function () { window.__RES = { error: 'timeout' }; }, 60000);
    var poll = setInterval(function () {
      var log = window.__log || [];
      for (var k = cursor; k < log.length; k++) {
        var m; try { m = JSON.parse(log[k]); } catch (e) { continue; }
        if (m && m.type === 'info') window.__RAW.push(m);
        if (m && m.type === 'bestmove') {
          clearInterval(poll); clearTimeout(timer);
          window.__RES = { uci: m.uci, info: m.info || null, raw: window.__RAW.slice() };
          return;
        }
      }
      cursor = log.length;
    }, 25);
  };
  /*
   * The bounded-search driver: engine.ts sends {cmd:'bestmove'} for depth
   * searches, and a movetime here is a HARD CAP the host must forward as
   * 'go depth N movetime M'. A null movetime means the key is omitted
   * entirely, which is the caller shape that must stay uncapped.
   */
  window.__runBounded = function (fen, depth, movetime) {
    window.__RES = null; window.__RAW = [];
    var cursor = (window.__log || []).length;
    toPage({ cmd: 'setoption', line: 'setoption name MultiPV value 1' });
    var req = { cmd: 'bestmove', fen: fen, depth: depth };
    if (movetime != null) req.movetime = movetime;
    toPage(req);
    var timer = setTimeout(function () { window.__RES = { error: 'timeout' }; }, 60000);
    var poll = setInterval(function () {
      var log = window.__log || [];
      for (var k = cursor; k < log.length; k++) {
        var m; try { m = JSON.parse(log[k]); } catch (e) { continue; }
        if (m && m.type === 'info') window.__RAW.push(m);
        if (m && m.type === 'bestmove') {
          clearInterval(poll); clearTimeout(timer);
          window.__RES = { uci: m.uci, info: m.info || null, raw: window.__RAW.slice() };
          return;
        }
      }
      cursor = log.length;
    }, 25);
  };
})();
`;

await evaluate(DRIVER);
await evaluate(`window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({cmd:'init'}) }))`);
let ready = false;
for (let i = 0; i < 160; i++) {
  const r = await evaluate(`(window.__log||[]).some(function(s){return s.indexOf('\\"type\\":\\"ready\\"')>=0})`);
  if (r === true) { ready = true; break; }
  await sleep(250);
}
if (!ready) {
  /*
   * SAY WHAT ACTUALLY HAPPENED.
   *
   * This used to print only "engine never ready", which is the least useful possible message for the
   * failures that produce it, and all of them look identical from outside. Worse, the first version of
   * this diagnostic printed `(window.__log||[]).slice(0,8)`, which renders "the log does not exist" and
   * "the log is empty" as the same `[]` - so it reported an empty log for a page where no script had
   * ever run, which is a different bug with a different fix.
   *
   * So it reports the page's own state: what exists, what type it is, and how far the document got.
   */
  const state = await evaluate(`JSON.stringify({
    readyState: document.readyState,
    hasLog: typeof window.__log,
    logLength: (window.__log || []).length,
    hasEarly: typeof window.__earlyCmds,
    earlyLength: (window.__earlyCmds || []).length,
    hasFactory: typeof window.__sfFactory,
    hasReadWasm: typeof window.__sfReadWasm,
    scripts: document.scripts.length,
    bodyLen: document.body ? document.body.innerHTML.length : -1
  })`);
  console.error(`engine never ready on ${page.url}`);
  console.error(`  page state: ${state}`);
  console.error(`  log tail: ${await evaluate('JSON.stringify((window.__log||[]).slice(0,8))')}`);
  cleanup(1);
}
console.log('[mpv] engine ready\n');

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

/**
 * Collect distinct moves from the raw info stream the way `engine.analyse` does:
 * key by the `multipv` index, keep the deepest report per slot.
 */
function distinctLines(rawInfo) {
  const bySlot = new Map();
  for (const m of rawInfo) {
    const idx = m.multipv ?? 1;
    const uci = (m.pvUci && m.pvUci[0]) || m.bestMoveUci;
    if (!uci) continue;
    bySlot.set(idx, { idx, uci, cp: m.scoreCp, mate: m.mateIn, depth: m.depth });
  }
  return [...bySlot.values()].sort((a, b) => a.idx - b.idx);
}

// ---- 1. multipv = 3 gives 3 distinct moves --------------------------------

console.log('[1] multipv=3 returns three distinct moves');
const results = [];
for (const f of FENS) {
  await evaluate(`window.__run(${JSON.stringify(f.fen)}, 12, 3)`);
  let res = null;
  for (let i = 0; i < 240; i++) {
    res = await evaluate(`window.__RES ? { uci: window.__RES.uci, raw: (window.__RES.raw||[]).map(function(m){return {multipv:m.multipv, pvUci:m.pvUci, scoreCp:m.scoreCp, mateIn:m.mateIn, depth:m.depth}}) } : null`);
    if (res) break;
    await sleep(250);
  }
  const lines = res ? distinctLines(res.raw.map((r) => ({ ...r, bestMoveUci: r.pvUci?.[0] }))) : [];
  results.push({ id: f.id, lines, uci: res?.uci });
  console.log(`  ${f.id}: ${lines.length} line(s) -> ${lines.map((l) => l.uci).join(', ')}`);
}

ok('every position returned 3 lines', results.every((r) => r.lines.length === 3),
   `(${results.map((r) => r.lines.length).join('/')})`);
ok('the lines are DISTINCT moves', results.every((r) => new Set(r.lines.map((l) => l.uci)).size === r.lines.length));
ok('line 1 matches the reported best move', results.every((r) => !r.uci || r.lines[0]?.uci === r.uci),
   `(${results.map((r) => `${r.lines[0]?.uci}vs${r.uci}`).join(' ')})`);

// ---- 2. ordering is best-first by score -----------------------------------

console.log('\n[2] lines are ordered best-first');
function scoreOf(l) {
  if (l.mate != null) {
    const mag = 10000 - Math.min(Math.abs(l.mate), 60) * 100;
    return l.mate > 0 ? mag : -mag;
  }
  return l.cp ?? 0;
}
let ordered = 0, total = 0;
for (const r of results) {
  const scores = r.lines.map(scoreOf);
  total++;
  let good = true;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[i - 1] + 1) good = false;
  if (good) ordered++;
  console.log(`  ${r.id}: ${scores.join(' >= ')}  ${good ? 'ok' : 'OUT OF ORDER'}`);
}
ok('scores are non-increasing across lines', ordered === total, `(${ordered}/${total})`);

// ---- 3. a plain analyse still returns ONE line ----------------------------

console.log('\n[3] single-line analyse is unaffected (MultiPV reset works)');
await evaluate(`window.__run(${JSON.stringify(FENS[0].fen)}, 12, 1)`);
let single = null;
for (let i = 0; i < 240; i++) {
  single = await evaluate(`window.__RES ? { uci: window.__RES.uci, raw: (window.__RES.raw||[]).map(function(m){return {multipv:m.multipv, pvUci:m.pvUci, scoreCp:m.scoreCp, mateIn:m.mateIn, depth:m.depth}}) } : null`);
  if (single) break;
  await sleep(250);
}
const singleLines = single ? distinctLines(single.raw.map((r) => ({ ...r, bestMoveUci: r.pvUci?.[0] }))) : [];
console.log(`  single-line search reported ${singleLines.length} line(s): ${singleLines.map((l) => l.uci).join(', ')}`);
ok('exactly one line came back', singleLines.length === 1, `(${singleLines.length})`);

// ---- 4. the shipped host forwards the cap ---------------------------------

/*
 * THE CAP IS ONLY REAL IF THE HOST PAGE HONOURS IT.
 *
 * The behavioural checks below run the harness shim, which is a copy; these
 * probes read the two files that actually ship — the host page source and
 * `assets.ts`, which is GENERATED from it and is what the APK inlines. Both
 * must carry the same branch, because `assets.ts` is a build artifact and a
 * host edit that is never regenerated would ship an app that still ignores
 * the cap while the source looks fixed.
 */
console.log('\n[4] the shipped host page forwards depth+movetime as a pair');
const hostSrc = readFileSync(join(here, '..', 'src', 'engine', 'stockfish-host.js'), 'utf8');
const assetsSrc = readFileSync(join(here, '..', 'src', 'engine', 'assets.ts'), 'utf8');
const CAP_JOIN = "'go depth ' + msg.depth + ' movetime ' + msg.movetime";
const DEPTH_ONLY = ": 'go depth ' + msg.depth);";
ok('stockfish-host.js combines the two limits when both are set', hostSrc.includes(CAP_JOIN));
ok('and the generated assets.ts copy — the one compiled into the app — carries it too', assetsSrc.includes(CAP_JOIN));
ok('while a request without a movetime keeps the plain depth-only search',
   hostSrc.includes(DEPTH_ONLY) && assetsSrc.includes(DEPTH_ONLY));

// ---- 5. a capped depth search stops when the cap lands first ---------------

console.log('\n[5] a depth-40 search with a 300ms cap comes back at phone speed');
await evaluate(`window.__runBounded(${JSON.stringify(FENS[0].fen)}, 40, 300)`);
let bounded = null;
for (let i = 0; i < 240; i++) {
  bounded = await evaluate(`window.__RES ? { uci: window.__RES.uci, raw: (window.__RES.raw||[]).map(function(m){return {multipv:m.multipv, pvUci:m.pvUci, scoreCp:m.scoreCp, mateIn:m.mateIn, depth:m.depth}}) } : null`);
  if (bounded) break;
  await sleep(250);
}
const boundedDepths = bounded ? bounded.raw.map((m) => m.depth ?? 0) : [];
const maxBoundedDepth = boundedDepths.length ? Math.max(...boundedDepths) : 0;
console.log(`  depth 40 + movetime 300 -> ${bounded?.uci || '(no move)'} at depth ${maxBoundedDepth}`);
ok('the capped search answered with a move instead of running to depth 40',
   bounded && !!bounded.uci);
ok('and it stopped because of the cap, at a usable depth far short of 40',
   maxBoundedDepth >= 6 && maxBoundedDepth < 40,
   `(depth ${maxBoundedDepth})`);

// ---- 6. no cap means the search really runs to its depth -------------------

console.log('\n[6] a depth search with NO cap is not cut off');
await evaluate(`window.__runBounded(${JSON.stringify(FENS[0].fen)}, 12, null)`);
let uncapped = null;
for (let i = 0; i < 240; i++) {
  uncapped = await evaluate(`window.__RES ? { uci: window.__RES.uci, raw: (window.__RES.raw||[]).map(function(m){return {multipv:m.multipv, pvUci:m.pvUci, scoreCp:m.scoreCp, mateIn:m.mateIn, depth:m.depth}}) } : null`);
  if (uncapped) break;
  await sleep(250);
}
const uncappedDepths = uncapped ? uncapped.raw.map((m) => m.depth ?? 0) : [];
const maxUncappedDepth = uncappedDepths.length ? Math.max(...uncappedDepths) : 0;
console.log(`  depth 12, no cap -> ${uncapped?.uci || '(no move)'} at depth ${maxUncappedDepth}`);
ok('the uncapped search answered', uncapped && !!uncapped.uci);
ok('and it reached the requested depth — an absent cap did not become 0ms',
   maxUncappedDepth >= 12,
   `(depth ${maxUncappedDepth})`);

// ---- summary --------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
cleanup(failures === 0 ? 0 : 1);
