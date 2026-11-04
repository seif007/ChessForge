/**
 * GATE 1p — a pending `init()` must ALWAYS end. The engine booting is allowed to fail; a caller
 * waiting on it forever is not.
 *
 * WHAT THIS EXISTS BECAUSE OF
 * ==========================
 * The report: *"still no progress"* — the progress row appears on the tap, exactly as asked, and
 * then sits on "Starting up…" for ever. No error. No log. The WebView at 0% CPU.
 *
 * The cause was a structural mistake in the boot-retry change, not a tuning mistake. The ONLY code
 * that could resolve `init()` lived inside the boot-retry timer — and that timer is state other
 * methods clear:
 *
 *   attach(host)   ->  cleared the timer on entry
 *                      then called postBoot(), which returns early when bootSent is already true
 *                      => nothing re-posted, nothing re-armed, and the sole exit was gone
 *
 *   destroy()      ->  nulled initResolve without calling it, after clearing the retry timer
 *                      => the promise the caller was already awaiting had no resolver left at all
 *
 * `onLoadEnd` is not once-per-host: React re-renders `EngineHost`, the WebView can reload, and
 * `ref.current` can be a fresh object for the same page. So `attach(host)` arriving a second time
 * while a boot is pending was not an edge case, it was the normal case.
 *
 * The rule this gate encodes: the exit from `init()` must not be reachable only through state that
 * something else owns. Hence an INDEPENDENT deadline in `init()`, and `settleInit` as the single
 * place a pending init is allowed to end.
 *
 * WHY THIS RUNS THE CODE INSTEAD OF MATCHING THE SOURCE
 * ======================================================
 * A regex can tell you `INIT_DEADLINE_MS` is spelled correctly. It cannot tell you that the promise
 * actually resolves, and the bug being guarded here is precisely a promise that never settles —
 * which is invisible to source matching, because every line of it looks individually reasonable.
 * `engine.ts` imports nothing but `chess.js`, so it transpiles and runs standalone.
 *
 * Every assertion below was checked to FAIL against the pre-fix source; see the notes on each.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/*
 * Overridable so the gate can be pointed at an older `engine.ts` to prove it is not decorative:
 *
 *   git show <bad-commit>:src/lib/engine.ts > %TEMP%\old.ts
 *   node .bench/engine.init.test.mjs %TEMP%\old.ts
 *
 * The transpiled module is always written next to this file, so `require('chess.js')` resolves
 * through the project's node_modules no matter where the source came from.
 */
const TARGET = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'src', 'lib', 'engine.ts');
const TEMP = join(HERE, '.engine-under-test.cjs');

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log('   PASS  ' + msg); }
  else { failures.push(msg); console.log('   FAIL  ' + msg); }
}
function head(t) {
  console.log('\n' + t);
  console.log('-'.repeat(t.length));
}

/* ---------------------------------------------------------------------------
 * Fake timers.
 *
 * `setTimeout` is captured off the global by the transpiled module at CALL time, so patching it here
 * — before anything constructs an engine — controls every timer the class arms: the boot retry, the
 * init deadline and the no-reply grace alike.
 * ------------------------------------------------------------------------- */
const realSetTimeout = globalThis.setTimeout;

let clock = 0;
let seq = 0;
const timers = new Map();

globalThis.setTimeout = (fn, ms) => {
  const id = ++seq;
  timers.set(id, { fn, at: clock + (Number(ms) || 0) });
  return id;
};
globalThis.clearTimeout = (id) => { timers.delete(id); };

/** Move the clock forward, firing everything due, in order, including newly armed timers. */
function advance(ms) {
  const target = clock + ms;
  for (;;) {
    let next = null;
    for (const [id, t] of timers) {
      if (t.at <= target && (next === null || t.at < next[1].at)) next = [id, t];
    }
    if (!next) break;
    clock = next[1].at;
    timers.delete(next[0]);
    next[1].fn();
  }
  clock = target;
}

/** Let queued microtasks (promise resolutions) run. */
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/**
 * Resolve to 'resolved' / 'pending', using REAL time so a stranded promise fails the test instead
 * of hanging the gate. A hanging gate is the one failure mode this whole file exists to catch, so
 * it must not be able to produce one.
 */
async function state(p) {
  const t = { done: false };
  p.then(() => { t.done = true; }, () => { t.done = true; });
  for (let i = 0; i < 5; i++) {
    await flush();
    if (t.done) return 'resolved';
    await new Promise((r) => realSetTimeout(r, 4));
  }
  return 'pending';
}

/* --------------------------------------------------------------------------- */
const src = readFileSync(TARGET, 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
writeFileSync(TEMP, js, 'utf8');

/** Engine chatter would bury the results. Captured for the whole run, printed only if asked. */
const seen = [];
const realWarn = console.warn;
const realError = console.error;
console.warn = (...a) => { seen.push(['warn', a.join(' ')]); };
console.error = (...a) => { seen.push(['error', a.join(' ')]); };

let ChessEngine;
try {
  ({ ChessEngine } = await import(`file:///${TEMP.replace(/\\/g, '/')}`));
} catch (err) {
  console.warn = realWarn;
  console.error = realError;
  console.error(`could not load ${TARGET}: ${err && err.message}`);
  process.exit(1);
}

/** A WebView stand-in that records what it was told. */
function fakeHost() {
  const posts = [];
  return {
    posts,
    handshakes: () => posts.filter((p) => JSON.parse(p).cmd === 'init').length,
    postMessage(s) { posts.push(s); },
  };
}

function track(p) {
  const t = { done: false };
  p.then(() => { t.done = true; }, () => { t.done = true; });
  return t;
}

/* ===========================================================================
 * 1. THE REGRESSION: a repeat attach must not strand a pending init.
 * ========================================================================== */
head('1. A REPEAT ATTACH MUST NOT KILL THE ONLY EXIT');
{
  const e = new ChessEngine();
  const t = track(e.init());          // tapped before the WebView existed
  const host = fakeHost();
  e.attach(host);                     // page loads -> handshake, retry armed
  e.attach(host);                     // ...and again, for the same page. This is the killer.

  advance(120_000);
  await flush();
  ok(t.done,
    'CONTROL: init() resolves even after attach(host) arrives twice for the same page '
    + '(pre-fix: the retry timer was cleared and never re-armed, so this promise never settled)');
  ok(e.isReady === false, 'and it settled by admitting the engine never became ready');
}

/* ===========================================================================
 * 2. init() owns a deadline that does not depend on the retry chain.
 * ========================================================================== */
head('2. init() HAS ITS OWN DEADLINE');
{
  const e = new ChessEngine();
  const t = track(e.init());          // no host EVER appears
  advance(24_000);
  await flush();
  ok(!t.done, '24s in, a host-less init is still waiting — the deadline is 25s, not instant');
  advance(2_000);
  await flush();
  ok(t.done, 'CONTROL: by 26s it has settled regardless (pre-fix: no deadline existed at all, so '
    + 'this awaited for ever)');
  ok(e.isReady === false, 'settled with ready=false, so callers can report the engine is missing');
}
{
  const e = new ChessEngine();
  const host = fakeHost();
  e.attach(host);
  const t = track(e.init());
  // Kill the retry chain the way the old `attach` did, WITHOUT letting it resolve anything.
  e.attach(null);
  advance(120_000);
  await flush();
  ok(t.done, 'CONTROL: detaching the host mid-boot still releases the caller');
}

/* ===========================================================================
 * 3. destroy() releases rather than orphans.
 * ========================================================================== */
head('3. destroy() MUST NOT ORPHAN A PENDING init()');
{
  const e = new ChessEngine();
  const host = fakeHost();
  e.attach(host);
  const t = track(e.init());
  e.destroy();
  await flush();
  ok(t.done,
    'CONTROL: destroy() while init() is pending resolves it (pre-fix it nulled initResolve and '
    + 'walked away, leaving the caller awaiting a promise with no resolver)');
  ok(e.isReady === false, 'and the engine is left not-ready');
}

/* ===========================================================================
 * 4. The retry chain still does its original job.
 * ========================================================================== */
head('4. THE RETRY CHAIN STILL RE-POSTS THE HANDSHAKE');
{
  const e = new ChessEngine();
  const host = fakeHost();
  e.attach(host);
  ok(host.handshakes() === 1, 'the first attach posts exactly one handshake');

  for (let n = 2; n <= 6; n++) {
    advance(6_000);
    await flush();
    ok(host.handshakes() === n, `it re-posts after a silent 6s (attempt ${n} of 6)`);
  }
  advance(60_000);
  await flush();
  ok(host.handshakes() === 6, 'and then STOPS at the budget instead of hammering the page for ever');
  ok(e.isReady === false, 'still not ready, and saying so rather than pretending');
}
{
  // A brand new page object has never been told to boot, and must not inherit the old budget.
  const e = new ChessEngine();
  const first = fakeHost();
  e.attach(first);
  advance(6_000 * 5);
  await flush();
  const second = fakeHost();
  e.attach(second);
  ok(second.handshakes() === 1,
    'CONTROL: a DIFFERENT host gets its own handshake rather than inheriting the previous '
    + "page's exhausted attempt count");
}

/* ===========================================================================
 * 5. A healthy boot is untouched.
 * ========================================================================== */
head('5. A HEALTHY BOOT STILL WORKS');
{
  const e = new ChessEngine();
  const host = fakeHost();
  e.attach(host);
  const t = track(e.init());
  e.handleMessage(JSON.stringify({ type: 'ready' }));
  await flush();
  ok(t.done && e.isReady, 'a `ready` from the page settles init with the engine usable');
  advance(120_000);
  await flush();
  ok(host.handshakes() === 1, 'and the retry chain is disarmed — no further handshakes');
  ok(e.init() !== undefined, 'init() after ready is a resolved no-op, not a new wait');
}

/* ===========================================================================
 * 6. The engine page's own diagnostics are readable again.
 * ========================================================================== */
head('6. PAGE DIAGNOSTICS REACH LOGCAT IN A RELEASE BUILD');
{
  const e = new ChessEngine();
  const host = fakeHost();
  e.attach(host);
  e.handleMessage(JSON.stringify({ type: 'log', message: 'wasm ready: 7295411 bytes' }));
  ok(seen.some(([lvl, m]) => lvl === 'warn' && m.includes('7295411')),
    "CONTROL: the page's `log` is emitted as console.warn, because console.log is stripped from a "
    + 'release bundle and every engine diagnostic was therefore invisible in the build that ships');
}

/* ===========================================================================
 * 7. THE REQUEST PAYLOAD CARRIES THE SEARCH BUDGET — AND NEVER INVENTS ONE.
 * ========================================================================== */
head('7. A DEPTH SEARCH TRAVELS WITHOUT AN INVENTED TIME CAP');
{
  /*
   * The host now understands `movetime` alongside `depth` (`go depth N movetime
   * M`, stops at whichever lands first), which is how the Your-Openings family
   * check got bounded. That makes the PAYLOAD the contract: a depth search that
   * quietly carried the old 300ms default would be cut to 300ms on the phone —
   * a silent quality regression across every depth caller in the app — and a
   * depth search with NO movetime whose safety timer read `undefined` would arm
   * `NaN` (fires at once) and return a null eval before the engine could answer.
   * Both failures are invisible without this probe.
   */
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  /** A ready engine with a recording host, freshly booted so requests never supersede each other. */
  const boot = async () => {
    const e = new ChessEngine();
    const host = fakeHost();
    e.attach(host);
    e.handleMessage(JSON.stringify({ type: 'ready' }));
    await flush();
    return { e, host };
  };

  /** The last analyse/bestmove dispatch the engine posted. */
  const lastDispatch = (host) => {
    for (let i = host.posts.length - 1; i >= 0; i--) {
      const m = JSON.parse(host.posts[i]);
      if (m.cmd === 'analyse' || m.cmd === 'bestmove') return m;
    }
    return null;
  };

  {
    const { e, host } = await boot();
    const p = e.analyse(START_FEN, { movetime: 500 });
    await flush();
    const d = lastDispatch(host);
    ok(d && d.cmd === 'analyse' && d.movetime === 500 && d.depth === undefined,
      'a plain analysis carries its movetime and no depth', JSON.stringify(d));
    advance(8_100);
    await flush();
    ok(await state(p) === 'pending',
      'CONTROL: its 500ms + 8s budget is still open at 8.1s — the grace is added, not replaced');
    advance(600);
    await flush();
    ok(await state(p) === 'resolved', 'and it settles one grace later');
  }

  {
    const { e, host } = await boot();
    const p = e.analyse(START_FEN, { depth: 10 });
    await flush();
    const d = lastDispatch(host);
    ok(d && d.cmd === 'bestmove' && d.depth === 10 && !('movetime' in d),
      'a depth search travels with NO movetime key at all — the old 300ms default is gone', JSON.stringify(d));
    /*
     * Tick the clock BEFORE looking. A timer armed with a NaN delay (`undefined + grace` is NaN, and
     * `setTimeout(fn, NaN)` fires at once) only proves itself when the clock moves, so the 100ms tick
     * is what makes this probe catch the NaN budget instead of politely waiting for a timer that
     * already believes it is due.
     */
    advance(100);
    await flush();
    ok(await state(p) === 'pending',
      'the clock ticked and its safety timer did not fire — no NaN budget, the search is still waiting');
    advance(8_100);
    await flush();
    ok(await state(p) === 'resolved',
      'its valve fires at 0ms + 8s of grace, so a dead host cannot hold it for ever');
  }

  {
    const { e, host } = await boot();
    const p = e.analyse(START_FEN, { depth: 10, movetime: 800 });
    await flush();
    const d = lastDispatch(host);
    ok(d && d.cmd === 'bestmove' && d.depth === 10 && d.movetime === 800,
      'and a bounded depth search — the family check\'s shape — carries both limits', JSON.stringify(d));
    advance(8_100);
    await flush();
    ok(await state(p) === 'pending', 'its budget is 800ms + 8s, so 8.1s has not settled it');
    advance(900);
    await flush();
    ok(await state(p) === 'resolved', 'and it settles inside its own budget');
  }
}

/* --------------------------------------------------------------------------- */
console.warn = realWarn;
console.error = realError;

console.log('\n' + '-'.repeat(60));
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log('  x ' + f);
} else {
  console.log(`${passed}/${passed} passed   (${TARGET})`);
}

if (seen.length && process.env.TRACE) {
  console.log('\n(engine output during the run)');
  for (const [lvl, m] of seen) console.log(`  ${lvl}: ${m}`);
}

try { unlinkSync(TEMP); } catch { /* best effort */ }

process.exit(failures.length ? 1 : 0);
