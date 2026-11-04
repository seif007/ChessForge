/**
 * A GAME'S OPENING NAME MUST COME FROM ITS MOVES, NOT ONLY FROM THE SOURCE LABEL.
 *
 * The report was a game the app labelled "Tarrasch Defense" whose moves never played `...c5` -
 * the move that makes a Tarrasch a Tarrasch. The source's book can file a game under the opening
 * whose deciding move was never played. Taking that label faithfully is not the fix: the fix is
 * that OUR books, which follow a line move by move, get the last word when they can follow the
 * game far enough to have one.
 *
 * WHAT THIS ASSERTS
 * -----------------
 *   1. The legacy URL parse is unchanged and still faithful.
 *   2. Every shipped opening is named from a real line through it - the sweep is counted, so a
 *      repertoire whose shape changes cannot turn this into a vacuous pass.
 *   3. A wrongly-filed game is corrected: a Queen's Gambit move order filed as "Tarrasch Defense"
 *      comes out as the registry's own name.
 *   4. Agreement is left alone, as an identity: no churn, and the source variation survives.
 *   5. A game too short to decide anything keeps its source label (five plies is a shared stem,
 *      and a chess player would also have to ask).
 *   6. An unclassified game whose moves we DO know gains our name instead of "Unknown Opening".
 *   7. Over every shipped line: relabelling is idempotent, leaves correct labels alone, and
 *      produces only registry names.
 *
 * Run: node .bench/openinglabel.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-openinglabel');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
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

const lichess = origLoad.call(Module, findEmitted(BUILD_DIR, 'lichess.js'), null, false);
const openings = origLoad.call(Module, findEmitted(BUILD_DIR, 'openings.js'), null, false);
const {
  openingFromEcoUrl, openingNameFromMoves, openingRefForGame, relabelGameOpening,
} = lichess;
const { OPENINGS, bestOpeningForLine } = openings;

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

const registryName = (id) => OPENINGS.find((o) => o.id === id)?.name ?? null;
const available = OPENINGS.filter((o) => o.available && o.repertoire);

/** A real line through an opening, from that opening's OWN first study tree. */
function realLineFor(entry) {
  const chapters = entry.repertoire?.chapters ?? [];
  const line = [];
  for (const ch of chapters) {
    for (const st of ch.studies ?? []) {
      for (const m of st.tree ?? []) {
        if (line.length >= 14) return line;
        line.push(m.san);
      }
    }
    if (line.length >= 14) break;
  }
  return line.length >= 12 ? line : null;
}

/* --------------------------------------------------------------------- 1 */

head('1. the legacy URL parse is unchanged and faithful');

const tarraschUrl = 'https://example.test/openings/Tarrasch-Defense-1.d4-d5-2.c4-e6';
ok(openingFromEcoUrl(tarraschUrl).family === 'Tarrasch Defense',
  'the raw slug still produces its own family name',
  `got ${openingFromEcoUrl(tarraschUrl).family}`);
ok(openingFromEcoUrl(null).family === 'Unknown Opening',
  'a missing URL is still Unknown Opening');

/* --------------------------------------------------------------------- 2 */

head('2. every shipped opening is named from a real line through it');

let named = 0;
const missed = [];
for (const entry of available) {
  const line = realLineFor(entry);
  if (!line) { missed.push(`${entry.id}: no line found - SHAPE CHANGED?`); continue; }
  const got = openingNameFromMoves(line);
  if (got === entry.name) named++;
  else missed.push(`${entry.id} -> ${got === null ? 'null' : `"${got}"`}`);
}
ok(named >= 30,
  `the per-opening sweep actually ran, over ${named} openings`,
  'if this is zero the repertoire shape changed and the rest of this section is vacuous');
ok(missed.length === 0,
  `all ${named} openings are named correctly from their own line`,
  missed.join('\n          '));

/* --------------------------------------------------------------------- 3 */

head('3. a game filed under the wrong opening is corrected by its moves');

const qgEntry = available.find((o) => o.id === 'queens-gambit');
const qgLine = qgEntry ? realLineFor(qgEntry) : null;
ok(qgLine !== null, 'the Queen\'s Gambit book has a real line to test with');

if (qgLine) {
  /*
   * THE FETCH PATH FIRST, because that is the one the user's games take: `toGame` labels a
   * game through this exact function. The stored-games path below re-derives the same answer
   * from the slug, and the two must not be able to disagree.
   */
  const fetched = openingRefForGame(tarraschUrl, null, qgLine);
  ok(fetched.family === 'Queen\'s Gambit',
    'a freshly fetched game is labelled by its moves, not by the URL',
    `got "${fetched.family}" for ${qgLine.join(' ')}`);

  const misFiled = {
    opening: 'Tarrasch Defense',
    openingVariation: 'Tarrasch Defense',
    ecoSlug: 'Tarrasch-Defense-1.d4-d5-2.c4-e6',
    movesSan: qgLine,
  };
  const fixed = relabelGameOpening(misFiled);
  ok(fixed.opening === 'Queen\'s Gambit',
    'the Queen\'s Gambit move order is no longer called "Tarrasch Defense"',
    `got "${fixed.opening}" for ${qgLine.join(' ')}`);
  ok(fixed.openingVariation === 'Queen\'s Gambit',
    'and the detail name is ours too, not the stale source text');
  ok(fixed.ecoSlug === misFiled.ecoSlug,
    'the source ECO slug is preserved on the game');
  ok(bestOpeningForLine([qgLine])?.id === 'queens-gambit',
    'the correction is the registry\'s own verdict, not a second opinion',
    `registry says ${bestOpeningForLine([qgLine])?.id}`);
}

/* --------------------------------------------------------------------- 4 */

head('4. agreement is left alone - no churn');

const frenchEntry = available.find((o) => o.id === 'french-defense');
const frenchLine = frenchEntry ? realLineFor(frenchEntry) : null;
if (frenchLine) {
  const agree = {
    opening: 'French Defense',
    openingVariation: 'French Defense Classical Variation',
    ecoSlug: 'French-Defense-Classical-Variation',
    movesSan: frenchLine,
  };
  const same = relabelGameOpening(agree);
  ok(same === agree, 'an agreeing label is returned untouched (same object)');
  ok(same.openingVariation === 'French Defense Classical Variation',
    'and the source variation text survives');
}

/*
 * The same URL as section 3, a different game: here the moves really are a Tarrasch
 * (`...c5` is played), so the correction must leave both the label and the game alone. A rule
 * that "fixes" the Tarrasch direction too would be renaming from a source it distrusts to a
 * source it prefers, not correcting a misfiled game.
 */
const tarraschEntry = available.find((o) => o.id === 'tarrasch-defense');
const tarraschLine = tarraschEntry ? realLineFor(tarraschEntry) : null;
if (tarraschLine) {
  const genuine = {
    opening: 'Tarrasch Defense',
    openingVariation: 'Tarrasch Defense',
    ecoSlug: 'Tarrasch-Defense',
    movesSan: tarraschLine,
  };
  ok(relabelGameOpening(genuine) === genuine,
    'a genuine Tarrasch keeps its Tarrasch label',
    `line ${tarraschLine.slice(0, 6).join(' ')}`);
}

/* --------------------------------------------------------------------- 5 */

head('5. a game too short to decide keeps its URL label');

const stem = ['d4', 'd5', 'c4', 'e6', 'Nc3'];
ok(openingNameFromMoves(stem) === null,
  'five plies of a shared stem return no name at all',
  `got ${openingNameFromMoves(stem)}`);
const shortGame = {
  opening: 'Tarrasch Defense',
  openingVariation: 'Tarrasch Defense',
  ecoSlug: 'Tarrasch-Defense',
  movesSan: stem,
};
ok(relabelGameOpening(shortGame) === shortGame,
  'so a five-ply game keeps the source label rather than being re-guessed');

/* --------------------------------------------------------------------- 6 */

head('6. an unclassified game we DO know gains our name');

if (qgLine) {
  const unknown = {
    opening: 'Unknown Opening',
    openingVariation: 'Unknown Opening',
    ecoSlug: '',
    movesSan: qgLine,
  };
  const fixed = relabelGameOpening(unknown);
  ok(fixed.opening === 'Queen\'s Gambit',
    '"Unknown Opening" becomes the known opening',
    `got "${fixed.opening}"`);
}

/* --------------------------------------------------------------------- 7 */

head('7. every shipped line: idempotent, no churn, names valid');

const games = [];
for (const entry of available) {
  const line = realLineFor(entry);
  if (!line) continue;
  games.push({
    opening: entry.name,
    openingVariation: entry.name,
    ecoSlug: '',
    movesSan: line,
  });
}
ok(games.length >= 30, `the sweep ran over ${games.length} shipped lines`);

let changed = 0, unstable = 0, invalid = 0;
const examples = [];
const t0 = Date.now();
for (const g of games) {
  const once = relabelGameOpening(g);
  const twice = relabelGameOpening(once);
  if (twice.opening !== once.opening || twice.openingVariation !== once.openingVariation) unstable++;
  if (once.opening !== g.opening) {
    changed++;
    if (!available.some((o) => o.name === once.opening)) invalid++;
    if (examples.length < 6) examples.push(`${g.opening} -> ${once.opening}  [${g.movesSan.slice(0, 8).join(' ')}]`);
  }
}
const elapsed = Date.now() - t0;
console.log('  ---- corrections ----');
for (const e of examples) console.log('   ' + e);
console.log(`  ${changed} of ${games.length} correct labels changed`);
console.log(`  two passes over ${games.length} games took ${elapsed}ms`);
ok(elapsed < 20_000,
  'relabelling the whole corpus is not a stall',
  `${elapsed}ms for ${games.length * 2} passes - this runs once, on the load that follows the update`);
ok(changed === 0,
  `correct labels are left alone (${changed}/${games.length} changed)`,
  'a rewriter that renames correct games is replacing the source, not correcting it');
ok(unstable === 0, 'relabelling is idempotent', `${unstable} games changed on the second pass`);
ok(invalid === 0, 'every produced name is a name we ship', `${invalid} unknown names`);

/* One deliberately misfiled game proves the sweep above is not vacuous. */
const misfiled = {
  opening: 'Tarrasch Defense',
  openingVariation: 'Tarrasch Defense',
  ecoSlug: '',
  movesSan: qgLine ?? [],
};
ok(qgLine !== null && relabelGameOpening(misfiled).opening === "Queen's Gambit",
  'a wrong label is still corrected');
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILED'}  (${checks - failures}/${checks})`);
process.exit(failures === 0 ? 0 : 1);
