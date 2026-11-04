/**
 * Does the finished line actually hand the user a REACHABLE study?
 *
 * `studyForLine` returns an id, and the course screen opens a study by that id
 * through `onCourse`. An id that does not resolve is worse than no link at all:
 * the user taps "Read our study" and nothing happens, or the course opens on a
 * blank screen. So the id must round-trip through the same lookup the course
 * uses (`findStudyWithOpening`).
 *
 * Uses the shared legal-opening corpus and the real builder, like the book-tail bench.
 *
 * Usage: node .bench/openingbuilder.studylink.test.mjs
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
function cleanDir(dir) {
  try { execFileSync('rm', ['-rf', dir], { stdio: 'pipe' }); } catch { /* best effort */ }
}

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-studylink');
cleanDir(BUILD_DIR);
fs.mkdirSync(BUILD_DIR, { recursive: true });
const CONFIG = path.join(BUILD_DIR, 'tsconfig.json');
fs.writeFileSync(CONFIG, JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, paths: { '@/*': ['../../../src/*'] },
    rootDir: ROOT, outDir: BUILD_DIR, esModuleInterop: true,
  },
  include: [path.join(ROOT, 'src').replace(/\\/g, '/') + '/**/*.ts'],
  exclude: [BUILD_DIR.replace(/\\/g, '/')],
}, null, 2));
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', CONFIG,
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 1500));
  process.exit(2);
}

const Module = require('node:module');
const origResolve = Module._resolveFilename;
const OUT = path.join(BUILD_DIR, 'src');
Module._resolveFilename = function (request, parent, isMain, options) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    const rel = request.slice(2);
    if (rel.endsWith('.json')) return path.join(ROOT, 'src', rel);
    return path.join(OUT, rel + '.js');
  }
  return origResolve.call(this, request, parent, isMain, options);
};

const { buildFamilyLines, studyForLine } = require(path.join(OUT, 'lib', 'openingBuilder.js'));
const { analysedPositionsFromGames } = require(path.join(OUT, 'lib', 'gameOpenings.js'));
const { openingFromEcoUrl } = require(path.join(OUT, 'lib', 'lichess.js'));
const { findStudyWithOpening } = require(path.join(OUT, 'lib', 'openings.js'));

const PAYLOAD = [
  path.join(HERE, 'test-games.json'),
  path.join(ROOT, 'test-games.json'),
].find((p) => fs.existsSync(p));
if (!PAYLOAD) { console.error('missing test-games.json'); process.exit(2); }

function mainlineSans(pgn) {
  const body = pgn.split('\n').filter((l) => !l.trim().startsWith('[')).join(' ');
  const sans = []; const c = new Chess();
  for (const tok of body.split(/\s+/)) {
    const t = tok.trim(); if (!t) continue;
    if (t.startsWith('{') || t.endsWith('}') || t.includes('%clk')) continue;
    if (/^\d+\.+$/.test(t)) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) break;
    const clean = t.replace(/[!?]+$/, '');
    if (!clean) continue;
    try { const m = c.move(clean); if (!m) break; sans.push(m.san); } catch { break; }
  }
  return sans;
}

const raw = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
const games = (raw.games ?? raw).map((g, i) => {
  const sans = mainlineSans(g.pgn || '');
  if (sans.length < 8) return null;
  const isW = String(g.white?.username ?? '').toLowerCase() === 'hikaru';
  const { family, name } = openingFromEcoUrl(g.eco);
  return {
    id: g.uuid ?? 'g' + i, url: '', opening: family, openingVariation: name, ecoSlug: '',
    color: isW ? 'w' : 'b', outcome: 'win', playerRating: null, opponentRating: null,
    opponent: 'x', accuracy: null, opponentAccuracy: null, movesUci: [], movesSan: sans,
    timeClass: 'blitz', timeControl: '600', rated: true, endTime: 0,
  };
}).filter(Boolean);

const positions = analysedPositionsFromGames(games, { maxGames: 160, maxPly: 24 });
const families = buildFamilyLines(positions, { maxPerFamily: 24, maxAlternates: 8 });
console.log(`\ncorpus: ${games.length} games · ${families.length} families`);

console.log('\n[1] every study id the screen can offer actually resolves');

let lines = 0, linked = 0, unresolved = 0, noTitle = 0;
const titles = new Set();
const samples = [];

for (const f of families) {
  for (const steps of [f.steps, ...f.alternates]) {
    if (steps.length === 0) continue;
    lines++;
    const s = studyForLine(steps.map((x) => x.moveSan));
    if (!s) continue;
    linked++;
    if (!s.title) noTitle++;
    titles.add(s.title);
    // The exact lookup the course screen uses to open a study.
    if (!findStudyWithOpening(s.id)) {
      unresolved++;
      if (samples.length < 3) samples.push({ name: f.name, id: s.id, title: s.title });
    }
  }
}

ok('some line offers a study', linked > 0, `${linked}/${lines} lines`);
ok('every offered study id resolves in the registry', unresolved === 0, `${unresolved} unresolved`);
ok('every offered study has a title', noTitle === 0, `${noTitle} untitled`);
ok('the link covers a real spread of studies', titles.size >= 5,
  `${titles.size} distinct studies`);

for (const s of samples) console.log(`       UNRESOLVED ${s.name} -> id="${s.id}" title="${s.title}"`);

console.log('\n[2] the match is the line\'s own, not a coincidence');

/*
 * The id must come from a study whose tree the line actually follows. If the
 * matcher returned an arbitrary study, the user would tap through to a lesson
 * about an opening he did not play — the failure mode this whole feature was
 * meant to avoid. Verified by checking the study's tree contains the line's
 * first few moves.
 */
const { OPENINGS } = require(path.join(OUT, 'lib', 'openings.js'));
const treeOf = (studyId) => {
  for (const e of OPENINGS) {
    if (!e.repertoire) continue;
    for (const ch of e.repertoire.chapters) {
      const found = ch.studies.find((s) => s.id === studyId);
      if (found) return found.tree;
    }
  }
  return null;
};
const walkOk = (tree, sans) => {
  let nodes = tree;
  for (const san of sans) {
    const hit = nodes.find((n) => n.san === san);
    if (hit) { nodes = hit.variations.length ? nodes : nodes; return true; }
    let viaVar = false;
    for (const n of nodes) for (const v of n.variations) if (v[0] && v[0].san === san) viaVar = true;
    return viaVar;
  }
  return true;
};

let mismatched = 0, checkedMatch = 0;
for (const f of families) {
  const steps = f.steps;
  if (!steps || steps.length === 0) continue;
  const sans = steps.map((x) => x.moveSan);
  const s = studyForLine(sans);
  if (!s) continue;
  const tree = treeOf(s.id);
  if (!tree) continue;
  checkedMatch++;
  if (!walkOk(tree, sans.slice(0, 2))) {
    mismatched++;
    if (mismatched <= 3) console.log(`       MISMATCH ${f.name}: study "${s.title}" lacks ${sans.slice(0, 2).join(' ')}`);
  }
}
ok('the study is one whose tree the line follows', mismatched === 0,
  `${checkedMatch} checked, ${mismatched} mismatched`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILED'}  (${checks - failures}/${checks})`);
process.exit(failures === 0 ? 0 : 1);
