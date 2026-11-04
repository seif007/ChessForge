/**
 * LICHESS API MANNERS: one request at a time, no silent 429 retry, and honest
 * errors when the network or the server fails.
 *
 * The parser gate covers what a game means. This one covers how the client
 * behaves while asking for it, because a public API is a shared resource:
 * retrying a rate limit makes the next import worse for every user.
 *
 * Run: node .bench/lichess.fetch.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-lichess-fetch');

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
const {
  fetchAllGames, fetchProfile, clearGameCache, LichessError,
  sanitizeLichessUser, lichessAccountError,
  USER_AGENT, MAX_GAMES,
} = client;

let checks = 0, failures = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

const MAINLINE = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7';
const rawGame = (id = 'g1') => ({
  id, rated: true, variant: 'standard', speed: 'blitz', perf: 'blitz', status: 'resign',
  createdAt: Date.parse('2026-10-01T12:00:00Z'), lastMoveAt: Date.parse('2026-10-02T12:00:00Z'),
  players: {
    white: { user: { name: 'Hikaru' }, rating: 2400 },
    black: { user: { name: 'Foe' }, rating: 2350 },
  },
  winner: 'white',
  opening: { eco: 'C60', name: 'Ruy Lopez', ply: 10 },
  moves: MAINLINE,
  clock: { initial: 180, increment: 2 },
});

const calls = [];
let route = () => null;
const headers = { get: () => null };
const response = (body, status = 200) => ({
  ok: status < 400, status, headers,
  text: async () => body,
});
globalThis.fetch = async (input, init) => {
  calls.push({ url: String(input), headers: init?.headers ?? {} });
  if (init?.signal?.aborted) throw new Error('aborted');
  return route(String(input)) ?? response('', 404);
};

const profile = {
  id: 'hikaru', username: 'Hikaru', createdAt: 0,
  perfs: { blitz: { rating: 3300 } },
};
const gamesBody = [rawGame('g1'), rawGame('g2')].map(JSON.stringify).join('\n');
const profileBody = JSON.stringify(profile);

console.log('\n1. the request is one request, and it says who is asking');
route = (url) => (url.endsWith('/api/user/hikaru') ? response(profileBody) : response(gamesBody));
calls.length = 0;
const profileResult = await fetchProfile('hikaru');
const games = await fetchAllGames('hikaru', { maxGames: 2 });
ok(profileResult.username === 'Hikaru' && profileResult.ratings.blitz === 3300,
  'the profile is read');
ok(games.length === 2, 'the games are read');
ok(calls.length === 2, 'one profile request and one games request, not one per game', String(calls.length));
ok(calls.every((c) => c.headers['User-Agent'] === USER_AGENT),
  'every request carries the identifying User-Agent');
ok(calls[1].headers.Accept === 'application/x-ndjson', 'games ask for NDJSON');
ok(calls[0].headers.Accept === 'application/json', 'the profile asks for JSON');
ok(/ChessForge/.test(USER_AGENT) && /Android/.test(USER_AGENT),
  'the User-Agent names the app and platform, without a personal contact', USER_AGENT);
ok(!/@|mailto:/.test(USER_AGENT),
  'the User-Agent carries no email address', USER_AGENT);

console.log('\n2. a 429 is a stop sign, not a retry loop');
route = () => response('', 429);
calls.length = 0;
let limited = null;
try { await fetchAllGames('hikaru'); } catch (e) { limited = e; }
ok(limited instanceof LichessError && limited.kind === 'rate-limit',
  'the caller can tell a rate limit from a network failure', limited?.kind);
ok(/rate-limiting/.test(limited?.message) && /minute|seconds/.test(limited?.message),
  'the message tells the user to wait', limited?.message);
ok(calls.length === 1, 'the 429 is not retried automatically', String(calls.length));

console.log('\n3. a server error is retried, a client error is not');
let serverFailures = 2;
route = (url) => {
  if (url.includes('/api/games/user/hikaru') && serverFailures-- > 0) return response('', 503);
  return response(gamesBody);
};
calls.length = 0;
const recovered = await fetchAllGames('hikaru', { maxGames: 2 });
ok(recovered.length === 2, 'a transient 503 is survived');
ok(calls.length === 3, 'the failed request is retried twice, then succeeds', String(calls.length));

route = () => response('', 404);
calls.length = 0;
let missing = null;
try { await fetchProfile('nobody'); } catch (e) { missing = e; }
ok(missing instanceof LichessError && missing.kind === 'not-found',
  'a 404 is a missing account, not a retryable outage', missing?.kind);
ok(calls.length === 1, 'a 404 is not retried', String(calls.length));

console.log('\n4. network failures are bounded and named');
route = () => { throw new Error('offline'); };
calls.length = 0;
let offline = null;
try { await fetchAllGames('hikaru'); } catch (e) { offline = e; }
ok(offline instanceof LichessError && offline.kind === 'network',
  'a dead network is a network error', offline?.kind);
ok(/Could not reach Lichess/.test(offline?.message), 'the message is in words a person wrote');
ok(calls.length === 3, 'three attempts, not an infinite retry', String(calls.length));

console.log('\n5. malformed data is an error, not an empty success');
route = () => response('{ not json');
calls.length = 0;
let malformed = null;
try { await fetchProfile('hikaru'); } catch (e) { malformed = e; }
ok(malformed instanceof LichessError && malformed.kind === 'parse',
  'unreadable profile JSON is a parse error', malformed?.kind);

route = () => response('{"id":123}');
let badProfile = null;
try { await fetchProfile('hikaru'); } catch (e) { badProfile = e; }
ok(badProfile instanceof LichessError && badProfile.kind === 'not-found',
  'a profile without an id is not a usable account', badProfile?.kind);

console.log('\n6. query parameters are explicit');
route = (url) => (url.includes('/api/games/user/hikaru') ? response(gamesBody) : response('', 404));
calls.length = 0;
await fetchAllGames('hikaru', {
  maxGames: 12, perfType: 'rapid', rated: false, since: 1_700_000_000, until: 1_800_000_000,
});
const q = decodeURIComponent(calls[0].url);
ok(q.includes('max=12'), 'the cap is sent', q);
ok(q.includes('perfType=rapid'), 'the perf filter is sent', q);
ok(!q.includes('rated=true'), 'casual games are requested when rated is false', q);
ok(q.includes('since=1700000000000') && q.includes('until=1800000000000'),
  'second timestamps become milliseconds for Lichess', q);
ok(q.includes('sort=dateDesc'), 'newest first is explicit', q);
ok(MAX_GAMES === 4000, 'the app-wide hard cap is still 4000 games', String(MAX_GAMES));

console.log('\n7. progress and cancellation');
const progress = [];
route = (url) => (url.includes('/api/games/user/hikaru') ? response(gamesBody) : response(profileBody));
await fetchAllGames('hikaru', { onProgress: (p) => progress.push(p), maxGames: 2 });
ok(progress.length > 0 && /Reading your Lichess games/.test(progress[0].phase),
  'the first report says what is being read', JSON.stringify(progress[0]));
ok(progress.some((p) => p.gamesSoFar === 2), 'kept games are counted in progress');

const ctrl = new AbortController();
ctrl.abort();
let cancelled = null;
try { await fetchProfile('hikaru', ctrl.signal); } catch (e) { cancelled = e; }
ok(cancelled instanceof LichessError && cancelled.kind === 'aborted',
  'an aborted profile request says it was cancelled', cancelled?.kind);

ok(clearGameCache() === undefined, 'the compatibility cache clear is a harmless no-op');

console.log('\n7. handles, closed accounts, and one shared message');
/*
 * THE ACCOUNT-IMPORT REPORT: *"i am giving names of accounts and the app either
 * says no matches for the account or there is no account for this name"*. Two
 * separate defects produced that: a pasted URL kept its query string in the
 * "handle", so a real account was asked for under a name that does not exist;
 * and a closed account returns 200 from the profile endpoint but 404 from its
 * games, which an import reported as "does not exist".
 */
ok(sanitizeLichessUser('https://lichess.org/@/Hikaru?sort=rating') === 'hikaru',
  'a query string is not part of the handle');
ok(sanitizeLichessUser('https://lichess.org/@/Hikaru#games') === 'hikaru',
  'a fragment is not part of the handle');
ok(sanitizeLichessUser('https://lichess.org/user/Hikaru/perf/blitz') === 'hikaru',
  'a profile sub-page is not part of the handle');
ok(sanitizeLichessUser('@Hikaru') === 'hikaru', 'an @ handle is normalised');

route = () => response(JSON.stringify({ ...profile, disabled: true }));
const closedProfile = await fetchProfile('hikaru');
ok(closedProfile.disabled === true,
  'a closed account is reported by its profile, which still answers 200');

route = () => response('', 404);
let closedGames = null;
try { await fetchAllGames('hikaru', { disabledHint: true }); } catch (e) { closedGames = e; }
ok(closedGames instanceof LichessError && closedGames.kind === 'disabled',
  'with the profile flag, a games 404 means "closed", not "missing"', closedGames?.kind);

const missingMessage = lichessAccountError('nobody', new LichessError('x', 'not-found'));
ok(/No Lichess account called "nobody"/.test(missingMessage) && /spelling/.test(missingMessage),
  'a missing account says what to check', missingMessage);
const closedMessage = lichessAccountError('gone', new LichessError('x', 'disabled'));
ok(/closed/i.test(closedMessage) && !/does not exist/i.test(closedMessage),
  'a closed account is not called nonexistent', closedMessage);

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
