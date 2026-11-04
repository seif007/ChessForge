/**
 * Is the book index EXACT, or just fast?
 *
 * THE CLAIM
 * ---------
 * `bestCoverageAcrossOpenings` used to answer every question by walking all 692
 * shipped studies with `matchTree`. It now walks a SAN trie, uses the trie only
 * to CHOOSE the winning study, and takes `matchedPly` / `expectedNext` /
 * `study` from `studyCoverage` on that one study.
 *
 * A trie is the kind of thing that is *nearly* right: variations replace their
 * parent node's move, some books store a side-line as a variation that repeats
 * the parent move before diverging, and the old scan resolved ties by "first
 * study wins". Any of those could make the fast path answer a different
 * question than the slow one, and the symptom would be invisible — a book tail
 * that joins a line the library does not actually teach.
 *
 * So this compares the two implementations FIELD BY FIELD on the real corpus:
 * every prefix of every game in `test-games.json` (thousands of queries, all
 * of them the exact shape the opening builder asks), plus a set of hand-picked
 * awkward cases.
 *
 * The reference implementation here is a LITERAL COPY of the pre-index code, not
 * the shipped fallback, so a bug in the shipped one cannot hide behind itself.
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

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-bookindex');
cleanDir(BUILD_DIR);
fs.mkdirSync(BUILD_DIR, { recursive: true });

const CONFIG = path.join(BUILD_DIR, 'tsconfig.json');
fs.writeFileSync(CONFIG, JSON.stringify({
  compilerOptions: {
    target: 'es2020',
    module: 'commonjs',
    skipLibCheck: true,
    noEmitOnError: false,
    resolveJsonModule: true,
    esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] },
    rootDir: ROOT,
    outDir: BUILD_DIR,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'openings.ts'),
    path.join(ROOT, 'src', 'lib', 'repertoire.ts'),
  ],
}, null, 2));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project', CONFIG,
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
const OPENINGS_JS = findEmitted(BUILD_DIR, 'openings.js');
const REPERTOIRE_JS = findEmitted(BUILD_DIR, 'repertoire.js');

Module._load = function (request, parent, isMain) {
  if (request === 'chess.js') return REAL_CHESS;
  if (request === '@/lib/repertoire') return origLoad.call(this, REPERTOIRE_JS, null, false);
  if (request.startsWith('@/data/')) {
    return origLoad.call(this, path.join(ROOT, 'src', request.slice(2)), parent, isMain);
  }
  return origLoad.call(this, request, parent, isMain);
};

const openings = origLoad.call(Module, OPENINGS_JS, null, false);
const { OPENINGS, bestCoverageAcrossOpenings } = openings;
const { allStudies, bestCoverage } = origLoad.call(Module, REPERTOIRE_JS, null, false);

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  if (!cond || process.env.VERBOSE) console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/* ------------------------------------------------- the PRE-INDEX implementation */

function refMatchTree(nodes, sans, depth) {
  let i = 0;
  while (i < nodes.length && depth + i < sans.length && nodes[i].san === sans[depth + i]) i++;
  let best = { matched: i, expected: [] };
  if (i < nodes.length) {
    const exp = [nodes[i].san];
    for (const v of nodes[i].variations) if (v.length) exp.push(v[0].san);
    best.expected = exp.slice(0, 3);
  }
  for (let j = 0; j < i; j++) {
    for (const vari of nodes[j].variations) {
      if (!vari.length || vari[0].san !== sans[depth + j]) continue;
      const sub = refMatchTree(vari, sans, depth + j);
      if (j + sub.matched > best.matched) best = { matched: j + sub.matched, expected: sub.expected };
    }
  }
  return best;
}

function refBestCoverage(rep, sans) {
  if (sans.length === 0) return null;
  let best = null;
  for (const study of allStudies(rep)) {
    const r = refMatchTree(study.tree, sans, 0);
    if (r.matched > 0 && (!best || r.matched > best.matchedPly)) {
      best = { study, matchedPly: r.matched, expectedNext: r.expected };
    }
  }
  return best;
}

function refBestCoverageAcrossOpenings(sans) {
  if (sans.length === 0) return null;
  let best = null;
  for (const entry of OPENINGS) {
    if (!entry.available || !entry.repertoire) continue;
    const cov = refBestCoverage(entry.repertoire, sans);
    if (cov && cov.matchedPly > 0 && (!best || cov.matchedPly > best.coverage.matchedPly)) {
      best = { opening: entry, coverage: cov };
    }
  }
  return best;
}

/** Compare the two answers field by field. */
function same(a, b) {
  if (a === null || b === null) return a === b;
  if (a.opening.id !== b.opening.id) return false;
  if (a.coverage.matchedPly !== b.coverage.matchedPly) return false;
  if (a.coverage.study.id !== b.coverage.study.id) return false;
  const ea = a.coverage.expectedNext ?? [];
  const eb = b.coverage.expectedNext ?? [];
  if (ea.length !== eb.length) return false;
  for (let i = 0; i < ea.length; i++) if (ea[i] !== eb[i]) return false;
  return true;
}

/* ------------------------------------------------------------------ §1 corpus */

console.log('§1  every prefix of every real game, old vs new');
const PAYLOAD = [
  path.join(HERE, 'test-games.json'),
  path.join(ROOT, 'test-games.json'),
  path.join(HERE, '..', 'test-games.json'),
].find((p) => fs.existsSync(p));
if (!PAYLOAD) { console.error('missing test-games.json'); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));

function mainlineSans(pgn) {
  const body = pgn.split('\n').filter((l) => !l.trim().startsWith('[')).join(' ');
  const sans = [];
  const c = new Chess();
  for (const tok of body.split(/\s+/)) {
    const t = tok.trim();
    if (!t) continue;
    if (t.startsWith('{') || t.endsWith('}') || t.includes('%clk')) continue;
    if (/^\d+\.+$/.test(t)) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) break;
    const clean = t.replace(/[!?]+$/, '');
    if (!clean) continue;
    try { const m = c.move(clean); if (!m) break; sans.push(m.san); } catch { break; }
  }
  return sans;
}

let queries = 0, mismatches = 0, nonNull = 0;
const firstBad = [];
/*
 * How many games to walk.
 *
 * Every prefix of every game means ~30 exhaustive scans per game, and the
 * reference implementation is 692 studies per scan — so 1,000 games is ~6
 * minutes and a few GB of transient garbage, which is not a useful thing to ask
 * of a regression check. 300 games is ~9,000 queries over the same 692 studies
 * and the same move orders, which discriminates a wrong index immediately; the
 * sample is taken across the whole file rather than from the top so the openings
 * represented are varied.
 */
const GAMES_SCANNED = Number(process.env.BOOKINDEX_GAMES ?? 300);
const allSans = (raw.games ?? raw)
  .map((g) => mainlineSans(g.pgn ?? ''))
  .filter((s) => s.length >= 8);
const stride = Math.max(1, Math.floor(allSans.length / GAMES_SCANNED));
for (let gi = 0; gi < allSans.length; gi += stride) {
  const sans = allSans[gi];
  // The builder only ever asks about a PREFIX of a game (a position the user
  // reached), capped at MAX_PLY=24 — so that is what is compared, plus a few
  // deeper ones for good measure.
  for (let n = 1; n <= Math.min(sans.length, 30); n++) {
    const prefix = sans.slice(0, n);
    const a = refBestCoverageAcrossOpenings(prefix);
    const b = bestCoverageAcrossOpenings(prefix);
    queries++;
    if (a) nonNull++;
    if (!same(a, b)) {
      mismatches++;
      if (firstBad.length < 5) firstBad.push({ sans: prefix, a, b });
    }
  }
}
ok(`corpus queries compared (${queries})`, queries > 5000, `${queries} queries`);
ok(`every answer identical (${mismatches} mismatches)`, mismatches === 0,
  firstBad.length ? JSON.stringify(firstBad[0].sans) : '');
ok('the corpus really exercises in-book lines', nonNull > queries * 0.2,
  `${nonNull}/${queries} in book`);

/* ------------------------------------------------- §2 full games, untruncated */

console.log('§2  WHOLE games, not just prefixes (gameScan / Analysis do this)');
let full = 0, fullBad = 0;
for (const g of (raw.games ?? raw).slice(0, 250)) {
  const sans = mainlineSans(g.pgn ?? '');
  if (sans.length < 8) continue;
  full++;
  if (!same(refBestCoverageAcrossOpenings(sans), bestCoverageAcrossOpenings(sans))) fullBad++;
}
ok(`whole games identical (${full} games, ${fullBad} bad)`, fullBad === 0);

/* ------------------------------------------------------- §3 the awkward cases */

console.log('§3  hand-picked awkward cases');

/** A SAN list that diverges from every book at ply 1. */
const foreign = 'Nh3 d5 Rb3 Nc6'.split(' ');
ok('a line no book follows -> null', same(
  refBestCoverageAcrossOpenings(foreign), bestCoverageAcrossOpenings(foreign)));
ok('a single foreign move -> null', same(
  refBestCoverageAcrossOpenings(['Nh3']), bestCoverageAcrossOpenings(['Nh3'])));
ok('empty -> null', same(
  refBestCoverageAcrossOpenings([]), bestCoverageAcrossOpenings([])));

/**
 * Transpositions: the same position reached by two move orders. These are the
 * cases the module's own comments call out ("openings transpose constantly"),
 * and the ones a prefix trie is most likely to get wrong.
 */
const transpositions = [
  ['e4', 'c5', 'Nf3', 'd6'],
  ['c4', 'e5'],
  ['d4', 'Nf6', 'c4', 'e6'],
  ['Nf3', 'd5', 'c4'],
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'],
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6', 'O-O', 'Nxe4'],
];
let transBad = 0;
for (const sans of transpositions) {
  for (let n = 1; n <= sans.length; n++) {
    if (!same(refBestCoverageAcrossOpenings(sans.slice(0, n)), bestCoverageAcrossOpenings(sans.slice(0, n)))) {
      transBad++;
    }
  }
}
ok('transposed and side-line move orders identical', transBad === 0, `${transBad} bad`);

/**
 * Lines that LEAVE a book mid-way, which is the shape the "your openings" lines
 * actually are: the user's own games diverge and only the head is in book.
 */
const diverging = [
  'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2'.split(' '),
  'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3'.split(' '),
  'd4 Nf6 c4 e6 Nc3 Bb4'.split(' '),
];
let divBad = 0;
for (const sans of diverging) {
  for (let n = 1; n <= sans.length; n++) {
    if (!same(refBestCoverageAcrossOpenings(sans.slice(0, n)), bestCoverageAcrossOpenings(sans.slice(0, n)))) {
      divBad++;
    }
  }
}
ok('mid-line divergence identical', divBad === 0, `${divBad} bad`);

/**
 * A real book mainline, walked ply by ply — the case where the library follows
 * the line DEEPEST, so `matchedPly` and `expectedNext` are both load-bearing.
 */
let studyBad = 0, studyChecked = 0;
for (const entry of OPENINGS) {
  if (!entry.repertoire) continue;
  for (const study of allStudies(entry.repertoire)) {
    const sans = study.tree.map((m) => m.san);
    for (let n = 1; n <= sans.length; n++) {
      studyChecked++;
      if (!same(refBestCoverageAcrossOpenings(sans.slice(0, n)), bestCoverageAcrossOpenings(sans.slice(0, n)))) {
        studyBad++;
      }
    }
  }
}
ok(`every shipped mainline prefix identical (${studyChecked} queries)`, studyBad === 0,
  `${studyBad} bad`);

/* ---------------------------------------------------- §4 the fallback is armed */

console.log('§4  the fast path is actually being used');
/*
 * If the shipped function silently fell back to the exhaustive scan whenever the
 * two disagree, it would be correct and still slow — the failure this section
 * exists to prevent, and it is INVISIBLE in the output of §1-§3, which only
 * compare answers.
 *
 * The invariant to assert is therefore NOT a speed ratio: a ratio depends on how
 * expensive the old scan happens to be for that particular line, so it is a noisy
 * proxy for the thing that actually matters. The thing that matters is the
 * fallback itself — the index claiming a depth the winning study's own tree walk
 * does not confirm.
 *
 * The first version of this index DID claim 36% too much on in-book prefixes
 * (measured: `e4 c5 Nc3` -> trie depth 3, `s1`'s own walk 2), and every one of
 * those quietly took the slow path. A ratio check on a textbook mainline passed
 * happily, because a mainline is the one shape where the two certainly agree.
 */
const { buildCoverageTrie, lookupCoverage, studyCoverage } =
  origLoad.call(Module, REPERTOIRE_JS, null, false);
{
  const flat = [];
  for (const e of OPENINGS) for (const s of allStudies(e.repertoire)) flat.push(s);
  const root = buildCoverageTrie(flat);

  let checked = 0, disagree = 0;
  const bad = [];
  for (const sans of allSans.slice(0, 120)) {
    for (let n = 1; n <= Math.min(sans.length, 30); n++) {
      const p = sans.slice(0, n);
      const hit = lookupCoverage(root, p);
      if (!hit) continue;
      const st = hit.node.studies[0];
      if (!st) continue;
      checked++;
      const cov = studyCoverage(st, p);
      if (cov.matched !== hit.depth) {
        disagree++;
        if (bad.length < 3) bad.push(`"${p.join(' ')}" index ${hit.depth} vs ${cov.matched}`);
      }
    }
  }
  ok(`the index never over-claims depth (${checked} in-book prefixes)`, disagree === 0,
    bad.join(' | '));
}

// And a plain unit-price check, on the two shapes that matter, so a future change
// that quietly reintroduces a per-study walk fails here rather than on a phone.
const speedup = (label, sans) => {
  const t = process.hrtime.bigint();
  const N = 300;
  for (let i = 0; i < N; i++) bestCoverageAcrossOpenings(sans);
  const per = Number(process.hrtime.bigint() - t) / 1e6 / N;
  const t2 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) refBestCoverageAcrossOpenings(sans);
  const perRef = Number(process.hrtime.bigint() - t2) / 1e6 / 20;
  const ratio = perRef / per;
  ok(`${label}: >=20x cheaper (${per.toFixed(4)} ms vs ${perRef.toFixed(3)} ms)`, ratio >= 20,
    `speedup ${ratio.toFixed(0)}x`);
};

const sampleLine = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5'.split(' ');
speedup('book mainline', sampleLine);
speedup('a line the library does not know', foreign);
ok('a lookup costs well under a millisecond even for a full game',
  (() => {
    const full = allSans.find((s) => s.length > 150) ?? sampleLine;
    const t = process.hrtime.bigint();
    for (let i = 0; i < 300; i++) bestCoverageAcrossOpenings(full);
    return Number(process.hrtime.bigint() - t) / 1e6 / 300 < 0.05;
  })());

/* --------------------------------------------------------------- §5 bookMoveAt */

console.log('§5  the shipped bestCoverage still works on its own');
let repBad = 0, repChecked = 0;
for (const entry of OPENINGS) {
  if (!entry.repertoire) continue;
  for (const sans of [sampleLine, foreign, transpositions[0]]) {
    for (let n = 1; n <= sans.length; n++) {
      repChecked++;
      const a = refBestCoverage(entry.repertoire, sans.slice(0, n));
      const b = bestCoverage(entry.repertoire, sans.slice(0, n));
      if ((a?.matchedPly ?? null) !== (b?.matchedPly ?? null)) repBad++;
      if ((a?.study?.id ?? null) !== (b?.study?.id ?? null)) repBad++;
    }
  }
}
ok(`per-repertoire bestCoverage unchanged (${repChecked} queries)`, repBad === 0, `${repBad} bad`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'}: ${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
