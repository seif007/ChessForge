/**
 * OLD CACHES GET THE NEW LABELS WITHOUT A REFETCH.
 *
 * The opening label of a stored game is now derived from the moves. Games on disk were written
 * by a build that trusted Lichess's URL, and the list is only refetched every six hours (and
 * a user who never taps Refresh would keep the old labels indefinitely). So the blob is
 * relabelled ONCE, on load, from the moves it already carries.
 *
 * The two ways that migration could go wrong are both asserted here:
 *
 *   1. FAKE FRESHNESS - it must not stamp `savedAt` with the current time. That would silence
 *      the staleness check and delay the user's next real refresh by six hours, turning a label
 *      fix into a data-freshness bug.
 *   2. EVERY LOAD - it must run once per blob, not once per read, or every screen that paints
 *      from the cache pays for it forever.
 *
 * Run: node .bench/openinglabel.cache.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-labelcache');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    esModuleInterop: true, paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [path.join(ROOT, 'src', 'lib', 'lichessStore.ts')],
}, null, 2));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project',
    path.join(BUILD_DIR, 'tsconfig.json'),
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 2000));
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

const mem = new Map();
const Storage = {
  getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: async (k, v) => { mem.set(k, String(v)); },
  removeItem: async (k) => { mem.delete(k); },
};

/* A counting stand-in for the real relabeller: the contract under test is WHEN it runs. */
let relabels = 0;
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'expo-sqlite/kv-store') return { default: Storage, __esModule: true };
  if (request === '@/lib/lichess') {
    return {
      relabelGameOpening: (g) => {
        relabels++;
        if (g.opening === 'Unknown source') {
          return { ...g, opening: 'Our Book', openingVariation: 'Our Book' };
        }
        return g;
      },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

const store = require(path.join(findEmitted(BUILD_DIR, 'lichessStore.js')));
const { loadCachedGames, saveCachedGames, gamesCacheIsStale, OPENING_LABEL_VERSION } = store;

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

const GAMES_KEY = 'chessforge.li.games.v1.alice';
// Older than the six-hour TTL, so "still stale afterwards" is a real claim.
const OLD_SAVED_AT = Date.now() - 8 * 60 * 60 * 1000;
const staleBlob = () => ({
  v: 1,
  username: 'alice',
  games: [
    { id: 'g1', opening: 'Unknown source', openingVariation: 'Unknown source', movesSan: ['e4'] },
    { id: 'g2', opening: 'Fine', openingVariation: 'Fine', movesSan: ['d4'] },
  ],
  savedAt: OLD_SAVED_AT,
});

/* --------------------------------------------------------------------- 1 */

head('1. an old blob is relabelled on load, once');

mem.set(GAMES_KEY, JSON.stringify(staleBlob()));
const first = await loadCachedGames('alice');
ok(first !== null && first.games[0].opening === 'Our Book',
  'the stored game gets the corrected label on load',
  JSON.stringify(first?.games?.[0]?.opening));
ok(relabels === 2, 'the relabeller ran once per game', `ran ${relabels} times`);
ok(first.labelsV === OPENING_LABEL_VERSION, 'and the blob is marked as current');
ok(first.savedAt === OLD_SAVED_AT,
  'the migration did NOT stamp a new savedAt',
  `savedAt ${first.savedAt} vs original ${OLD_SAVED_AT}`);

const onDisk = JSON.parse(mem.get(GAMES_KEY));
ok(onDisk.games[0].opening === 'Our Book' && onDisk.labelsV === OPENING_LABEL_VERSION,
  'the corrected blob is written back');

relabels = 0;
const second = await loadCachedGames('alice');
ok(relabels === 0, 'a second load does no relabelling at all', `ran ${relabels} times`);
ok(second.games[0].opening === 'Our Book', 'and it still reports the corrected label');

/* --------------------------------------------------------------------- 2 */

head('2. freshness is still judged by the real fetch time');

ok(gamesCacheIsStale(first) === true,
  'an eight-hour-old fetch is still stale after migration');
ok(gamesCacheIsStale({ ...first, savedAt: Date.now() }) === false,
  'and a fresh one is not');

/* --------------------------------------------------------------------- 3 */

head('3. a freshly saved list is written already marked');

mem.clear();
await saveCachedGames('alice', staleBlob().games);
const saved = JSON.parse(mem.get(GAMES_KEY));
ok(saved.labelsV === OPENING_LABEL_VERSION, 'saveCachedGames writes the current label version');
const loadedAfterSave = await loadCachedGames('alice');
ok(relabels === 0, 'so the next load relabels nothing', `ran ${relabels} times`);
ok(loadedAfterSave.games.length === 2, 'and the games round-trip');

/* --------------------------------------------------------------------- 4 */

head('4. an empty save never clobbers a good list');

const before = mem.get(GAMES_KEY);
await saveCachedGames('alice', []);
ok(mem.get(GAMES_KEY) === before, 'saving zero games is a no-op');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILED'}  (${checks - failures}/${checks})`);
process.exit(failures === 0 ? 0 : 1);
