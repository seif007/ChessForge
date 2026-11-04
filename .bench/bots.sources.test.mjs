/**
 * A BOT'S GAMES MUST COME FROM SOMEWHERE REAL, AND FROM SOMEWHERE ALIVE.
 *
 * The fetch layer is where a bot's whole existence is decided: which games the
 * device reads, whether it reads the RECENT ones, whose games they are when the
 * archives spell a name five ways, and what happens when the archives disagree
 * about which player the user meant. Both pipelines are exercised here against
 * fake archives over a stubbed `fetch`, so every claim below is about the
 * code's behaviour rather than about the network of the day:
 *
 *   1. THE LICHESS FETCH         - one profile request and one games request,
 *                                  server-side time-class filtering, bullet
 *                                  never kept, and recent games first.
 *   2. THE SHAPE OF A GAME       - the Lichess client's game is converted into
 *                                  a PGN with the right colours, result, date
 *                                  and ratings, and the builder accepts it.
 *   3. NAMES                     - spellings the archives really publish are
 *                                  matched; a different given name is not.
 *   4. FIDE                      - an ID resolves to a name and a rating.
 *   5. THE OTB PIPELINE          - the notable-players archive is found and
 *                                  read; the TWIC scan stops when it has
 *                                  enough; too few games is an honest error;
 *                                  two plausible players is an ambiguity the
 *                                  caller must resolve, never a guess.
 *   6. RESILIENCE                - a request the resolver refused is retried;
 *                                  a dead archive half never kills a build the
 *                                  other half can serve; and when nothing can
 *                                  be reached at all, the error says so in
 *                                  words a person wrote.
 *
 * Run: node .bench/bots.sources.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { zipSync, strToU8 } = require('fflate');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-bots-sources');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2021', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'bots', 'sources.ts'),
    path.join(ROOT, 'src', 'lib', 'bots', 'otb.ts'),
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
  if (request === '@/lib/lichess') {
    return origLoad.call(this, findEmitted(BUILD_DIR, 'lichess.js'), null, false);
  }
  if (request === '@/lib/openings') {
    return origLoad.call(this, findEmitted(BUILD_DIR, 'openings.js'), null, false);
  }
  if (request === '@/lib/repertoire') {
    return origLoad.call(this, findEmitted(BUILD_DIR, 'repertoire.js'), null, false);
  }
  // Any other `@/lib/*` import (sacrifice, accuracy, ...) is emitted next to the
  // rest; resolve it by basename rather than listing every module in the app.
  if (request.startsWith('@/lib/')) {
    const emitted = findEmitted(BUILD_DIR, request.split('/').pop() + '.js');
    if (emitted) return origLoad.call(this, emitted, null, false);
  }
  if (request.startsWith('@/data/')) {
    return origLoad.call(this, path.join(ROOT, 'src', request.slice(2)), parent, isMain);
  }
  return origLoad.call(this, request, parent, isMain);
};

const sources = origLoad.call(Module, findEmitted(BUILD_DIR, 'sources.js'), null, false);
const otb = origLoad.call(Module, findEmitted(BUILD_DIR, 'otb.js'), null, false);
const profileMod = origLoad.call(Module, findEmitted(BUILD_DIR, 'profile.js'), null, false);

const {
  BOT_GAMES_TARGET, MAX_BOT_GAMES, MIN_GAMES_FOR_BOT,
  sanitizeLichessUser, lichessRawGame, fetchLichessBotGames,
} = sources;
const {
  parseFideProfileHtml, resolveFideProfile, scoreName, swapName, nameMatches, nameMatchScore,
  variantKey, mergeVariants, bestPlayerMatch, parseOtbGame, unzipPgn, fetchOtbBotGames,
  clearOtbSessionCache, OtbAmbiguityError, OtbNoGamesError, ArchiveUnreachableError,
  TWIC_MAX_WEEKS, TWIC_BATCH_WEEKS,
} = otb;
const { buildBotProfile } = profileMod;

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

/* -------------------------------------------------------------- fake network */

const calls = [];
let route = () => null;

const headers = { get: () => null };
const jsonResponse = (obj, status = 200) => ({
  ok: status < 400, status, headers,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(obj)).buffer,
});
const textResponse = (text, status = 200) => ({
  ok: status < 400, status, headers,
  json: async () => JSON.parse(text),
  text: async () => text,
  arrayBuffer: async () => new TextEncoder().encode(text).buffer,
});
const bytesResponse = (bytes) => ({
  ok: true, status: 200, headers,
  text: async () => '',
  json: async () => { throw new Error('not json'); },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});
const notFound = () => jsonResponse({ error: 'not found' }, 404);
const makeZip = (name, text) => zipSync({ [name]: strToU8(text) });

globalThis.fetch = async (input) => {
  const url = String(input);
  calls.push(url);
  return route(url) ?? notFound();
};
const fetches = (pred) => calls.filter(pred);

/* --------------------------------------------------------------- Lichess setup */

const MAINLINE = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7';
const line = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7';
const at = (iso) => Date.parse(iso + 'T12:00:00Z') / 1000;

/** One raw Lichess game, in the shape the public API really serves. */
function liGame(name, spec = {}) {
  const {
    id, color = 'w', speed = 'blitz', opp = 'Foe', rating = 3300, oppRating = 3200,
    winner, date = '2026-10-20', moves = MAINLINE, variant = 'standard', rated = true,
  } = spec;
  const isWhite = color === 'w';
  const players = {
    white: {
      user: { name: isWhite ? name : opp },
      rating: isWhite ? rating : oppRating,
    },
    black: {
      user: { name: isWhite ? opp : name },
      rating: isWhite ? oppRating : rating,
    },
  };
  const end = at(date);
  return {
    id, rated, variant, speed, perf: speed,
    createdAt: end - 300,
    lastMoveAt: end * 1000,
    status: winner ? 'resign' : 'draw',
    players,
    ...(winner ? { winner } : {}),
    opening: { eco: 'C60', name: 'Ruy Lopez', ply: 10 },
    moves,
    clock: { initial: speed === 'rapid' ? 600 : speed === 'classical' ? 1800 : 180, increment: 2 },
  };
}

const HIKARU_PROFILE = {
  id: 'hikaru',
  username: 'Hikaru',
  createdAt: at('2010-01-01'),
  perfs: {
    bullet: { rating: 3200 },
    blitz: { rating: 3300 },
    rapid: { rating: 3150 },
    classical: { rating: 3000 },
    correspondence: { rating: 2900 },
  },
  profile: { fideRating: 2780 },
};

const FEED = [
  ...Array.from({ length: 12 }, (_, i) => liGame('Hikaru', {
    id: 'bullet' + i, speed: 'bullet', opp: 'Bullet' + i, winner: i % 2 ? 'white' : 'black',
    date: '2026-10-' + String(28 - (i % 8)).padStart(2, '0'),
  })),
  ...Array.from({ length: 6 }, (_, i) => liGame('Hikaru', {
    id: 'blitz' + i, speed: 'blitz', color: i % 2 ? 'b' : 'w',
    opp: 'Blitz' + i, winner: i % 3 === 0 ? (i % 2 ? 'white' : 'black') : (i % 2 ? 'black' : 'white'),
    date: '2026-10-' + String(20 - i).padStart(2, '0'),
  })),
  ...Array.from({ length: 6 }, (_, i) => liGame('Hikaru', {
    id: 'rapid' + i, speed: 'rapid', opp: 'Rapid' + i, winner: i % 2 ? 'white' : 'black',
    date: '2026-09-' + String(20 - i).padStart(2, '0'),
  })),
  ...Array.from({ length: 6 }, (_, i) => liGame('Hikaru', {
    id: 'classical' + i, speed: 'classical', opp: 'Slow' + i, winner: i % 2 ? 'white' : 'black',
    date: '2026-08-' + String(20 - i).padStart(2, '0'),
  })),
  liGame('Hikaru', { id: 'variant', variant: 'chess960', speed: 'blitz', winner: 'white', date: '2026-07-01' }),
];

/** A fake Lichess server: profile JSON and one NDJSON games response. */
function liRoute({ profile = HIKARU_PROFILE, games = FEED } = {}) {
  return (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/user/hikaru') {
      return profile ? jsonResponse(profile) : notFound();
    }
    if (u.pathname === '/api/games/user/hikaru') {
      const perf = u.searchParams.get('perfType');
      const max = Number(u.searchParams.get('max') || 4000);
      let list = games;
      if (perf) {
        const accepted = new Set(perf.split(','));
        list = list.filter((g) => accepted.has(g.speed));
      }
      if (u.searchParams.get('rated') === 'true') list = list.filter((g) => g.rated);
      list = [...list].sort((a, b) => b.lastMoveAt - a.lastMoveAt).slice(0, max);
      return textResponse(list.map((g) => JSON.stringify(g)).join('\n'));
    }
    return notFound();
  };
}

/* --------------------------------------------------------------------- 1 */

head('1. one profile read and one games read, bullet never kept');

ok(sanitizeLichessUser('https://lichess.org/@/Hikaru/') === 'hikaru',
  'a Lichess profile URL becomes the handle');
ok(sanitizeLichessUser('@Hikaru') === 'hikaru', 'an @ handle is accepted too');
/*
 * A COPIED ADDRESS IS NOT ONLY A HANDLE. People paste the whole profile URL,
 * often with a query string or fragment, and every character of it used to end
 * up in the "username" — a real account, reported as missing.
 */
ok(sanitizeLichessUser('https://lichess.org/@/Hikaru?sort=rating') === 'hikaru',
  'a query string is dropped from a pasted profile URL');
ok(sanitizeLichessUser('https://lichess.org/@/Hikaru#games') === 'hikaru',
  'a fragment is dropped from a pasted profile URL');
ok(sanitizeLichessUser('https://lichess.org/user/Hikaru/perf/blitz') === 'hikaru',
  'a profile sub-page is reduced to the handle');
ok(sanitizeLichessUser('lichess.org/@/Hikaru') === 'hikaru',
  'a scheme-less profile path is accepted');
ok(sanitizeLichessUser('  @Hikaru.  ') === 'hikaru',
  'surrounding whitespace and a trailing full stop are not part of the name');

route = liRoute();
calls.length = 0;
const progress = [];
const account = await fetchLichessBotGames(
  'https://lichess.org/@/Hikaru/',
  (p) => progress.push(p),
  { maxGames: 6 },
);

ok(calls.length === 2, 'one profile request and one games request', calls.join('\n'));
ok(calls[0] === 'https://lichess.org/api/user/hikaru',
  'the profile is read first', calls[0]);
const gamesCall = decodeURIComponent(calls[1] ?? '');
ok(gamesCall.startsWith('https://lichess.org/api/games/user/hikaru?'),
  'the games endpoint is the account handle', gamesCall);
for (const [needle, label] of [
  ['max=6', 'the requested cap is sent to the server'],
  ['perfType=blitz,rapid,classical,correspondence', 'non-bullet classes are requested'],
  ['rated=true', 'only rated games are requested'],
  ['moves=true', 'moves are requested'],
  ['opening=true', 'opening labels are requested'],
  ['sort=dateDesc', 'newest first is explicit'],
]) ok(gamesCall.includes(needle), label, gamesCall);

ok(progress.some((p) => /Looking up the account/.test(p.label)),
  'the profile lookup is on the progress line');
ok(progress.some((p) => /Fetching their games/.test(p.label)),
  'the games fetch is on the progress line');
ok(progress.some((p) => /Reading your Lichess games/.test(p.label)),
  'the NDJSON read is on the progress line');

ok(account.games.length === 6, 'six games are kept', String(account.games.length));
ok(account.games.every((g) => g.source === 'lichess'),
  'every game says where it came from');
ok(account.games.every((g) => g.timeControl === 'blitz'),
  'the bullet games and the variant are gone', account.games.map((g) => g.timeControl).join(','));
ok(account.games.every((g) => /Hikaru/.test(g.white) || /Hikaru/.test(g.black)),
  'the tracked player is in every PGN');
ok(account.meta.name === 'Hikaru' && account.meta.key === 'Hikaru',
  'the handle is the identity');
ok(account.meta.source === 'lichess', 'the bot source is Lichess');
ok(account.meta.title === undefined && account.meta.avatar === undefined && account.meta.country === undefined,
  'no title, photo or country is copied from the profile');
ok(account.meta.ratings?.blitz === 3300 && account.meta.ratings?.rapid === 3150
  && account.meta.ratings?.daily === 3000 && account.meta.ratings?.fide === 2780,
  'the ratings are the account ratings, with classical in the daily slot',
  JSON.stringify(account.meta.ratings));
ok(account.meta.ratings?.bullet === undefined,
  'no bullet rating is offered for a format the bot cannot play');

const built = await buildBotProfile(account.games, account.meta, { yieldEvery: 100 });
ok(built.gamesAnalyzed === 6, 'the builder accepts the fetched games', String(built.gamesAnalyzed));
ok(built.meta.name === 'Hikaru' && built.source === 'lichess', 'the profile keeps the handle and source');
ok(built.rating === 3300 && built.ratingLabel === 'Lichess blitz',
  'the profile card quotes the class the games came from', built.rating + ' ' + built.ratingLabel);

/* --------------------------------------------------------------------- 2 */

head('2. the time-class filter is server-side and honest');

route = liRoute();
calls.length = 0;
const rapid = await fetchLichessBotGames('hikaru', () => {}, { maxGames: 6, timeClass: 'rapid' });
const rapidCall = decodeURIComponent(calls[1] ?? '');
ok(rapidCall.includes('perfType=rapid'), 'rapid asks the server for rapid only', rapidCall);
ok(rapid.games.length === 6 && rapid.games.every((g) => g.timeControl === 'rapid'),
  'only rapid games are kept');
const rapidProfile = await buildBotProfile(rapid.games, rapid.meta, { yieldEvery: 100 });
ok(rapidProfile.ratingLabel === 'Lichess rapid' && rapidProfile.rating === 3150,
  'the rapid card quotes the rapid rating', rapidProfile.rating + ' ' + rapidProfile.ratingLabel);

route = liRoute();
calls.length = 0;
const daily = await fetchLichessBotGames('hikaru', () => {}, { maxGames: 6, timeClass: 'daily' });
const dailyCall = decodeURIComponent(calls[1] ?? '');
ok(dailyCall.includes('perfType=classical,correspondence'),
  'classical and correspondence are one daily request', dailyCall);
ok(daily.games.length === 6 && daily.games.every((g) => g.timeControl === 'daily'),
  'both slow formats are mapped to the app daily class');
const dailyProfile = await buildBotProfile(daily.games, daily.meta, { yieldEvery: 100 });
ok(dailyProfile.ratingLabel === 'Lichess classical' && dailyProfile.rating === 3000,
  'the daily card says classical, not a made-up daily rating',
  dailyProfile.rating + ' ' + dailyProfile.ratingLabel);

/* --------------------------------------------------------------------- 3 */

head('3. missing accounts, too few games, and the 429 rule');

route = liRoute({ profile: null });
calls.length = 0;
let missing = null;
try { await fetchLichessBotGames('nobody', () => {}); } catch (e) { missing = e; }
ok(missing instanceof Error && /No Lichess account called "nobody"/.test(missing.message)
  && /spelling/.test(missing.message),
  'a missing account is named, with something to check', missing?.message);
ok(calls.length === 1, 'a missing account is not retried', String(calls.length));

/*
 * A CLOSED ACCOUNT IS NOT A MISSING ONE. Lichess answers its profile with 200
 * and `disabled: true`; only the games endpoint 404s. Saying "does not exist"
 * for a handle that plainly does is the wrong answer, and it stops here rather
 * than making a second request that cannot succeed.
 */
route = liRoute({ profile: { ...HIKARU_PROFILE, disabled: true } });
calls.length = 0;
let closed = null;
try { await fetchLichessBotGames('hikaru', () => {}); } catch (e) { closed = e; }
ok(closed instanceof Error && /closed/i.test(closed.message)
  && !/does not exist|not a Lichess username/i.test(closed.message),
  'a closed account says it is closed, not that it does not exist', closed?.message);
ok(calls.length === 1, 'a closed account stops before the games request', String(calls.length));

route = liRoute({ games: FEED.filter((g) => g.speed === 'blitz').slice(0, 3) });
calls.length = 0;
let tooFew = null;
try { await fetchLichessBotGames('hikaru', () => {}); } catch (e) { tooFew = e; }
ok(tooFew instanceof Error && /fewer than 6/.test(tooFew.message),
  'too few games is an honest error, not a bot with no personality', tooFew?.message);
ok(calls.length === 2, 'the games read happened before the refusal', String(calls.length));

route = () => jsonResponse({ error: 'slow down' }, 429);
calls.length = 0;
let limited = null;
try { await fetchLichessBotGames('hikaru', () => {}); } catch (e) { limited = e; }
ok(limited instanceof Error && /rate-limiting/.test(limited.message)
  && /minute|seconds/.test(limited.message),
  'a 429 says to wait rather than retrying silently', limited?.message);
ok(calls.length === 1, 'a 429 is never auto-retried', String(calls.length));

let profileFailures = 1;
route = (url) => {
  if (url.endsWith('/api/user/hikaru') && profileFailures-- > 0) {
    throw new Error('transient network failure');
  }
  return liRoute()(url);
};
calls.length = 0;
const recovered = await fetchLichessBotGames('hikaru', () => {}, { maxGames: 6 });
ok(recovered.games.length === 6, 'one transient network failure is survived');
ok(fetches((u) => u.endsWith('/api/user/hikaru')).length === 2,
  'the profile request was retried once', String(fetches((u) => u.endsWith('/api/user/hikaru')).length));

/* --------------------------------------------------------------------- 4 */

head('4. the shape of a Lichess game');

const NOW = {
  id: 'abc123', url: 'https://lichess.org/abc123', opening: 'Ruy Lopez',
  openingVariation: 'Ruy Lopez', ecoSlug: 'C60', color: 'b', outcome: 'win',
  playerRating: 2100, opponentRating: 2000, opponent: 'Foe', accuracy: null,
  opponentAccuracy: null, movesUci: [], movesSan: MAINLINE.split(' '),
  timeClass: 'blitz', timeControl: '180+2', rated: true, endTime: at('2026-10-01'),
};
const raw = lichessRawGame(NOW, 'Hikaru');
ok(raw.white === 'Foe' && raw.black === 'Hikaru',
  'the tracked player is black when the game says so');
ok(raw.whiteRating === 2000 && raw.blackRating === 2100,
  'ratings follow the colours');
ok(raw.source === 'lichess' && raw.timeControl === 'blitz' && raw.date === '2026-10-01',
  'source, class and date are carried');
ok(raw.pgn.includes('[White "Foe"]') && raw.pgn.includes('[Black "Hikaru"]')
  && raw.pgn.includes('[Result "0-1"]')
  && raw.pgn.includes('[WhiteElo "2000"]') && raw.pgn.includes('[BlackElo "2100"]'),
  'the PGN headers describe the same game', raw.pgn);
ok(raw.pgn.includes('1. e4 e5 2. Nf3 Nc6'),
  'the SAN mainline is rebuilt in movetext', raw.pgn.split('\n').at(-1));

/* --------------------------------------------------------------------- 5 */

head('3. the archives spell names every which way');

ok(scoreName('Nakamura, Hikaru', 'Nakamura, Hikaru') === 100, 'the same spelling is a perfect score');
ok(scoreName('Hikaru Nakamura', 'Nakamura,Hikaru') === 96,
  'the two word orders are the same name', `${scoreName('Hikaru Nakamura', 'Nakamura,Hikaru')}`);
ok(nameMatches('Nakamura,Hi', 'Hikaru Nakamura'),
  'an abbreviated PGN spelling still counts', `${nameMatchScore('Nakamura,Hi', 'Hikaru Nakamura')}`);
ok(swapName('Aronian,L') === 'L Aronian', 'an abbreviation can be read the other way round', swapName('Aronian,L'));
ok(!nameMatches('Nakamura, Takumi', 'Nakamura, Hikaru'),
  'a different given name is a different player', `${nameMatchScore('Nakamura, Takumi', 'Nakamura, Hikaru')}`);
ok(!nameMatches('Carlsen, Magnus', 'Nakamura'),
  'and a different surname is too', `${nameMatchScore('Carlsen, Magnus', 'Nakamura')}`);

const mergedVariants = mergeVariants([
  { name: 'Nakamura,Hi', normKey: variantKey('Nakamura,Hi'), games: 3 },
  { name: 'Nakamura,Hikaru', normKey: variantKey('Nakamura,Hikaru'), games: 7 },
]);
ok(mergedVariants.length === 1 && mergedVariants[0].games === 10 && mergedVariants[0].name === 'Nakamura,Hikaru',
  'an abbreviation merges with its full spelling', JSON.stringify(mergedVariants));
const twoPeople = mergeVariants([
  { name: 'Magnus', normKey: variantKey('Magnus'), games: 2 },
  { name: 'Magnuson', normKey: variantKey('Magnuson'), games: 2 },
]);
ok(twoPeople.length === 2,
  'but a surname that merely starts the same stays two people', JSON.stringify(twoPeople));

/*
 * The guard the probe above does not reach.
 *
 * 'Magnus'/'Magnuson' differ in the SURNAME, so they never even arrive at the
 * given-name comparison. The rule that needs its own probe is the one inside
 * mergeVariants: only an abbreviation merges, and an abbreviation is at most
 * four letters. 'Nikola' is long enough to be a name of its own, so it is not
 * an abbreviation of 'Nikolaus' - two different players - while 'Niko' is.
 * Without the length guard the prefix test alone fuses the first pair.
 */
const longGiven = mergeVariants([
  { name: 'Carlsen,Nikola', normKey: variantKey('Carlsen,Nikola'), games: 5 },
  { name: 'Carlsen,Nikolaus', normKey: variantKey('Carlsen,Nikolaus'), games: 3 },
]);
ok(longGiven.length === 2,
  'a long given name is not an abbreviation of a longer one', JSON.stringify(longGiven));
const shortGiven = mergeVariants([
  { name: 'Carlsen,Niko', normKey: variantKey('Carlsen,Niko'), games: 5 },
  { name: 'Carlsen,Nikolaus', normKey: variantKey('Carlsen,Nikolaus'), games: 3 },
]);
ok(shortGiven.length === 1 && shortGiven[0].games === 8,
  'CONTROL: but a four-letter abbreviation still merges', JSON.stringify(shortGiven));

const players = [
  { file: 'Carlsen.zip', name: 'Carlsen, Magnus', games: 3000 },
  { file: 'Nakamura.zip', name: 'Nakamura, Hikaru', games: 4000 },
  { file: 'Nakamuraw.zip', name: 'Nakamura, Takumi', games: 40 },
];
ok(bestPlayerMatch('Hikaru Nakamura', players)?.file === 'Nakamura.zip',
  'the notable-players list picks the right Nakamura', bestPlayerMatch('Hikaru Nakamura', players)?.file);
ok(bestPlayerMatch('Nobody At All', players) === null,
  'and picks nobody when there is nobody to pick');

head('4. FIDE profile pages and their ratings');

const fideHtml = '<html><head><title>Nakamura, Hikaru FIDE Profile</title></head><body><img src="/img/logo_std.svg" alt="standart" height=25><p>2792</p></body></html>';
const fide = parseFideProfileHtml(fideHtml);
ok(fide?.name === 'Nakamura, Hikaru' && fide?.stdRating === 2792,
  'the title is the name and the standard rating is read', JSON.stringify(fide));
ok(parseFideProfileHtml('<html><head><title>FIDE Ratings</title></head></html>') === null,
  'a generic page is not a player');
ok(parseFideProfileHtml('<html><head><title>Carlsen, Magnus FIDE Profile</title></head><body>Standard Classical <b>2830</b></body></html>')?.stdRating === 2830,
  'the older rating layout still parses');

head('5. one archive game, parsed by hand');

const pgnGame = `[Event "Test Open"]\n[Site "Test"]\n[Date "2025.06.14"]\n[Round "7"]\n[White "Nakamura, Hikaru"]\n[Black "Foe, A."]\n[Result "1-0"]\n[WhiteElo "2790"]\n[BlackElo "2600"]\n[ECO "C68"]\n\n${line} 1-0`;
const parsed = parseOtbGame(pgnGame, 'Hikaru Nakamura');
ok(parsed?.matchedName === 'Nakamura, Hikaru' && parsed?.whiteRating === 2790 && parsed?.date === '2025.06.14' && parsed?.eco === 'C68',
  'the game is the player’s and the header facts travel with it', JSON.stringify(parsed?.matchedName));
ok(parseOtbGame(pgnGame, 'Carlsen') === null, 'a game without the player is not his');
const zipPgn = unzipPgn(makeZip('export.pgn', pgnGame));
ok(zipPgn === pgnGame, 'a PGN inside a zip comes out exactly as it went in');
ok(unzipPgn(makeZip('readme.txt', 'no pgn here')) === null, 'a zip without a PGN yields nothing');
ok(unzipPgn(new Uint8Array([1, 2, 3, 4])) === null, 'and so does a file that is not a zip at all');

/* --------------------------------------------------------------- otb fixtures */

const otbGamePgn = (white, black, date, round, blackElo = 2600) =>
  `[Event "Test Open"]\n[Site "Test"]\n[Date "${date}"]\n[Round "${round}"]\n[White "${white}"]\n[Black "${black}"]\n[Result "1-0"]\n[WhiteElo "2790"]\n[BlackElo "${blackElo}"]\n\n${line} 1-0`;

const mentorPlayersHtml = (entries) => entries
  .map((e) => `<a href="players/${e.file.replace(/\.zip$/, '')}.zip">${e.name}</a>${'x'.repeat(20)}<td>${e.name}, ${e.games} games</td>`)
  .join('\n');

const TWIC_LIST_HTML = '<html><body><a href="https://theweekinchess.com/zips/twic1666g.zip">twic1666</a></body></html>';

/**
 * Every TWIC issue route: a zip holding one game. `games` maps an issue to the
 * PGN body, so each scenario can decide what the archive contains that week.
 */
const twicZipFor = (issue, games) => bytesResponse(makeZip(`twic${issue}.pgn`, games.join('\n\n')));

head('6. the OTB pipeline: archive first, weeklies second');

clearOtbSessionCache();
const MENTOR_GAMES = [
  otbGamePgn('Nakamura, Hikaru', 'Foe, A.', '2025.06.25', '1'),
  otbGamePgn('Nakamura, Hikaru', 'Foe, B.', '2025.06.26', '2'),
  otbGamePgn('Nakamura, Hikaru', 'Foe, C.', '2025.06.27', '3'),
];
/* Issue 1660 repeats a game the player archive already has — the merge must not. */
const DUPLICATE = otbGamePgn('Nakamura, Hikaru', 'Foe, C.', '2025.06.27', '3');
const twicNakamura = (issue) =>
  issue === 1660 ? DUPLICATE : otbGamePgn('Nakamura, Hikaru', `Rival${issue}, R.`, `2025.06.${14 + (1666 - issue)}`, '4');

calls.length = 0;
route = (url) => {
  if (url === 'https://www.pgnmentor.com/files.html') {
    return textResponse(mentorPlayersHtml([{ file: 'Nakamura.zip', name: 'Nakamura, Hikaru', games: 4000 }]));
  }
  if (url === 'https://www.pgnmentor.com/players/Nakamura.zip') {
    return bytesResponse(makeZip('Nakamura.pgn', MENTOR_GAMES.join('\n\n')));
  }
  if (url === 'https://theweekinchess.com/twic') return textResponse(TWIC_LIST_HTML);
  const z = url.match(/\/zips\/twic(\d+)g\.zip$/);
  if (z) return twicZipFor(Number(z[1]), [twicNakamura(Number(z[1]))]);
  return null;
};

const otbReports = [];
const otbBuild = await fetchOtbBotGames('Hikaru Nakamura', (p) => otbReports.push(p), { maxGames: 6 });
ok(otbBuild.games.length === 6, 'six recent games come out of the archives', `${otbBuild.games.length}`);
ok(otbBuild.meta.source === 'otb' && otbBuild.meta.key === 'Nakamura, Hikaru',
  'the meta names the player the way the archives do', JSON.stringify(otbBuild.meta));
ok(otbBuild.meta.ratings.fide === undefined,
  'no FIDE rating is invented when the lookup did not go through FIDE');
const dates = otbBuild.games.map((g) => g.date ?? '');
ok(dates.every((d, i) => i === 0 || dates[i - 1] >= d),
  'the games are ordered newest first', dates.join(' '));
ok(otbBuild.games.some((g) => g.date === '2025.06.25'),
  'the player archive contributes its deepest history');
ok(otbBuild.games.filter((g) => g.date === '2025.06.27' && g.black === 'Foe, C.').length === 1,
  'and the repeated game is not counted twice');
const zipsAsked = fetches((u) => u.includes('/zips/twic'));
ok(zipsAsked.length === TWIC_BATCH_WEEKS,
  `the weekly scan stops after one batch of ${TWIC_BATCH_WEEKS}`, `${zipsAsked.length}`);
ok(otbReports.some((r) => r.label === 'Downloading player archive' && /Nakamura/.test(r.detail ?? '')),
  'the archive download is on the progress line');
ok(otbReports.some((r) => r.label === 'Scanning international tournament reports'),
  'and so is the weekly scan');

const otbBuilt = await buildBotProfile(otbBuild.games, otbBuild.meta, { yieldEvery: 1000 });
ok(otbBuilt.gamesAnalyzed === 6,
  'the builder accepts the archive’s own spelling of the player', `${otbBuilt.gamesAnalyzed}`);

head('6b. two plausible players is a question, not a guess');

clearOtbSessionCache();
calls.length = 0;
route = (url) => {
  if (url === 'https://www.pgnmentor.com/files.html') return textResponse('<html></html>');
  if (url === 'https://theweekinchess.com/twic') return textResponse(TWIC_LIST_HTML);
  const z = url.match(/\/zips\/twic(\d+)g\.zip$/);
  if (z) {
    const issue = Number(z[1]);
    const idx = 1666 - issue;
    if (idx < 7) return twicZipFor(issue, [otbGamePgn('Nakamura, Hikaru', `Rival${issue}, R.`, `2025.07.0${idx + 1}`, '1')]);
    if (idx < 12) return twicZipFor(issue, [otbGamePgn('Nakamura, Takumi', `Rival${issue}, R.`, `2025.07.1${idx - 6}`, '1')]);
    return twicZipFor(issue, [otbGamePgn('Other, O.', 'Foe, F.', '2025.07.20', '1')]);
  }
  return null;
};

let ambiguous = null;
try {
  await fetchOtbBotGames('Nakamura', () => {}, { maxGames: 6 });
} catch (e) { ambiguous = e; }
ok(ambiguous instanceof OtbAmbiguityError,
  'the lookup refuses to guess', ambiguous?.name);
const opts = ambiguous?.options ?? [];
ok(opts.length === 2 && opts[0].name === 'Nakamura, Hikaru' && opts[0].games === 7 && opts[1].name === 'Nakamura, Takumi' && opts[1].games === 5,
  'and offers the players it found, with how much of each there is', JSON.stringify(opts));

head('6c. nothing published is an honest dead end');

clearOtbSessionCache();
calls.length = 0;
route = (url) => {
  if (url === 'https://www.pgnmentor.com/files.html') return textResponse('<html></html>');
  if (url === 'https://theweekinchess.com/twic') return textResponse(TWIC_LIST_HTML);
  const z = url.match(/\/zips\/twic(\d+)g\.zip$/);
  if (z) return twicZipFor(Number(z[1]), [otbGamePgn('Other, O.', 'Foe, F.', '2025.07.20', '1')]);
  return null;
};
let lonely = null;
try {
  await fetchOtbBotGames('Club Player', () => {}, { maxGames: 6 });
} catch (e) { lonely = e; }
ok(lonely instanceof OtbNoGamesError && /No public over-the-board games/.test(lonely.message),
  'the error says the games are not published', lonely?.message?.slice(0, 80));
ok(Array.isArray(lonely?.suggestions),
  'and carries suggestions for when the player list had a near miss');
const allWeeksAsked = fetches((u) => u.includes('/zips/twic'));
ok(allWeeksAsked.length === TWIC_MAX_WEEKS,
  `with nothing found, the scan really does walk all ${TWIC_MAX_WEEKS} weeks and stop`, `${allWeeksAsked.length}`);

head('6d. a FIDE ID becomes the player it belongs to');

clearOtbSessionCache();
calls.length = 0;
route = (url) => {
  if (url.startsWith('https://ratings.fide.com/profile/14109603')) {
    return textResponse('<html><head><title>Nakamura, Hikaru FIDE Profile</title></head><body><img src="/img/logo_std.svg" alt="standart" height=25><p>2792</p></body></html>');
  }
  if (url === 'https://www.pgnmentor.com/files.html') {
    return textResponse(mentorPlayersHtml([{ file: 'Nakamura.zip', name: 'Nakamura, Hikaru', games: 4000 }]));
  }
  if (url === 'https://www.pgnmentor.com/players/Nakamura.zip') {
    return bytesResponse(makeZip('Nakamura.pgn', MENTOR_GAMES.join('\n\n')));
  }
  if (url === 'https://theweekinchess.com/twic') return textResponse(TWIC_LIST_HTML);
  const z = url.match(/\/zips\/twic(\d+)g\.zip$/);
  if (z) return twicZipFor(Number(z[1]), [twicNakamura(Number(z[1]))]);
  return null;
};
const byId = await fetchOtbBotGames('14109603', () => {}, { maxGames: 6 });
ok(byId.meta.fideId === '14109603' && byId.meta.ratings.fide === 2792,
  'the ID is kept and the published rating travels with it', JSON.stringify(byId.meta.ratings));
ok(byId.meta.name === 'Nakamura, Hikaru',
  'and the profile page decides the spelling the archives are searched with', byId.meta.name);

let badId = null;
route = () => textResponse('<html><head><title>FIDE Ratings</title></head></html>');
try {
  await fetchOtbBotGames('99999999', () => {});
} catch (e) { badId = e; }
ok(badId !== null && /No FIDE player found with ID 99999999/.test(badId.message),
  'an ID without a profile says exactly that', badId?.message);

head('6e. a refused resolver is retried, and an unreachable archive says so in words');

/*
 * THE REPORT: an OTB build failed with a raw `java.net.UnknownHostException`
 * from the device's DNS while the archives were answering again a second
 * later. Phones hop networks and resolvers hiccup; these scenarios pin the
 * promised behaviour: a transient refusal is retried, a dead archive half
 * does not kill a build the other half can serve, and only a build that ends
 * with nothing to show blames the connection — in words a person wrote.
 */
const nakamuraRoutes = (url) => {
  if (url === 'https://www.pgnmentor.com/files.html') {
    return textResponse(mentorPlayersHtml([{ file: 'Nakamura.zip', name: 'Nakamura, Hikaru', games: 4000 }]));
  }
  if (url === 'https://www.pgnmentor.com/players/Nakamura.zip') {
    return bytesResponse(makeZip('Nakamura.pgn', MENTOR_GAMES.join('\n\n')));
  }
  if (url === 'https://theweekinchess.com/twic') return textResponse(TWIC_LIST_HTML);
  const z = url.match(/\/zips\/twic(\d+)g\.zip$/);
  if (z) return twicZipFor(Number(z[1]), [twicNakamura(Number(z[1]))]);
  return null;
};

/* One refusal, then the archive answers — the build must survive it. */
clearOtbSessionCache();
calls.length = 0;
let listRefused = 1;
route = (url) => {
  if (url === 'https://www.pgnmentor.com/files.html' && listRefused > 0) {
    listRefused--;
    throw new TypeError('Network request failed'); // the resolver saying no, once
  }
  return nakamuraRoutes(url);
};
const flakyOtb = await fetchOtbBotGames('Hikaru Nakamura', () => {}, { maxGames: 6 });
const listFetches = fetches((u) => u === 'https://www.pgnmentor.com/files.html').length;
ok(flakyOtb.games.length === 6 && listFetches === 2,
  'one network refusal is retried and the archive is read anyway',
  `games=${flakyOtb.games.length} listFetches=${listFetches}`);

/* The player archive never answers at all — the weeklies must carry the build. */
clearOtbSessionCache();
calls.length = 0;
route = (url) => {
  if (url === 'https://www.pgnmentor.com/files.html') throw new TypeError('Network request failed');
  if (url === 'https://theweekinchess.com/twic') return textResponse(TWIC_LIST_HTML);
  const z = url.match(/\/zips\/twic(\d+)g\.zip$/);
  if (z) return twicZipFor(Number(z[1]), [twicNakamura(Number(z[1]))]);
  return null;
};
const weeklyOnly = await fetchOtbBotGames('Hikaru Nakamura', () => {}, { maxGames: 6 });
ok(weeklyOnly.games.length === 6 && weeklyOnly.meta.key === 'Nakamura, Hikaru',
  'a dead player archive still yields a bot from the weekly reports',
  `${weeklyOnly.games.length} games`);

/* Nothing answers anywhere — the error must be one a person can act on. */
clearOtbSessionCache();
calls.length = 0;
route = (url) => {
  if (url === 'https://www.pgnmentor.com/files.html') throw new TypeError('Network request failed');
  if (url === 'https://theweekinchess.com/twic') throw new TypeError('Network request failed');
  const z = url.match(/\/zips\/twic(\d+)g\.zip$/);
  if (z) throw new TypeError('Network request failed');
  return null;
};
let unreachable = null;
try {
  await fetchOtbBotGames('Hikaru Nakamura', () => {}, { maxGames: 6 });
} catch (e) { unreachable = e; }
ok(unreachable instanceof ArchiveUnreachableError &&
  /Could not reach the over-the-board archives/.test(unreachable.message),
  'when nothing can be reached, the build says so in words a person wrote',
  unreachable?.message);
ok(!/unknownhost|java\.|fetch failed/i.test(unreachable?.message ?? ''),
  'and no raw resolver text ever reaches the user');

head('7. the small numbers are what the screen will promise');

ok(BOT_GAMES_TARGET === 60 && MIN_GAMES_FOR_BOT === 6 && MAX_BOT_GAMES === 200,
  'the target, the floor and the ceiling are the ones the screens quote',
  `${BOT_GAMES_TARGET}/${MIN_GAMES_FOR_BOT}/${MAX_BOT_GAMES}`);

/* -------------------------------------------------------------------- done */

console.log('');
if (failures === 0) console.log(`ALL CHECKS PASSED  (${checks}/${checks})`);
else console.log(`${failures} of ${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
