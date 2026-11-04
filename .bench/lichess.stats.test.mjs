/**
 * THE LICHESS → STATS BRIDGE NEVER INVENTS A NUMBER.
 *
 * Lichess publishes moves and results, not per-move quality and not accuracy.
 * This gate checks that the adapter carries the facts it has, leaves accuracy
 * null when it has none, and keeps the default game filter honest about rated,
 * non-bullet games.
 *
 * Run: node .bench/lichess.stats.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-lichess-stats');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2021', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [path.join(ROOT, 'src', 'lib', 'statsFromLichess.ts')],
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
Module._load = function (request, parent, isMain) {
  return origLoad.call(this, request, parent, isMain);
};
const adapter = origLoad.call(Module, findEmitted(BUILD_DIR, 'statsFromLichess.js'), null, false);
const { toGameStatRow, keepGame, filterGames, emptyCounts } = adapter;

let checks = 0, failures = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

const at = (iso) => Date.parse(iso + 'T12:00:00Z') / 1000;
const game = (over = {}) => ({
  id: 'g1',
  url: 'https://lichess.org/g1',
  opening: 'Sicilian Defense',
  openingVariation: 'Sicilian Defense: Najdorf Variation',
  ecoSlug: 'B90',
  color: 'w',
  outcome: 'win',
  playerRating: 2000,
  opponentRating: 1900,
  opponent: 'Foe',
  accuracy: null,
  opponentAccuracy: null,
  movesUci: [],
  movesSan: ['e4', 'c5', 'Nf3', 'd6'],
  timeClass: 'blitz',
  timeControl: '180+2',
  rated: true,
  endTime: at('2026-10-01'),
  ...over,
});

console.log('\n1. the row carries the facts Lichess gives us');
const row = toGameStatRow(game(), null, 'hikaru');
ok(row.id === 'g1' && row.color === 'w' && row.result === 'win',
  'id, colour and result are carried');
ok(row.date === '2026-10-01' && row.createdAt === '2026-10-01',
  'the unix end time becomes an ISO date');
ok(row.openingKey === 'Sicilian Defense' && row.openingLine === 'Sicilian Defense: Najdorf Variation',
  'both opening levels are carried');
ok(row.plies === 4, 'the ply count is the mainline length');
ok(row.accuracy === null && row.opponentAccuracy === null,
  'no published accuracy stays null - not zero, and not an invented average');
ok(row.analysed === false, 'a game with no scan is not marked analysed');
ok(row.deviationPly === null && row.deviationMove === null,
  'an unscanned game has no invented deviation');
ok(Object.values({
  brilliant: row.brilliant, great: row.great, bestCount: row.bestCount,
  excellent: row.excellent, good: row.good, book: row.book,
  inaccuracy: row.inaccuracy, miss: row.miss, mistake: row.mistake, blunder: row.blunder,
}).every((n) => n === 0), 'unscanned quality columns are all zero');

console.log('\n2. a scan supplies quality, deviation and an estimate');
const scanned = {
  counts: {
    brilliant: 1, great: 2, best: 3, excellent: 4, good: 5,
    book: 6, inaccuracy: 7, miss: 8, mistake: 9, blunder: 10,
  },
  deviationPly: 6,
  deviationMove: 'Nf3',
  onBook: false,
  estimatedAccuracy: 82.5,
  depthReached: 12,
};
const scannedRow = toGameStatRow(game(), scanned, 'hikaru');
ok(scannedRow.accuracy === 82.5, 'the scan estimate is used when the source has none');
ok(scannedRow.opponentAccuracy === 82.5,
  'the opponent mirrors the estimate rather than inventing a different number');
ok(scannedRow.analysed === true, 'a scanned game is marked analysed');
ok(scannedRow.deviationPly === 6 && scannedRow.deviationMove === 'Nf3',
  'the deviation is carried');
ok(scannedRow.brilliant === 1 && scannedRow.bestCount === 3 && scannedRow.blunder === 10,
  'every quality bucket is mapped to its column');

console.log('\n3. a published accuracy wins over the estimate');
const published = toGameStatRow(game({ accuracy: 91, opponentAccuracy: 88 }), scanned, 'hikaru');
ok(published.accuracy === 91, 'the source accuracy is not overwritten');
ok(published.opponentAccuracy === 88, 'the opponent accuracy is carried');
const noOpp = toGameStatRow(game({ accuracy: 91 }), scanned, 'hikaru');
ok(noOpp.opponentAccuracy === null, 'a missing opponent number stays missing, not zero');

console.log('\n4. malformed scan data cannot poison the row');
const odd = toGameStatRow(game(), {
  counts: { brilliant: NaN, best: -1, blunder: 'many' },
  deviationPly: null,
  deviationMove: null,
  onBook: true,
  estimatedAccuracy: null,
  depthReached: 0,
}, 'hikaru');
ok(odd.brilliant === 0 && odd.bestCount === 0 && odd.blunder === 0,
  'non-finite and non-numeric counts become zero');
ok(odd.analysed === false, 'depth zero means the game was not really analysed');

console.log('\n5. the default filter is rated, non-bullet, and has moves');
ok(keepGame(game()), 'a rated blitz game is kept');
ok(!keepGame(game({ rated: false })), 'an unrated game is dropped by default');
ok(keepGame(game({ rated: false }), { includeUnrated: true }), 'unless casual games are requested');
ok(!keepGame(game({ timeClass: 'bullet' })), 'bullet is dropped by default');
ok(keepGame(game({ timeClass: 'bullet' }), { includeBullet: true }), 'unless bullet is requested');
ok(keepGame(game({ timeClass: 'daily' })), 'daily is kept - it is slow, rated signal');
ok(!keepGame(game({ movesSan: ['e4', 'c5', 'Nf3'] })), 'a stub with fewer than four plies is dropped');
ok(keepGame(game({ movesSan: ['e4', 'c5', 'Nf3', 'd6'] })), 'exactly four plies is enough');

console.log('\n6. filtering preserves the caller order');
const many = [
  game({ id: 'a', rated: false }),
  game({ id: 'b' }),
  game({ id: 'c', timeClass: 'bullet' }),
  game({ id: 'd', movesSan: ['e4'] }),
  game({ id: 'e' }),
];
ok(filterGames(many).map((g) => g.id).join(',') === 'b,e',
  'only b and e survive, in that order', filterGames(many).map((g) => g.id).join(','));
ok(filterGames(many, { includeUnrated: true, includeBullet: true }).map((g) => g.id).join(',') === 'a,b,c,e',
  'the flags only change the rule they name');

console.log('\n7. the empty tally is really empty');
const empty = emptyCounts();
ok(Object.keys(empty).length === 10 && Object.values(empty).every((n) => n === 0),
  'all ten quality buckets start at zero');

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
