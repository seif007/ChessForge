/**
 * DOES "YOUR OPENINGS" BELONG TO THE ACCOUNT, OR ONLY TO THE ONE WE TESTED WITH?
 *
 * THE QUESTION
 * ------------
 * The owner's report after using the build: *"also check whether if we give a new
 * account that everything in 'your openings' works fine with new data (the user
 * gets his openings and suggestions on what to play etc) and that is not built
 * just for this account."*
 *
 * That is not answerable by reading the owner's own cache. It needs a DIFFERENT
 * account's real games run through the same pipeline, and it needs the engine
 * pass to produce a suggestion for a position that account actually reached.
 *
 * So this gate builds a second account from legal opening lines: many openings
 * the app does not ship, both colours, deep lines, and enough games to exercise
 * the same derivation the screen runs. It then runs the real family pass over
 * one of that account's out-of-book positions with a deterministic engine. The
 * corpus is generated locally, so the gate has no provider fixture to rot.
 *
 * WHAT IS ASSERTED
 * ----------------
 *   1. the families come from THAT account's games, not from a baked-in list;
 *   2. every card has a playable line, and known openings are named by the
 *      registry while unknown ones keep the account's own label;
 *   3. the engine-free book suggestions are legal moves in the position;
 *   4. the engine pass turns an out-of-book position into a real suggestion,
 *      with the played move still present for comparison;
 *   5. nothing is shared between accounts: every cache key is namespaced, and a
 *      switch clears the in-memory list.
 *
 * The engine is a stub because this is not a Stockfish speed test — it answers
 * with a LEGAL move computed from the position, so "the suggestion is real"
 * cannot pass by accident.
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
const SRC = path.join(ROOT, 'src');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-youropenings-newaccount');

let checks = 0, failures = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) { console.log('  PASS  ' + label); return; }
  failures++;
  console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : ''));
}

/* ------------------------------------------------------------------ compile */

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [
    path.join(SRC, 'lib', 'openings.ts'),
    path.join(SRC, 'lib', 'repertoire.ts'),
    path.join(SRC, 'lib', 'gameOpenings.ts'),
    path.join(SRC, 'lib', 'openingBuilder.ts'),
    path.join(SRC, 'lib', 'lichess.ts'),
  ],
}, null, 2));
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project',
    path.join(BUILD_DIR, 'tsconfig.json'),
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 4000));
  process.exit(2);
}

function findEmitted(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const h = findEmitted(p, name); if (h) return h; }
    else if (e.name === name) return p;
  }
  return null;
}
const J = (n) => findEmitted(BUILD_DIR, n + '.js');

/* --------------------------------------------------------------- engine stub */

const playedByFen = new Map();
function legalMove(fen, avoidUci = null) {
  const board = new Chess(fen);
  const moves = board.moves({ verbose: true });
  const picked = moves.find((m) => {
    const uci = m.from + m.to + (m.promotion ?? '');
    return uci !== avoidUci;
  }) ?? moves[0];
  if (!picked) return null;
  return picked.from + picked.to + (picked.promotion ?? '');
}
function uciToSan(fen, uci) {
  if (!uci) return null;
  try {
    const board = new Chess(fen);
    const m = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return m?.san ?? null;
  } catch { return null; }
}

let calls = [];
const engineStub = {
  analyse: async (fen, opts = {}) => {
    calls.push({ fen, depth: opts.depth, multipv: opts.multipv, movetime: opts.movetime });
    const uci = legalMove(fen, playedByFen.get(fen) ?? null);
    if (!uci) return null;
    return {
      bestMoveUci: uci, scoreCp: 24, mateIn: null, depth: opts.depth ?? 10,
      pvUci: [uci], lines: [{ uci, scoreCp: 24, mateIn: null, pvUci: [uci] }],
    };
  },
  bestMove: async () => null,
  restart: () => {},
};

/* ------------------------------------------------------------------- load */

const Module = require('node:module');
const origLoad = Module._load;
const REAL_CHESS = require('chess.js');
const stub = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : stub), apply: () => stub });
Module._load = function (request, parent, isMain) {
  if (request === 'chess.js') return REAL_CHESS;
  if (request === '@/lib/engine') return { getEngine: () => engineStub, uciToSan };
  const map = {
    '@/lib/repertoire': 'repertoire', '@/lib/openings': 'openings',
    '@/lib/gameOpenings': 'gameOpenings', '@/lib/openingBuilder': 'openingBuilder',
    '@/lib/lichess': 'lichess',
  };
  if (map[request]) return origLoad.call(this, J(map[request]), null, false);
  if (request.startsWith('@/data/')) return origLoad.call(this, path.join(SRC, request.slice(2)), parent, isMain);
  if (request.startsWith('@/')) return stub;
  return origLoad.call(this, request, parent, isMain);
};

const go = origLoad.call(Module, J('gameOpenings'), null, false);
const ob = origLoad.call(Module, J('openingBuilder'), null, false);
const openings = origLoad.call(Module, J('openings'), null, false);

/* ------------------------------------------------------- second-account data */

/*
 * A deterministic second account. Each opening is played once as White and
 * once as Black, three times over, so the corpus has both colours and enough
 * games for the same 160-game cap the screen uses. Two labels are deliberately
 * outside the shipped books: those are the hard case the card must preserve.
 */
const TRACKED = 'second-account';
const OPENING_GAMES = [
  ['Ruy Lopez', 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O'],
  ['Sicilian Defense', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7'],
  ['French Defense', 'e4 e6 d4 d5 Nc3 Nf6 e5 Nfd7 f4 c5 Nf3 Nc6 Be3 Be7 Qd2 O-O'],
  ['Caro-Kann Defense', 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7 h5 Bh7'],
  ["Queen's Gambit", 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6 cxd5 Nxd5'],
  ["King's Indian", 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7'],
  ['English Opening', 'c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O Be7 d3 O-O'],
  ['Dutch Defense', 'd4 f5 g3 Nf6 Bg2 e6 Nf3 Be7 O-O O-O c4 d6 Nc3 Qe8 Re1 Qg6'],
  ['Italian Game', 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O Re1 a6 Bb3 Ba7 Nbd2 Be6'],
  ['Scotch Game', 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Bc5 Be3 Qf6 c3 Nge7 Bc4 Ne5 Be2 Qg6'],
  ['Vienna Game', 'e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4 Nf3 Be7 d4 O-O Bd3 f5'],
  ['Alekhine Defense', 'e4 Nf6 e5 Nd5 d4 d6 Nf3 dxe5 Nxe5 c6 Be2 Be7 O-O O-O'],
  ['Pirc Defense', 'e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7 Be2 O-O O-O c6'],
  ['London System', 'd4 d5 Bf4 Nf6 e3 e6 Nf3 c5 c3 Nc6 Nbd2 Bd6 Bg3 O-O'],
  ['Catalan Opening', 'd4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O O-O dxc4 Qc2 a6'],
  ['Réti Opening', 'Nf3 d5 c4 e6 g3 Nf6 Bg2 Be7 O-O O-O b3 c5 Bb2 Nc6'],
  ['Trompowsky Attack', 'd4 Nf6 Bg5 e6 e4 h6 Bxf6 Qxf6 Nc3 d6 Qd2 g6'],
  ['Nimzo-Indian Defense', 'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5 O-O Nc6 a3 Bxc3 bxc3 dxc4'],
  ['Benoni Defense', 'd4 Nf6 c4 c5 d5 e6 Nc3 exd5 cxd5 d6 e4 g6 Nf3 Bg7 Be2 O-O'],
  ['Pterodactyl Defense', 'a3 e5 h3 d5 a4 Nf6 b3 Be7'],
  ['Zukertort Opening', 'h3 d5 h4 e5 d3 Nf6 Nd2 Be7'],
];

const games = [];
let gameNo = 0;
for (let rep = 0; rep < 3; rep++) {
  for (const [name, line] of OPENING_GAMES) {
    for (const color of ['w', 'b']) {
      gameNo++;
      games.push({
        id: `second-${gameNo}`,
        url: `https://lichess.org/second-${gameNo}`,
        opening: name,
        openingVariation: name,
        ecoSlug: '',
        color,
        outcome: 'draw',
        playerRating: null,
        opponentRating: null,
        opponent: 'Opponent',
        accuracy: null,
        opponentAccuracy: null,
        movesUci: [],
        movesSan: line.split(' '),
        timeClass: 'blitz',
        timeControl: '180+2',
        rated: true,
        endTime: 1_760_000_000 + gameNo,
      });
    }
  }
}

const kept = games
  .filter((g) => g.rated && g.timeClass !== 'bullet' && g.movesSan.length >= 6)
  .slice(0, 160);
const keptIds = new Set(kept.map((g) => g.id));

const cands = await go.deriveCandidatesAsync(kept, {
  limit: Number.MAX_SAFE_INTEGER, maxPly: 24, slice: 8,
});
const positions = go.analysedPositionsFromCandidates(cands);
const families = ob.buildFamilyLines(positions, { maxPly: 24, maxAlternates: 8 });

/* ------------------------------------------------------------- the assertions */

console.log('\n[1] the list is built from THIS account\'s games');
ok(games.length >= 120, 'the corpus is a full second account, not a handful of games',
  `(${games.length} games)`);
ok(kept.length >= 100, 'the same filter the screen uses keeps a full sample',
  `(${kept.length} kept)`);
ok(cands.length > 150, 'the derivation produces positions from them',
  `(${cands.length} positions)`);
ok(families.length >= 15, 'and those positions make a real opening list',
  `(${families.length} families)`);

const labels = new Set(families.flatMap((f) => f.sourceNames));
ok(labels.has('Pterodactyl Defense') && labels.has('Zukertort Opening'),
  'openings this account actually plays appear under their own labels',
  [...labels].slice(0, 8).join(', '));
ok(families.some((f) => f.side === 'w') && families.some((f) => f.side === 'b'),
  'both colours are represented, because the account played both');

console.log('\n[2] every card is playable and belongs to the account');
function lineReplays(steps) {
  const board = new Chess();
  for (const s of steps) {
    try {
      if (!board.move(s.moveSan)) return false;
    } catch { return false; }
  }
  return true;
}
let playable = 0, legalChoice = 0, namesConsistent = 0, idsConsistent = 0;
for (const f of families) {
  const lines = [f.steps, ...f.alternates].filter((l) => l.length >= 6);
  if (lines.length > 0 && lines.some(lineReplays)) playable++;
  for (const l of [f.steps, ...f.alternates]) {
    for (const s of l) {
      if (s.choice) {
        const board = new Chess(s.fen);
        try {
          if (board.move(s.choice.recommendSan)) legalChoice++;
        } catch { /* counted by the miss */ }
      }
    }
  }
  if (f.sourceNames.length > 0
    && f.positions.every((p) => f.sourceNames.includes(p.opening) || p.opening === 'Unknown opening')) {
    namesConsistent++;
  }
  if (f.positions.every((p) => keptIds.has(p.gameId))) idsConsistent++;
}
ok(playable === families.length, 'every family has at least one legal line of 6+ plies',
  `(${playable}/${families.length})`);
ok(namesConsistent === families.length,
  'no position from another opening was folded into a card',
  `(${namesConsistent}/${families.length})`);
ok(idsConsistent === families.length,
  'no position came from a game outside this account\'s list',
  `(${idsConsistent}/${families.length})`);
ok(legalChoice > 0,
  'the engine-free suggestions already on the cards are legal moves',
  `(${legalChoice} choices checked)`);

const known = families.filter((f) => f.openingId != null);
const unknown = families.filter((f) => f.openingId == null);
ok(known.length > 0, 'some of this account\'s openings are ones we ship',
  `(${known.length} known)`);
ok(unknown.length > 0, 'and some are new to us, which is the harder case',
  `(${unknown.length} new)`);
ok(known.every((f) => openings.OPENINGS.find((o) => o.id === f.openingId)?.name === f.name),
  'a known card is named by the registry, not by a hardcoded list');
ok(unknown.every((f) => f.sourceNames.length > 0 && f.name.length > 0),
  'a new opening keeps the account\'s own label instead of becoming "Unknown"');

console.log('\n[3] the engine pass suggests a move for a real new-account position');
function chosenLine(f) {
  if (f.steps.some((s) => s.choice != null)) return f.steps;
  const alt = f.alternates.find((a) => a.some((s) => s.choice != null));
  return alt ?? f.steps;
}
const byKey = new Map(cands.map((c) => [c.key, c]));
let target = null;
for (const f of families) {
  const line = chosenLine(f);
  const outOfBook = line
    .map((s) => (s.position ? byKey.get(s.position.key) : null))
    .filter((c) => c && !c.inBook && c.playedUci);
  if (outOfBook.length >= 4) { target = { family: f, cands: outOfBook.slice(0, 4) }; break; }
}
ok(target != null, 'an out-of-book line with real positions was found',
  target ? `${target.family.name} (${target.cands.length} positions)` : '(none)');

if (target) {
  for (const c of target.cands) playedByFen.set(c.fen, c.playedUci);
  calls = [];
  const analysed = await go.analyseFamily(target.cands, {
    depth: 10, multipv: 3, movetime: 450, probeMovetime: 200,
  });
  ok(analysed.length === target.cands.length,
    'every position on the line came back analysed',
    `(${analysed.length}/${target.cands.length})`);
  ok(analysed.every((p) => p.recommendUci && p.recommendUci !== p.playedUci),
    'every position has a suggestion that differs from what the user played',
    analysed.map((p) => `${p.playedSan}->${p.recommendSan}`).join(', '));
  let legalRec = 0;
  for (const p of analysed) {
    try {
      const board = new Chess(p.fen);
      if (p.recommendUci) {
        const m = board.move({
          from: p.recommendUci.slice(0, 2), to: p.recommendUci.slice(2, 4), promotion: p.recommendUci[4],
        });
        if (m) legalRec++;
      }
    } catch { /* counted by the miss */ }
  }
  ok(legalRec === analysed.length, 'and every suggestion is legal in its own position',
    `(${legalRec}/${analysed.length})`);
  ok(analysed.every((p) => p.options.some((o) => o.played)),
    'the move the user played is still present beside the suggestion');
  const mains = calls.filter((c) => c.multipv === 3);
  const probes = calls.filter((c) => c.multipv === 1);
  ok(mains.length === target.cands.length
    && mains.every((c) => c.movetime === 450),
    'the main searches use the screen\'s main budget',
    `(${mains.length} mains)`);
  ok(probes.length > 0 && probes.every((c) => c.movetime === 200),
    'and the played-move probes use the cheaper probe budget',
    `(${probes.length} probes)`);
}

console.log('\n[4] nothing is shared between accounts');
const STORE = fs.readFileSync(path.join(SRC, 'lib', 'lichessStore.ts'), 'utf8');
const SCREEN_SRC = fs.readFileSync(path.join(SRC, 'components', 'screens', 'GameOpeningsScreen.tsx'), 'utf8');
const keyFns = [
  ['OPENINGS_CACHE', /const OPENINGS_CACHE = \(u: string\) => `[^`]*\$\{u\.toLowerCase\(\)\}`/],
  ['POSITIONS_CACHE', /const POSITIONS_CACHE = \(u: string\) => `[^`]*\$\{u\.toLowerCase\(\)\}`/],
  ['VERDICTS_CACHE', /const VERDICTS_CACHE = \(u: string\) => `[^`]*\$\{u\.toLowerCase\(\)\}`/],
  ['GAMES_CACHE', /const GAMES_CACHE = \(u: string\) => `[^`]*\$\{u\.toLowerCase\(\)\}`/],
];
for (const [name, re] of keyFns) {
  ok(re.test(STORE), `${name} is namespaced by account`);
}
ok(/Storage\.removeItem\(OPENINGS_CACHE\(u\)\)/.test(STORE)
  && /Storage\.removeItem\(GAMES_CACHE\(u\)\)/.test(STORE),
  'switching away deletes the old account\'s openings and games');
ok(/const switched = previousUser != null && previousUser !== user;/.test(SCREEN_SRC)
  && /analysedRef\.current = new Map\(\);/.test(SCREEN_SRC)
  && /candsRef\.current = \[\];/.test(SCREEN_SRC),
  'the screen drops its in-memory list and verdicts when the account changes');
ok(/loadCachedPositions\(user\)/.test(SCREEN_SRC)
  && /fetchAllGames\(user, \{/.test(SCREEN_SRC)
  && /saveCachedPositions\(user, positions/.test(SCREEN_SRC)
  && /loadCachedOpenings\(user\)/.test(SCREEN_SRC)
  && /saveCachedOpenings\(user, result\.lines/.test(SCREEN_SRC),
  'every read and write in the builder is scoped to the active username');

/* ------------------------------------------------------------------- report */

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
process.exit(failures === 0 ? 0 : 1);
