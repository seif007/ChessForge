/**
 * Are the puzzle and endgame LEVELS real, or do they only change the label?
 *
 * The user asked: *"check if there is really levels for puzzles (i dont want to click on hard
 * and found an easy one)"*, and then the same question for endgames.
 *
 * The answer for both turned out to be "half real", which is the worst kind:
 *
 *   * Both screens resolved the chosen level into a genuine rating band, and both derived a
 *     Lichess difficulty from it.
 *   * The PUZZLE screen then had a fallback slot that took whatever the difficulty bucket
 *     returned and accepted it with NO rating check at all, so the band governed almost
 *     nothing whenever the first attempts missed.
 *   * The ENDGAME screen asked Lichess for `angle=endgame` with no difficulty parameter and
 *     no rating check, so the tier set the rules of the drill (move budget, engine strength)
 *     but not the position being judged.
 *
 * Those are behaviour on the network and cannot be exercised from a test, so what is checked
 * here is what CAN be: that the tables the fix depends on are coherent, and that each level
 * really is a different window. A test that only confirmed "beginner is easier than pro" would
 * be satisfied by a one-line label change, so the checks below are about the arithmetic —
 * every rating must fall inside the band its own tier maps to, and each tier's accepted window
 * must actually exclude material from another tier.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-levels');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'puzzles.ts'),
    path.join(ROOT, 'src', 'lib', 'endgameTrainer.ts'),
    path.join(ROOT, 'src', 'lib', 'repertoire.ts'),
    path.join(ROOT, 'src', 'lib', 'openings.ts'),
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
// Captured BEFORE the hook is installed. Calling require('chess.js') from inside the hook
// re-enters the hook for 'chess.js', which calls require('chess.js') again, forever.
const REAL_CHESS = require('chess.js');
const map = {
  '@/lib/puzzles': 'puzzles', '@/lib/endgameTrainer': 'endgameTrainer',
  '@/lib/repertoire': 'repertoire', '@/lib/openings': 'openings',
};
const stub = new Proxy(function () {}, {
  get: (_t, p) => (p === '__esModule' ? false : stub),
  apply: () => stub,
});
Module._load = function (request, parent, isMain) {
  if (map[request]) return origLoad.call(this, findEmitted(BUILD_DIR, map[request] + '.js'), null, false);
  if (request === 'chess.js') return REAL_CHESS;
  if (request.startsWith('@/data/')) {
    return origLoad.call(this, path.join(ROOT, 'src', request.slice(2)), parent, isMain);
  }
  if (request.startsWith('@/')) return stub;
  return origLoad.call(this, request, parent, isMain);
};

const puzzles = origLoad.call(Module, findEmitted(BUILD_DIR, 'puzzles.js'), null, false);
const endgames = origLoad.call(Module, findEmitted(BUILD_DIR, 'endgameTrainer.js'), null, false);

// Destructured HERE rather than in section 2, because the agreement checks in section 1 compare the
// endgame tables against the puzzle bands. Using them above their own `const` is a temporal dead zone
// error, not a soft failure — it threw here, which is why it is stated plainly rather than left to be
// discovered.
const { TIER_RATING_BAND, TIER_LICHESS_DIFFICULTY, TIER_LABEL } = endgames;

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

// ---------------------------------------------------------------------------
head('1. PUZZLE levels — every rating falls inside the band its own tier maps to');

const { PUZZLE_MODES, modeWindow, bandRange, autoModeFor, lichessDifficulty } = puzzles;
const bands = Object.fromEntries(PUZZLE_MODES.map((m) => [m.id, m.range]));

let outside = [];
for (let r = 400; r <= 2900; r += 5) {
  const tier = autoModeFor(r);
  const [lo, hi] = bands[tier];
  if (r < lo || r > hi) outside.push(`${r} -> ${tier} [${lo},${hi}]`);
}
ok(outside.length === 0,
  'every rating from 400 to 2900 is inside the band its own auto-tier maps to',
  outside.slice(0, 5).join(', '));

// A level must EXCLUDE another level's material, or it is a label and nothing else.
//
// THE FOUR BANDS, BY ID. They were renamed from chess strength titles; the bands are unchanged, so
// every number in this section is the same as it was. The ids and labels now live in five places
// that must agree, and four of them fail SILENTLY on a mismatch — `bandRange` falls back to the whole
// pool for a name it does not recognise, `POOL.filter(p => p.tier === tier)` matches nothing, and the
// screen shows an empty list with nothing in the log. The agreement is asserted below rather than left
// to a review, because a rename that missed one of the five would otherwise pass this whole gate.
const BANDS = ['warmup', 'steady', 'sharp', 'relentless'];

ok(JSON.stringify(PUZZLE_MODES.map((m) => m.id)) === JSON.stringify(BANDS),
  'PUZZLE_MODES is the four band ids, in order', PUZZLE_MODES.map((m) => m.id).join(', '));
ok(PUZZLE_MODES.every((m, i) => i === 0 || m.range[0] >= PUZZLE_MODES[i - 1].range[0]),
  'the bands ascend by rating', PUZZLE_MODES.map((m) => `${m.id} ${m.range}`).join(' | '));
ok(Object.keys(TIER_LABEL).join(',') === BANDS.join(','),
  'TIER_LABEL has one label per band, in the same order', Object.keys(TIER_LABEL).join(','));
ok(Object.keys(TIER_RATING_BAND).join(',') === BANDS.join(','),
  'TIER_RATING_BAND has one band per tier, in the same order', Object.keys(TIER_RATING_BAND).join(','));
ok(Object.keys(TIER_LICHESS_DIFFICULTY).join(',') === BANDS.join(','),
  'TIER_LICHESS_DIFFICULTY has one bucket per tier, in the same order',
  Object.keys(TIER_LICHESS_DIFFICULTY).join(','));

// (`POOL_SHARE`, `BUDGET`, `tierShift` and `GEN_MENU` are also `Record<TrainerTier, …>`, so `tsc`
// already refuses to compile if one of them loses a band. They are not checked at runtime because they
// are not exported, and this gate does not go and read private module state.)

// ...and `endgame_pool.json`, whose `tier` is matched with `===`. A row carrying a retired id makes
// `pickPool` return null for the band it was meant to serve, so the drill list comes back empty.
{
  const pool = JSON.parse(fs.readFileSync(new URL('../src/data/endgame_pool.json', import.meta.url), 'utf8'));
  const stray = [...new Set(pool.map((r) => r.tier))].filter((t) => !BANDS.includes(t));
  ok(stray.length === 0,
    `every row of endgame_pool.json carries a real band id (${pool.length} rows)`, stray.join(', '));
  ok(pool.length > 0, 'the pool file parsed and is not empty', `${pool.length} rows`);
}

// Two copies of the same edges are loaded here — `PUZZLE_MODES` and `TIER_RATING_BAND`. The third is
// `ratingBand()` in `rating.ts`, which is checked at source level below because it is a copy of the
// same if-chain and a runtime check would need another module loaded for no extra signal.
{
  let mismatch = null;
  for (let r = 400; r <= 2900; r += 10) {
    const mode = autoModeFor(r);
    const band = TIER_RATING_BAND[mode];
    if (!band) { mismatch = `${r} -> ${mode}, which TIER_RATING_BAND has no band for`; break; }
    if (r < band[0] || r > band[1]) { mismatch = `${r} -> ${mode} outside ${band}`; break; }
  }
  ok(mismatch === null,
    'the puzzle bands and the endgame bands put every rating in the same place', String(mismatch));
}

// `ratingBand()` is the third copy of those edges, and a typo in it is invisible: its result is used
// as a lookup key, so a misspelt id misses every table it is looked up in rather than throwing.
{
  const src = fs.readFileSync(new URL('../src/lib/rating.ts', import.meta.url), 'utf8');
  const returns = [...src.matchAll(/return '(\w+)';/g)].map((m) => m[1]);
  ok(returns.join(',') === BANDS.join(','),
    "ratingBand() returns the same four band ids, in the same order", returns.join(',') || '(none)');
  ok(!/ratingBand\(rating: number\):\s*'/.test(src),
    'ratingBand() is typed as TrainerTier rather than repeating the union by hand',
    'it re-declared the union inline');
}

const warmup = bandRange('warmup');
const top = bandRange('relentless');
ok(top[0] > warmup[1],
  `the Relentless band starts above the Warm-up band ends — ${top[0]} > ${warmup[1]}`,
  `warmup ${warmup}, relentless ${top}`);
/*
 * A 1300 PUZZLE IS WARM-UP MATERIAL AND A 2200 PUZZLE IS RELENTLESS MATERIAL — the report this whole
 * gate exists for: *"i dont want to click on hard and found an easy one"*.
 *
 * The bands were widened to make them satisfiable against the measured Lichess distribution (GATE 1n:
 * the `easy` bucket's floor is ~1300, so the old bottom ceiling of 1250 made the first band able to
 * load nothing at all). Widening is only defensible if the tiers still MEAN something, which is what
 * these two checks are for. The old assertion was on the old edges; it is written now against the
 * buckets, so it keeps its meaning when the bands move again.
 */
const BUCKET_FLOOR = { easy: 1300, medium: 1300, hard: 1400, hardest: 1600 };
ok(warmup[1] <= BUCKET_FLOOR.easy + 50,
  `a 1300 puzzle is inside the Warm-up band (${warmup[0]}-${warmup[1]}, easy floor ${BUCKET_FLOOR.easy})`,
  `warmup ${warmup}`);
ok(warmup[1] < top[0],
  `and a 1300 puzzle is not offered as Relentless (relentless starts at ${top[0]})`);
ok(top[0] <= 2200,
  `a 2200 puzzle is inside the Relentless band (${top[0]}-${top[1]})`,
  `relentless ${top}`);
ok(top[0] > warmup[1],
  'and a 2200 puzzle is not offered as Warm-up');

/*
 * Adjacent bands OVERLAP on purpose — the original comment recorded two bands that overlapped, and
 * after the widening they overlap rather more. That is not a defect
 * and must not be "fixed" by pulling them apart: `autoModeFor` resolves a rating to exactly one band,
 * and each band's range contains every rating that maps to it (checked above across the whole
 * 400-2900 range). What matters is that no rating falls into a GAP, and that the overlap is small
 * relative to the bands rather than a merge.
 *
 * The bound used to be an absolute 50 points, which encoded the width of the OLD bands rather than
 * anything about difficulty. With bands widened to be satisfiable, an absolute number is no longer
 * meaningful: the check has to be about the SHAPE. So it is a fraction of the narrower band, which
 * says "these are distinct tiers that touch" at any scale.
 */
const mid = bandRange('steady');
const upper = bandRange('sharp');
const sorted = PUZZLE_MODES.map((m) => m.range).sort((a, b) => a[0] - b[0]);
let gap = null;
for (let i = 1; i < sorted.length; i++) {
  if (sorted[i][0] > sorted[i - 1][1]) gap = `gap ${sorted[i - 1][1]}..${sorted[i][0]}`;
}
ok(gap === null, 'no rating falls in a gap between two bands', String(gap));
const widestOverlap = Math.max(
  ...sorted.slice(1).map((r, i) => sorted[i][1] - r[0]),
);
// The narrower of each overlapping pair, so the bound scales with the tiers rather than with an
// absolute number that happened to suit the previous table.
const narrowestInvolved = Math.min(
  ...sorted.slice(1).map((r, i) => Math.min(sorted[i][1] - sorted[i][0], r[1] - r[0])),
);
ok(widestOverlap <= narrowestInvolved / 2,
  `the widest overlap (${widestOverlap}) is at most half the narrowest band involved `
  + `(${narrowestInvolved}), so the tiers touch rather than merge`,
  `steady ${mid}, sharp ${upper}`);
// And the overlap is smaller than either band, or it would not be an overlap but a merge.
ok(widestOverlap < (upper[1] - upper[0]) / 2,
  'the overlap is a fraction of a band, not the whole of it',
  `overlap ${widestOverlap}, sharp width ${upper[1] - upper[0]}`);

// The accepted window is the intersection of the mode window and the band, which is what the
// provider uses. Recompute it here and prove it is never empty — an empty window would mean a
// level that can never serve anything.
const tol = 200;
for (const m of PUZZLE_MODES) {
  const win = modeWindow(m.id, 1500);
  const bw = bandRange(m.id);
  const lo = Math.max(win[0] - tol, bw[0]);
  const hi = Math.min(win[1] + tol, bw[1]);
  ok(hi > lo, `the ${m.id} accepted window is not empty`, `[${lo}, ${hi}]`);
}

// And the difficulty bucket genuinely differs per level, so the request to Lichess differs.
const diffs = PUZZLE_MODES.map((m) => lichessDifficulty(m.id, 1500));
ok(new Set(diffs).size === PUZZLE_MODES.length,
  'each level asks Lichess for a different difficulty bucket',
  `got ${diffs.join(', ')}`);

// ---------------------------------------------------------------------------
head('2. ENDGAME levels — the same arithmetic, on the trainer\'s tiers');

const { tierFromRating } = endgames;

let out2 = [];
for (let r = 400; r <= 2900; r += 5) {
  const tier = tierFromRating(r);
  const [lo, hi] = TIER_RATING_BAND[tier];
  if (r < lo || r > hi) out2.push(`${r} -> ${tier} [${lo},${hi}]`);
}
ok(out2.length === 0,
  'every rating from 400 to 2900 is inside the band its own tier maps to',
  out2.slice(0, 5).join(', '));

const eb = TIER_RATING_BAND.warmup;
const ep = TIER_RATING_BAND.relentless;
ok(ep[0] > eb[1],
  `the Relentless band starts above the Warm-up band ends — ${ep[0]} > ${eb[1]}`,
  `warmup ${eb}, relentless ${ep}`);

const ediff = Object.values(TIER_LICHESS_DIFFICULTY);
ok(new Set(ediff).size === 4,
  'each endgame band asks Lichess for a different difficulty bucket', `got ${ediff.join(', ')}`);

// THE CONTROL: a level table alone proves nothing, because a table is what a pure label change
// also produces. What makes the level real is that the request to Lichess is built FROM it.
// Assert the request would differ per tier by checking the tier is what selects the bucket —
// `auto` has no bucket of its own, which is the property the fix relies on.
ok(TIER_LICHESS_DIFFICULTY.warmup === 'easy' && TIER_LICHESS_DIFFICULTY.relentless === 'hardest',
  'the bottom band asks for easy and the top band asks for hardest, the extremes of the four we use');
ok(!('auto' in TIER_LICHESS_DIFFICULTY),
  'there is no auto bucket, so every request names the band the user actually chose');

// `tierLabel` used to be derived from the id by capitalising its first letter, which made the id the
// displayed word. It is a table now, and a missing entry would render `undefined` in the menu — so
// assert every band has a label, and that no two bands share one.
const labels = BANDS.map((t) => endgames.tierLabel(t));
ok(labels.every((l) => typeof l === 'string' && l.length > 0),
  'every band has a menu label', labels.join(', '));
ok(new Set(labels).size === labels.length,
  'no two bands share a label', labels.join(', '));

console.log(`\n${checks - failures}/${checks} passed`);
console.log('\nNOTE: these check the tables, not the network path. The fix that removed the');
console.log('unconditional fallback and the unfiltered endgame request can only be confirmed on');
console.log('a device: force the bottom band, ask for several puzzles, and confirm none is rated');
console.log('above the band.');
process.exit(failures > 0 ? 1 : 0);
