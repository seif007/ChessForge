/**
 * LICHESS OPENING NAMES BECOME THE APP'S TWO-LEVEL LABEL.
 *
 * Lichess sends a full opening name ("Sicilian Defense: Najdorf Variation")
 * and an ECO code. The Stats screen groups by family, so the family must be the
 * opening's first real name and not a bare adjective, a variation, or the full
 * string with a colon still in it.
 *
 * Run: node .bench/lichess.opening.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-lichess-opening');

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

const { openingFromName, openingFromEcoUrl } = origLoad.call(
  Module, findEmitted(BUILD_DIR, 'lichess.js'), null, false,
);

let checks = 0, failures = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

const cases = [
  ['Sicilian Defense: Najdorf Variation', 'Sicilian Defense'],
  ["Queen's Gambit Declined: Exchange Variation", "Queen's Gambit"],
  ['Ruy Lopez: Berlin Defense', 'Ruy Lopez'],
  ['French Defense: Winawer Variation', 'French Defense'],
  ["King's Indian Defense: Classical Variation", "King's Indian"],
  ['Caro-Kann Defense: Advance Variation', 'Caro-Kann Defense'],
  ['Italian Game: Giuoco Piano', 'Italian Game'],
  ['English Opening: Symmetrical Variation', 'English Opening'],
  ['Dutch Defense: Stonewall Variation', 'Dutch Defense'],
  ['Vienna Game: Falkbeer Variation', 'Vienna Game'],
  ['Scotch Game: Classical Variation', 'Scotch Game'],
  ['Alekhine Defense: Modern Variation', 'Alekhine Defense'],
  ['Pirc Defense: Austrian Attack', 'Pirc Defense'],
  ['London System', 'London System'],
  ['Catalan Opening: Closed Variation', 'Catalan Opening'],
  ['Réti Opening: King\'s Indian Attack', 'Réti Opening'],
  ["King's Gambit Accepted", "King's Gambit"],
  ['Bishop\'s Opening: Berlin Defense', "Bishop's Opening"],
  ['Nimzowitsch Larsen Attack', 'Nimzowitsch Larsen'],
  ['Trompowsky Attack: Raptor Variation', 'Trompowsky Attack'],
];

console.log('\n1. full Lichess names and their families');
for (const [name, family] of cases) {
  const ref = openingFromName(name, 'C60');
  ok(ref.name === name, `the full name survives: ${name}`);
  ok(ref.family === family, `${name} groups under ${family}`, ref.family);
  ok(ref.slug === 'C60', 'the ECO code is kept');
  ok(ref.family === name || name.startsWith(ref.family + ':') || name.startsWith(ref.family + ' '),
    'the family is a real prefix of the name', `${ref.family} / ${name}`);
}

console.log('\n2. no family is a bare adjective');
const suspicious = cases
  .map(([name]) => openingFromName(name))
  .filter((ref) => ref.family.split(/\s+/).length === 1 && !/^Unknown/.test(ref.family));
ok(suspicious.length === 0,
  'every family has at least two words or is an Unknown fallback',
  suspicious.map((r) => r.family).join(', '));

console.log('\n3. missing and malformed names');
const unknown = openingFromName(null, 'C60');
ok(unknown.family === 'Unknown Opening' && unknown.name === 'Unknown Opening',
  'a missing name is Unknown Opening');
ok(unknown.slug === 'C60', 'but the ECO code is not discarded');
ok(openingFromName('', '')?.family === 'Unknown Opening', 'an empty name is Unknown Opening');
ok(openingFromName('   ', null)?.family === 'Unknown Opening', 'whitespace is not a name');
const noEco = openingFromName('Ruy Lopez', null);
ok(noEco.slug === '', 'a missing ECO code is an empty slug, not the string "null"');
ok(openingFromName('Kings Indian Defense')?.family === "King's Indian",
  'the apostrophe is restored, not lost');
ok(openingFromName('Queens Gambit Declined')?.family === "Queen's Gambit",
  'the Queen apostrophe is restored too');
ok(openingFromName('Reti Opening')?.family === 'Réti Opening',
  'the accent is restored');

console.log('\n4. the legacy URL parser still reads a slug faithfully');
const legacy = openingFromEcoUrl('https://example.test/openings/Sicilian-Defense-Najdorf-1.e4-c5-2.Nf3-d6');
ok(legacy.name.startsWith('Sicilian Defense'), 'the URL slug becomes the full name', legacy.name);
ok(legacy.family === 'Sicilian Defense', 'and the family is the same two-level label', legacy.family);
ok(legacy.slug.length > 0, 'the raw slug is preserved');

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
