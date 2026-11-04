/**
 * GATE 1s — bot personalities.
 *
 * Personalities are a layer on the existing mimic engine, not a second move
 * chooser. This gate checks the layer's contract:
 *
 *   1. The five presets exist and each one normalises to a real mixture.
 *   2. Custom personalities derived from imported style are bounded and
 *      normalised too.
 *   3. A preset bot is honest: source "preset", zero imported games, a CURATED
 *      opening repertoire (not fake history), and a playing strength separate
 *      from its character.
 *   4. Applying a personality to an imported profile preserves the fingerprint.
 *   5. The feature weights actually distinguish an attacker from a strategist.
 *   6. Safety damping keeps a personality from throwing a clearly lost move
 *      into the engine's top choice, even when its style likes that move.
 *
 * Run: node .bench/bots.personality.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-personality');

try { fs.rmSync(BUILD_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2021', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] },
    rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [
    path.join(ROOT, 'src/lib/bots/types.ts'),
    path.join(ROOT, 'src/lib/bots/personality.ts'),
    path.join(ROOT, 'src/lib/bots/mimic.ts'),
  ],
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
  if (request.startsWith('@/')) {
    const emitted = findEmitted(BUILD_DIR, request.slice(2).split('/').pop() + '.js');
    if (emitted) return origLoad.call(this, emitted, null, false);
  }
  return origLoad.call(this, request, parent, isMain);
};

const personality = require(path.join(BUILD_DIR, 'src/lib/bots/personality.js'));
const mimic = require(path.join(BUILD_DIR, 'src/lib/bots/mimic.js'));
const repertoire = require(findEmitted(BUILD_DIR, 'repertoire.js'));
const { Chess } = require('chess.js');

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
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));
function close(actual, expected, msg) {
  ok(Math.abs(actual - expected) < 1e-9, `${msg} (got ${actual}, expected ${expected})`);
}
function deepEq(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg}\n  got ${JSON.stringify(actual)}\n  expected ${JSON.stringify(expected)}`);
}
function sumWeights(w) {
  return w.attack + w.position + w.defence + w.gambit + w.endgame;
}

/* ---------------------------------------------------------------- 1. presets */

eq(personality.PERSONALITY_PRESETS.length, 5, 'there are five presets');
eq(new Set(personality.PERSONALITY_PRESETS.map((p) => p.id)).size, 5, 'preset ids are unique');
for (const preset of personality.PERSONALITY_PRESETS) {
  ok(!!preset.name && !!preset.short && !!preset.tagline, `${preset.id} has display copy`);
  ok(!!preset.description, `${preset.id} has a description`);
  const p = personality.personalityFor(preset.id, preset.style);
  close(sumWeights(p.weights), 1, `${preset.id} weights sum to one`);
  ok(p.weights.risk >= 0 && p.weights.risk <= 1, `${preset.id} risk is bounded`);
  ok(p.safetyCp > 0, `${preset.id} has a safety cap`);
}
eq(personality.presetById('custom'), null, 'custom is not a preset');
eq(personality.personalityLabel('custom'), 'Custom Player', 'custom has a label');
eq(personality.personalityTagline('custom'), 'Your imported fingerprint', 'custom has a tagline');

/* --------------------------------------------------------------- 2. normalize */

{
  const n = personality.normalizePersonality({
    attack: 2, position: -1, defence: 1, gambit: 1, endgame: 1, risk: 9,
  });
  close(sumWeights(n), 1, 'out-of-range dials normalise to a mixture');
  eq(n.attack, 0.25, 'the positive attack weight survives the clamp');
  eq(n.position, 0, 'a negative dial clamps to zero');
  eq(n.risk, 1, 'risk clamps to one');
  const zero = personality.normalizePersonality({
    attack: 0, position: 0, defence: 0, gambit: 0, endgame: 0, risk: 0.4,
  });
  close(sumWeights(zero), 1, 'all-zero dials fall back to an even blend');
  eq(zero.risk, 0.4, 'the all-zero fallback keeps risk');
}

{
  const aggressive = personality.customPersonalityFromStyle({
    aggression: 100, kingSafety: 20, pieceActivity: 80, endgame: 20, castlePly: 10, avgGameLength: 50,
  });
  const solid = personality.customPersonalityFromStyle({
    aggression: 10, kingSafety: 90, pieceActivity: 40, endgame: 70, castlePly: 25, avgGameLength: 100,
  });
  close(sumWeights(aggressive), 1, 'aggressive style normalises');
  close(sumWeights(solid), 1, 'solid style normalises');
  ok(aggressive.attack > solid.attack, 'aggression raises the attack dial');
  ok(aggressive.gambit > solid.gambit, 'aggression raises the gambit dial');
  ok(solid.defence > aggressive.defence, 'king safety raises the defence dial');
  ok(aggressive.risk > solid.risk, 'aggression raises risk');
}

/* ---------------------------------------------------------------- 3. factory */

{
  const p = personality.createPresetProfile({
    id: 'bot_aggressive',
    preset: 'aggressive',
    name: 'The Hunter',
    rating: 2200,
    createdAt: 1_700_000_000_000,
  });
  eq(p.id, 'bot_aggressive', 'the caller owns the id');
  eq(p.name, 'The Hunter', 'the caller can name the bot');
  eq(p.source, 'preset', 'a preset bot is labelled as a preset');
  eq(p.recipe.kind, 'preset', 'the recipe says preset');
  eq(p.recipe.games, 0, 'a preset bot did not import games');
  eq(p.gamesAnalyzed, 0, 'the sample count is honestly zero');
  eq(p.playElo, 2200, 'playing strength is the rating cap');
  eq(p.rating, 2200, 'the displayed rating matches the cap');
  eq(p.personality?.preset, 'aggressive', 'the personality is stored');
  eq(p.personality?.safetyCp, 220, 'an attacker has the wider safety cap');
  ok(Object.keys(p.book).length > 0,
    'a preset bot carries a curated opening repertoire (not an empty book)',
    JSON.stringify(Object.keys(p.book).slice(0, 3)));
  const startKey = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
  ok((p.book[startKey]?.e4 ?? 0) > 0,
    'the attacker\'s repertoire opens 1.e4 from the standard start',
    JSON.stringify(p.book[startKey]));
  eq(p.openings.length, 0, 'a preset bot has no fake openings');
  eq(p.firstMoves.length, 0, 'a preset bot has no fake first moves');
  eq(p.wins + p.draws + p.losses, 0, 'a preset bot has no fake record');
}

{
  const p = personality.createPresetProfile({
    id: 'bot_defensive', preset: 'defensive', rating: 1400,
  });
  eq(p.personality?.safetyCp, 160, 'a defensive bot has the tighter safety cap');
  eq(p.playElo, 1400, 'a preset can be weak without changing character');
  eq(p.style.aggression, personality.presetById('defensive').style.aggression,
    'the preset style is copied');
}

/* --------------------------------------------------------- 4. imported overlay */

{
  const imported = {
    id: 'imported_1',
    name: 'Imported Player',
    source: 'lichess',
    meta: { name: 'Imported Player', key: 'player' },
    recipe: { kind: 'lichess', query: 'player', games: 50 },
    gamesAnalyzed: 50,
    rating: 1712,
    ratingLabel: 'Lichess blitz',
    wins: 20,
    draws: 10,
    losses: 20,
    openings: [{ name: 'Sicilian', games: 10 }],
    style: {
      aggression: 70, kingSafety: 50, pieceActivity: 60, endgame: 40, castlePly: 20, avgGameLength: 70,
    },
    book: { start: { e4: 3 } },
    typeRates: {},
    firstMoves: [{ san: 'e4', games: 10 }],
    repliesToE4: [],
    repliesToD4: [],
    timeControlMix: [],
    dateRange: {},
    fetchedAt: '2026-01-01T00:00:00.000Z',
    createdAt: 1,
  };
  const p = personality.withPersonality(imported, 'custom', { attack: 0.9 });
  eq(p.source, 'lichess', 'the imported source is preserved');
  eq(p.gamesAnalyzed, 50, 'the imported sample count is preserved');
  eq(p.book.start.e4, 3, 'the imported book is preserved');
  eq(p.personality?.preset, 'custom', 'the overlay is custom');
  close(sumWeights(p.personality.weights), 1, 'the overlay is normalised');
  ok(p.personality.weights.attack > p.personality.weights.defence,
    'the explicit attack override wins the blend');
}

/* ---------------------------------------------------------- 5. fit + summary */

{
  const attackFeatures = { attack: 1, position: 0, defence: 0, gambit: 0, endgame: 0 };
  const positionFeatures = { attack: 0, position: 1, defence: 0, gambit: 0, endgame: 0 };
  const aggressive = personality.personalityFor('aggressive');
  const positional = personality.personalityFor('positional');
  ok(mimic.personalityFit(attackFeatures, aggressive.weights) >
    mimic.personalityFit(attackFeatures, positional.weights),
    'an attacking move fits the attacker more than the strategist');
  ok(mimic.personalityFit(positionFeatures, positional.weights) >
    mimic.personalityFit(positionFeatures, aggressive.weights),
    'a positional move fits the strategist more than the attacker');
  eq(mimic.personalityFit(attackFeatures, {
    attack: 0, position: 0, defence: 0, gambit: 0, endgame: 0,
  }), 0.5, 'an empty personality is neutral');
}

{
  const preset = personality.createPresetProfile({ id: 's', preset: 'gambit', rating: 1800 });
  ok(personality.personalitySummary(preset).includes('Gambit'),
    'the summary names the preset');
  const customPreset = personality.createPresetProfile({ id: 'x', preset: 'positional', rating: 1800 });
  customPreset.personality = personality.personalityFor('custom', customPreset.style);
  eq(personality.personalitySummary(customPreset),
    'Custom blend on top of the preset character.',
    'a customised preset does not claim an imported fingerprint');
  const imported = { ...customPreset, source: 'lichess', meta: { ...customPreset.meta, source: 'lichess' } };
  eq(personality.personalitySummary(imported), 'Custom blend on top of the imported fingerprint.',
    'a customised imported profile keeps the imported summary');
  const bare = { ...imported, personality: undefined };
  eq(personality.personalitySummary(bare),
    'Imported fingerprint, with the original book and tendency model.',
    'a profile without a personality keeps the legacy description');
}

/* -------------------------------------------------------------- 6. safety */

{
  const p = personality.createPresetProfile({
    id: 'safe_attacker', preset: 'aggressive', rating: 2600,
  });
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const lines = [
    { multipv: 1, scoreCp: 0, mate: null, pv: ['e2e4'], depth: 12 },
    { multipv: 2, scoreCp: -25, mate: null, pv: ['d2d4'], depth: 12 },
    { multipv: 3, scoreCp: -1000, mate: null, pv: ['a2a3'], depth: 12 },
  ];
  const decision = mimic.selectMove(lines, start, p, mimic.weightsFromMimicry(0.78));
  ok(!!decision, 'a personality profile still chooses a legal move');
  ok(decision.san !== 'a3', 'safety damping rejects a move a thousand centipawns worse');
  ok(['e4', 'd4'].includes(decision.san), 'the choice comes from the competitive lines');
}

/* ------------------------------------------------------- 7. the repertoires */

/*
 * THE REPORT: *"i tried playing against a gambit personality bot and he never
 * played any gambits"*. A repertoire that exists in the data but never reaches
 * the board is the same bug as no repertoire at all, so this section checks the
 * data AND the choice.
 */
head('7. every preset has a repertoire, and the gambit plays one');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const OPENING_LINES = [
  { multipv: 1, scoreCp: 20, mate: null, pv: ['g1f3'], depth: 14 },
  { multipv: 2, scoreCp: 18, mate: null, pv: ['f1c4'], depth: 14 },
  { multipv: 3, scoreCp: 15, mate: null, pv: ['d2d4'], depth: 14 },
  { multipv: 4, scoreCp: 12, mate: null, pv: ['b1c3'], depth: 14 },
  { multipv: 5, scoreCp: 10, mate: null, pv: ['d2d3'], depth: 14 },
];

/** The first move a preset's curated book names in a position, with its weight. */
function topBookMove(book, fen) {
  const key = fen.split(' ').slice(0, 4).join(' ');
  const slot = book[key];
  if (!slot) return null;
  return Object.entries(slot).sort((a, b) => b[1] - a[1])[0] ?? null;
}

for (const preset of personality.PERSONALITY_PRESETS) {
  const bot = personality.createPresetProfile({ id: `p_${preset.id}`, preset: preset.id, rating: 1800 });
  ok(Object.keys(bot.book).length > 0, `${preset.id} has a curated repertoire`);
  const first = topBookMove(bot.book, START_FEN);
  ok(!!first, `${preset.id} has a first move from the standard start`);
  const expected = preset.id === 'positional' || preset.id === 'defensive' || preset.id === 'endgame' ? 'd4' : 'e4';
  ok(first?.[0] === expected,
    `${preset.id} opens ${expected}`, JSON.stringify(first));
}

{
  const gambit = personality.createPresetProfile({ id: 'g', preset: 'gambit', rating: 2400 });
  ok(topBookMove(gambit.book, AFTER_E4_E5)?.[0] === 'f4',
    'the gambit repertoire\'s signature reply to 1.e4 e5 is 2.f4 (King\'s Gambit)',
    JSON.stringify(topBookMove(gambit.book, AFTER_E4_E5)));

  /*
   * MORE GAMBITS, AS ASKED. The owner's note was that one gambit is not a
   * personality; the book must actually reach the Blackmar-Diemer, the Benko and
   * From's Gambit, not merely contain them in a list nothing reads.
   */
  const rep = repertoire.PRESET_REPERTOIRES.gambit;
  ok(rep.white.length >= 25 && rep.black.length >= 30,
    'the gambit repertoire is broad on both colours',
    `${rep.white.length} white / ${rep.black.length} black lines`);

  const bookAfter = (sans) => {
    const c = new Chess();
    for (const s of sans) c.move(s);
    return gambit.book[c.fen().split(' ').slice(0, 4).join(' ')] ?? {};
  };
  const top = (slot) => Object.entries(slot).sort((a, b) => b[1] - a[1])[0]?.[0];
  ok(top(bookAfter(['d4', 'd5', 'e4', 'dxe4', 'Nc3', 'Nf6'])) === 'f3',
    'Blackmar-Diemer Gambit is in the book after 1.d4 d5 2.e4 dxe4 3.Nc3 Nf6',
    JSON.stringify(bookAfter(['d4', 'd5', 'e4', 'dxe4', 'Nc3', 'Nf6'])));
  ok(top(bookAfter(['d4', 'Nf6', 'c4', 'c5', 'd5'])) === 'b5',
    'as Black the Benko Gambit is played after 1.d4 Nf6 2.c4 c5 3.d5',
    JSON.stringify(bookAfter(['d4', 'Nf6', 'c4', 'c5', 'd5'])));
  ok(top(bookAfter(['f4'])) === 'e5',
    'From\'s Gambit answers 1.f4 with 1...e5',
    JSON.stringify(bookAfter(['f4'])));
  ok(top(bookAfter(['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'])) === 'f3',
    'the Alien Gambit is in the book after 1.d4 Nf6 2.c4 e6 3.Nc3 Bb4',
    JSON.stringify(bookAfter(['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'])));
  ok(top(bookAfter([
    'e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6',
    'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'O-O', 'c3',
  ])) === 'd5',
    'the Marshall Attack is played as Black after the main Ruy Lopez move order',
    JSON.stringify(bookAfter([
      'e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6',
      'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'O-O', 'c3',
    ])));

  /*
   * THE ATTACKER SHARES THEM. The owner asked for the marshall, scotch and alien
   * gambits to appear in the attacking personality too, not only the Gambit one.
   */
  const aggressiveRep = repertoire.PRESET_REPERTOIRES.aggressive;
  const aggressiveBook = personality.createPresetProfile({ id: 'agg', preset: 'aggressive', rating: 2400 }).book;
  const aggAfter = (sans) => {
    const c = new Chess();
    for (const s of sans) c.move(s);
    return aggressiveBook[c.fen().split(' ').slice(0, 4).join(' ')] ?? {};
  };
  ok((aggAfter(['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4']) ?? {}).Bc4 > 0,
    'the attacker has the Scotch Gambit');
  ok((aggAfter(['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4']) ?? {}).f3 > 0,
    'the attacker has the Alien Gambit');
  ok((aggAfter([
    'e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6',
    'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'O-O', 'c3',
  ]) ?? {}).d5 > 0,
    'the attacker has the Marshall Attack');
  ok(aggressiveRep.white.length > 10 && aggressiveRep.black.length > 10,
    'and the attacking repertoire stays broad on both colours');

  const decision = mimic.selectMove(OPENING_LINES, AFTER_E4_E5, gambit, mimic.weightsFromMimicry(0.6));
  ok(decision?.san === 'f4',
    'at the default mimicry the Gambit Enthusiast PLAYS 2.f4 instead of normal development',
    JSON.stringify(decision));
  ok((decision?.reason ?? '').includes('repertoire'),
    'and the move reason says it is the opening repertoire', decision?.reason);

  const white = mimic.selectMove(
    OPENING_LINES.map((l, i) => ({ ...l, pv: [['e2e4', 'd2d4', 'g1f3', 'c2c4', 'e2e3'][i]] })),
    START_FEN, gambit, mimic.weightsFromMimicry(0.6),
  );
  ok(white?.san === 'e4', 'as White the Gambit Enthusiast opens 1.e4', JSON.stringify(white));

  /* THE DIAL IS STILL THE DIAL: at pure engine there is no commitment. */
  const enginePick = mimic.selectMove(OPENING_LINES, AFTER_E4_E5, gambit, mimic.weightsFromMimicry(0));
  ok(enginePick?.san === 'Nf3',
    'at the pure-engine end of the dial the bot plays the engine, not the book',
    JSON.stringify(enginePick));

  /*
   * THE BLACK SIDE TOO. A gambit personality that only gambits as White is
   * half a personality; as Black it answers 2.Nf3 with the Latvian.
   */
  const AFTER_E4_E5_NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
  const blackLines = [
    { multipv: 1, scoreCp: 15, mate: null, pv: ['b8c6'], depth: 14 },
    { multipv: 2, scoreCp: 5, mate: null, pv: ['d7d6'], depth: 14 },
    { multipv: 3, scoreCp: 0, mate: null, pv: ['f8c5'], depth: 14 },
    { multipv: 4, scoreCp: -10, mate: null, pv: ['g8f6'], depth: 14 },
    { multipv: 5, scoreCp: -20, mate: null, pv: ['d7d5'], depth: 14 },
  ];
  const black = mimic.selectMove(blackLines, AFTER_E4_E5_NF3, gambit, mimic.weightsFromMimicry(0.6));
  ok(black?.san === 'f5',
    'as Black the Gambit Enthusiast answers 2.Nf3 with the Latvian counter-gambit',
    JSON.stringify(black));
}

{
  /*
   * THE SAFETY RAIL STILL HOLDS. A repertoire move that the engine says is lost
   * must not be committed to merely because it is in the book.
   */
  const gambit = personality.createPresetProfile({ id: 'g2', preset: 'gambit', rating: 2400 });
  const lostLines = [
    { multipv: 1, scoreCp: 40, mate: null, pv: ['g1f3'], depth: 14 },
    { multipv: 2, scoreCp: -900, mate: null, pv: ['f2f4'], depth: 14 },
  ];
  const d = mimic.selectMove(lostLines, AFTER_E4_E5, gambit, mimic.weightsFromMimicry(0.6));
  ok(d?.san === 'Nf3',
    'a repertoire move the engine evaluates as lost is not played',
    JSON.stringify(d));
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures > 0 ? 1 : 0);
