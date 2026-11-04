/**
 * GATE 1r — ChessForge Arena.
 *
 * The Arena is local-only, but "local" is not a synonym for "untested". This
 * gate covers the parts that are easy to get subtly wrong and impossible to
 * notice by looking at the board:
 *
 *   1. Elo updates use both players' PRE-GAME ratings, and K=32 is symmetric.
 *   2. A bot-vs-bot result moves bot ratings only; a human game moves the human
 *      pool only for the human side. Unrated and untimed games move nothing.
 *   3. Round robin / double round robin produce the right number of games,
 *      opponents, colours and byes.
 *   4. Swiss avoids rematches where it can; Arena allows them; both give a bye
 *      to the lowest-scoring player without one.
 *   5. Knockout seeds a bracket, gives an odd field's bye to the top seed, and
 *      resolves a drawn final on the tiebreak.
 *   6. Drafts are saved without pairings, can be edited before starting, and
 *      start with fresh pairings.
 *   7. Standings include points, Buchholz, Sonneborn-Berger and a performance
 *      estimate that excludes byes.
 *   8. PGN export, clock arithmetic and result detection are the same helpers
 *      the game screen uses.
 *
 * Run: node .bench/arena.test.mjs
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
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-arena');

try { fs.rmSync(BUILD_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'storage.d.ts'), [
  'declare const Storage: {',
  '  getItem(key: string): Promise<string | null>;',
  '  setItem(key: string, value: string): Promise<void>;',
  '  removeItem(key: string): Promise<void>;',
  '  getAllKeys(): Promise<string[]>;',
  '};',
  'export default Storage;',
].join('\n'));

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2021', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true, baseUrl: '.', ignoreDeprecations: '6.0',
    paths: {
      'expo-sqlite/kv-store': ['./storage.d.ts'],
      '@/*': ['../../../src/*'],
    },
    rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [
    'src/lib/arena/types.ts',
    'src/lib/arena/timeControl.ts',
    'src/lib/arena/ratings.ts',
    'src/lib/arena/pairing.ts',
    'src/lib/arena/game.ts',
    'src/lib/arena/labels.ts',
    'src/lib/arena/field.ts',
    'src/lib/arena/store.ts',
    'src/lib/bots/types.ts',
    'src/lib/bots/display.ts',
    'src/lib/bots/postgame.ts',
    'src/lib/bots/personality.ts',
  ].map((f) => path.join(ROOT, f)),
}, null, 2));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project',
    path.join(BUILD_DIR, 'tsconfig.json'),
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 3000));
  process.exit(2);
}

const Module = require('node:module');
const store = new Map();
let writeDelayMs = 0;
const fakeStorage = {
  async getItem(key) { return store.has(key) ? store.get(key) : null; },
  async setItem(key, value) {
    if (writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
    store.set(key, value);
  },
  async removeItem(key) { store.delete(key); },
  async getAllKeys() { return [...store.keys()]; },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'expo-sqlite/kv-store') {
    return { __esModule: true, default: fakeStorage };
  }
  if (request.startsWith('@/')) {
    const emitted = path.join(BUILD_DIR, 'src', request.slice(2) + '.js');
    if (fs.existsSync(emitted)) return origLoad(emitted, parent, isMain);
  }
  return origLoad(request, parent, isMain);
};

function emitted(rel) {
  return require(path.join(BUILD_DIR, 'src', rel));
}

const ratings = emitted('lib/arena/ratings.js');
const time = emitted('lib/arena/timeControl.js');
const pairing = emitted('lib/arena/pairing.js');
const gameLib = emitted('lib/arena/game.js');
const fieldLib = emitted('lib/arena/field.js');
const storeLib = emitted('lib/arena/store.js');
const personality = emitted('lib/bots/personality.js');

let checks = 0;
let failures = 0;
function ok(cond, msg) {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(Object.is(actual, expected), `${msg} (got ${String(actual)}, expected ${String(expected)})`);
}
function deepEq(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg}\n  got ${JSON.stringify(actual)}\n  expected ${JSON.stringify(expected)}`);
}

/* ------------------------------------------------------------------ helpers */

const TC_BLITZ = time.timeControlById('blitz-5-3');
const TC_RAPID = time.timeControlById('rapid-10-5');

function bot(id, preset, rating) {
  return personality.createPresetProfile({
    id,
    preset,
    rating,
    createdAt: 1_700_000_000_000,
  });
}

const BOTS = [
  bot('bot_a', 'aggressive', 1800),
  bot('bot_b', 'positional', 1900),
  bot('bot_c', 'defensive', 2000),
  bot('bot_d', 'gambit', 2100),
  bot('bot_e', 'endgame', 2200),
];

function settings(overrides = {}) {
  return {
    name: 'Test Arena',
    mode: 'bots',
    format: 'round-robin',
    timeControl: TC_BLITZ,
    rated: true,
    rounds: 5,
    colourPreference: 'random',
    continuation: 'immediate',
    botIds: [],
    humanColor: 'random',
    ...overrides,
  };
}

function build(overrides = {}, count = 4, list = BOTS) {
  return storeLib.buildTournament(
    storeLib.emptyArenaData(),
    settings(overrides),
    list.slice(0, count),
    1_700_000_100_000,
  );
}

function tournamentOf(data, id) {
  return data.tournaments.find((t) => t.id === id);
}

function resultFor(game, result = '1-0') {
  return result;
}

/** Finish every game in the current round, then advance if the format asks. */
function playRound(data, tournamentId, pick = resultFor) {
  let next = data;
  const before = tournamentOf(next, tournamentId);
  const round = before.currentRound;
  const games = before.games.filter((g) => g.round === round && g.status !== 'done');
  for (const g of games) {
    next = storeLib.recordGameResult(next, tournamentId, g.id, pick(g));
  }
  const after = tournamentOf(next, tournamentId);
  if (after.status === 'active' && pairing.roundComplete(after, round)) {
    next = storeLib.advanceTournament(next, tournamentId);
  }
  return next;
}

/* ------------------------------------------------------------------ 1. Elo */

eq(ratings.eloDelta(1500, 1500, 1), 16, 'an even win is +16 at K=32');
eq(ratings.eloDelta(1500, 1500, 0), -16, 'an even loss is -16 at K=32');
eq(ratings.eloDelta(1500, 1500, 0.5), 0, 'an even draw changes nothing');
ok(
  ratings.eloDelta(1700, 1400, 1) < ratings.eloDelta(1400, 1700, 1),
  'the favourite gains less for winning than the underdog',
);
eq(ratings.applyElo(100, 2400, 0), 100, 'applyElo never drops below 100');
deepEq(ratings.normalizeRatings({ blitz: 1725 }), {
  bullet: 1500, blitz: 1725, rapid: 1500, classical: 1500,
}, 'normalizeRatings fills missing pools with 1500');
deepEq(ratings.normalizeRatings({ rapid: Number.NaN, classical: Number.POSITIVE_INFINITY }), {
  bullet: 1500, blitz: 1500, rapid: 1500, classical: 1500,
}, 'normalizeRatings rejects non-finite stored values');
eq(ratings.initialBotRating({ playElo: 2200, rating: 900 }), 2200,
  'a bot starts from its playing strength, not its source rating');

/* -------------------------------------------------------------- 2. time control */

eq(time.classifyTimeControl(60, 0), 'bullet', '1+0 is bullet');
eq(time.classifyTimeControl(180, 0), 'blitz', '3+0 is blitz');
eq(time.classifyTimeControl(600, 5), 'rapid', '10+5 is rapid');
eq(time.classifyTimeControl(1800, 0), 'classical', '30+0 is classical');
eq(time.formatClock(65), '1:05', 'formatClock renders m:ss');
eq(time.formatClock(3661), '1:01:01', 'formatClock renders h:mm:ss');
eq(time.ratedAllowed(time.timeControlById('untimed')), true,
  'untimed games CAN be rated — a result without a clock is still a result');
const custom = time.customTimeControl(600, 5);
eq(custom.category, 'rapid', 'custom 10+5 lands in the rapid pool');
eq(custom.untimed, false, 'custom positive time is timed');

/* --------------------------------------------------------------- 3. round robin */

{
  const { data, tournament } = build({ format: 'round-robin' }, 4);
  eq(tournament.status, 'active', 'an immediate round robin starts active');
  eq(tournament.games.length, 6, 'four players produce six round-robin games');
  eq(new Set(tournament.games.map((g) => g.round)).size, 3, 'four players need three rounds');
  const pairCounts = new Map();
  for (const g of tournament.games) {
    const key = [g.whiteId, g.blackId].sort().join('|');
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  eq(pairCounts.size, 6, 'every pair meets exactly once');
  ok([...pairCounts.values()].every((n) => n === 1), 'no round-robin pair repeats');
  const whites = new Map(tournament.participants.map((p) => [p.id, 0]));
  const blacks = new Map(tournament.participants.map((p) => [p.id, 0]));
  for (const g of tournament.games) {
    whites.set(g.whiteId, whites.get(g.whiteId) + 1);
    if (g.blackId) blacks.set(g.blackId, blacks.get(g.blackId) + 1);
  }
  ok([...whites.values()].every((n) => n === 1 || n === 2), 'white counts are balanced');
  ok([...blacks.values()].every((n) => n === 1 || n === 2), 'black counts are balanced');
  eq(tournament.participants.length, 4, 'the human is not added in bot mode');
  eq(data.humanRatings.blitz, 1500, 'creating a tournament does not move the human rating');
}

{
  const { tournament } = build({ format: 'round-robin' }, 5);
  eq(tournament.rounds, 5, 'five players need five rounds');
  eq(tournament.games.filter((g) => g.result === 'bye').length, 5, 'five players produce five byes');
  eq(tournament.games.filter((g) => g.result !== 'bye').length, 10, 'five players play ten real games');
  eq(new Set(tournament.games.filter((g) => g.result === 'bye').map((g) => g.byeId)).size, 5,
    'each player gets exactly one bye');
}

{
  const { tournament } = build({ format: 'double-round-robin' }, 4);
  eq(tournament.games.length, 12, 'four players play twelve double-round-robin games');
  eq(tournament.rounds, 6, 'double round robin doubles the rounds');
  const pairs = new Map();
  for (const g of tournament.games) {
    const key = [g.whiteId, g.blackId].sort().join('|');
    const entry = pairs.get(key) ?? { count: 0, whites: new Set() };
    entry.count += 1;
    entry.whites.add(g.whiteId);
    pairs.set(key, entry);
  }
  eq(pairs.size, 6, 'every pair appears in a double round robin');
  ok([...pairs.values()].every((p) => p.count === 2 && p.whites.size === 2),
    'each double-round-robin pair plays both colours once');
}

/* ------------------------------------------------------------------ 4. Swiss/Arena */

{
  let data = build({ format: 'swiss', rounds: 3 }, 4).data;
  const id = data.tournaments[0].id;
  const seen = new Set();
  for (let round = 1; round <= 3; round++) {
    const before = tournamentOf(data, id);
    const games = before.games.filter((g) => g.round === round && g.result !== 'bye');
    for (const g of games) {
      const key = [g.whiteId, g.blackId].sort().join('|');
      ok(!seen.has(key), `Swiss round ${round} does not repeat a pairing`);
      seen.add(key);
    }
    data = playRound(data, id);
  }
  const done = tournamentOf(data, id);
  eq(done.status, 'completed', 'a three-round Swiss completes after three rounds');
  eq(done.games.filter((g) => g.result !== 'bye').length, 6, 'four players play two games per Swiss round');
  eq(done.championId, done.participants.find((p) => p.id === done.championId)?.id,
    'the Swiss champion is one of the field');
}

{
  let data = build({ format: 'arena', rounds: 3 }, 4).data;
  const id = data.tournaments[0].id;
  for (let round = 1; round <= 3; round++) data = playRound(data, id);
  const done = tournamentOf(data, id);
  eq(done.status, 'completed', 'a three-round Arena event completes');
  eq(done.games.filter((g) => g.result !== 'bye').length, 6, 'Arena still plays one game per player per round');
}

{
  const { tournament } = build({ format: 'swiss', rounds: 3 }, 5);
  const firstBye = tournament.games.find((g) => g.result === 'bye');
  const lowest = tournament.participants.reduce((a, b) => (a.rating <= b.rating ? a : b));
  eq(firstBye?.byeId, lowest.id, 'the first Swiss bye goes to the lowest-scoring player, which is the lowest seed before round one');
}

/* ------------------------------------------------------------------ 5. knockout */

{
  let data = build({ format: 'knockout' }, 4).data;
  const id = data.tournaments[0].id;
  let t = tournamentOf(data, id);
  eq(t.games.length, 2, 'a four-player knockout starts with two games');
  eq(t.rounds, 2, 'a four-player knockout needs two rounds');
  data = playRound(data, id);
  t = tournamentOf(data, id);
  eq(t.games.length, 3, 'the winners meet in the final (two semis and one final)');
  eq(t.currentRound, 2, 'the bracket advances to round two');
  data = playRound(data, id);
  t = tournamentOf(data, id);
  eq(t.status, 'completed', 'the knockout final completes the tournament');
  ok(!!t.championId, 'the knockout has a champion');
  eq(t.championId, t.games.find((g) => g.round === 2)?.winnerId,
    'the knockout champion is the final winner');
}

{
  const { tournament } = build({ format: 'knockout' }, 5);
  const bye = tournament.games.find((g) => g.result === 'bye');
  const topSeed = tournament.participants.find((p) => p.seed === 1);
  eq(bye?.byeId, topSeed?.id, 'an odd knockout field gives the bye to the top seed');
}

{
  const { data, tournament } = build({ format: 'knockout' }, 2);
  const g = tournament.games[0];
  const next = storeLib.recordGameResult(data, tournament.id, g.id, '1/2-1/2', { reason: 'Draw agreed' });
  const done = tournamentOf(next, tournament.id);
  const final = done.games.find((x) => x.id === g.id);
  eq(final.result, '1/2-1/2', 'a knockout draw still displays as a draw');
  eq(final.winnerId, null, 'a drawn knockout game does not pick a winner on a rating');
  eq(done.status, 'active', 'the final is not over: an Armageddon tiebreak is scheduled');
  const tb = done.games.find((x) => x.armageddon);
  ok(!!tb, 'a level knockout match gets an Armageddon game');
  eq(tb.status, 'pending', 'the Armageddon is the next game to play');
  eq(tb.whiteId, g.blackId, 'the player who had Black in the regulation game gets White in the Armageddon');
  eq(tb.blackId, g.whiteId, 'and the other gets Black, with the draw odds');
  ok((tb.clockStart?.white ?? 0) > (tb.clockStart?.black ?? 0),
    'White has the longer Armageddon clock');

  // A drawn Armageddon sends Black through.
  const after = storeLib.recordGameResult(next, tournament.id, tb.id, '1/2-1/2');
  const crowned = tournamentOf(after, tournament.id);
  eq(crowned.championId, tb.blackId, 'the drawn Armageddon crowns Black');
  eq(crowned.status, 'completed', 'and the tournament is over');
  ok(/Armageddon drawn/.test(crowned.games.find((x) => x.id === tb.id)?.reason ?? ''),
    'the saved reason explains the Armageddon result');
}

/*
 * TWO LEGS, BOTH COLOURS. A level 1–1 match goes to Armageddon; a decisive one
 * does not.
 */
{
  const { data, tournament } = build({ format: 'knockout', knockoutLegs: 2 }, 2);
  eq(tournament.knockoutLegs, 2, 'the match length is stored');
  const legs = tournament.games.filter((g) => !g.armageddon && g.blackId);
  eq(legs.length, 2, 'a two-leg match schedules two games');
  eq(legs[0].whiteId, legs[1].blackId, 'and the second leg swaps the colours');
  eq(legs[0].blackId, legs[1].whiteId, 'both colours are played once each');

  let dataNext = data;
  for (const leg of legs) {
    dataNext = storeLib.recordGameResult(dataNext, tournament.id, leg.id, '1/2-1/2');
  }
  const level = tournamentOf(dataNext, tournament.id);
  const tb = level.games.find((x) => x.armageddon);
  ok(!!tb, 'a 1–1 match over two legs goes to Armageddon');

  // A decisive second leg avoids it.
  const { data: d2, tournament: t2 } = build({ format: 'knockout', knockoutLegs: 2 }, 2);
  const legs2 = t2.games.filter((g) => !g.armageddon && g.blackId);
  let d2Next = storeLib.recordGameResult(d2, t2.id, legs2[0].id, '1-0');
  d2Next = storeLib.recordGameResult(d2Next, t2.id, legs2[1].id, '0-1');
  const decided = tournamentOf(d2Next, t2.id);
  ok(!decided.games.some((x) => x.armageddon),
    'a decided two-leg match needs no Armageddon');
  eq(decided.championId, legs2[0].whiteId, 'and the same player winning both legs is crowned');

  /*
   * A HUMAN'S COLOUR CHOICE MUST NOT BREAK THE TWO-LEG FORMAT. Flipping only the
   * first leg would give the human the same colour twice.
   */
  const humanTwoLegs = build({
    format: 'knockout', mode: 'human', colourPreference: 'white', knockoutLegs: 2,
  }, 1, [bot('only_bot', 'positional', 1600)]);
  const mine = humanTwoLegs.tournament.games.filter((g) => g.whiteId === 'you' || g.blackId === 'you');
  eq(mine.length, 2, 'the human plays both legs');
  ok(mine.some((g) => g.whiteId === 'you') && mine.some((g) => g.blackId === 'you'),
    'and gets one game with each colour, even after honouring the preference');
}

/* --------------------------------------------------------------- 6. standings */

{
  const equal = [
    bot('eq_a', 'aggressive', 1500),
    bot('eq_b', 'positional', 1500),
    bot('eq_c', 'defensive', 1500),
    bot('eq_d', 'gambit', 1500),
  ];
  const { data, tournament } = build({ format: 'round-robin' }, 4, equal);
  const g = tournament.games[0];
  const next = storeLib.recordGameResult(data, tournament.id, g.id, '1-0');
  const t = tournamentOf(next, tournament.id);
  const standings = pairing.computeStandings(t);
  const winner = standings.find((s) => s.participant.id === g.whiteId);
  const loser = standings.find((s) => s.participant.id === g.blackId);
  eq(winner.points, 1, 'a win is one point');
  eq(loser.points, 0, 'a loss is zero points');
  eq(winner.played, 1, 'a win counts as played');
  eq(winner.performance, 1700, 'beating an equal player estimates 1700 performance');
  eq(loser.performance, 1300, 'losing to an equal player estimates 1300 performance');
  eq(standings[0].participant.id, winner.participant.id, 'the winner leads the table');
  eq(standings[0].rank, 1, 'the leader is ranked first');
}

{
  const equal = [bot('bye_a', 'aggressive', 1500), bot('bye_b', 'positional', 1500)];
  const tournament = {
    id: 'bye_only', name: 'Bye only', mode: 'bots', format: 'round-robin',
    timeControl: TC_BLITZ, rated: true, rounds: 1, colourPreference: 'random',
    continuation: 'immediate', createdAt: 1, startedAt: 1,
    participants: equal.map((p, i) => ({
      id: p.id, kind: 'bot', name: p.name, rating: 1500, startingRating: 1500,
      seed: i + 1, bot: p,
    })),
    games: [{
      id: 'bye_game', round: 1, board: 1, whiteId: equal[0].id, blackId: null,
      byeId: equal[0].id, status: 'done', result: 'bye', winnerId: equal[0].id,
      moves: [], clockHistory: [],
    }],
    currentRound: 1, status: 'active',
  };
  const standings = pairing.computeStandings(tournament);
  const byeRow = standings.find((s) => s.participant.id === equal[0].id);
  eq(byeRow.byes, 1, 'the bye is recorded');
  eq(byeRow.performance, null, 'a player with only a bye has no performance estimate');
}

/* --------------------------------------------------------- 7. lifecycle + ratings */

{
  const equal = [bot('rate_a', 'aggressive', 1500), bot('rate_b', 'positional', 1500)];
  const { data, tournament } = build({ format: 'round-robin' }, 2, equal);
  const g = tournament.games[0];
  const whiteBefore = data.botRatings[g.whiteId].blitz;
  const blackBefore = data.botRatings[g.blackId].blitz;
  const next = storeLib.recordGameResult(data, tournament.id, g.id, '1-0');
  eq(next.humanRatings.blitz, 1500, 'a bot-vs-bot game never moves the human rating');
  eq(next.botRatings[g.whiteId].blitz, whiteBefore + 16, 'the winning bot gains 16 against an equal bot');
  eq(next.botRatings[g.blackId].blitz, blackBefore - 16, 'the losing bot loses 16 against an equal bot');
  eq(next.history.filter((h) => h.participantId === 'you').length, 0,
    'bot-vs-bot history has no human entries');
  const done = tournamentOf(next, tournament.id);
  eq(done.status, 'completed', 'a one-game round robin completes after its only game');
  eq(done.championId, g.whiteId, 'the winner is the champion');
  ok(!!done.completedAt, 'the completion time is recorded');
}

{
  const { data, tournament } = build({ format: 'round-robin', rated: false }, 2);
  const g = tournament.games[0];
  const next = storeLib.recordGameResult(data, tournament.id, g.id, '1-0');
  deepEq(next.botRatings, data.botRatings, 'an unrated game moves no bot ratings');
  deepEq(next.humanRatings, data.humanRatings, 'an unrated game moves no human ratings');
  eq(next.history.length, 0, 'an unrated game writes no rating history');
}

{
  /*
   * UNTIMED IS A VALID RATED CONTROL. The owner played a rated tournament
   * without clocks and saw their rating never move, because the event was
   * silently downgraded to unrated. An untimed game still has a result, and the
   * result still moves the pool.
   */
  const { data, tournament } = build({ format: 'round-robin', timeControl: time.timeControlById('untimed'), rated: true }, 2);
  eq(tournament.rated, true, 'a requested rated untimed tournament stays rated');
  const g = tournament.games[0];
  const next = storeLib.recordGameResult(data, tournament.id, g.id, '1-0');
  ok(Object.keys(next.botRatings).some((id) => next.botRatings[id].classical !== data.botRatings[id]?.classical),
    'an untimed rated game moves ratings in the Classical pool');
}

{
  const equal = [bot('human_opponent', 'positional', 1500)];
  const { data, tournament } = build({ format: 'round-robin', mode: 'human' }, 1, equal);
  eq(tournament.participants.length, 2, 'human mode adds the human to the field');
  const human = tournament.participants.find((p) => p.kind === 'human');
  const g = tournament.games[0];
  const next = storeLib.recordGameResult(data, tournament.id, g.id, g.whiteId === human.id ? '1-0' : '0-1');
  eq(next.humanRatings.blitz, 1516, 'a human win against an equal bot raises the human pool');
  ok(next.history.some((h) => h.participantId === 'you'), 'the human game is written to rating history');
}

{
  /*
   * Seed the human between two bots so board one is bot-vs-bot. The next-game
   * card and "Play now" must still offer the human's own pairing.
   */
  const mixed = [
    bot('high_bot', 'aggressive', 2200),
    bot('mid_bot', 'positional', 1800),
    bot('low_bot', 'defensive', 1400),
  ];
  const { tournament } = build({ format: 'round-robin', mode: 'human' }, 3, mixed);
  const next = pairing.nextPendingGame(tournament);
  ok(
    !!next && (next.whiteId === 'you' || next.blackId === 'you'),
    'a human tournament offers the human game before a bot-only board',
  );
  eq(next?.board, 2, 'the human game can sit behind board one');
}

/* --------------------------------------------------------------- 8. draft flow */

{
  const { data, tournament } = build({ continuation: 'later', format: 'round-robin' }, 4);
  eq(tournament.status, 'draft', 'save-for-later creates a draft');
  eq(tournament.games.length, 0, 'a draft has no pairings yet');
  eq(tournament.startedAt, undefined, 'a draft has not started');
  const edited = storeLib.updateDraftSettingsData(data, tournament.id, {
    name: 'Edited Cup',
    format: 'swiss',
    timeControl: TC_RAPID,
    rated: false,
    rounds: 3,
  });
  const draft = tournamentOf(edited, tournament.id);
  eq(draft.status, 'draft', 'editing a draft leaves it a draft');
  eq(draft.name, 'Edited Cup', 'the draft name can be edited');
  eq(draft.format, 'swiss', 'the draft format can be edited');
  eq(draft.timeControl.category, 'rapid', 'the draft time control can be edited');
  eq(draft.rounds, 3, 'the draft Swiss round count can be edited');
  eq(draft.rated, false, 'the draft rated flag can be edited');
  eq(draft.games.length, 0, 'editing a draft does not create pairings');
  ok(draft.participants.every((p) => p.rating === edited.botRatings[p.id]?.rapid),
    'editing the pool re-reads each bot rapid rating');
  const started = storeLib.startTournamentData(edited, tournament.id);
  const live = tournamentOf(started, tournament.id);
  eq(live.status, 'active', 'starting a draft makes it active');
  eq(live.games.length, 2, 'starting a four-player Swiss creates the first round');
  eq(live.currentRound, 1, 'a started draft begins at round one');
  ok(typeof live.startedAt === 'number', 'starting a draft records its start time');
}

{
  let threw = false;
  try {
    build({ mode: 'bots' }, 1);
  } catch {
    threw = true;
  }
  ok(threw, 'a bot championship refuses a field with fewer than two bots');
}

/* --------------------------------------------------------------- 9. snapshots */

{
  const source = BOTS[0];
  const originalName = source.name;
  const { tournament } = build({ format: 'round-robin', mode: 'human' }, 1);
  source.name = 'Changed After Creation';
  const participant = tournament.participants.find((p) => p.id === source.id);
  eq(participant?.bot?.name, originalName, 'the tournament keeps a frozen bot snapshot');
  source.name = originalName;
}

/* --------------------------------------------------------------- 10. persistence */

{
  const { data } = build({ format: 'round-robin' }, 2);
  await storeLib.saveArenaData(data);
  const loaded = await storeLib.loadArenaData();
  eq(loaded.tournaments.length, 1, 'a saved tournament loads back');
  eq(loaded.tournaments[0].games.length, data.tournaments[0].games.length,
    'the loaded tournament keeps its games');
  await storeLib.clearArenaData();
  eq((await storeLib.loadArenaData()).tournaments.length, 0, 'clearing removes the Arena key');
}

{
  /*
   * A move save and a result save are both load-modify-save. The move save is
   * deliberately slow; without the store's write queue it can load the pre-result
   * data and write it after the result, turning a finished game back into a live
   * one. The queue must make the result the last write.
   */
  const { data, tournament } = build({ format: 'round-robin' }, 2);
  const g = tournament.games[0];
  await storeLib.saveArenaData(data);
  writeDelayMs = 25;
  const stateWrite = storeLib.saveTournamentGameState(tournament.id, g.id, {
    moves: [{ san: 'e4', from: 'e2', to: 'e4', color: 'white' }],
    clocks: { white: 300, black: 300 },
    clockHistory: [],
  });
  const resultWrite = storeLib.saveTournamentGameResult(tournament.id, g.id, '1-0');
  await Promise.all([stateWrite, resultWrite]);
  writeDelayMs = 0;
  const final = await storeLib.loadArenaData();
  const savedGame = final.tournaments[0].games.find((x) => x.id === g.id);
  eq(savedGame?.status, 'done', 'a queued result is not overwritten by a slower move save');
  eq(savedGame?.result, '1-0', 'the queued result survives the move save');
  eq(savedGame?.moves.length, 1, 'the result write keeps the move list');
}

{
  /*
   * Leaving a game starts a queued save and immediately opens the tournament.
   * The tournament reader must wait for that write instead of loading the old
   * snapshot and repainting the lobby from stale data.
   */
  const { data } = build({ format: 'round-robin' }, 2);
  await storeLib.saveArenaData(data);
  writeDelayMs = 25;
  const pendingWrite = storeLib.saveArenaData({
    ...data,
    humanRatings: { ...data.humanRatings, blitz: 1616 },
  });
  const loaded = await storeLib.loadArenaData();
  writeDelayMs = 0;
  eq(loaded.humanRatings.blitz, 1616, 'a reader waits for a queued Arena write');
  await pendingWrite;
}

{
  /*
   * Round-robin pairings for every round are created up front. A caller can
   * legitimately submit those games out of round order; once every scheduled
   * game is done the tournament must complete even if currentRound never moved.
   */
  const { data, tournament } = build({ format: 'round-robin' }, 4);
  let next = data;
  for (const game of tournament.games) {
    next = storeLib.recordGameResult(next, tournament.id, game.id, '1-0');
  }
  const completed = tournamentOf(next, tournament.id);
  eq(completed.status, 'completed',
    'a fully played round robin completes without walking the round counter');
  eq(completed.games.every((g) => g.status === 'done'), true,
    'every scheduled round-robin game is saved as done');
}

{
  const raw = {
    v: 1,
    tournaments: [{
      id: 'draft_1',
      name: 'Draft',
      mode: 'bots',
      format: 'swiss',
      timeControl: TC_BLITZ,
      rated: true,
      rounds: 3,
      colourPreference: 'random',
      continuation: 'later',
      createdAt: 1,
      participants: [],
      games: [],
      currentRound: 1,
      status: 'draft',
    }],
    humanRatings: { blitz: 1725 },
    botRatings: {},
    history: [],
  };
  const normalised = storeLib.normaliseArenaData(raw);
  eq(normalised.tournaments[0].status, 'draft', 'normalisation preserves a draft status');
  eq(normalised.humanRatings.blitz, 1725, 'normalisation preserves a human rating');
  eq(normalised.humanRatings.bullet, 1500, 'normalisation fills a missing rating pool');
}

/* --------------------------------------------------------------- 11. game helpers */

{
  const { tournament } = build({ format: 'round-robin' }, 2);
  const g = tournament.games[0];
  const move = { san: 'e4', from: 'e2', to: 'e4', color: 'white' };
  const arenaGame = {
    ...g,
    status: 'done',
    result: '1-0',
    winnerId: g.whiteId,
    moves: [move],
    clockHistory: [{ ply: 1, white: 300, black: 300 }],
  };
  const pgn = gameLib.arenaPgn(tournament, arenaGame, '1-0');
  ok(pgn.includes(`[White "${tournament.participants.find((p) => p.id === g.whiteId).name}"]`),
    'PGN names the white player');
  ok(pgn.includes(`[Black "${tournament.participants.find((p) => p.id === g.blackId).name}"]`),
    'PGN names the black player');
  ok(pgn.includes('[Result "1-0"]'), 'PGN carries the result');
  ok(pgn.includes('1. e4'), 'PGN carries the move text');

  const replay = gameLib.replayArenaGame([move]);
  eq(replay.fen().split(' ')[0], 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR',
    'replayArenaGame applies saved moves');

  const promotionBoard = new Chess();
  const promotionMoves = [];
  for (const san of ['g4', 'h5', 'gxh5', 'g6', 'hxg6', 'Nf6', 'g7', 'Ng4', 'gxh8=N']) {
    const m = promotionBoard.move(san);
    promotionMoves.push({
      san: m.san,
      from: m.from,
      to: m.to,
      color: m.color === 'w' ? 'white' : 'black',
      promotion: m.promotion,
    });
  }
  const promoted = gameLib.replayArenaGame(promotionMoves);
  eq(promoted.get('h8')?.type, 'n', 'an underpromotion replays as the saved piece, not a queen');
  const clocks = gameLib.startingClocks(300);
  deepEq(clocks, { white: 300, black: 300 }, 'startingClocks gives both sides the initial time');
  deepEq(gameLib.addIncrement(clocks, 'white', 3, 300), { white: 303, black: 300 },
    'increment is applied to the player who moved');

  const mate = new Chess();
  mate.move('f3');
  mate.move('e5');
  mate.move('g4');
  mate.move('Qh4#');
  const outcome = gameLib.outcomeFromChess(mate, g.whiteId, g.blackId);
  eq(outcome?.result, '0-1', 'checkmate is detected for black');
  eq(outcome?.winnerId, g.blackId, 'the checkmated side loses');

  const kings = new Chess('8/8/8/8/8/8/8/K6k w - - 0 1');
  eq(gameLib.timeoutOutcome('white', kings, g.whiteId, g.blackId).result, '1/2-1/2',
    'a timeout with insufficient material is a draw');
}

/* --------------------------------------------------- 12. screen invariants */

{
  const gameScreen = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/ArenaGameScreen.tsx'),
    'utf8',
  );
  ok(gameScreen.includes('const replay = replayArenaGame(g.moves);'),
    'resuming a game replays saved promotions through the shared helper');
  ok(gameScreen.includes('setReviewPly(movesRef.current.length);'),
    'a game finished on screen opens review at its final position');
  ok(/\[engineError, finish, live, paused, tournament, untimed\]/.test(gameScreen),
    'the clock effect restarts when the loaded tournament supplies its clocks');

  const tournamentScreen = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/TournamentScreen.tsx'),
    'utf8',
  );
  ok(tournamentScreen.includes('const canOpen = !bye && !future;'),
    'future round-robin games wait for the current round');
}

/* ------------------------------------------------- 11. the tournament field */

/*
 * THE REQUEST: *"for the tournaments, the user should be able to choose the
 * number of bots who would play in the tournament"*. Selection is the pool; the
 * count is the field. These are the rules the create screen applies.
 */
{
  const all = ['a', 'b', 'c', 'd', 'e', 'f'];
  eq(fieldLib.tournamentField(all, all, 4, 2).join(','), 'a,b,c,d',
    'the count takes the selected bots first, in order');
  eq(fieldLib.tournamentField(['e'], all, 3, 2).join(','), 'e,a,b',
    'a short selection is topped up from the library to reach the count');
  eq(fieldLib.tournamentField(all, all, 99, 2).length, 6,
    'a count larger than the library is clamped to the library');
  eq(fieldLib.tournamentField([], all, 1, 2).join(','), 'a,b',
    'the mode minimum still applies');
  eq(fieldLib.tournamentField([], [], 4, 2).length, 0,
    'no bots means no field instead of a crash');
  eq(fieldLib.tournamentField(['zzz', 'a'], all, 2, 2).join(','), 'a,b',
    'an id that is not in the library is ignored');

  deepEq(fieldLib.tournamentCountBounds(6, 2), { min: 2, max: 6 },
    'the count is bounded by the library and the mode minimum');
  deepEq(fieldLib.tournamentCountBounds(1, 2), { min: 1, max: 1 },
    'a one-bot library cannot claim a two-bot minimum it cannot meet');

  const createScreen = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/CreateTournamentScreen.tsx'),
    'utf8',
  );
  ok(/Bots in the tournament/.test(createScreen),
    'the create screen exposes the participant-count control');
  ok(/tournamentField\(selected, availableIds, effectiveCount, minBots\)/.test(createScreen),
    'and the created field is the count, not the whole selection');
}

/* ------------------------------------------- 12. one winner, by real rules */

/*
 * THE REPORT: *"we draw the match and the app says the bot won the tournament!
 * no tie break ... then how he won?"* There must be ONE winner, and the rule
 * that chose them must be a published tiebreak, not a hidden rating.
 *
 * In a single drawn game every chess measure is level; the published ladder's
 * last discriminating rule is "more games with Black", so the player who had
 * Black takes first place — and the sheet can say so.
 */
{
  const { data, tournament } = build({ format: 'round-robin' }, 2);
  eq(tournament.games.length, 1, 'a two-player round robin is one game');
  const g = tournament.games[0];
  const next = storeLib.recordGameResult(data, tournament.id, g.id, '1/2-1/2');
  const done = next.tournaments.find((t) => t.id === tournament.id);
  eq(done.status, 'completed', 'the drawn game completes the event');
  const standings = storeLib.computeStandings(done);
  eq(standings[0].rank, 1, 'first place is rank 1');
  eq(standings[1].rank, 2, 'second place is rank 2 — the sheet has one winner');
  eq(done.championId, g.blackId,
    'the drawn game still has one champion: the player who had Black wins the last tiebreak');
  eq(storeLib.championOf(done)?.participant.id, g.blackId,
    'championOf agrees with the stored champion');
  eq(storeLib.championTiebreakNote(done), 'more games with Black',
    'and the rule that separated them is nameable');
  ok(standings[0].blackGames === 1 && standings[1].blackGames === 0,
    'the count behind that rule is on the standings row');
}

/*
 * A RATING IS NOT A RESULT. Give the two players very different ratings; the
 * drawn game must still be decided by the chess tiebreak, not by who is
 * stronger on paper.
 */
{
  const low = bot('low', 'positional', 1200);
  const high = bot('high', 'aggressive', 2400);
  const { data, tournament } = build({ format: 'round-robin' }, 2, [high, low]);
  const g = tournament.games[0];
  const next = storeLib.recordGameResult(data, tournament.id, g.id, '1/2-1/2');
  const done = next.tournaments.find((t) => t.id === tournament.id);
  eq(done.championId, g.blackId,
    'the champion is decided by the tiebreak ladder, not by the higher rating');
}

/* ------------------------------------------------ 13. a rated casual game */

/*
 * "A game against a bot outside a tournament is still a game." The same Elo and
 * the same pools as a rated Arena game, with two history rows so the profile's
 * last-played category is right.
 */
{
  await storeLib.clearArenaData();
  const change = await storeLib.recordCasualGame({
    botId: 'casual_bot',
    botProfile: { playElo: 1500, rating: 1500 },
    category: 'blitz',
    humanScore: 1,
  });
  ok(!!change, 'a casual rated result returns the rating movement');
  eq(change.category, 'blitz', 'it lands in the chosen pool');
  eq(change.humanDelta, 16, 'a win over an equal bot is +16 at K=32');
  eq(change.botDelta, -16, 'and the bot loses the same');
  const data = await storeLib.loadArenaData();
  eq(data.humanRatings.blitz, 1516, 'the human pool is written');
  eq(data.botRatings.casual_bot.blitz, 1484, 'the bot pool is written');
  ok(data.history.some((h) => h.participantId === 'you' && h.category === 'blitz'),
    'the profile can see the category the user last played');
}

/* ------------------------------------------------- 14. the in-game controls */

{
  const gameScreen = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/ArenaGameScreen.tsx'),
    'utf8',
  );
  ok(/IconFlag/.test(gameScreen) && /label="Resign"/.test(gameScreen),
    'Arena resigns with the conventional flag, like the bot games');
  ok(/IconUndo/.test(gameScreen) && /label="Undo last move"/.test(gameScreen),
    'and offers the same undo button');
  ok(/label="Offer draw"/.test(gameScreen) && /offerDraw/.test(gameScreen),
    'the draw is a proposal, not an instant result');
  ok(/drawGlyph/.test(gameScreen) && !/label="½ Draw"/.test(gameScreen),
    'and it is an icon-sized ½ button, not a full-width button');
  ok(/DRAW_ACCEPT_CP/.test(gameScreen) && /declines the draw/.test(gameScreen),
    'the bot answers a draw offer — and can decline it');
  ok(/botShouldResign/.test(gameScreen),
    'the bot can still resign a lost game instead of playing it out');
  ok(/playMoveSound/.test(gameScreen) && /playGameEnd/.test(gameScreen),
    'Arena moves and endings have sounds');
  const tournamentScreen = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/TournamentScreen.tsx'),
    'utf8',
  );
  ok(/playTournamentSound/.test(tournamentScreen),
    'entering a tournament has its own fanfare');
  ok(/championTiebreakNote/.test(tournamentScreen)
    && /won on the tiebreak/.test(tournamentScreen),
    'the final sheet says which tiebreak chose the winner');

  /*
   * THE OWNER'S TWO REMINDERS: a knockout match can be one game or two (both
   * colours), a level match goes to Armageddon, and tournaments survive a
   * relaunch until the user deletes them.
   */
  const createScreenSrc = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/CreateTournamentScreen.tsx'),
    'utf8',
  );
  ok(/Match length/.test(createScreenSrc) && /2 games \(both colours\)/.test(createScreenSrc)
    && /knockoutLegs/.test(createScreenSrc),
    'knockout creation offers one game or two legs with both colours');
  ok(/Armageddon/.test(createScreenSrc),
    'and says a level match is decided by Armageddon');
  const arenaScreen = fs.readFileSync(path.join(ROOT, 'src/components/screens/ArenaScreen.tsx'), 'utf8');
  ok(/deleteTournament/.test(arenaScreen) && /Delete this tournament\?/.test(arenaScreen),
    'a saved tournament can be deleted when the user is done with it');
  ok(/Save for later/.test(createScreenSrc),
    'and tournaments are saved for later play');

  /*
   * A CASUAL GAME OFFERS THE SAME CHOICES. Rated or not, and a real time
   * control with a clock; a rated result moves the same pool.
   */
  const botScreen = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/BotPlayScreen.tsx'),
    'utf8',
  );
  ok(/recordCasualGame/.test(botScreen) && /Game settings/.test(botScreen)
    && /Time control/.test(botScreen) && /label: 'Rated'/.test(botScreen),
    'a game against a bot lets the user choose rated and a time control');
  ok(/startingClocks/.test(botScreen) && /formatClock/.test(botScreen)
    && /setTimedOutWinner/.test(botScreen),
    'a timed casual game has a real clock and can flag');
  const profileScreen = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/ProfileScreen.tsx'),
    'utf8',
  );
  ok(/arenaRatings\?\.\[primaryCategory\]/.test(profileScreen),
    'the profile header shows the ChessForge rating, not the puzzle rating');

  /* CELEBRATIONS AND MEDALS. A game win and a tournament win each have a banner. */
  const storeSrc = fs.readFileSync(path.join(ROOT, 'src/lib/store.ts'), 'utf8');
  ok(/type GlobalCelebrationKind = 'gamewin' \| 'champion'/.test(storeSrc)
    && /celebrate: \(kind, detail = ''\)/.test(storeSrc),
    'the store can raise a game-win and a tournament-win celebration');
  const bannerSrc = fs.readFileSync(path.join(ROOT, 'src/components/CelebrationBanner.tsx'), 'utf8');
  ok(/case 'gamewin':/.test(bannerSrc) && /case 'champion':/.test(bannerSrc),
    'the banner has copy for both victory moments');
  ok(/MEDAL\[/.test(tournamentScreen) && /row\.rank <= 3/.test(tournamentScreen),
    'the top three places get medals');
}

/* ---------------------------------- 15. the owner's follow-up reports */

{
  /*
   * HOME SHOWS THE APP RATING, NOT THE PUZZLE RATING.
   * The report: *"at home there is still a rating 800 on puzzles! it should be
   * his rating in the app, no more his puzzle rating there"*.
   */
  const homeScreen = fs.readFileSync(path.join(ROOT, 'src/components/screens/HomeScreen.tsx'), 'utf8');
  ok(/loadArenaData/.test(homeScreen) && /ChessForge Arena/.test(homeScreen),
    'the home header reads the ChessForge rating');
  ok(!/label: 'puzzle rating'/.test(homeScreen),
    'and the puzzle rating is gone from the home header');
  ok(/arenaRating\?\.value/.test(homeScreen),
    'the header number comes from the ChessForge rating, not the puzzle rating');

  /*
   * "YOU VS BOTS" IS THE DEFAULT AND SITS ON THE LEFT.
   */
  const createScreen = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/CreateTournamentScreen.tsx'), 'utf8',
  );
  ok(/useState<ArenaMode>\('human'\)/.test(createScreen),
    'the create screen defaults to "You vs bots"');
  ok(/\{ id: 'human', label: 'You vs bots' \},\s*\n\s*\{ id: 'bots', label: 'Bot championship' \}/.test(createScreen),
    'and "You vs bots" is the left-hand option');
  ok(/setPlayerCount\(list\.length > 0 \? 1 : 0\)/.test(createScreen),
    'a human event defaults to a single opponent, not a four-bot league');

  /*
   * THE FORMAT DIFFERENCES ARE ON THE SCREEN, and an Armageddon is offered where
   * the user can actually start it.
   */
  const sheetSrc = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/TournamentScreen.tsx'), 'utf8',
  );
  ok(/FORMAT_RULES/.test(sheetSrc) && /A level match goes to Armageddon/.test(sheetSrc),
    'the sheet says what the chosen format does');
  ok(/next\?\.armageddon/.test(sheetSrc) && /Play the tiebreak/.test(sheetSrc),
    'a pending Armageddon is named and has its own play button');
}

/* ---------------------- 16. the match shape survives a write/read round trip */

/*
 * THE REPORT: *"it says we will play armagedon the next game but it is a normal
 * game and each time we draw there is a next game!"*.
 *
 * `normaliseGame` rebuilt every game from an explicit field list and dropped
 * `armageddon`, `leg` and `clockStart`. So the tie-break was created correctly,
 * stored correctly, and read back as an ordinary game: its draw never sent Black
 * through and the store appended another one. This test writes and re-reads the
 * tournament, which is what the app does on every navigation.
 */
{
  await storeLib.clearArenaData();
  const { data, tournament } = build({ format: 'knockout', knockoutLegs: 2 }, 2);
  let next = data;
  for (const leg of tournament.games.filter((g) => !g.armageddon && g.blackId)) {
    next = storeLib.recordGameResult(next, tournament.id, leg.id, '1/2-1/2');
  }
  const withTb = next.tournaments.find((t) => t.id === tournament.id);
  const created = withTb.games.find((g) => g.armageddon);
  ok(!!created, 'a level two-leg match created an Armageddon');

  // The round trip the app performs: write, then read back through the store.
  await storeLib.saveArenaData(next);
  const reloaded = await storeLib.loadArenaData();
  const readBack = reloaded.tournaments.find((t) => t.id === tournament.id);
  const tb = readBack.games.find((g) => g.id === created.id);
  ok(tb?.armageddon === true,
    'the Armageddon flag survives being written and read (it did not before)',
    JSON.stringify(tb));
  ok(typeof tb?.clockStart?.white === 'number' && tb.clockStart.white > tb.clockStart.black,
    'and so do its unequal clocks', JSON.stringify(tb?.clockStart));
  ok(readBack.games.filter((g) => g.blackId).every((g) => g.leg === undefined || typeof g.leg === 'number'),
    'and the leg numbers stay numbers');
  eq(readBack.knockoutLegs, 2, 'the match length survives the round trip too');

  // With the flag intact, a drawn Armageddon now ends the match for good.
  const afterDraw = storeLib.recordGameResult(reloaded, tournament.id, created.id, '1/2-1/2');
  const done = afterDraw.tournaments.find((t) => t.id === tournament.id);
  eq(done.games.filter((g) => g.armageddon).length, 1,
    'a drawn Armageddon does not schedule a second one');
  eq(done.championId, created.blackId, 'Black advances and the knockout is over');
}

/* ---------------------------------- 17. platform and create-screen rules */

{
  const manifest = fs.readFileSync(
    path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8',
  );
  ok(/android:allowBackup="false"/.test(manifest),
    'Android auto-backup is OFF, so a deleted bot cannot come back with the next install');
  ok(/dataExtractionRules/.test(manifest)
    && fs.existsSync(path.join(ROOT, 'android/app/src/main/res/xml/data_extraction_rules.xml')),
    'and the Android 12+ extraction rules exclude everything');

  const createScreen = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/CreateTournamentScreen.tsx'), 'utf8',
  );
  ok(/onCreated\(tournament\.id, false\)/.test(createScreen),
    'creating a tournament lands on its sheet instead of auto-starting a game');
}

/* ---------------------------------- 18. cup view, auto boards, draw rules */

{
  const sheet = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/TournamentScreen.tsx'), 'utf8',
  );
  const bracket = fs.readFileSync(path.join(ROOT, 'src/components/KnockoutBracket.tsx'), 'utf8');

  // A KNOCKOUT IS A CUP, THE REST ARE LEAGUES.
  ok(/<KnockoutBracket/.test(sheet) && /League table/.test(sheet),
    'knockouts render the cup bracket and the other formats render a league table');
  ok(/knockoutMatches/.test(bracket) && /sides\[0\]\} \/ \$\{/.test(bracket),
    'future bracket slots list the players who could fill them (FIFA-style possible opponent)');
  ok(/onOpenGame/.test(bracket),
    'and a played tie can be opened to watch');

  // THE USER IS NOT FORCED TO WATCH BOT BOARDS.
  ok(/simulateBotGame/.test(sheet) && /isBotOnlyGame/.test(sheet)
    && /Simulating \$\{simulating\}/.test(sheet),
    'the sheet plays the bot-only boards itself and says so');
  const auto = fs.readFileSync(path.join(ROOT, 'src/lib/arena/autoPlay.ts'), 'utf8');
  ok(/SIM_MAX_PLIES/.test(auto) && /saveTournamentGameResult/.test(auto),
    'a simulated board is stored as a complete, watchable game');
  const shell = fs.readFileSync(path.join(ROOT, 'src/components/AppShell.tsx'), 'utf8');
  ok(/arenaTournamentId !== null/.test(shell),
    'the tournament sheet, where the simulation runs, mounts the engine host');

  // DRAW RULES.
  const arenaGame = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/ArenaGameScreen.tsx'), 'utf8',
  );
  ok(/DRAW_MIN_PLIES/.test(arenaGame) && /Too early to agree a draw/.test(arenaGame),
    'a bot declines a draw before the game has developed');
  ok(/cannot be drawn/.test(arenaGame) && /g\.armageddon/.test(arenaGame),
    'and never accepts one in an Armageddon');
  ok(/humanThinkDelayMs/.test(arenaGame),
    'a bot in an Arena game visibly thinks before moving');
  const botScreenSrc = fs.readFileSync(
    path.join(ROOT, 'src/components/screens/BotPlayScreen.tsx'), 'utf8',
  );
  ok(/humanThinkDelayMs/.test(botScreenSrc),
    'and so does a bot in a casual game');

  // HOME: the app's own games decide the pool, never the Lichess archive.
  const home = fs.readFileSync(path.join(ROOT, 'src/components/screens/HomeScreen.tsx'), 'utf8');
  ok(/for \(const t of d\.tournaments\)/.test(home) && /participantId === 'you'/.test(home),
    'the home rating pool is chosen from games played in this app');
  ok(!/loadCachedGames/.test(home),
    'and not from the imported Lichess time classes');

  // PROFILE: the two cards the owner removed stay removed.
  const profile = fs.readFileSync(path.join(ROOT, 'src/components/screens/ProfileScreen.tsx'), 'utf8');
  ok(!/>Chapter progress</.test(profile), 'the profile has no chapter-progress card');
  ok(!/>Analyzed games</.test(profile), 'and no analysed-games card');
}

/* ------------------------------------------------------------------ summary */

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures > 0 ? 1 : 0);
