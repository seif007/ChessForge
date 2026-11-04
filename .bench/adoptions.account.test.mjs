/**
 * WHOSE ADOPTED MOVES ARE THESE?
 *
 * The report: connect a second account and its "Your openings" trains the FIRST account's
 * adopted moves. The custom repertoire was stored under one global key, deliberately, on the
 * reasoning that a hand-made choice is the user's rather than the account's. The reasoning had
 * a hole in it: an adopted move is an answer to a position that came from a specific account's
 * games, and the screen that shows it belongs to that account.
 *
 * So this harness runs the REAL store against an in-memory kv-store and checks the four things
 * that make the fix a fix rather than a rename:
 *
 *   1. ISOLATION   - what alice adopts, bob never sees, in both directions.
 *   2. MIGRATION   - a repertoire written before namespacing is claimed by the first account to
 *                    load it, ONCE; the legacy key is gone and no second account inherits it.
 *   3. OWNERSHIP   - clearing (one entry, or the whole repertoire) touches only the account
 *                    that asked.
 *   4. NO ACCOUNT  - with nothing connected, adoptions still have a home, and that home is
 *                    claimed by the next account that connects rather than shown to everyone.
 *
 * Run: node .bench/adoptions.account.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-adoptions');

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

/* An in-memory kv-store, exactly the small contract the store uses. */
const mem = new Map();
const Storage = {
  getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: async (k, v) => { mem.set(k, String(v)); },
  removeItem: async (k) => { mem.delete(k); },
};

const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'expo-sqlite/kv-store') return { default: Storage, __esModule: true };
  if (request === '@/lib/lichess') {
    // Not what this gate tests: the store only re-exports it for the games-cache migration.
    return { relabelGameOpening: (g) => g };
  }
  return origLoad.call(this, request, parent, isMain);
};

const store = origLoad.call(Module, findEmitted(BUILD_DIR, 'lichessStore.js'), null, false);
const { loadCustomRepertoire, saveAdoptions, clearAdoption, clearCustomRepertoire } = store;

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

const ACTIVE = 'chessforge.li.active.v1';
const LEGACY = 'chessforge.rep.custom.v1';
const keyFor = (u) => `chessforge.rep.custom.v1.${u}`;
const setActive = async (u) => { if (u === null) mem.delete(ACTIVE); else mem.set(ACTIVE, u); };
const line = (key, san) => ({ key, prefixSan: ['d4', 'd5'], adoptedSan: san, adoptedUci: 'c2c4' });
const positionKeys = (rep) => Object.keys(rep.positions).sort();

/* --------------------------------------------------------------------- 1 */

head('1. two accounts, two repertoires');

await setActive('alice');
const afterAlice = await saveAdoptions([line('kA', 'c4'), line('kB', 'Nf3')]);
ok(positionKeys(afterAlice).join(',') === 'kA,kB', 'alice adopted two moves');

await setActive('bob');
const bobSees = await loadCustomRepertoire();
ok(positionKeys(bobSees).length === 0,
  'bob does not see alice\'s adopted moves',
  `bob sees ${positionKeys(bobSees).join(',')}`);

await saveAdoptions([line('kB', 'e3')]);
const bobNow = await loadCustomRepertoire();
ok(positionKeys(bobNow).join(',') === 'kB', 'bob has his own — and only his own — repertoire');

await setActive('alice');
const aliceNow = await loadCustomRepertoire();
ok(positionKeys(aliceNow).join(',') === 'kA,kB', 'alice still has hers, intact');
ok(aliceNow.positions.kB.adoptedSan === 'Nf3',
  'and her own move at the shared key, not bob\'s', `got ${aliceNow.positions.kB.adoptedSan}`);

/* --------------------------------------------------------------------- 2 */

head('2. a pre-namespacing repertoire is claimed once, not shared');

mem.clear();
mem.set(LEGACY, JSON.stringify({ positions: { kOld: line('kOld', 'Bf4') }, updatedAt: 1 }));
await setActive('alice');
const claimed = await loadCustomRepertoire();
ok(positionKeys(claimed).join(',') === 'kOld',
  'the first account to load inherits the un-namespaced repertoire');
ok(mem.has(keyFor('alice')) && !mem.has(LEGACY),
  'the claim is a MOVE: written under the account, removed from the shared key',
  `account key ${mem.has(keyFor('alice'))}, legacy ${mem.has(LEGACY)}`);

await setActive('bob');
const bobAfter = await loadCustomRepertoire();
ok(positionKeys(bobAfter).length === 0,
  'the second account does not inherit it afterwards',
  `bob sees ${positionKeys(bobAfter).join(',')}`);

/* --------------------------------------------------------------------- 3 */

head('3. clearing touches one account');

mem.clear();
await setActive('alice');
await saveAdoptions([line('kA', 'c4')]);
await setActive('bob');
await saveAdoptions([line('kB', 'e3'), line('kC', 'c4')]);

await setActive('alice');
await clearCustomRepertoire();
const aliceCleared = await loadCustomRepertoire();
ok(positionKeys(aliceCleared).length === 0, 'alice\'s wipe empties alice');

await setActive('bob');
const bobAfterAliceWipe = await loadCustomRepertoire();
ok(positionKeys(bobAfterAliceWipe).join(',') === 'kB,kC',
  'and nothing of bob\'s', `bob has ${positionKeys(bobAfterAliceWipe).join(',')}`);

await clearAdoption('kC');
const bobCleared = await loadCustomRepertoire();
ok(positionKeys(bobCleared).join(',') === 'kB',
  'removing one entry removes exactly that entry', `bob has ${positionKeys(bobCleared).join(',')}`);

await setActive('alice');
await saveAdoptions([line('kA', 'c4')]);
await setActive('bob');
await clearCustomRepertoire();
await setActive('alice');
const aliceAfterBobWipe = await loadCustomRepertoire();
ok(positionKeys(aliceAfterBobWipe).join(',') === 'kA',
  'bob\'s wipe does not touch alice\'s repertoire',
  `alice has ${positionKeys(aliceAfterBobWipe).join(',')}`);

/* --------------------------------------------------------------------- 4 */

head('4. with no account connected, adoptions have a home — and it is claimed next');

mem.clear();
await setActive(null);
await saveAdoptions([line('kFree', 'Nf3')]);
const freeSees = await loadCustomRepertoire();
ok(positionKeys(freeSees).join(',') === 'kFree', 'adoptions still work with nothing connected');
ok(mem.has(LEGACY), 'and they live under the shared key while there is no account');

await setActive('carol');
const carolSees = await loadCustomRepertoire();
ok(positionKeys(carolSees).join(',') === 'kFree',
  'the next account to connect claims them');
ok(!mem.has(LEGACY), 'and the shared key is gone');

await setActive('dave');
const daveSees = await loadCustomRepertoire();
ok(positionKeys(daveSees).length === 0, 'a later account starts empty');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILED'}  (${checks - failures}/${checks})`);
process.exit(failures === 0 ? 0 : 1);
