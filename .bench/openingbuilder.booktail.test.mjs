/**
 * Does the course actually reach the END of a line, and does it say where the
 * second half came from?
 *
 * WHY THIS EXISTS
 * ---------------
 * The user reported, twice, that the course stops short: "it doesn't complete
 * the line, i just played one move and that's it". A line built purely from the
 * user's own games is a SAMPLE, and a thin one — measured on the reference
 * corpus most families' lines die inside the opening because no single game of
 * his continued in that exact move order. We ship 30-ply studies for those
 * openings, and the ask was explicit:
 *
 *   "you can refer to what we have in the openings studies also in 'your
 *    openings', so the user get trained on his repertoire and ours (in the
 *    course also not just in training)"
 *
 * So `withBookTail` appends the book's remainder and tags each appended step
 * with `fromStudy`. Three things have to hold, and each one fails in a way that
 * would look fine on screen:
 *
 *   1. **It actually fires.** If the book lookup never hits, the feature is
 *      dead code and the line is as short as it was — the original complaint.
 *   2. **The appended moves are LEGAL and CONTIGUOUS.** They are replayed onto
 *      the line's own last FEN; a book continuation from anywhere but that
 *      position would put a move on the board that does not follow, or corrupt
 *      the FEN the board renders.
 *   3. **Provenance is honest.** The tail must be tagged and the head must NOT
 *      be: the whole point is that the user can tell "this is what I play" from
 *      "this is what ChessForge teaches". Tagging the user's own moves as ours would
 *      be worse than not labelling at all.
 *
 * Usage: node .bench/openingbuilder.booktail.test.mjs
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

function cleanDir(dir) {
  try { execFileSync('rm', ['-rf', dir], { stdio: 'pipe' }); } catch { /* best effort */ }
}

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

/* ------------------------------------------------------------------ compile */

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-booktail');
cleanDir(BUILD_DIR);
fs.mkdirSync(BUILD_DIR, { recursive: true });

const CONFIG = path.join(BUILD_DIR, 'tsconfig.json');
fs.writeFileSync(CONFIG, JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
    esModuleInterop: true,
  },
  include: [path.join(ROOT, 'src').replace(/\\/g, '/') + '/**/*.ts'],
  exclude: [BUILD_DIR.replace(/\\/g, '/')],
}, null, 2));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', CONFIG,
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 1500));
  process.exit(2);
}

const Module = require('node:module');
const origResolve = Module._resolveFilename;
const OUT = path.join(BUILD_DIR, 'src');
Module._resolveFilename = function (request, parent, isMain, options) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    const rel = request.slice(2);
    if (rel.endsWith('.json')) return path.join(ROOT, 'src', rel);
    return path.join(OUT, rel + '.js');
  }
  return origResolve.call(this, request, parent, isMain, options);
};

const { buildFamilyLines, continueFromBook } = require(path.join(OUT, 'lib', 'openingBuilder.js'));
const { analysedPositionsFromGames } = require(path.join(OUT, 'lib', 'gameOpenings.js'));
const { openingFromEcoUrl } = require(path.join(OUT, 'lib', 'lichess.js'));

/* ------------------------------------------------------------------ corpus */

const PAYLOAD = [
  path.join(HERE, 'test-games.json'),
  path.join(ROOT, 'test-games.json'),
].find((p) => fs.existsSync(p));
if (!PAYLOAD) { console.error('missing test-games.json'); process.exit(2); }

function mainlineSans(pgn) {
  const body = pgn.split('\n').filter((l) => !l.trim().startsWith('[')).join(' ');
  const sans = []; const c = new Chess();
  for (const tok of body.split(/\s+/)) {
    const t = tok.trim();
    if (!t) continue;
    if (t.startsWith('{') || t.endsWith('}') || t.includes('%clk')) continue;
    if (/^\d+\.+$/.test(t)) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) break;
    const clean = t.replace(/[!?]+$/, '');
    if (!clean) continue;
    try { const m = c.move(clean); if (!m) break; sans.push(m.san); } catch { break; }
  }
  return sans;
}

const raw = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
const games = (raw.games ?? raw).map((g, i) => {
  const sans = mainlineSans(g.pgn || '');
  if (sans.length < 8) return null;
  const isW = String(g.white?.username ?? '').toLowerCase() === 'hikaru';
  const { family, name } = openingFromEcoUrl(g.eco);
  return {
    id: g.uuid ?? 'g' + i, url: '', opening: family, openingVariation: name, ecoSlug: '',
    color: isW ? 'w' : 'b', outcome: 'win', playerRating: null, opponentRating: null,
    opponent: 'x', accuracy: null, opponentAccuracy: null, movesUci: [], movesSan: sans,
    timeClass: 'blitz', timeControl: '600', rated: true, endTime: 0,
  };
}).filter(Boolean);

const positions = analysedPositionsFromGames(games, { maxGames: 160, maxPly: 24 });
const families = buildFamilyLines(positions, { maxPerFamily: 24, maxAlternates: 8 });
console.log(`\ncorpus: ${games.length} games · ${positions.length} positions · ${families.length} families`);

/* --------------------------------------------------- [0] the lookup itself */

console.log('\n[0] the book lookup answers for a real line');

// A line the shipped book definitely contains: the Sicilian's 1.e4 c5 stem.
const probe = continueFromBook(['e4', 'c5']);
ok('book continues 1.e4 c5', probe != null && probe.moves.length > 0,
  probe ? `study="${probe.studyTitle}" next=${probe.moves.slice(0, 4).join(' ')}` : 'null');

// A position no book can be in: White has just been checkmated (1.f3 e5 2.g4 Qh4#).
// Whatever the lookup returns, it must not throw and must not invent a move.
let nonsenseOk = true;
let nonsense = null;
try { nonsense = continueFromBook(['f3', 'e5', 'g4', 'Qh4#']); } catch { nonsenseOk = false; }
ok('book lookup survives a finished game', nonsenseOk && (nonsense == null || nonsense.moves.length > 0),
  nonsense ? `returned ${nonsense.moves.length} moves` : 'null');

/* -------------------------------------------- [1] tails fire, and are legal */

console.log('\n[1] the book tail fires, and every appended move is legal on the board');

let lines = 0, withTail = 0, badTail = 0, badHead = 0, tailPlies = 0;
let longestBefore = 0, longestWith = 0;
const studyNames = new Set();
const badSamples = [];

for (const f of families) {
  for (const steps of [f.steps, ...f.alternates]) {
    if (steps.length === 0) continue;
    lines++;

    const tagged = steps.filter((s) => s.fromStudy);
    if (tagged.length === 0) {
      longestBefore = Math.max(longestBefore, steps.length);
      continue;
    }
    withTail++;
    tailPlies += tagged.length;
    for (const s of tagged) studyNames.add(s.fromStudy);
    longestWith = Math.max(longestWith, steps.length);

    /*
     * The tail must be a CONTIGUOUS run at the END. A tagged step in the middle
     * would mean the book was spliced into the user's own play, which would
     * misattribute a move he actually made.
     */
    const firstTag = steps.findIndex((s) => s.fromStudy);
    if (steps.slice(firstTag).some((s) => !s.fromStudy)) badTail++;
    if (steps.slice(0, firstTag).some((s) => s.fromStudy)) badHead++;

    /*
     * Replay the whole line and check it never breaks. `steps[i].fen` is the
     * position BEFORE the move, so the move at i must be legal there and must
     * lead to `steps[i+1].fen`. That is exactly what `boardFen` does at runtime.
     */
    let fen = new Chess().fen();
    let firstBad = -1;
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].fen !== fen) { firstBad = i; break; }
      const c = new Chess(fen);
      let m = null;
      try { m = c.move(steps[i].moveSan); } catch { m = null; }
      if (!m) { firstBad = i; break; }
      fen = c.fen();
    }
    if (firstBad >= 0) {
      badTail++;
      if (badSamples.length < 3) {
        badSamples.push({ name: f.name, side: f.side, i: firstBad, moves: steps.map((s) => s.moveSan) });
      }
    }
  }
}

/*
 * HOW MANY LINES SHOULD GET A TAIL?
 *
 * Not "most", and fixing a number here would be a lie in either direction. The
 * tail only exists when the book genuinely continues from the line's OWN end
 * position; a line that transposes into a structure our studies reach by another
 * move order has no honest continuation, and pad with a guess is exactly what we
 * refuse. So the assertion is on the two things that must hold — it fires on a
 * meaningful share of lines, and every append is legal — not on a percentage
 * that would drift as the corpus changes.
 */
ok('the book tails a meaningful share of lines', withTail >= 24,
  `${withTail}/${lines} lines (${Math.round(100 * withTail / lines)}%)`);
ok('every appended move is legal where it is played', badTail === 0, `${badTail} bad`);
ok('no user ply is mislabelled as book', badHead === 0, `${badHead} bad`);
ok('tails come from named shipped studies', studyNames.size > 0,
  `${studyNames.size} studies: ${[...studyNames].slice(0, 3).join(', ')}`);

for (const b of badSamples) {
  console.log(`       BAD ${b.name} [${b.side}] broke at ply ${b.i}`);
  console.log(`           ${b.moves.join(' ')}`);
}

console.log(`       lines ${lines} · with tail ${withTail} · appended plies ${tailPlies}`);
console.log(`       longest line before ${longestBefore} plies · after ${longestWith} plies`);

/* ------------------------------------------------ [2] honesty + no duplication */

console.log('\n[2] the tail does not duplicate the join');

let dupJoin = 0;
for (const f of families) {
  for (const steps of [f.steps, ...f.alternates]) {
    const firstTag = steps.findIndex((s) => s.fromStudy);
    if (firstTag <= 0) continue;
    if (steps[firstTag].moveSan === steps[firstTag - 1].moveSan) dupJoin++;
  }
}
ok('the join move is not repeated', dupJoin === 0, `${dupJoin} duplicated`);

/* ---------------------------------------------------- [3] it is bounded */

console.log('\n[3] a tail cannot run away');

// The book is 30 plies; with a 24-ply spine cap a tail can push a line long but
// must stay finite and playable. Anything past a few hundred plies means the
// append looped.
let absurd = 0;
for (const f of families) {
  for (const steps of [f.steps, ...f.alternates]) {
    if (steps.length > 200) absurd++;
  }
}
ok('no line is absurdly long', absurd === 0, `${absurd} over 200 plies`);

/* --------------------------------------------------------------- verdict */

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILED'}  (${checks - failures}/${checks})`);
process.exit(failures === 0 ? 0 : 1);
