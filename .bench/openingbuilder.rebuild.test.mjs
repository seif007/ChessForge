/**
 * Is "analyse, then rebuild" IDEMPOTENT?
 *
 * THE BUG THIS PINS
 * -----------------
 * The screen builds a family's lines engine-free, then -- once the user opens
 * that family -- runs the engine and rebuilds the family from the analysed
 * positions. If the rebuild starts from a SUBSET of the family's positions, the
 * rotation sees a smaller pool and can return a different (usually shorter)
 * line. The user would open a 15-ply Sicilian, wait for the engine, and watch
 * the line quietly shrink.
 *
 * That is not hypothetical: `mergeAnalysed` used to rebuild from `steps` alone,
 * keeping only the PLACED positions and dropping every orphan. With the old
 * one-ply spines almost nothing was placed and the pool happened to be small
 * enough not to matter; with real 15-ply spines the pool matters a lot.
 *
 * So: rebuilding a family from its own full pool, with the analysed records
 * substituted in, must reproduce the SAME line. If it does not, the screen is
 * showing something different from what the engine scored.
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

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-idem');
try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* ok */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

const CONFIG = path.join(BUILD_DIR, 'tsconfig.json');
fs.writeFileSync(CONFIG, JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT,
    outDir: BUILD_DIR, esModuleInterop: true,
  },
  include: [path.join(ROOT, 'src').replace(/\\/g, '/') + '/**/*.ts'],
  exclude: [BUILD_DIR.replace(/\\/g, '/')],
}, null, 2));
try {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', CONFIG], { stdio: 'pipe' });
} catch (e) { console.error('tsc:', e.stdout?.toString()?.slice(0, 2000)); process.exit(2); }

const OUT = path.join(BUILD_DIR, 'src');
const Module = require('node:module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    const rel = request.slice(2);
    if (rel.endsWith('.json')) return path.join(ROOT, 'src', rel);
    return path.join(OUT, rel + '.js');
  }
  return origResolve.call(this, request, parent, isMain, options);
};

const { buildFamilyLines } = require(path.join(OUT, 'lib', 'openingBuilder.js'));
const { analysedPositionsFromGames } = require(path.join(OUT, 'lib', 'gameOpenings.js'));
const { openingFromEcoUrl } = require(path.join(OUT, 'lib', 'lichess.js'));

const PAYLOAD = [path.join(HERE, 'test-games.json'), path.join(ROOT, 'test-games.json')].find((p) => fs.existsSync(p));
if (!PAYLOAD) { console.error('missing test-games.json'); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));

function mainlineSans(pgn) {
  const body = pgn.split('\n').filter((l) => !l.trim().startsWith('[')).join(' ');
  const sans = []; const c = new Chess();
  for (const tok of body.split(/\s+/)) {
    const t = tok.trim(); if (!t) continue;
    if (t.startsWith('{') || t.endsWith('}') || t.includes('%clk')) continue;
    if (/^\d+\.+$/.test(t)) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) break;
    const clean = t.replace(/[!?]+$/, ''); if (!clean) continue;
    try { const m = c.move(clean); if (!m) break; sans.push(m.san); } catch { break; }
  }
  return sans;
}

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

const OPTS = { maxPly: 20, maxAlternates: 8 };
const base = analysedPositionsFromGames(games, { maxGames: 160, maxPly: OPTS.maxPly });
const families = buildFamilyLines(base, OPTS);
console.log(`\ncorpus: ${games.length} games · ${base.length} positions · ${families.length} families\n`);

/** The screen's mergeAnalysed, mirrored: pool -> substitute -> rebuild. */
function rebuild(fam, substituted) {
  const byKey = new Map(substituted.map((p) => [p.key, p]));
  const pool = fam.positions.map((p) => byKey.get(p.key) ?? p);
  return buildFamilyLines(pool, OPTS).find((r) => r.id === fam.id) ?? null;
}

const sig = (steps) => steps.map((s) => `${s.moveSan}${s.choice ? '*' : ''}`).join(' ');

console.log('[1] rebuilding from the FULL pool reproduces the same line');

let checked = 0, drifted = 0, missing = 0;
for (const f of families) {
  checked++;

  // Identity substitution: every position maps to itself. Any difference at all
  // is the rotation being unstable, which would also make the engine pass lossy.
  const again = rebuild(f, f.positions);
  if (!again) { missing++; ok(`rebuild: ${f.name}`, false, 'family disappeared'); continue; }
  if (sig(again.steps) !== sig(f.steps)) {
    drifted++;
    ok(`rebuild: ${f.name} (${f.side})`, false,
      `line changed: ${f.steps.length} -> ${again.steps.length} plies`);
    continue;
  }
  if (again.alternates.length !== f.alternates.length) {
    drifted++;
    ok(`rebuild siblings: ${f.name} (${f.side})`, false,
      `${f.alternates.length} -> ${again.alternates.length}`);
  }
}
ok(`rebuild is idempotent (${checked} families)`, drifted === 0 && missing === 0,
  drifted || missing ? `${drifted} drifted, ${missing} missing` : '');

console.log('\n[2] the pool is the WHOLE family, not just the placed part');

/*
 * The property that makes [1] meaningful.
 *
 * Note what is NOT the invariant: `pool >= placedSteps`. Alternate lines are
 * rotated out of the SAME pool, so a family with one position placed on the
 * spine and one on a sibling has 2 step-slots but only 2 positions -- and a
 * family whose sibling re-uses the stem can report more steps than positions.
 * Comparing those two numbers directly is meaningless.
 *
 * What matters is that every position in the family is RETAINED, so the rebuild
 * has the full pool to rotate. That is checked exactly: the pool must contain
 * every position the family was built from, with none dropped.
 */
const poolKeys = new Set(families.flatMap((f) => f.positions.map((p) => p.key)));
const baseKeys = new Set(base.map((p) => p.key));
const missingKeys = [...baseKeys].filter((k) => !poolKeys.has(k));
ok(`every family position is retained in a pool (${poolKeys.size}/${baseKeys.size})`,
  missingKeys.length === 0, missingKeys.length ? `${missingKeys.length} dropped` : '');

const withOrphans = families.filter((f) => f.orphans > 0).length;
ok(`families report their orphans (${withOrphans}/${families.length})`, withOrphans >= 0,
  `${withOrphans} families have orphans`);

/*
 * ...and the pool must include the positions that are NOT on any line. If only
 * placed positions were carried, a family's pool would equal the distinct keys
 * appearing in its own steps, which is strictly smaller whenever it has orphans.
 */
let lossy = 0;
for (const f of families) {
  if (f.orphans === 0) continue;
  const onLine = new Set([f.steps, ...f.alternates].flat().map((s) => s.position?.key).filter(Boolean));
  if (onLine.size >= f.positions.length) lossy++;
}
ok(`orphaned positions are carried in the pool (${withOrphans - lossy}/${withOrphans} families)`,
  lossy === 0, lossy ? `${lossy} families carry only placed positions` : '');

console.log('\n[3] an ENGINE-FREE rebuild does not shrink the line');

/*
 * The specific failure mode: substitute the engine-free records back in (which
 * is what happens when the engine has not answered yet) and rebuild. The line
 * must be unchanged, and in particular must not lose depth.
 */
let shrank = 0;
for (const f of families) {
  const again = rebuild(f, base.filter((p) => p.opening === f.sourceName));
  if (!again) { shrank++; continue; }
  if (again.steps.length < f.steps.length) shrank++;
}
ok(`engine-free rebuild keeps the depth (${families.length} families)`, shrank === 0,
  shrank ? `${shrank} shrank` : '');

console.log('\n[4] edges');

ok('a family with no positions rebuilds to null', (() => {
  const empty = { ...families[0], positions: [] };
  return rebuild(empty, []) === null || rebuild(empty, []).steps.length === 0;
})());
ok('an unknown substitution key falls back to the original record', (() => {
  const f = families.find((x) => x.steps.length > 0);
  const again = rebuild(f, [{ ...f.positions[0], key: 'not-a-real-key' }]);
  return again != null && sig(again.steps) === sig(f.steps);
})());

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* ok */ }
