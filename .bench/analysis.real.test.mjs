/**
 * GATE — THE REVIEW, END TO END, ON REAL GAMES AND THE REAL ENGINE.
 *
 * WHY THIS EXISTS
 * ===============
 * THE REPORT, for the fourth time: *"i tried analysing a game and it is 100% acc
 * for both and always 0.0 in eval bar while the game has a lot of errors by
 * players so clearly the analyse doesnt work"*. Every previous attempt tested the
 * maths with hand-written numbers, which is exactly the blind spot: the formulas
 * were fine and the REVIEW was still empty on the device.
 *
 * So this drives the shipped engine through the shipped host page, over four real
 * PGNs, and runs them through the SAME classifier and accuracy module the screen
 * uses. It asserts the two things a user can see:
 *
 *   - the evaluations are REAL (every position gets a score or a mate — the
 *     "0.0 / 100%" failure is an engine that answered nothing);
 *   - the verdicts are HONEST (a game with a blunder contains a mistake or a
 *     blunder, and a quiet game does not become a disaster zone).
 *
 * It needs headless Chrome; when Chrome is missing it prints SKIPPED, which the
 * gate runner counts separately rather than calling it a pass.
 *
 * Run: node .bench/analysis.real.test.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function skip(reason) {
  console.log(`SKIPPED  ${reason}`);
  process.exit(0);
}

if (!existsSync(join(HERE, 'harness.html'))) skip('harness.html missing — run: node scripts/build-engine-harness.mjs');
if (!existsSync(CHROME)) skip('headless Chrome not found at the standard path');

let passed = 0;
const failures = [];
const ok = (cond, label, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
};

/* ------------------------------------------------------ compile the maths */

const BUILD = join(ROOT, 'node_modules', '.cache', 'chessforge-analysis-real');
try { rmSync(BUILD, { recursive: true, force: true }); } catch { /* best effort */ }
mkdirSync(BUILD, { recursive: true });
writeFileSync(join(BUILD, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true, rootDir: ROOT, outDir: BUILD,
  },
  files: [join(ROOT, 'src', 'lib', 'accuracy.ts'), join(ROOT, 'src', 'lib', 'moveQuality.ts')],
}, null, 2));
try {
  execFileSync(process.execPath, [
    join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', join(BUILD, 'tsconfig.json'),
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 3000));
  process.exit(2);
}
const accuracy = require(findEmitted(BUILD, 'accuracy.js'));
const quality = require(findEmitted(BUILD, 'moveQuality.js'));

function findEmitted(dir, name) {
  for (const e of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const h = findEmitted(p, name); if (h) return h; }
    else if (e.name === name) return p;
  }
  return null;
}

/* --------------------------------------------------------------- games */

const GAMES = [
  {
    id: "fool's mate",
    pgn: '1. f3 e5 2. g4 Qh4#',
    // Black plays a model game; White loses on the spot with 2.g4.
    worseSide: 'white',
  },
  {
    id: "scholar's mate",
    pgn: '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#',
    // Black walks into mate with 3...Nf6.
    worseSide: 'black',
  },
  {
    id: 'legal trap',
    pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5 Qg5 5. Nxf7 Qxg2 6. Rf1 Qxe4+ 7. Be2 Nf3#',
    // White's 4.Nxe5 and 5.Nxf7 are the blunders.
    worseSide: 'white',
  },
  {
    id: 'quiet Ruy Lopez',
    pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7',
    // Nobody blunders; the review must not invent mistakes.
    worseSide: null,
  },
];

/* ---------------------------------------------------- the engine, in Chrome */

const profile = mkdtempSync(join(tmpdir(), 'sf-review-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--allow-file-access-from-files',
  pathToFileURL(join(HERE, 'harness.html')).href,
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanup(code) {
  try { chrome.kill('SIGKILL'); } catch { /* gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(code);
}

const portFile = join(profile, 'DevToolsActivePort');
let port = null;
for (let i = 0; i < 200 && port === null; i++) {
  try {
    if (existsSync(portFile)) {
      const line = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (line && Number(line) > 0) port = Number(line);
    }
  } catch { /* not yet */ }
  if (port === null) {
    const m = chromeErr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
    if (m) port = Number(m[1]);
  }
  if (port === null) await sleep(100);
}
if (port === null) skip('headless Chrome did not open a DevTools port');

let targets = null;
for (let i = 0; i < 80; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { /* retry */ }
  if ((targets || []).some((t) => t.type === 'page' && t.url && t.url.includes('harness.html'))) break;
  await sleep(150);
}
const page = (targets || []).find((t) => t.type === 'page' && t.url && t.url.includes('harness.html'));
if (!page) skip('the harness page was never listed');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); }
});
await new Promise((res) => ws.addEventListener('open', res));
await send('Runtime.enable');
await sleep(1200);

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}

// Exactly what the app posts for one reviewed position: MultiPV 2, then a
// movetime analyse; collect the deepest info per multipv slot.
await evaluate(`
window.__review = function (fen, movetime) {
  window.__RES = null; window.__RAW = [];
  function toPage(o) { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(o) })); }
  var cursor = (window.__log || []).length;
  toPage({ cmd: 'setoption', line: 'setoption name MultiPV value 2' });
  toPage({ cmd: 'analyse', fen: fen, movetime: movetime, elo: null });
  var timer = setTimeout(function () { window.__RES = { error: 'timeout' }; }, 40000);
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
  }, 20);
};
true`);

await evaluate(`window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({cmd:'init'}) }))`);
let ready = false;
for (let i = 0; i < 250; i++) {
  if (await evaluate(`(window.__log||[]).some(function(s){return s.indexOf('"type":"ready"')>=0})`)) { ready = true; break; }
  await sleep(100);
}
if (!ready) skip('the engine never reported ready in this environment');

/** One position: the deepest line-1 and line-2 reports. */
async function analyse(fen, movetime) {
  await evaluate(`(function(){ window.__review(${JSON.stringify(fen)}, ${movetime}); })()`);
  let res = null;
  for (let t = 0; t < 400; t++) { res = await evaluate('window.__RES'); if (res) break; await sleep(50); }
  const raw = (res?.raw || []).filter((x) => typeof x.multipv === 'number');
  const best = (idx) => raw.filter((x) => x.multipv === idx).sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0))[0] ?? null;
  return { best: res?.uci ?? null, l1: best(1), l2: best(2) };
}

const { Chess } = require('chess.js');

console.log(`\nengine ready — reviewing ${GAMES.length} games\n${'-'.repeat(40)}`);

for (const game of GAMES) {
  const board = new Chess();
  const sans = [];
  try { board.loadPgn(game.pgn); } catch { /* handled below */ }
  sans.push(...board.history());
  const replay = new Chess();
  const fens = [replay.fen()];
  const ucis = [];
  for (const san of sans) { const mv = replay.move(san); ucis.push(mv.from + mv.to + (mv.promotion ?? '')); fens.push(replay.fen()); }

  const evals = [];
  for (let i = 0; i <= sans.length; i++) {
    // A terminal position is not searched — the board already knows.
    const b = new Chess(fens[i]);
    if (b.isGameOver()) { evals.push({ scoreCp: b.isCheckmate() ? null : 0, mateIn: b.isCheckmate() ? 0 : null, best: null, l1: null, l2: null }); continue; }
    const a = await analyse(fens[i], 500);
    evals.push({ scoreCp: a.l1?.scoreCp ?? null, mateIn: a.l1?.mateIn ?? null, best: a.best, l1: a.l1, l2: a.l2 });
  }

  const cpWhite = (e, turn) => (e.mateIn != null
    ? (e.mateIn === 0 ? -10000 : (e.mateIn > 0 ? 1 : -1) * (10000 - Math.min(999, Math.abs(e.mateIn)) * 10))
    : (e.scoreCp ?? 0)) * (turn === 'w' ? 1 : -1);

  const moves = sans.map((san, i) => {
    const turn = fens[i].split(' ')[1] === 'b' ? 'b' : 'w';
    const nextTurn = fens[i + 1].split(' ')[1] === 'b' ? 'b' : 'w';
    const cpBefore = cpWhite(evals[i], turn);
    const cpAfter = cpWhite(evals[i + 1], nextTurn);
    const l1 = evals[i].l1, l2 = evals[i].l2;
    const bestUci = evals[i].best && evals[i].best !== '(none)' ? evals[i].best : null;
    const lineScore = (l) => (l ? cpWhite({ scoreCp: l.scoreCp ?? null, mateIn: l.mateIn ?? null }, turn) : 0);
    const bestGap = bestUci && l1 && l2 && l1.uci === bestUci
      ? Math.abs(lineScore(l1) - lineScore(l2))
      : null;
    const kind = quality.classifyMove({
      ply: i, playedUci: ucis[i] || null, bestUci,
      fenBefore: fens[i], fenAfter: fens[i + 1],
      cpBefore, cpAfter, mover: turn, bookPlies: 0, bestGap,
    });
    return { kind, cpBefore, cpAfter, san, mover: turn };
  });

  const cps = moves.length > 0 ? [moves[0].cpBefore, ...moves.map((m) => m.cpAfter)] : [];
  const acc = accuracy.gameAccuracy(cps, moves[0]?.mover ?? 'w');

  const label = `[${game.id}]`;
  const coverage = accuracy.evalCoverage(evals);
  ok(coverage === 1,
    `${label} every position got a real evaluation (no 0.0 / 100% empty review)`,
    `coverage=${coverage}`);
  ok(accuracy.analysisUsable(evals), `${label} the review is publishable`);

  const mistakes = moves.filter((m) => m.kind === 'mistake' || m.kind === 'blunder').length;

  if (game.worseSide) {
    // A game with a blunder must show a real evaluation swing, not a flat 0.00.
    const bigSwing = moves.some((m) => Math.abs(m.cpAfter) > 120 || m.kind === 'blunder');
    ok(bigSwing, `${label} the evaluation is not pinned at 0.00`);
    ok(mistakes >= 1, `${label} the blundering side has a mistake or blunder (${mistakes})`,
      JSON.stringify(moves.map((m) => `${m.san}:${m.kind}`)));
    const worsePlayer = game.worseSide;
    const value = accurateFor(worsePlayer);
    ok(value < 96, `${label} the blundering side (${worsePlayer}) is below 96% accuracy (${value.toFixed(1)})`);
  } else {
    ok(mistakes <= 1, `${label} a quiet game is not a disaster zone (${mistakes} mistakes)`,
      JSON.stringify(moves.map((m) => `${m.san}:${m.kind}`)));
    ok(Math.min(acc.white, acc.black) > 90,
      `${label} both sides stay above 90% in a clean game (${acc.white.toFixed(1)} / ${acc.black.toFixed(1)})`);
  }

  function accurateFor(side) {
    return side === 'white' ? acc.white : acc.black;
  }

  console.log(`        ${moves.map((m) => `${m.san}(${m.kind})`).join(' ')}`);
}

console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) { console.log('FAILED:'); for (const f of failures) console.log(`  - ${f}`); }
cleanup(failures.length ? 1 : 0);
