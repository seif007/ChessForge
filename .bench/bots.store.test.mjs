/**
 * A BOT THE USER CREATED MUST SURVIVE REOPENING THE APP - AND NEVER LIE.
 *
 * Bots are the only feature whose data the user CREATES rather than derives:
 * build one, close the app, and it must still be there, deletable, and opening
 * it must show the profile that was built. The store keeps that promise with
 * two keys - a light index for the list and one blob per bot - and this harness
 * runs the real store against an in-memory kv-store to check the parts where
 * that design can go wrong:
 *
 *   1. ROUND TRIP   - save, list, open, and the profile comes back with its
 *                     fields and its style dials.
 *   2. ORDER        - newest first, whatever order they were saved in, and
 *                     saving an existing id replaces rather than duplicates.
 *   3. DELETE       - the card AND the profile go; other bots are untouched.
 *   4. BAD DATA     - a corrupt blob, an old blob version and a corrupt index
 *                     are each treated as "not there" instead of crashing or
 *                     resurrecting half a bot.
 *   5. WRITE ORDER  - if the index write fails, no card appears for a bot that
 *                     cannot be opened; the orphaned profile is the acceptable
 *                     side of that trade, so it is asserted, not tolerated.
 *
 * Run: node .bench/bots.store.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-bots-store');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2021', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [path.join(ROOT, 'src', 'lib', 'bots', 'store.ts')],
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

/* ------------------------------------------------------------------ kv stub */

const mem = new Map();
let indexWritesFail = false;

const Storage = {
  async getItem(key) { return mem.has(key) ? mem.get(key) : null; },
  async setItem(key, value) {
    /*
     * The index is the only key that is not a per-bot profile blob. Failing
     * "everything else" instead of the literal index key means a rename of that
     * key cannot quietly defuse the write-order test.
     */
    if (indexWritesFail && !String(key).startsWith('chessforge.bots.v1.')) {
      throw new Error('disk full');
    }
    mem.set(String(key), String(value));
  },
  async removeItem(key) { mem.delete(String(key)); },
};

const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'expo-sqlite/kv-store') return Storage;
  return origLoad.call(this, request, parent, isMain);
};

const store = origLoad.call(Module, findEmitted(BUILD_DIR, 'store.js'), null, false);
const { loadBotSummaries, saveBot, loadBot, deleteBot, botProfileKey, newBotId, botSummaryOf } = store;

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

const reset = () => { mem.clear(); indexWritesFail = false; };

/* ---------------------------------------------------------------- fixtures */

const profileOf = (over = {}) => ({
  id: 'bot_1', name: 'Alpha', source: 'lichess',
  meta: { name: 'Alpha', key: 'Alpha', source: 'lichess', title: 'GM', country: 'France', avatar: 'https://x/a.png' },
  recipe: { kind: 'lichess', query: 'Alpha', games: 50 },
  gamesAnalyzed: 50, rating: 2000, ratingLabel: 'Lichess blitz',
  wins: 20, draws: 15, losses: 15, openings: [{ name: 'Italian Game', asColor: 'white', count: 8, wins: 5, draws: 2, losses: 1 }],
  style: { aggression: 61, kingSafety: 72, pieceActivity: 55, endgame: 40, castlePly: 12, avgGameLength: 38.2 },
  book: { rnbqkbnrpppppppp8_8: { e4: 2 } },
  typeRates: { opening: { total: 30 }, middle: { total: 20 }, end: { total: 0 } },
  firstMoves: [{ san: 'e4', count: 30 }], repliesToE4: [], repliesToD4: [], timeControlMix: [],
  dateRange: { from: '2024-01-01', to: '2025-01-01' },
  fetchedAt: '2026-01-01T00:00:00.000Z', createdAt: 1000,
  ...over,
});

const ids = (list) => list.map((b) => b.id).join(',');

/* --------------------------------------------------------------------- 1 */

reset();
head('1. a saved bot comes back whole');

await saveBot(profileOf());
const listed1 = await loadBotSummaries();
ok(listed1.length === 1 && listed1[0].id === 'bot_1',
  'the saved bot is the one on the list', ids(listed1));
ok(listed1[0].name === 'Alpha' && listed1[0].rating === 2000 && listed1[0].ratingLabel === 'Lichess blitz',
  'the card carries the name and the rating label', JSON.stringify(listed1[0]));
ok(listed1[0].gamesAnalyzed === 50 && listed1[0].style.aggression === 61,
  'and the counts and style dials the card draws');
ok(listed1[0].title === undefined && listed1[0].country === undefined && listed1[0].avatar === undefined,
  'a Lichess card carries the handle, not a title, country or photo',
  JSON.stringify(listed1[0]));

const opened = await loadBot('bot_1');
ok(opened?.id === 'bot_1' && opened.name === 'Alpha' && opened.book['rnbqkbnrpppppppp8_8'].e4 === 2,
  'opening the bot returns the profile, book and all', JSON.stringify(opened?.book));
ok(opened.recipe.kind === 'lichess' && opened.recipe.query === 'Alpha' && opened.recipe.games === 50,
  'including the recipe it was built from', JSON.stringify(opened.recipe));

ok(mem.has(botProfileKey('bot_1')),
  'the profile lives under its own key', botProfileKey('bot_1'));
ok(JSON.parse(mem.get(botProfileKey('bot_1'))).v === 1,
  'the blob is versioned, so a future layout can refuse it cleanly');
ok(typeof JSON.parse(mem.get('chessforge.bots.index.v1')).v === 'number',
  'and so is the index');

ok(await loadBot('bot_none') === null, 'a bot id that was never saved opens as nothing');
ok((await loadBotSummaries()).every((s) => typeof s.createdAt === 'number'),
  'every card has the sort key it needs');

/* --------------------------------------------------------------------- 2 */

reset();
head('2. the list is newest first, and saving twice is still one bot');

await saveBot(profileOf({ id: 'p1', createdAt: 1000 }));
await saveBot(profileOf({ id: 'p2', createdAt: 2000 }));
await saveBot(profileOf({ id: 'p3', createdAt: 1500 }));
ok(ids(await loadBotSummaries()) === 'p2,p3,p1',
  'saved out of order, listed newest first', ids(await loadBotSummaries()));

const replaced = await saveBot(profileOf({
  id: 'p1',
  name: 'Alpha v2',
  meta: { ...profileOf().meta, key: 'Alpha v2', name: 'Alpha v2' },
  createdAt: 3000,
}));
ok(replaced.length === 3 && ids(replaced) === 'p1,p2,p3',
  'saving an existing id replaces the card instead of duplicating it', ids(replaced));
ok((await loadBot('p1')).name === 'Alpha v2' && (await loadBot('p1')).createdAt === 3000,
  'and the profile behind it is the new one');
ok(ids(await loadBotSummaries()) === 'p1,p2,p3',
  'the stored index agrees with what saveBatch returned');

/* --------------------------------------------------------------------- 3 */

reset();
head('3. deleting takes the card and the profile');

await saveBot(profileOf({ id: 'p1', createdAt: 1000 }));
await saveBot(profileOf({ id: 'p2', createdAt: 2000 }));
await deleteBot('p2');
ok(ids(await loadBotSummaries()) === 'p1', 'the deleted bot leaves the list', ids(await loadBotSummaries()));
ok(!mem.has(botProfileKey('p2')), 'its profile is gone from storage');
ok(await loadBot('p2') === null, 'and opening it finds nothing');
ok((await loadBot('p1'))?.id === 'p1', 'the other bot is untouched');

const noop = await deleteBot('never_existed');
ok(ids(noop) === 'p1', 'deleting something that is not there is a no-op, not a crash', ids(noop));

/* --------------------------------------------------------------------- 4 */

reset();
head('4. unreadable data is "not there", never half a bot');

await saveBot(profileOf({ id: 'p1', createdAt: 1000 }));
mem.set(botProfileKey('p1'), '{ this is not json');
ok(await loadBot('p1') === null, 'a corrupt profile opens as nothing');
ok((await loadBotSummaries()).length === 0,
  'and its card is not shown, so the list never points at an unopenable bot');

reset();
await saveBot(profileOf({ id: 'p1', createdAt: 1000 }));
mem.set(botProfileKey('p1'), JSON.stringify({ v: 2, profile: profileOf() }));
ok(await loadBot('p1') === null, 'a profile from a future layout is refused');

reset();
await saveBot(profileOf({ id: 'p1', createdAt: 1000 }));
mem.set(botProfileKey('p1'), JSON.stringify({ v: 1, profile: { id: 'p1' } }));
ok(await loadBot('p1') === null, 'a blob that is missing the profile body is refused too');

reset();
await saveBot(profileOf({ id: 'p1', createdAt: 1000 }));
mem.set('chessforge.bots.index.v1', '{ not json either');
ok((await loadBotSummaries()).length === 0, 'a corrupt index lists no bots');
await saveBot(profileOf({ id: 'p2', createdAt: 2000 }));
ok(ids(await loadBotSummaries()) === 'p2', 'and the next save rebuilds it');

reset();
mem.set('chessforge.bots.index.v1', JSON.stringify({ v: 0, bots: [{ id: 'p1', name: 'Alpha' }] }));
ok((await loadBotSummaries()).length === 0, 'an index from a future layout lists no bots');

/* --------------------------------------------------------------------- 5 */

reset();
head('5. the card is only shown once its profile exists');

await saveBot(profileOf({ id: 'p1', createdAt: 1000 }));
indexWritesFail = true;
let rejected = false;
try {
  await saveBot(profileOf({ id: 'p2', createdAt: 2000 }));
} catch { rejected = true; }
indexWritesFail = false;

ok(rejected, 'a save whose index write fails does not pretend to have worked');
ok(mem.has(botProfileKey('p2')),
  'the profile was written first, so the failure leaves an orphan rather than a broken card');
ok(ids(await loadBotSummaries()) === 'p1',
  'and the list still shows only bots that can actually be opened');
ok((await loadBot('p2'))?.id === 'p2',
  'the orphan is only invisible, not lost - a later save under the same id resurrects it');
await saveBot(profileOf({
  id: 'p2',
  name: 'Recovered',
  meta: { ...profileOf().meta, key: 'Recovered', name: 'Recovered' },
  createdAt: 2000,
}));
ok(ids(await loadBotSummaries()) === 'p2,p1' && (await loadBot('p2')).name === 'Recovered',
  'which is exactly what happens',
  ids(await loadBotSummaries()));

/* --------------------------------------------------------------------- 6 */

head('6. ids and keys');

const a = newBotId();
const b = newBotId();
ok(a.startsWith('bot_') && a.length > 10, 'ids are readable and prefixed', a);
ok(a !== b, 'and two calls do not collide', `${a} vs ${b}`);
ok(botProfileKey('x') === 'chessforge.bots.v1.x' && botProfileKey('y') !== botProfileKey('x'),
  'each bot has its own storage key', botProfileKey('x'));

const summary = botSummaryOf(profileOf({ id: 'z', createdAt: 42 }));
ok(summary.id === 'z' && summary.createdAt === 42 && summary.style.kingSafety === 72,
  'the summary is the card\'s view of the profile', JSON.stringify(summary));
ok(summary.key === 'Alpha' && summary.avatar === undefined && summary.gamesAnalyzed === 50,
  'with the handle and the count, and no avatar');

reset();
head('7. old Lichess blobs lose personal details on read');
mem.set(botProfileKey('old'), JSON.stringify({
  v: 1,
  profile: profileOf({
    id: 'old',
    name: 'Alpha Real Name',
    meta: {
      ...profileOf().meta,
      name: 'Alpha Real Name',
      key: undefined,
      title: 'GM',
      country: 'France',
      avatar: 'https://x/a.png',
    },
    recipe: { ...profileOf().recipe, query: 'https://lichess.org/@/alpha_handle/' },
  }),
}));
const old = await loadBot('old');
ok(old?.name === 'alpha_handle' && old.meta.name === 'alpha_handle',
  'the handle becomes the bot name', old?.name);
ok(old?.meta.title === undefined && old?.meta.country === undefined && old?.meta.avatar === undefined,
  'and the old title, country and photo are stripped', JSON.stringify(old?.meta));
const rewritten = JSON.parse(mem.get(botProfileKey('old'))).profile;
ok(rewritten.name === 'alpha_handle' && rewritten.meta.key === 'alpha_handle'
  && rewritten.meta.avatar === undefined && rewritten.meta.country === undefined
  && rewritten.meta.title === undefined,
  'the stored blob is rewritten, not just hidden by the screen',
  JSON.stringify(rewritten.meta));

/* ------------------------------------------------------------------ done */

console.log('');
if (failures === 0) console.log(`ALL CHECKS PASSED  (${checks}/${checks})`);
else console.log(`${failures} of ${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
