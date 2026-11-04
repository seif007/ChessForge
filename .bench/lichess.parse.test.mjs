/**
 * THE LICHESS PARSER: one NDJSON stream becomes games the app can trust.
 *
 * This gate imports the shipped client rather than copying its parser. It
 * exercises the parts that decide whether a game is usable: the standard
 * variant, a real result, both players, a legal mainline, the tracked player's
 * colour, the opening family, and the app's time classes.
 *
 * Run: node .bench/lichess.parse.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-lichess-parse');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2021', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'lichess.ts'),
    path.join(ROOT, 'src', 'lib', 'openings.ts'),
    path.join(ROOT, 'src', 'lib', 'repertoire.ts'),
  ],
}, null, 2));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project',
    path.join(BUILD_DIR, 'tsconfig.json'),
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 2500));
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

const Module = require('node:module');
const origLoad = Module._load;
const REAL_CHESS = require('chess.js');
Module._load = function (request, parent, isMain) {
  if (request === 'chess.js') return REAL_CHESS;
  if (request === '@/lib/openings') {
    return origLoad.call(this, findEmitted(BUILD_DIR, 'openings.js'), null, false);
  }
  if (request === '@/lib/repertoire') {
    return origLoad.call(this, findEmitted(BUILD_DIR, 'repertoire.js'), null, false);
  }
  if (request.startsWith('@/data/')) {
    return origLoad.call(this, path.join(ROOT, 'src', request.slice(2)), parent, isMain);
  }
  return origLoad.call(this, request, parent, isMain);
};

const client = origLoad.call(Module, findEmitted(BUILD_DIR, 'lichess.js'), null, false);
const { fetchAllGames, fetchProfile, sanitizeLichessUser, USER_AGENT } = client;

let checks = 0, failures = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

const MAINLINE = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7';
const at = (iso) => Date.parse(iso + 'T12:00:00Z');

function raw(over = {}) {
  const white = 'white' in over ? over.white : 'Hikaru';
  const black = 'black' in over ? over.black : 'Foe';
  return {
    id: over.id ?? 'g1',
    rated: over.rated ?? true,
    variant: over.variant ?? 'standard',
    speed: over.speed ?? 'blitz',
    perf: over.speed ?? 'blitz',
    status: over.status ?? 'resign',
    createdAt: at('2026-10-01'),
    lastMoveAt: at('2026-10-02'),
    players: {
      white: { user: white ? { name: white } : null, rating: over.whiteRating ?? 2400 },
      black: { user: black ? { name: black } : null, rating: over.blackRating ?? 2350 },
    },
    ...(over.winner === null ? {} : { winner: over.winner ?? 'white' }),
    opening: over.opening ?? { eco: 'C60', name: 'Ruy Lopez', ply: 10 },
    moves: over.moves ?? MAINLINE,
    clock: { initial: 180, increment: 2 },
    ...over,
  };
}

const calls = [];
let route = () => null;
const json = (obj, status = 200) => ({
  ok: status < 400, status, headers: { get: () => null },
  text: async () => JSON.stringify(obj),
});
const ndjson = (lines) => ({
  ok: true, status: 200, headers: { get: () => null },
  text: async () => lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'),
});
globalThis.fetch = async (input, init) => {
  calls.push({ url: String(input), headers: init?.headers ?? {} });
  return route(String(input)) ?? json({ error: 'not found' }, 404);
};

const profile = {
  id: 'hikaru', username: 'Hikaru', createdAt: at('2010-01-01'),
  perfs: {
    bullet: { rating: 3200 }, blitz: { rating: 3300 }, rapid: { rating: 3150 },
    classical: { rating: 3000 }, correspondence: { rating: 2900 },
  },
  profile: { fideRating: 2780 },
};

console.log('\n1. profile');
route = (url) => (url.endsWith('/api/user/hikaru') ? json(profile) : null);
calls.length = 0;
const me = await fetchProfile(sanitizeLichessUser('@Hikaru'));
ok(me.username === 'Hikaru', 'the display handle is kept');
ok(me.ratings.blitz === 3300 && me.ratings.rapid === 3150,
  'the current ratings are read');
ok(me.ratings.daily === 3000, 'classical is mapped into the daily slot');
ok(me.ratings.fide === 2780, 'the FIDE rating is read when present');
ok(me.joined === at('2010-01-01'), 'the join date is read');
ok(sanitizeLichessUser('https://lichess.org/@/Hikaru/') === 'hikaru',
  'a profile URL is accepted as a username');

console.log('\n2. one NDJSON read');
route = (url) => {
  if (url.includes('/api/games/user/hikaru')) {
    return ndjson([
      raw({ id: 'g1', winner: 'white', whiteRating: 2400, blackRating: 2350 }),
      raw({ id: 'g2', color: 'b', black: 'Hikaru', white: 'Foe', winner: 'black' }),
      raw({ id: 'aborted', status: 'aborted' }),
      raw({ id: 'variant', variant: 'chess960' }),
      raw({ id: 'engine', black: null }),
      raw({ id: 'nomoves', moves: '' }),
      '{ this line is not JSON',
      raw({
        id: 'classical', speed: 'classical',
        opening: { eco: 'D30', name: 'Queen\'s Gambit Declined' },
        moves: 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O',
      }),
      raw({
        id: 'correspondence', speed: 'correspondence',
        opening: { eco: 'C50', name: 'Italian Game: Giuoco Piano' },
        moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6',
      }),
    ]);
  }
  return null;
};
calls.length = 0;
const games = await fetchAllGames('Hikaru', { maxGames: 100 });
ok(games.length === 4, `four usable games survive the stream (${games.length})`, games.map((g) => g.id).join(','));
ok(!games.some((g) => g.id === 'aborted'), 'an aborted seek is not a game');
ok(!games.some((g) => g.id === 'variant'), 'a non-standard variant is not imported');
ok(!games.some((g) => g.id === 'engine'), 'an engine opponent is not a public account game');
ok(!games.some((g) => g.id === 'nomoves'), 'a game with no moves is a stub');
ok(games.some((g) => g.id === 'g1') && games.some((g) => g.id === 'g2'),
  'a broken line does not discard the games around it');

const one = games.find((g) => g.id === 'g1');
ok(one.color === 'w' && one.outcome === 'win', 'colour and result are from the tracked player');
ok(one.playerRating === 2400 && one.opponentRating === 2350, 'ratings are from the tracked player');
ok(one.opponent === 'Foe' && one.url === 'https://lichess.org/g1', 'the opponent and game URL are kept');
ok(one.accuracy === null && one.opponentAccuracy === null,
  'Lichess does not publish accuracy, so it stays null rather than becoming 0');
ok(one.movesSan.join(' ') === MAINLINE, 'the SAN mainline is replayed');
ok(one.movesUci.length === 10 && one.movesUci[0] === 'e2e4',
  'the same line is available as UCI for the engine');
ok(one.timeClass === 'blitz' && one.timeControl === '180+2', 'the time class and control are read');
ok(one.endTime === Math.floor(at('2026-10-02') / 1000), 'the end time is unix seconds');
ok(one.opening === 'Ruy Lopez', 'the opening family comes from the book');

const black = games.find((g) => g.id === 'g2');
ok(black.color === 'b' && black.outcome === 'win', 'a Black win is a win for the tracked player');
ok(black.opponent === 'Foe', 'the opponent is the other side');
ok(games.find((g) => g.id === 'classical')?.timeClass === 'daily',
  'classical is grouped into daily');
ok(games.find((g) => g.id === 'correspondence')?.timeClass === 'daily',
  'correspondence is grouped into daily');
ok(games.find((g) => g.id === 'classical')?.opening === "Queen's Gambit",
  'a Lichess opening name becomes the app family');
const italian = games.find((g) => g.id === 'correspondence');
ok(italian?.opening === 'Italian Opening',
  'the family is the app registry name, not the full variation',
  `${italian?.opening} / ${italian?.openingVariation}`);

const request = calls.find((c) => c.url.includes('/api/games/user/hikaru'));
ok(!!request, 'the games request happened');
ok(request.headers.Accept === 'application/x-ndjson', 'the NDJSON media type is requested');
ok(request.headers['User-Agent'] === USER_AGENT && /ChessForge/.test(USER_AGENT),
  'the client identifies itself with the app name');
ok(request.url.includes('max=100') && request.url.includes('rated=true'),
  'the cap and rated filter are sent to Lichess', request.url);
ok(request.url.includes('moves=true') && request.url.includes('opening=true'),
  'moves and opening labels are requested', request.url);

console.log('\n3. the cap and the abort');
calls.length = 0;
route = (url) => (url.includes('/api/games/user/hikaru')
  ? ndjson([raw({ id: 'g1' })])
  : null);
const capped = await fetchAllGames('Hikaru', { maxGames: 7 });
ok(capped.length === 1, 'a short response is returned whole');
ok(calls[0].url.includes('max=7'), 'the cap is on the request even when fewer games come back');

const ctrl = new AbortController();
ctrl.abort();
let aborted = null;
try { await fetchAllGames('Hikaru', { signal: ctrl.signal }); } catch (e) { aborted = e; }
ok(aborted && aborted.kind === 'aborted', 'an aborted fetch reports cancellation', aborted?.message);

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
