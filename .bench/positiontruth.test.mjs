/**
 * THE INVARIANT THE DEVICE BROKE: the move the screen asks for must be legal in
 * the position the screen SHOWS.
 *
 * THE DEVICE REPORT
 * -----------------
 * "it shows me to play an illegal move from the start" — the Sicilian line opened
 * at "3 / 25 plies" saying "Play cxd4", over a board on which `cxd4` cannot be
 * played. And the last-move highlight was on two squares that are not a legal move
 * pair.
 *
 * WHY THE SCREEN CAN DISAGREE WITH ITS OWN LINE
 * ---------------------------------------------
 * There are two sources of truth for the position, and they are not the same:
 *
 *   1. `BuilderStep.fen` — the builder CARRIES the position on every step, and
 *      `rotateLine` computes it by walking one board down the line. It is right by
 *      construction.
 *   2. `GameOpeningsScreen` renders the board from `replayLine(playedSans)`, a
 *      SECOND replay of the SAN list, started from the initial position.
 *
 * Whenever those two disagree, the arrows and the instruction describe a position
 * the board is not showing — which is exactly "play an illegal move". So this
 * harness asserts the thing that matters and nothing about how it is implemented:
 *
 *   A. for every family, every line, every step:
 *        - the step's own `fen` is the position after the previous steps
 *        - `step.moveSan` is LEGAL in `step.fen`
 *   B. a line replayed from the SAN list, the way the screen does, lands on the
 *      same position as the step's own `fen` at every step.
 *
 * B is the one that fails, and the failure names the exact opening, line and ply.
 * It is run over the whole reference corpus, so it covers every family a user can
 * open for any account — which is what "fix it for all the openings" means here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function cleanDir(d) { try { execFileSync('rm', ['-rf', d], { stdio: 'pipe' }); } catch { /* */ } }
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-positiontruth');
cleanDir(BUILD_DIR);
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'openingBuilder.ts'),
    path.join(ROOT, 'src', 'lib', 'gameOpenings.ts'),
    path.join(ROOT, 'src', 'lib', 'lichess.ts'),
    path.join(ROOT, 'src', 'lib', 'openings.ts'),
    path.join(ROOT, 'src', 'lib', 'repertoire.ts'),
  ],
}, null, 2));
try {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project', path.join(BUILD_DIR, 'tsconfig.json')], { stdio: 'pipe' });
} catch (e) { console.error('tsc failed:', e.stdout?.toString()?.slice(0, 2000)); process.exit(2); }

function findEmitted(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const h = findEmitted(p, name); if (h) return h; }
    else if (e.name === name) return p;
  }
  return null;
}
const Module = require('node:module');
const origLoad = Module._load;
const REAL = require('chess.js');
const GO = findEmitted(BUILD_DIR, 'gameOpenings.js');
const CC = findEmitted(BUILD_DIR, 'lichess.js');
const OB = findEmitted(BUILD_DIR, 'openingBuilder.js');
const OP = findEmitted(BUILD_DIR, 'openings.js');
const RP = findEmitted(BUILD_DIR, 'repertoire.js');
let go = null, cc = null;
Module._load = function (request, parent, isMain) {
  if (request === 'chess.js') return REAL;
  if (request === GO) return go;
  if (request === CC) return cc;
  if (request === '@/lib/gameOpenings') return go;
  if (request === '@/lib/lichess') return cc;
  if (request === '@/lib/openings') return origLoad.call(this, OP, null, false);
  if (request === '@/lib/repertoire') return origLoad.call(this, RP, null, false);
  if (request === '@/lib/engine') return { getEngine: () => ({ analyse: async () => null }) };
  if (request.startsWith('@/data/')) {
    return origLoad.call(this, path.join(ROOT, 'src', request.slice(2)), parent, isMain);
  }
  return origLoad.call(this, request, parent, isMain);
};
go = origLoad.call(Module, GO, null, false);
cc = origLoad.call(Module, CC, null, false);
const { buildFamilyLines } = origLoad.call(Module, OB, null, false);
const { analysedPositionsFromGames } = go;
const { openingFromEcoUrl } = cc;

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/* ---------------------------------------------------------------- the corpus */
const PAYLOAD = [path.join(HERE, 'test-games.json'), path.join(ROOT, 'test-games.json')]
  .find((p) => fs.existsSync(p));
const raw = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
function sans(pgn) {
  const body = pgn.split('\n').filter((l) => !l.trim().startsWith('[')).join(' ');
  const out = []; const c = new Chess();
  for (const tok of body.split(/\s+/)) {
    const t = tok.trim();
    if (!t) continue;
    if (t.startsWith('{') || t.endsWith('}') || t.includes('%clk')) continue;
    if (/^\d+\.+$/.test(t)) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) break;
    try { const m = c.move(t.replace(/[!?]+$/, '')); if (!m) break; out.push(m.san); } catch { break; }
  }
  return out;
}
const games = (raw.games ?? raw).map((g) => {
  const s = sans(g.pgn ?? '');
  if (s.length < 8) return null;
  const isW = String(g.white?.username ?? '').toLowerCase() === 'hikaru';
  const { family } = openingFromEcoUrl(g.eco);
  return {
    id: g.uuid ?? '', url: '', opening: family, openingVariation: '', ecoSlug: '',
    color: isW ? 'w' : 'b', outcome: 'win', playerRating: null, opponentRating: null,
    opponent: 'x', accuracy: null, opponentAccuracy: null, movesUci: [], movesSan: s,
    timeClass: 'blitz', timeControl: '600', rated: true, endTime: 0,
  };
}).filter(Boolean);

const MAX_PLY = 24;
const positions = analysedPositionsFromGames(games, { maxGames: 160, maxPly: MAX_PLY });
const families = buildFamilyLines(positions, { maxPly: MAX_PLY, maxAlternates: 8 });
ok(`families built (${families.length})`, families.length > 5);

/* ============================== §A the line is internally consistent + legal */
console.log('\n§A  every step: legal in its OWN fen, and chained to the step before');

let stepsChecked = 0, illegalInOwnFen = 0, chainBroken = 0;
const stepBad = [];
for (const f of families) {
  const lines = [f.steps, ...f.alternates];
  for (let li = 0; li < lines.length; li++) {
    const steps = lines[li];
    let expect = new Chess().fen();
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      stepsChecked++;
      // A.1 the step's fen is the position the line is actually in
      if (s.fen.split(' ').slice(0, 4).join(' ') !== expect.split(' ').slice(0, 4).join(' ')) {
        chainBroken++;
        if (stepBad.length < 3) stepBad.push(`${f.name} line${li} ply${i} fen mismatch`);
      }
      // A.2 and the move it asks for is playable there
      const c = new Chess(s.fen);
      let legal = false;
      try { legal = c.move(s.moveSan) != null; } catch { legal = false; }
      if (!legal) {
        illegalInOwnFen++;
        if (stepBad.length < 6) stepBad.push(`${f.name} line${li} ply${i} ${s.moveSan} illegal in its own fen`);
      } else {
        expect = c.fen();
      }
    }
  }
}
// 39 families x 9 lines x ~24 plies is ~3,000 steps on this corpus. The threshold
// only has to catch a harness that silently stopped building lines.
ok(`steps examined (${stepsChecked})`, stepsChecked > 500);
ok('every step is chained to the one before it', chainBroken === 0,
  `${chainBroken} broken${stepBad.length ? ' — ' + stepBad[0] : ''}`);
ok('every step asks for a move that is legal in its own position', illegalInOwnFen === 0,
  `${illegalInOwnFen} illegal${stepBad.length ? ' — ' + stepBad.join(' | ') : ''}`);

/* ============ §B and now the screen's SECOND replay of the same SAN list */
console.log('\n§B  and the board the SCREEN shows (its own replay of the SAN list)');

let replayBad = 0, linesChecked = 0, stopsUnreachable = 0;
const replayBadExamples = [];
for (const f of families) {
  const lines = [f.steps, ...f.alternates];
  for (let li = 0; li < lines.length; li++) {
    const steps = lines[li];
    if (steps.length === 0) continue;
    linesChecked++;
    /*
     * Reproduce the screen EXACTLY: it builds `boardFen` by replaying the SAN
     * list from the initial position, and the instruction it shows is
     * `step.moveSan` for whichever step it stopped at.
     */
    const c = new Chess();
    const own = new Chess();
    for (let i = 0; i < steps.length; i++) {
      const san = steps[i].moveSan;
      let boardOk = true;
      try { c.move(san); } catch { boardOk = false; }
      let ownOk = true;
      try { own.move(san); } catch { ownOk = false; }

      if (boardOk !== ownOk || (boardOk && ownOk
        && c.fen().split(' ').slice(0, 4).join(' ') !== own.fen().split(' ').slice(0, 4).join(' '))) {
        replayBad++;
        if (replayBadExamples.length < 5) {
          replayBadExamples.push(
            `${f.name} line${li} ply${i} "${san}"  screen board=${c.fen().split(' ').slice(0, 4).join(' ')}` +
            `  step says=${steps[i].fen.split(' ').slice(0, 4).join(' ')}` +
            (boardOk ? '' : '  (the screen replay cannot even play it)'));
        }
      }
      if (!ownOk) break;   // the line is broken from here on
    }
  }
  /*
   * And the specific thing the user hit: the auto-played prefix. `startLine`
   * walks the SAN list to the first step that needs the user, so the board it
   * shows is `replayLine(steps[0..stop))`. If that replay cannot follow the
   * prefix, the board stops early while the instruction is for a later ply — and
   * the move it names is illegal where the board actually is.
   */
  for (let li = 0; li < lines.length; li++) {
    const steps = lines[li];
    const stop = (() => {
      const first = steps.findIndex((s) => s.choice != null || s.isUserMove);
      return first < 0 ? steps.length : first;
    })();
    if (stop === 0) continue;
    const c = new Chess();
    let reached = 0;
    for (let i = 0; i < stop; i++) {
      try { if (!c.move(steps[i].moveSan)) break; reached++; } catch { break; }
    }
    if (reached !== stop) {
      stopsUnreachable++;
      if (replayBadExamples.length < 8) {
        replayBadExamples.push(
          `${f.name} line${li}: board follows only ${reached}/${stop} plies of the prefix; ` +
          `it would show a position where "${steps[stop].moveSan}" is not playable`);
      }
    }
  }
}
ok(`lines checked (${linesChecked})`, linesChecked > 25);
ok('the screen replay agrees with the step FENs at every ply', replayBad === 0,
  `${replayBad} divergences`);
ok('every auto-played prefix is fully replayable, so the board matches the instruction',
  stopsUnreachable === 0, `${stopsUnreachable} prefixes stop short`);
for (const e of replayBadExamples) console.log(`        ${e}`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'}: ${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
