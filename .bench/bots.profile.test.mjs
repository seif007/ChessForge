/**
 * THE BOT FINGERPRINT MUST BE MEASURED, NOT GUESSED.
 *
 * A bot is only "that player" if the numbers under the hood actually came from
 * their games: the book of moves they chose, how often they capture and castle
 * per phase, and the results. This harness builds profiles from a fixture set
 * whose every property is known by hand, and checks the builder against it —
 * including the parts that are easy to get quietly wrong:
 *
 *   1. WHOSE GAMES ARE THESE — a game the requested player was not in, a game
 *      too short to say anything, and a game that breaks mid-move are all
 *      excluded from the analysis while still being recognised (or not) the way
 *      the mix and the date span expect.
 *   2. THE BOOK IS THE PLAYER'S OWN MOVES — every entry is a move they made,
 *      keyed by the position they made it in, and nothing past the book window
 *      is stored.
 *   3. THE RATES AND THE RESULT — win/draw/loss from the header and the side,
 *      per-phase feature rates, castling plies.
 *   4. THE LABELS — the opening comes from our registry when the file has no
 *      tag, the rating label from where the games came from.
 *   5. NAME MATCHING — PGN headers spell names every way there is; the tolerant
 *      compare finds the player and refuses the near-miss.
 *
 * Run: node .bench/bots.profile.test.mjs
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
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-bots-profile');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2021', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'bots', 'profile.ts'),
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

const profileMod = origLoad.call(Module, findEmitted(BUILD_DIR, 'profile.js'), null, false);
const openings = origLoad.call(Module, findEmitted(BUILD_DIR, 'openings.js'), null, false);
const {
  buildBotProfile, playerInGame, botOpeningFromMoves, splitPgnGames, pgnHeaders,
  BOOK_PLIES,
} = profileMod;
const { OPENINGS, bestOpeningForLine } = openings;

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

/* --------------------------------------------------------------- the fixtures */

const G1 = `[Event "Fixture"]
[White "Alpha"]
[Black "Rival"]
[Result "1-0"]
[WhiteElo "2000"]
[BlackElo "1900"]
[Date "2024.03.05"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 5. d3 d6 6. Bg5 h6 7. Bxf6 Qxf6 8. Nc3 O-O 9. Nd5 Qd8 10. c3 a6 1-0`;

const G2 = `[Event "Fixture"]
[White "Rival2"]
[Black "Alpha"]
[Result "1/2-1/2"]
[WhiteElo "2100"]
[BlackElo "2050"]
[Date "2024.02.10"]

1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. e5 Nfd7 5. f4 c5 6. Nf3 Nc6 7. Be2 Be7 8. O-O O-O 9. Kh1 b6 10. a3 a5 1/2-1/2`;

const G3 = `[Event "Fixture"]
[White "Alpha"]
[Black "Rival3"]
[Result "0-1"]
[WhiteElo "2000"]
[BlackElo "2200"]
[Date "2024.01.15"]

1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 h6 7. Bh4 b6 8. cxd5 exd5 9. Bd3 Bb7 10. O-O Ne4 0-1`;

const G4 = `[Event "Fixture"]
[White "Rival4"]
[Black "Alpha"]
[Result "0-1"]
[WhiteElo "1800"]
[BlackElo "2050"]
[Date "2024.04.01"]

1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Bd2 Be7 5. g3 O-O 6. Bg2 d5 7. O-O dxc4 8. Qc2 b6 0-1`;

/* Clock comment and an inline variation: the mainline must survive both. */
const G5 = `[Event "Fixture"]
[White "Alpha"]
[Black "Rival5"]
[Result "1-0"]
[Date "2024.05.02"]

1. e4 { [%clk 0:05:00] } 1... e5 2. Nf3 (2. Bc4 Nf6) 2... Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 1-0`;

/* 26 plies: three of the player's moves fall past the book window. */
const G6 = `[Event "Fixture"]
[White "Alpha"]
[Black "Rival6"]
[Result "*"]
[Date "2024.06.01"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 11. c4 c6 12. cxb5 axb5 13. Nc3 Bb7 *`;

/* Matched, never analysed: the game starts from a problem position. */
const G_SETUP = `[Event "Fixture"]
[White "Alpha"]
[Black "Rival7"]
[Result "1-0"]
[Date "2024.07.01"]

1. e4 e5 2. Nf3 Nc6 1-0`;

/* Not this player at all. */
const G_OTHER = `[Event "Fixture"]
[White "Someone"]
[Black "Else"]
[Result "1-0"]
[Date "2030.01.01"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 1-0`;

/* Cut short by a token chess.js cannot read. */
const G_GARBAGE = `[Event "Fixture"]
[White "Alpha"]
[Black "Rival8"]
[Result "*"]
[Date "2024.08.01"]

1. e4 e5 2. Zz9 blunder *`;

/* Legal but too short to be evidence. */
const G_TINY = `[Event "Fixture"]
[White "Alpha"]
[Black "Rival9"]
[Result "*"]
[Date "2024.09.01"]

1. e4 e5 *`;

const game = (pgn, extra = {}) => ({
  pgn, white: '', black: '', source: 'lichess', timeControl: 'blitz', ...extra,
});
const withNames = (pgn, white, black, extra = {}) => ({ ...game(pgn, extra), white, black });

const GAMES = [
  withNames(G1, 'Alpha', 'Rival', { whiteRating: 2000, blackRating: 1900, date: '2024.03.05' }),
  withNames(G2, 'Rival2', 'Alpha', { whiteRating: 2100, blackRating: 2050, date: '2024.02.10' }),
  withNames(G3, 'Alpha', 'Rival3', { whiteRating: 2000, blackRating: 2200, date: '2024.01.15' }),
  withNames(G4, 'Rival4', 'Alpha', { whiteRating: 1800, blackRating: 2050, date: '2024.04.01' }),
  withNames(G5, 'Alpha', 'Rival5', { date: '2024.05.02' }),
  withNames(G6, 'Alpha', 'Rival6', { date: '2024.06.01' }),
  withNames(G_SETUP, 'Alpha', 'Rival7', {
    date: '2024.07.01', initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  }),
  withNames(G_OTHER, 'Someone', 'Else', { timeControl: 'rapid', date: '2030.01.01' }),
  withNames(G_GARBAGE, 'Alpha', 'Rival8', { date: '2024.08.01' }),
  withNames(G_TINY, 'Alpha', 'Rival9', { date: '2024.09.01' }),
];

const META = {
  name: 'Alpha',
  key: 'Alpha',
  source: 'lichess',
  ratings: { blitz: 2000 },
};

const progress = [];
const profile = await buildBotProfile(GAMES, META, {
  yieldEvery: 2,
  onProgress: (p) => progress.push(p),
});

/* --------------------------------------------------- independent book checker */

/** Replay SANs, returning the player's own moves with the position before each. */
function ownMoves(sans, side) {
  const c = new Chess();
  const out = [];
  for (let ply = 0; ply < sans.length; ply++) {
    const before = c.fen();
    let mv;
    try { mv = c.move(sans[ply], { strict: false }); } catch { break; }
    const isPlayer = (ply % 2 === 0) === (side === 'w');
    if (isPlayer) {
      out.push({
        ply: ply + 1,
        key: before.split(' ').slice(0, 4).join(' '),
        san: mv.san,
        castled: mv.flags.includes('k') || mv.flags.includes('q'),
      });
    }
  }
  return out;
}

const SAN_LIST = {
  G1: 'e4 e5 Nf3 Nc6 Bc4 Bc5 O-O Nf6 d3 d6 Bg5 h6 Bxf6 Qxf6 Nc3 O-O Nd5 Qd8 c3 a6'.split(' '),
  G2: 'e4 e6 d4 d5 Nc3 Nf6 e5 Nfd7 f4 c5 Nf3 Nc6 Be2 Be7 O-O O-O Kh1 b6 a3 a5'.split(' '),
  G3: 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6 cxd5 exd5 Bd3 Bb7 O-O Ne4'.split(' '),
  G4: 'd4 Nf6 c4 e6 Nf3 Bb4+ Bd2 Be7 g3 O-O Bg2 d5 O-O dxc4 Qc2 b6'.split(' '),
  G5: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6'.split(' '),
  G6: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 c4 c6 cxb5 axb5 Nc3 Bb7'.split(' '),
};
const SIDES = { G1: 'w', G2: 'b', G3: 'w', G4: 'b', G5: 'w', G6: 'w' };

let expectedStored = 0;
let expectedPlies = 0;
let expOpening = 0;
let expMiddle = 0;
let expEnd = 0;
let expPlayerMoves = 0;
const expCastlePlies = [];
for (const id of Object.keys(SAN_LIST)) {
  const moves = ownMoves(SAN_LIST[id], SIDES[id]);
  expectedStored += moves.filter((m) => m.ply <= BOOK_PLIES).length;
  expectedPlies += SAN_LIST[id].length;
  expPlayerMoves += moves.length;
  for (const m of moves) {
    if (m.ply <= 12) expOpening++;
    else if (m.ply <= 60) expMiddle++;
    else expEnd++;
  }
  const firstCastle = moves.find((m) => m.castled);
  if (firstCastle) expCastlePlies.push(firstCastle.ply);
}

/* --------------------------------------------------------------------- 1 */

head('1. whose games were analysed');

ok(profile.gamesAnalyzed === 6,
  'six games were replayable and counted',
  `got ${profile.gamesAnalyzed}`);
ok(profile.wins === 3 && profile.draws === 1 && profile.losses === 1,
  'the record comes from the Result header and the player\'s side',
  `got ${profile.wins}/${profile.draws}/${profile.losses}`);
ok(profile.timeControlMix.some((m) => m.label === 'Blitz' && m.count === 9),
  'a matched game counts toward the time-control mix even when it cannot be replayed',
  JSON.stringify(profile.timeControlMix));
ok(!profile.timeControlMix.some((m) => m.label === 'Rapid'),
  'a game this player was not in counts toward nothing');
ok(profile.dateRange.from === '2024-01-15' && profile.dateRange.to === '2024-09-01',
  'the date span comes from matched games only - the 2030 game is not his, the short ones are',
  JSON.stringify(profile.dateRange));
ok(profile.gamesAnalyzed === 6 && profile.wins + profile.draws + profile.losses === 5,
  'the unattributed result ("*") is neither a win nor a loss for the player');

/* --------------------------------------------------------------------- 2 */

head('2. the book is the player\'s own moves');

const storedCount = Object.values(profile.book)
  .reduce((sum, slot) => sum + Object.values(slot).reduce((a, b) => a + b, 0), 0);
ok(storedCount === expectedStored,
  `every move inside the ${BOOK_PLIES}-ply window is stored, ${expectedStored} of them`,
  `got ${storedCount}`);
ok(expectedStored > 50, 'and the fixture is big enough for that count to mean something');

const startKey = new Chess().fen().split(' ').slice(0, 4).join(' ');
ok(JSON.stringify(profile.book[startKey]) === JSON.stringify({ e4: 3, d4: 1 }),
  'from the start position the counts are the moves actually played (e4 three times, d4 once)',
  JSON.stringify(profile.book[startKey]));

const movesG6 = ownMoves(SAN_LIST.G6, 'w');
const pastWindow = movesG6.filter((m) => m.ply > BOOK_PLIES);
ok(pastWindow.length === 3, 'the long fixture really does have moves past the window');
ok(pastWindow.every((m) => !(m.key in profile.book)),
  'and none of those positions entered the book');

const firstIn = movesG6.filter((m) => m.ply <= BOOK_PLIES);
ok(firstIn.every((m) => (profile.book[m.key]?.[m.san] ?? 0) >= 1),
  'every in-window move appears under the position it was played from');

ok(Object.values(profile.book).every((slot) =>
  Object.values(slot).every((n) => Number.isInteger(n) && n >= 1)),
  'the book holds whole counts, never fractions or zeroes');

/* --------------------------------------------------------------------- 3 */

head('3. the rates and the record');

const rates = profile.typeRates;
ok(rates.opening.total > 0 && rates.middle.total + rates.end.total > 0,
  'both an opening share and a later-phase share were measured',
  JSON.stringify({ o: rates.opening.total, m: rates.middle.total, e: rates.end.total }));
ok(rates.opening.total + rates.middle.total + rates.end.total === expPlayerMoves,
  'the feature rates counted every move the player made - the book is windowed, the rates are not',
  `got ${rates.opening.total + rates.middle.total + rates.end.total}, expected ${expPlayerMoves}`);
ok(rates.opening.total === expOpening && rates.middle.total === expMiddle && rates.end.total === expEnd,
  'the phase split follows the ply rule (opening <= 12, middle <= 60)',
  `got ${JSON.stringify({ o: rates.opening.total, m: rates.middle.total, e: rates.end.total })}, expected ${JSON.stringify({ o: expOpening, m: expMiddle, e: expEnd })}`);
ok(rates.opening.develop > 0 && rates.opening.develop <= 1,
  'development is a rate between 0 and 1', String(rates.opening.develop));

const expectedCastlePly = Math.round(
  expCastlePlies.reduce((a, b) => a + b, 0) / expCastlePlies.length);
ok(profile.style.castlePly === expectedCastlePly,
  'the castling ply is the average first castle, not the first one seen',
  `got ${profile.style.castlePly}, expected ${expectedCastlePly} over ${expCastlePlies.length} castles`);
ok([profile.style.aggression, profile.style.kingSafety, profile.style.pieceActivity, profile.style.endgame]
  .every((v) => Number.isInteger(v) && v >= 0 && v <= 100),
  'the four style dials are clamped integers',
  JSON.stringify(profile.style));
ok(profile.style.avgGameLength === Math.round((expectedPlies / 6) * 10) / 10,
  'the average length is the average of the games actually analysed',
  `got ${profile.style.avgGameLength}, expected ${Math.round((expectedPlies / 6) * 10) / 10}`);

ok(profile.wins === 3, 'the wins are counted from the player\'s point of view',
  String(profile.wins));

/* --------------------------------------------------------------------- 4 */

head('4. labels come from our registry and from the source');

const frenchId = OPENINGS.find((o) => o.id === 'french-defense');
ok(!!frenchId, 'the registry still has a French Defense to test with');
const fr = profile.openings.find((o) => o.name === frenchId?.name);
ok(!!fr, 'the French fixture opening is named by the registry, not "Unknown"',
  JSON.stringify(profile.openings.map((o) => o.name)));
ok(fr && fr.asColor === 'black' && fr.draws === 1 && fr.count === 1,
  'and its record is the black side\'s draw', JSON.stringify(fr));
ok(botOpeningFromMoves(['e4', 'e6']).name === frenchId?.name,
  'the detector itself agrees');
ok(botOpeningFromMoves(['e4']).name === "King's Pawn Opening",
  'an unmatched single move falls back to the pawn opening', botOpeningFromMoves(['e4']).name);
ok(botOpeningFromMoves(['a3', 'a6']).name === 'Irregular Opening',
  'a line the books do not know is at least honest about it');
ok(profile.openings.every((o) => o.count >= 1 && o.wins + o.draws + o.losses <= o.count),
  'every opening stat is a real record, never more results than games');
ok(profile.firstMoves[0]?.san === 'e4' && profile.firstMoves[0]?.count === 3,
  'the first-move histogram leads with the move played most',
  JSON.stringify(profile.firstMoves));
ok(profile.repliesToE4.some((m) => m.san === 'e6' && m.count === 1),
  'the e4 reply histogram has the French e6', JSON.stringify(profile.repliesToE4));
ok(profile.repliesToD4.some((m) => m.san === 'Nf6' && m.count === 1),
  'the d4 reply histogram has Nf6', JSON.stringify(profile.repliesToD4));

ok(profile.ratingLabel === 'Lichess blitz' && profile.rating === 2000,
  'the Lichess rating comes from the ratings the profile fetch returned',
  `${profile.ratingLabel} ${profile.rating}`);
/*
 * THE CARD'S NUMBER IS THE BOARD'S NUMBER. A bot built from an 1800 account
 * played Stockfish's uncapped best move because nothing set `playElo`; the
 * displayed rating was decoration. The built profile now carries it, so the play
 * screen and Arena cap the engine at the player's own strength.
 */
ok(profile.playElo === 2000,
  'the source rating is also the engine playing strength (playElo)',
  String(profile.playElo));

const OTB_GAMES = GAMES.map((g) => ({ ...g, source: 'otb' }));
const otb = await buildBotProfile(OTB_GAMES, {
  ...META, source: 'otb', ratings: { fide: 2500 },
}, { yieldToUI: async () => {} });
ok(otb.rating === 2500 && otb.ratingLabel === 'FIDE standard',
  'an OTB profile with a FIDE rating says so', `${otb.ratingLabel} ${otb.rating}`);
ok(otb.playElo === 2500,
  'and an OTB bot is capped at the FIDE rating too', String(otb.playElo));

const otbNoFide = await buildBotProfile(OTB_GAMES, { ...META, source: 'otb' }, { yieldToUI: async () => {} });
ok(otbNoFide.rating === 2050 && otbNoFide.ratingLabel === 'FIDE (from games)',
  'without one, the last game rating stands in - and says it is borrowed',
  `${otbNoFide.ratingLabel} ${otbNoFide.rating}`);
ok(otbNoFide.timeControlMix.some((m) => m.label === 'Classical'),
  'OTB games are labelled Classical, whatever the file calls them',
  JSON.stringify(otbNoFide.timeControlMix));

/* --------------------------------------------------------------------- 5 */

head('5. names are spelled every way there is');

ok(playerInGame('Hikaru Nakamura', 'X', 'Nakamura, Hikaru') === 'w',
  'a western-spelled key finds the comma-spelled header');
ok(playerInGame('Nakamura, Hikaru', 'X', 'Hikaru Nakamura') === 'w',
  'and the reverse');
ok(playerInGame('X', 'Nakamura,Hi', 'Nakamura, Hikaru') === 'b',
  'an abbreviated given name still matches the full one - on the side it appears');
ok(playerInGame('Alpha, B.', 'X', 'Alpha, B') === 'w',
  'surname plus initial matches surname plus initial');
ok(playerInGame('Alpha, C.', 'X', 'Alpha, B') === null,
  'a different initial does not');
ok(playerInGame('Alpha', 'X', 'Gamma') === null, 'a different surname does not');
ok(playerInGame('X', 'Beta', 'Beta') === 'b', 'and a black-side match is a black-side match');

/* --------------------------------------------------------------------- 6 */

head('6. PGN readers');

const two = splitPgnGames(`${G1}\n\n${G2}`);
ok(two.length === 2, 'two games in one string split into two', `got ${two.length}`);
const noEvent = splitPgnGames('[Site "Somewhere"]\n[White "A"]\n[Black "B"]\n\n1. e4 e5 1-0');
ok(noEvent.length === 1 && noEvent[0].includes('[Site "Somewhere"]'),
  'a game whose first tag is not Event is still one game');

const headers = pgnHeaders(G2);
ok(headers.Result === '1/2-1/2' && headers.White === 'Rival2' && headers.ECO === undefined,
  'headers come back as written, and a missing tag is simply missing',
  JSON.stringify(headers));

const withComments = await buildBotProfile(
  [withNames(G5, 'Alpha', 'Rival5', { timeControl: 'blitz' })], META, { yieldToUI: async () => {} });
const commentBook = withComments.book;
const afterE4E5 = ownMoves(SAN_LIST.G5, 'w').find((m) => m.san === 'Nf3');
ok(commentBook[afterE4E5.key]?.Nf3 === 1,
  'a game with clock comments and a variation replays its mainline exactly',
  JSON.stringify(commentBook[afterE4E5?.key ?? '?']));

/* --------------------------------------------------------------------- 7 */

head('7. progress, and refusing to build a bot from nothing');

/*
 * The bar is visible from the moment the job starts, not after the first yield
 * interval — a small import used to show no progress at all while it worked.
 * So: one report at zero, then one per interval.
 */
ok(progress.length === 6, 'progress fires at zero and then once per yield interval (10 games, every 2)',
  `got ${progress.length}`);
ok(progress[0]?.done === 0 && progress[0]?.pct === 0,
  'the first report is at zero, before any game is folded',
  JSON.stringify(progress[0]));
ok(progress.every((p) => p.stage === 'analyze' && Number.isInteger(p.pct) && p.pct >= 0 && p.pct <= 100),
  'every report is a sane analyse report');
ok(progress[progress.length - 1]?.done === 10 && progress[progress.length - 1]?.total === 10,
  'the last report counts all the games it was given',
  JSON.stringify(progress[progress.length - 1]));

let threw = '';
try {
  await buildBotProfile([withNames(G_TINY, 'Alpha', 'Rival9', {})], META, { yieldToUI: async () => {} });
} catch (e) { threw = String(e.message); }
ok(threw === 'No playable games found for this player.',
  'a set with nothing playable refuses honestly', threw);

let threwOther = '';
try {
  await buildBotProfile([withNames(G_OTHER, 'Someone', 'Else', {})], META, { yieldToUI: async () => {} });
} catch (e) { threwOther = String(e.message); }
ok(threwOther === 'No playable games found for this player.',
  'and a set about somebody else refuses too', threwOther);

/* --------------------------------------------------------------------- 8 */

head('8. real archives: glued move numbers, and the label follows the games');

/*
 * PGN Mentor writes "1.e4 c5" — the move number GLUED to the move — unlike
 * Lichess's "1. e4". chess.js rejects "1.e4" outright ("Invalid move"), so
 * before the token splitter learned this spelling every archive game died on
 * ply one, and the build honestly reported "No playable games found for this
 * player." while the archive sat there full of usable games.
 */
const G_PM = `[Event "Fixture"]
[White "Alpha"]
[Black "Rival10"]
[Result "1-0"]
[Date "2024.10.01"]

1.e4 c5 2.Nf3 e6 3.b3 Nc6 4.Bb2 Nf6 5.e5 Ng4 6.g3 b6 7.Bg2 Bb7 8.O-O Rc8 9.Re1 Na5 1-0`;

const mentorStyled = await buildBotProfile(
  [withNames(G_PM, 'Alpha', 'Rival10', { timeControl: 'classical' })],
  META,
  { yieldToUI: async () => {} },
);
ok(mentorStyled.gamesAnalyzed === 1,
  'a game with glued move numbers still analyses instead of being discarded',
  String(mentorStyled.gamesAnalyzed));
ok(mentorStyled.firstMoves[0]?.san === 'e4' && mentorStyled.firstMoves[0]?.count === 1,
  'and the whole line was read, not just its first token',
  JSON.stringify(mentorStyled.firstMoves));

/*
 * "All" time classes means the label follows the games actually read: a bot
 * built from games in one class used to wear a hard-coded fallback's badge —
 * the device report was an all-bullet Hikaru build labelled "Lichess
 * blitz" at the blitz rating, describing a player it never measured. Bullet
 * can no longer reach the builder at all, so the live equivalent is the
 * slowest class: all-Daily games must produce a Classical bot at the daily
 * rating, and the lookup must translate daily -> classical the way every
 * label prints it.
 */
const slowGames = GAMES.slice(0, 4).map((g) => ({ ...g, timeControl: 'daily' }));
const slowBot = await buildBotProfile(
  slowGames,
  { ...META, timeClass: 'all', ratings: { blitz: 2000, daily: 3200 } },
  { yieldToUI: async () => {} },
);
ok(slowBot.rating === 3200 && slowBot.ratingLabel === 'Lichess classical',
  'with no time-class filter the label and rating follow the games actually read',
  `${slowBot.ratingLabel} ${slowBot.rating}`);

const blitzFiltered = await buildBotProfile(
  slowGames,
  { ...META, timeClass: 'blitz' },
  { yieldToUI: async () => {} },
);
ok(blitzFiltered.rating === 2000 && blitzFiltered.ratingLabel === 'Lichess blitz',
  'an explicit time-class filter still wins over the games read',
  `${blitzFiltered.ratingLabel} ${blitzFiltered.rating}`);

/* ------------------------------------------------------------------ done */

console.log('');
if (failures === 0) console.log(`ALL CHECKS PASSED  (${checks}/${checks})`);
else console.log(`${failures} of ${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
