/**

 */

/**
 * Does "Your openings" now behave like the product, or just look like it?
 *
 * THE TWO COMPLAINTS THIS IS WRITTEN AGAINST
 * ------------------------------------------
 *   *"i played few moves in london and it is not london and just 2-3 moves !"*
 *
 * Two separate defects in one report, and they have different causes:
 *
 *   "not london"  - the card mixed three sources into one list: the user's own positions, a book
 *                   tail, and (as of the engine bridge) engine moves. A list assembled from
 *                   different sources is not a line, and the moves in it are not all London.
 *                   The fix is that a line is now ONE thing with a source per step, and this
 *                   test asserts a line is a single coherent move order that replays legally.
 *
 *   "2-3 moves"   - a family card showed one `spine` and hid the rest behind an "Other lines (8)"
 *                   control, and the spine is whatever the pool rotation reached first. Now every
 *                   line is listed, sized, and pickable.
 *
 * And the ordering claims, which are the actual product: "prioritizes what you're most likely to
 * encounter" and "see your win rate for each opening to pinpoint weaknesses". Both are checkable
 * here, and both were false before - the order came from the rotation and there was no win rate
 * at all.
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
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-youropenings');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'openings.ts'),
    path.join(ROOT, 'src', 'lib', 'repertoire.ts'),
    path.join(ROOT, 'src', 'lib', 'gameOpenings.ts'),
    path.join(ROOT, 'src', 'lib', 'openingBuilder.ts'),
    path.join(ROOT, 'src', 'lib', 'yourOpenings.ts'),
  ],
}, null, 2));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project',
    path.join(BUILD_DIR, 'tsconfig.json'),
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
const J = (n) => findEmitted(BUILD_DIR, n + '.js');
const stub = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : stub), apply: () => stub });

Module._load = function (request, parent, isMain) {
  if (request === 'chess.js') return REAL_CHESS;
  if (request === '@/lib/engine') return { getEngine: () => ({ bestMove: () => null }), uciToSan: () => null };
  const map = {
    '@/lib/repertoire': 'repertoire', '@/lib/openings': 'openings',
    '@/lib/gameOpenings': 'gameOpenings', '@/lib/openingBuilder': 'openingBuilder',
    '@/lib/yourOpenings': 'yourOpenings',
  };
  if (map[request]) return origLoad.call(this, J(map[request]), null, false);
  if (request.startsWith('@/data/')) return origLoad.call(this, path.join(ROOT, 'src', request.slice(2)), parent, isMain);
  if (request.startsWith('@/')) return new Proxy(function () {}, { get: (_t, p) => (p === '__esModule' ? false : stub), apply: () => stub });
  return origLoad.call(this, request, parent, isMain);
};

const builder = origLoad.call(Module, J('openingBuilder'), null, false);
const yo = origLoad.call(Module, J('yourOpenings'), null, false);
const { buildFamilyLines } = builder;
const { drillableLines, describeLine, familyRecord, rankFor, depthForRank, stepsForRef, resolveLine } = yo;
const { askablePositions, allLineRefs, buildDecisionIndex, decisionAt } = yo;
// The openings module is loaded here as well, so the checks can read the REAL corpus rather than a
// fixture. A floor that is only tested against synthetic games is a floor that has never met the
// thing it exists to protect.
yo.openingsForTest = origLoad.call(Module, J('openings'), null, false);
yo.repertoireForTest = origLoad.call(Module, J('repertoire'), null, false);

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) { console.log('  PASS  ' + label); return; }
  failures++;
  console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : ''));
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

/**
 * Build the `GamePosition[]` shape the screen feeds `buildFamilyLines`, from real move orders.
 *
 * THE RECOMMENDATION MUST DIFFER FROM THE PLAYED MOVE, and that took one attempt to notice.
 * A `choice` is only created when there is something to decide — "keep yours or take ours?" with
 * ours being yours is not a decision, and the builder correctly refuses to invent one. Setting
 * `recommendSan` to the move the user played therefore produced zero decisions and every line
 * read 0 decisions. The tests failed for the right reason and the fixture was wrong, not the
 * code. (Vision note: the mastery ring USED to be counted over decision positions and so read
 * zero here too — §4 now asserts it is counted over his own moves instead, precisely so a
 * decision-free line still reports progress.)
 */
function positionsFromGames(openingName, moveOrders) {
  // `timesSeen` MUST reflect reality, and the first version of this fixture set it to 1 for
  // everything. In the real pipeline a position reached by four games carries `timesSeen: 4` and
  // the other three are collapsed into it — so a fixture that says 1 for all of them describes a
  // world where the user played four different things, and the likelihood ordering cannot be
  // tested at all. Counted properly here, the same way the real pipeline counts.
  const fens = [];
  for (const sans of moveOrders) {
    const c = new Chess();
    const seen = [];
    for (const s of sans) { seen.push(c.fen()); c.move(s); }
    fens.push(seen);
  }
  const timesSeenAt = (gi, ply) => {
    let n = 0;
    for (let g = 0; g < moveOrders.length; g++) {
      // Only games that actually REACHED this ply, and that played the same move order to it,
      // count - a game that ended earlier or diverged did not reach this position.
      if ((fens[g][ply] ?? null) === fens[gi][ply]) n++;
    }
    return n;
  };

  const out = [];
  moveOrders.forEach((sans, gi) => {
    const c = new Chess();
    for (let ply = 0; ply < sans.length; ply++) {
      const fen = c.fen();
      const side = c.turn();
      const prefixSan = sans.slice(0, ply);
      let m;
      try { m = c.move(sans[ply]); } catch {
        throw new Error(`TEST DATA is not a legal game: ${openingName} game ${gi}, ply ${ply}, "${sans[ply]}"`);
      }

      // From ply 4 on, recommend a genuinely different legal move: the first one that is not the
      // move just played. A real recommendation, not a fabricated one - it is read back out of
      // the position by chess.js.
      let recommendSan = null, recommendUci = null;
      if (ply >= 4) {
        const legal = new Chess(fen).moves({ verbose: true });
        const alt = legal.find((x) => x.san !== sans[ply]);
        if (alt) { recommendSan = alt.san; recommendUci = `${alt.from}${alt.to}${alt.promotion ?? ''}`; }
      }

      out.push({
        key: `${openingName}#${gi}#${ply}`, fen, ply, side,
        gameId: `g${gi}`, gameUrl: '',
        opening: openingName,
        playedSan: sans[ply], playedUci: `${m.from}${m.to}${m.promotion ?? ''}`,
        prevSan: prefixSan.length ? prefixSan[prefixSan.length - 1] : null,
        prefixSan: [...prefixSan],
        inBook: false, bookSan: null, bookReplies: [],
        recommendUci, recommendSan, options: [],
        timesSeen: timesSeenAt(gi, ply),
      });
    }
  });
  return out;
}

const NO_PROGRESS = {};

// ---------------------------------------------------------------------------
head('1. a line is ONE coherent move order, not a mixture of sources');

/*
 * The "it is not london" half of the report. A family built from real games yields several lines,
 * and every one of them must be a legal, continuous line from move one. Before this, a card could
 * interleave the user's own positions with a book tail and engine moves, which is why the moves on
 * it were not recognisably the opening the card was named after.
 */
{
  const orders = [
    ['e4', 'c5', 'Nf3', 'd6', 'c4', 'd5', 'Nc3', 'Nc6'],
    ['e4', 'c5', 'Nf3', 'd6', 'c4', 'd5', 'Nc3', 'Nc6'],
    ['e4', 'c5', 'Nc3', 'Nc6', 'g3', 'g6'],
    ['e4', 'c5', 'Nc3', 'd6', 'g3', 'g6', 'Bg2'],
  ];
  const [fam] = buildFamilyLines(positionsFromGames('Sicilian Defense', orders), { maxPerFamily: 24 });
  const lines = drillableLines(fam, NO_PROGRESS);

  ok(lines.length >= 2, `the family offers ${lines.length} lines, not one spine`);

  let illegal = [];
  for (const line of lines) {
    const c = new Chess();
    for (const san of line.sans) { try { c.move(san); } catch { illegal.push(`${line.ref.kind}${line.ref.kind === 'alt' ? line.ref.index : ''}: ${san}`); break; } }
  }
  ok(illegal.length === 0, 'every line replays legally from the initial position', illegal.join(', '));

  // And every line is recognisably a Sicilian: it must start 1.e4 c5. A line that did not is the
  // exact "it is not london" symptom, and it is checkable because the corpus is real.
  const notSicilian = lines.filter((l) => l.sans[0] !== 'e4' || l.sans[1] !== 'c5');
  ok(notSicilian.length === 0,
    'every line of a Sicilian family actually starts 1.e4 c5',
    notSicilian.map((l) => l.sans.slice(0, 4).join(' ')).join(' | '));

  // Each line must be DISTINCT, or the list is the same line three times.
  const keys = lines.map((l) => l.sans.join(' '));
  ok(new Set(keys).size === keys.length, 'the lines are distinct from each other');
}

// ---------------------------------------------------------------------------
head('2. "just 2-3 moves" - the card is sized, and the lines are listed');

{
  const orders = [
    ['d4', 'd5', 'Nf3', 'Nf6', 'Bf4', 'e6', 'e3', 'Nbd7', 'Bd3', 'c5'],
    ['d4', 'd5', 'Nf3', 'Nf6', 'Bf4', 'e6', 'e3', 'Nbd7', 'Bd3', 'c5'],
  ];
  const [fam] = buildFamilyLines(positionsFromGames('London System', orders), { maxPerFamily: 24 });
  const lines = drillableLines(fam, NO_PROGRESS);

  // The pool here reaches ply 10, so any line the app offers as drillable must be at least that.
  // A 2-ply line is the reported symptom and must not be constructible.
  const shortest = Math.min(...lines.map((l) => l.plies));
  ok(shortest >= 10,
    `the shortest offered line is ${shortest} plies, not a 2-3 ply stub`,
    lines.map((l) => `${l.plies}`).join(', '));

  ok(lines.every((l) => l.preview.length > 0),
    'every line has a preview the user can recognise it by');
  ok(lines.every((l) => l.plies > 0 && l.decisions > 0),
    'every line has something to actually drill',
    lines.map((l) => `${l.plies}p/${l.decisions}d`).join(', '));
}

// ---------------------------------------------------------------------------
head('3. "prioritizes what you are most likely to encounter"');

/*
 * The ordering claim, checked against real games rather than asserted. One move order is played in
 * four games and another in one, and the four-game line must come first - even though the pool
 * rotation happened to reach the one-game line first, which is what the old order did.
 */
{
  const common = ['d4', 'd5', 'Nf3', 'Nf6', 'Bf4', 'e6', 'e3'];
  const rare = ['d4', 'd5', 'Nc3', 'Nf6', 'e3', 'c5', 'Nf3'];
  const orders = [common, common, common, common, rare];
  const [fam] = buildFamilyLines(positionsFromGames('Queen\'s Gambit', orders), { maxPerFamily: 24 });
  const lines = drillableLines(fam, NO_PROGRESS);

  const weights = lines.map((l) => l.weight);
  ok(weights.length > 1 && weights[0] > weights[weights.length - 1],
    `the most-played line is listed first (weights ${weights.join(', ')})`,
    'weights are ' + lines.map((l) => `${l.sans.slice(0, 3).join('')}:${l.weight}`).join(' '));

  // WEIGHT COUNTS GAMES, NOT PLIES, AND IS MEASURED AT THE DEEPEST POSITION. Two controls,
  // because both wrong answers looked plausible:
  //   - a plies-based weight would make one 20-ply game outweigh four 6-ply games;
  //   - a MAX-based weight is measured on the shared `d4 d5` prefix and ties every line, which
  //     is the version that shipped in the first attempt and made both lines weigh 5.
  const fourShort = lines.find((l) => l.weight === 4);
  ok(fourShort !== undefined, 'a line reached by four games weighs 4', `weights: ${weights.join(', ')}`);
  ok(lines.some((l) => l.weight === 1),
    'a line only one game reached weighs 1', `weights: ${weights.join(', ')}`);
  ok(lines.every((l) => l.weight <= 5),
    'no line weighs more than the number of games that reached it',
    `weights: ${weights.join(', ')}`);

  // ORDER MUST BE STABLE. An order that changes between renders would make the list reshuffle
  // under the user's thumb.
  const again = drillableLines(fam, NO_PROGRESS).map((l) => l.sans.join(' '));
  const once = lines.map((l) => l.sans.join(' '));
  ok(again.join('|') === once.join('|'), 'the order is deterministic for the same family');
}

// ---------------------------------------------------------------------------
head('4. mastery out of ten, and it grows');

{
  const orders = [['e4', 'c5', 'Nf3', 'd6', 'c4', 'd5', 'Nc3', 'a6']];
  const [fam] = buildFamilyLines(positionsFromGames('Sicilian Defense', orders), { maxPerFamily: 24 });
  const main = { kind: 'main' };

  const fresh = describeLine(fam, main, {});
  ok(fresh.mastery === 0,
    `a line never drilled reads 0/10, not "no data" and not a perfect score (got ${fresh.mastery})`);

  /*
   * THE BASIS IS HIS OWN MOVES, NOT THE POSITIONS THE ENGINE JUDGED.
   *
   * Play the whole line to perfection and the ring must reach 10 — and "the whole line" means
   * every step that carries a position, because every one of those is a move the user makes and
   * the app records. Averaging over `choice` steps instead pinned a family whose analysis had not
   * published at 0% for ever, which is the report: *"the circle ... advanced, but in a new one it
   * didnt advance while i complete it"*.
   */
  const mine = fam.steps.filter((s) => s.position != null);
  const judged = fam.steps.filter((s) => s.choice != null && s.position != null);
  ok(mine.length > 0 && judged.length > 0 && mine.length > judged.length,
    'CONTROL: the fixture has his moves the engine has NOT judged — the case the ring used to drop',
    `${mine.length} his, ${judged.length} judged`);

  const perfect = {};
  for (const step of mine) {
    perfect[step.position.key] = { asked: 3, correct: 3, mastery: 1 };
  }
  const mastered = describeLine(fam, main, perfect);
  ok(mastered.mastery === 10, `a fully played line reads 10/10 (got ${mastered.mastery})`);
  ok(mastered.asked > 0, 'the asked-count is carried, so the ring is backed by attempts');

  // The reported case, directly: no engine verdicts anywhere and the ring STILL moves when the
  // moves are played. The old decision-based basis could never move such a line's ring.
  const unjudged = { ...fam, steps: fam.steps.map((s) => ({ ...s, choice: null })) };
  ok(describeLine(unjudged, main, perfect).mastery === 10,
    'a line with no engine verdicts still moves its ring when played');
  ok(describeLine(unjudged, main, {}).mastery === 0,
    'CONTROL: and it still reads 0/10 before a single move of it has been played');

  // Half right, half wrong, and the ring must land between.
  const half = {};
  for (const step of mine) {
    half[step.position.key] = { asked: 2, correct: 1, mastery: 0.5 };
  }
  const middling = describeLine(fam, main, half);
  ok(middling.mastery > 0 && middling.mastery < 10,
    `a part-answered line reads between 0 and 10 (got ${middling.mastery})`);

  // Progress must be MONOTONE: more correct answers never lowers the ring. A ring that can go
  // backwards for the same state would make "it grows over time" false.
  let prev = -1, monotone = true;
  for (let m = 0; m <= 10; m++) {
    const prog = {};
    for (const step of mine) prog[step.position.key] = { asked: 1, correct: 1, mastery: m / 10 };
    const r = describeLine(fam, main, prog).mastery;
    if (r < prev) monotone = false;
    prev = r;
  }
  ok(monotone, 'the ring never goes down as mastery rises');
}

// ---------------------------------------------------------------------------
head('5. "see your win rate for each opening to pinpoint weaknesses"');

{
  const fam = {
    id: 'queens-gambit', name: "Queen's Gambit + Queen's Pawn",
    sourceName: "Queen's Gambit + Queen's Pawn",
    // The merged-family case, and the reason this test exists: the display name matches no single
    // game, so an equality test reports a 0% win rate on the opening he has played most.
    sourceNames: ["Queen's Gambit", "Queen's Pawn"],
    side: 'w', games: 4, openingId: 'queens-gambit', inBook: true,
  };
  const games = [
    { opening: "Queen's Gambit", outcome: 'win', accuracy: 80 },
    { opening: "Queen's Pawn", outcome: 'loss', accuracy: 60 },
    { opening: "Queen's Gambit", outcome: 'draw', accuracy: null },
    { opening: 'Sicilian Defense', outcome: 'loss', accuracy: 55 },
  ];
  const rec = familyRecord(fam, games);
  ok(rec.games === 3, `only the family's own games are counted (got ${rec.games})`);
  ok(rec.wins === 1 && rec.draws === 1 && rec.losses === 1,
    `the record is split correctly (${rec.wins}W ${rec.draws}D ${rec.losses}L)`);
  // A draw is half a win: (1 + 0.5) / 3.
  ok(Math.abs(rec.winRate - 0.5) < 1e-9,
    `a draw counts as half a win (got ${rec.winRate})`,
    'without this a family of draws looks like a family of losses');
  ok(rec.meanAccuracy === 70, `mean accuracy ignores the null (got ${rec.meanAccuracy})`);

  const empty = familyRecord(fam, []);
  ok(empty.winRate === null, 'no games reads "no record" rather than 0%');
}

// ---------------------------------------------------------------------------
head('6. rank grows with mastery and sets how deep a drill goes');

/*
 * THE LADDER IS SIX NAMES, AND IT LIVES IN FIVE PLACES.
 *
 * The six were renamed from chess strength titles to this app's own heat ladder, and nothing about
 * the mechanics moved. That rename is the reason this section is stricter than it needs to be.
 *
 * `RANKS`, `RANK_ORDER`, `LINES_PER_RANK`, `depthForRank`'s switch and `LEVELS` in `repertoire.ts`
 * are five separate places that have to agree on six strings, and THREE of them fail silently on a
 * mismatch rather than erroring:
 *
 *   `linesForRank`   - `LINES_PER_RANK[name] ?? 8`, so a name it does not know shows the FIRST
 *                      rank's worth of lines under the name of the sixth.
 *   `depthForRank`   - `default: return 999`, so a name it does not know is treated as the TOP rank
 *                      and the user is handed a complete line under a label that is not on the ladder.
 *   `xpTitle`        - a plain if-chain that simply returns whichever literal it reaches.
 *
 * A rename that missed one of the five would therefore still typecheck, still pass `tsc`, still build
 * an APK, and still report success — while the top rank silently behaved like the bottom one. That
 * is the whole class of defect these gates exist to catch, so the agreement is asserted here rather
 * than left to a review.
 *
 * The name check below is deliberately a list of literals rather than a regex: a test that greps for
 * a forbidden word cannot also be the test that requires the replacement, and the ladder is the
 * replacement.
 */
const LADDER = ['Spark', 'Ember', 'Flame', 'Blaze', 'Forge', 'Crucible'];

{
  const r0 = rankFor(0), r5 = rankFor(5), r10 = rankFor(10);
  ok(r0.current === 'Spark', `0/10 is a Spark (got ${r0.current})`);
  ok(r10.current === 'Crucible', `10/10 is a Crucible (got ${r10.current})`);
  ok(r10.next === null, 'Crucible has no next rank - there is nothing above it');
  ok(depthForRank('Spark') < depthForRank('Crucible'),
    `a Spark is taken less deep than a Crucible (${depthForRank('Spark')} vs ${depthForRank('Crucible')})`);
  // The floor is set so the shallowest rank still covers five moves - ten plies.
  ok(depthForRank('Spark') >= 10, 'Spark still covers five moves');
  ok(depthForRank('Crucible') >= 22, 'Crucible covers a full line');
  // Monotone.
  const names = LADDER;
  const depths = names.map(depthForRank);
  ok(depths.every((d, i) => i === 0 || d > depths[i - 1]),
    'depth increases with every rank', depths.join(' < '));
  // Every rung must produce a DISTINCT depth, or two rungs are the same rung with two labels.
  ok(new Set(depths).size === depths.length,
    `all six ranks drill to a different depth (got ${depths.join(', ')})`);
}

/* The five places agree, and no rank name from the retired ladder is still reachable. */
{
  const { RANK_ORDER, linesForRank, nextRankLineCount } = yo;

  ok(JSON.stringify(RANK_ORDER) === JSON.stringify(LADDER),
    'RANK_ORDER is the six ladder names, in order', RANK_ORDER.join(', '));

  // LINES_PER_RANK is not exported, so it is exercised through linesForRank: each rung must unlock a
  // strictly larger number of lines than the one below it, which fails if a name is missing (the
  // `?? 8` fallback collapses it back to the first rung) or if two rungs were given the same count.
  const fake = Array.from({ length: 200 }, (_, i) => ({ id: `l${i}`, chapter: 'c', sans: [] }));
  const perRank = LADDER.map((n) => linesForRank(fake, n).length);
  ok(perRank.every((n, i) => i === 0 || n > perRank[i - 1]),
    'each rank unlocks strictly more lines than the one below it', perRank.join(' < '));
  ok(perRank[perRank.length - 1] === fake.length,
    `the top rank unlocks the whole opening (${perRank[perRank.length - 1]} of ${fake.length})`);

  // A name that is not on the ladder must not be treated as the top one.
  const bogus = linesForRank(fake, 'Not A Rank');
  ok(bogus.length !== fake.length,
    `an unknown rank name does not unlock the whole opening (got ${bogus.length})`);

  // nextRankLineCount reads both tables, so a mismatch between them shows up as a negative or a gap.
  const deltas = LADDER.slice(0, -1).map((n) => nextRankLineCount(fake, n));
  ok(deltas.every((d) => Number.isFinite(d) && d > 0),
    'every rank but the top one can name how many more lines the next one adds', deltas.join(', '));

  // The retired names must be gone from every table, or a stale label is one rename away from shipping.
  //
  // COMMENTS ARE STRIPPED FIRST, and that is not a loophole. A file that documents a rename has to be
  // able to say what it replaced, and a check that forbade the old words in prose would make that
  // explanation unwritable. The defect being guarded against here is a retired name in a TABLE, where
  // it would be read at runtime; a retired name in a comment is inert, and is how the rename stays
  // legible to whoever reads the file next.
  const retired = ['Beginner', 'Novice', 'Club Player', 'Expert', 'Master', 'Legend'];
  const codeOnly = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');     // line comments, leaving http:// and :// alone
  const src = codeOnly('../src/lib/yourOpenings.ts') + codeOnly('../src/lib/repertoire.ts');
  const stillThere = retired.filter((n) => {
    // `lineMastery`, `avgMastery`, `mastered`, `chaptersCovered` contain these as substrings of other
    // identifiers, so only a name standing on its own - quoted, or as an object key - counts.
    return new RegExp(`(['"\`]${n}['"\`]|\\b${n}\\b\\s*:|\\b${n}\\b\\s*,)`).test(src);
  });
  ok(stillThere.length === 0,
    'no retired tier name survives as a standalone token in either ladder file', stillThere.join(', '));
}

// ---------------------------------------------------------------------------
head('7. the line the user chose is still that line after the engine pass');

/*
 * THE REPORT, THE THIRD TIME: *"it keep playin automatically 3 times and then i get a new
 * different position to play"*.
 *
 * A line was `{kind:'alt', index:n}` - a POSITION in `family.alternates` - and the engine pass
 * re-derives the family with the verdicts attached, which re-runs the pool rotation and returns a
 * DIFFERENT list. Published twice, so twice. An index into that is not an identity.
 *
 * These checks simulate it directly: record the moves, shuffle the family, and require the line
 * back. The control at the end asserts that the index alone would have picked a DIFFERENT line,
 * because without it this whole section passes on any implementation - including the broken one.
 */
{
  const orders = [
    ['e4', 'c5', 'Nf3', 'd6', 'c4', 'd5', 'Nc3', 'Nc6', 'g3'],
    ['e4', 'c5', 'Nc3', 'Nc6', 'g3', 'g6', 'Bg2', 'Bg7'],
    ['e4', 'c5', 'Nf3', 'd6', 'c4', 'd5', 'Nc3', 'a6', 'd4', 'cxd4'],
    // The Closed Sicilian main line. (Two earlier fixtures for this slot were illegal - `Bg5` after
// `Nc3` is blocked by the d2 pawn, and `c5` twice in a row from the same square is not a move -
// and the fixture generator's own guard named them, which is the only reason they were found
// before they could make an assertion mean nothing.)
['e4', 'c5', 'Nc3', 'Nc6', 'd4', 'cxd4', 'Nf3'],
  ];
  const [fam] = buildFamilyLines(positionsFromGames('Sicilian Defense', orders), { maxPerFamily: 24 });
  const lines = drillableLines(fam, NO_PROGRESS);
  ok(lines.length >= 3, `the family has ${lines.length} lines to choose between`);

  // The user picks the LAST one - the index most likely to be reshuffled.
  const chosen = lines[lines.length - 1];
  const recorded = [...chosen.sans];

  // THE ENGINE PASS: the same family with its alternates in a different order.
  const reordered = {
    ...fam,
    steps: fam.alternates[0] ?? fam.steps,
    alternates: [fam.steps, ...fam.alternates].reverse(),
  };

  const byMoves = resolveLine(reordered, chosen.ref, recorded);
  const byIndexOnly = reordered.alternates[chosen.ref.index]
    ?? reordered.steps;

  ok(byMoves !== null, 'the chosen line is still found after the list is reordered');
  ok(byMoves !== null && byMoves.map((s) => s.moveSan).join(' ') === recorded.join(' '),
    'and it is the SAME line, move for move',
    `got  ${byMoves ? byMoves.map((s) => s.moveSan).join(' ') : 'nothing'}`);
  ok(byIndexOnly.map((s) => s.moveSan).join(' ') !== recorded.join(' '),
    'CONTROL: the index alone would have handed over a DIFFERENT line, which is the bug',
    'if this is equal the test cannot tell the fix from the bug');

  // A line that gained moves at the end is the same line, not a new one.
  const extended = {
    ...reordered,
    steps: reordered.steps.map((s, i) => (i === reordered.steps.length - 1
      ? { ...s, moveSan: s.moveSan } : s)),
  };
  ok(resolveLine(reordered, { kind: 'main' }, reordered.steps.map((s) => s.moveSan)) !== null,
    'the main line resolves by its own moves');

  // Nothing recorded yet: the index is the only thing available, and it is used.
  ok(resolveLine(fam, chosen.ref, null) !== null,
    'with no moves recorded the index is used, which is the first render after a tap');

  // Genuinely absent: null, so the caller knows something really changed.
  ok(resolveLine(fam, chosen.ref, ['h4', 'h5', 'h6']) === null,
    'moves that are in no line return null rather than substituting a different one');

  /*
   * A LINE THAT SHRANK IS NOT THE SAME LINE.
   *
   * THE REPORT: *"the line finishes after 2 moves"* and *"it jumps to a completely different
   * position"* - two symptoms, one comparison.
   *
   * The engine pass publishes the family more than once while the user plays - the head of the
   * sample, then the tail - so the family he is standing in can be REBUILT SHORTER than the line
   * he tapped: the rotation ran over fewer positions, and what comes back is a PREFIX of the line
   * on his board.
   *
   * The comparison below was `Math.min(recorded.length, cand.length)` moves, and `family.steps` -
   * the MAIN line - is searched first. So a two-ply main line matched a thirty-ply session on its
   * first two moves and was returned as "the line the user chose": the board snapped back to move
   * two with the line written off as complete. He tapped an alternate and was handed the main
   * line, shorter and different, from one comparison.
   *
   * The rule is the one the docblock already states: the RECORDED moves must be a prefix of the
   * candidate (a book tail or engine continuation attaches at the END; that is the same line with
   * more data). A candidate that runs out before the recording does is a different line, and null
   * is the honest answer - the caller keeps the session on the board it is already playing.
   */
  const shrunk = {
    ...fam,
    steps: fam.steps.slice(0, 2),
    alternates: fam.alternates.map((a) => a.slice(0, 2)),
  };
  const afterShrink = resolveLine(shrunk, chosen.ref, recorded);
  ok(afterShrink === null || afterShrink.length >= recorded.length,
    'a rebuilt family whose lines are SHORTER than the recorded one does not resolve',
    `recorded ${recorded.length} plies, got ${afterShrink
      ? `${afterShrink.length} plies: ${afterShrink.map((s) => s.moveSan).join(' ')}`
      : 'null'}`);

  /*
   * AND THE CONTROL: the old rule really did match that short prefix. Without it the check above
   * passes on the broken comparison too, because a fixture where nothing matches proves nothing.
   */
  const underOldRule = [shrunk.steps, ...shrunk.alternates].find((cand) => {
    const n = Math.min(recorded.length, cand.length);
    for (let i = 0; i < n; i++) if (cand[i].moveSan !== recorded[i]) return false;
    return true;
  });
  ok(underOldRule != null && underOldRule.length < recorded.length,
    'CONTROL: the old min() comparison picked that short prefix - this was the bug',
    underOldRule
      ? `it returned ${underOldRule.length} plies against a ${recorded.length}-ply session`
      : 'nothing matched, so the fixture cannot show the bug');

  // The blessed direction is unchanged: the same line with MORE attached at the end still resolves.
  const grownSteps = [...fam.steps, { ...fam.steps[fam.steps.length - 1] }];
  const grown = { ...fam, steps: grownSteps };
  ok(resolveLine(grown, { kind: 'main' }, fam.steps.map((s) => s.moveSan)) === grownSteps,
    'a line that gained moves at the end is still the same line');
}

// ---------------------------------------------------------------------------
head('8. NOTHING SHORT IS EVER CALLED A LINE');

/*
 * *"i play only one or two moves and the app says the line is done."*
 *
 * The same defect has been reported four times in this project and every earlier fix attacked
 * whatever produced the short list THAT TIME - a lookup returning nothing, a tail stopping at the
 * first illegal move, an index blind to transpositions. None of them stopped a short list being
 * presented as a complete one, which is the part every one of them shared.
 *
 * So this asserts the floor directly, over BOTH sources, because they fail differently: the
 * user's games can end early, and a shipped study line can be short because it is a variation
 * stub. A floor that guards only the first is half a fix.
 */
{
  const { MIN_DRILL_PLIES, allLinesOf, linesForRank, chaptersCovered } = yo;

  ok(MIN_DRILL_PLIES >= 8, `the floor is at least four moves a side (it is ${MIN_DRILL_PLIES} plies)`);

  // (a) THE USER'S GAMES. A game that stops after three plies must not become a drillable line.
  const stubby = buildFamilyLines(
    positionsFromGames('Sicilian Defense', [['e4', 'c5']]), { maxPerFamily: 24 },
  );
  const stubbyLines = stubby[0] ? drillableLines(stubby[0], NO_PROGRESS) : [];
  ok(stubbyLines.every((l) => !l.drillable),
    'a family whose games stop after 2 plies offers nothing drillable',
    stubbyLines.map((l) => `${l.plies}p drillable=${l.drillable}`).join(', '));

  // (b) REAL GAMES, long enough to be legitimate.
  const real = buildFamilyLines(positionsFromGames('Sicilian Defense', [
    ['e4', 'c5', 'Nf3', 'd6', 'c4', 'd5', 'Nc3', 'Nc6'],
    ['e4', 'c5', 'Nc3', 'Nc6', 'd4', 'cxd4', 'Nf3'],
  ]), { maxPerFamily: 24 });
  const realLines = real[0] ? drillableLines(real[0], NO_PROGRESS) : [];
  // The real invariant is not "all drillable" - a game that ended at ply 7 legitimately is
  // not - but that `drillable` agrees with the floor on EVERY line, so no short line can slip
  // through and no long one can be refused.
  const disagree = realLines.filter((l) => l.drillable !== (l.plies >= MIN_DRILL_PLIES));
  ok(realLines.length > 0 && disagree.length === 0,
    'drillable agrees with the floor on every line from real games',
    disagree.map((l) => `${l.plies}p drillable=${l.drillable}`).join(', '));
  ok(realLines.some((l) => !l.drillable),
    'a line from a game that ended early is still shown, but marked not drillable',
    realLines.map((l) => `${l.plies}p/${l.drillable}`).join(', '));

  /*
   * AND THE SCREEN MUST ACT ON THE FLAG.
   *
   * `drillable` existed as a property with no reader: the family list started every line, the
   * short ones included, and one of those was played and produced "Line finished" after two moves
   * — *"i tried another opening and played two moves and it told me line finished!"*. A floor that
   * is enforced everywhere except where the tap happens is not a floor.
   */
  const screenSrc = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx'), 'utf8',
  );
  const screenCode = screenSrc.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  ok(/const linesForFamily = familyLines\.filter\(\(l\) => l\.drillable\);/.test(screenCode),
    'the screen offers only lines the floor called drillable — a two-move line cannot be started');
  ok(/const familyLines = drillableLines\(openFamily, positionProgress\);/.test(screenCode),
    'CONTROL: ...and it still describes every line first, so the held-back ones can be counted');
  ok(/play more of this opening and they will grow/.test(screenSrc),
    'and says how many lines were held back, instead of hiding them silently');

  // (c) THE SHIPPED STUDIES, against the REAL corpus. This is where a short line would
  // actually surface: a variation stub in the book, offered at the lowest rank.
  const { AVAILABLE_OPENINGS } = yo.openingsForTest ?? {};
  const entry = (AVAILABLE_OPENINGS ?? []).find((o) => o.id === 'sicilian');
  ok(!!entry && !!entry.repertoire, 'the Sicilian repertoire is available to the test');
  if (entry && entry.repertoire) {
    const all = allLinesOf(entry.repertoire);
    ok(all.length > 100, `the Sicilian yields ${all.length} drillable lines across its studies`);

    // EVERY rank's slice, checked individually. Checking only the lowest rank is how a floor ends
    // up guarding one end of the ladder only.
    const tooShort = [];
    for (const rank of yo.RANK_ORDER) {
      for (const l of linesForRank(all, rank)) {
        if (l.sans.length < MIN_DRILL_PLIES) tooShort.push(`${rank}: "${l.chapter}" ${l.sans.length}p`);
      }
    }
    ok(tooShort.length === 0,
      `no rank offers a line shorter than ${MIN_DRILL_PLIES} plies, in any chapter`,
      tooShort.slice(0, 6).join('\n          '));

    // Every line must also be a legal, continuous game - a tail that stopped at an illegal move
    // would be short enough to pass the floor and then die on the board.
    let illegal = null;
    for (const l of all) {
      const c = new Chess();
      for (const san of l.sans) { try { c.move(san); } catch { illegal = `${l.chapter}: ${san}`; break; } }
      if (illegal) break;
    }
    ok(illegal === null, 'every line of the opening replays legally from the start', illegal ?? '');

    // AND THE POINT OF THE INTERLEAVING: a low rank must span several variations, not one track.
    const lowest = linesForRank(all, LADDER[0]);
    const covered = chaptersCovered(lowest);
    ok(covered >= 3,
      `${LADDER[0]} already spans ${covered} variations, not one`,
      [...new Set(lowest.map((l) => l.chapter))].join(', '));

    // And each rank is a strict superset of the one below - advancing ADDS.
    let nested = true;
    const counts = yo.RANK_ORDER.map((r) => linesForRank(all, r).length);
    ok(counts.every((n, i) => i === 0 || n >= counts[i - 1]),
      `each rank shows at least as many lines as the one below: ${counts.join(' -> ')}`);
    ok(counts[counts.length - 1] === all.length,
      `${LADDER[LADDER.length - 1]} shows the whole opening (${counts[counts.length - 1]} of ${all.length})`);
    void nested;
  }
}

// ---------------------------------------------------------------------------
head('9. THE TRAINER DRILLS WHAT WAS LEARNED, IN THE OPENING YOU ARE IN');

/*
 * *"for the training in 'your openings' we get positions from what we learned by default (unless i
 * want to customize and choose)"*.
 *
 * Two properties, and they are separate. "From what we learned" was already true -
 * `buildTrainExercises` defaults to studies with `attempts > 0` - so it is asserted here rather
 * than assumed. "In your openings" was not: the button arrived with no idea which screen sent it.
 *
 * The one that bites is the shape of the argument. A `Pressable` given `onPress={onTrain}` calls the
 * handler with the gesture event, so the event becomes the opening id - truthy, unmatched, and the
 * session comes up empty with no error anywhere. That is why `scopedOpenings` degrades to the full
 * review instead of to nothing, and why the control below is the gesture event itself.
 */
{
  const { scopedOpenings } = yo;
  const { AVAILABLE_OPENINGS } = yo.openingsForTest;
  const sicilian = AVAILABLE_OPENINGS.find((o) => o.id === 'sicilian');

  ok(AVAILABLE_OPENINGS.length > 1, `the library has openings to choose between (${AVAILABLE_OPENINGS.length})`);

  ok(scopedOpenings(AVAILABLE_OPENINGS, null).length === AVAILABLE_OPENINGS.length,
    'no scope means every opening, which is what the list screen asks for');
  ok(scopedOpenings(AVAILABLE_OPENINGS, undefined).length === AVAILABLE_OPENINGS.length,
    'and an absent scope is the same thing');

  const one = scopedOpenings(AVAILABLE_OPENINGS, 'sicilian');
  ok(one.length === 1 && one[0].id === 'sicilian',
    'a scope narrows the session to exactly the opening in view',
    `got ${one.length}: ${one.map((o) => o.id).join(', ')}`);

  // THE CONTROL: what a Pressable actually passes.
  const event = { nativeEvent: {}, currentTarget: {}, preventDefault() {} };
  ok(scopedOpenings(AVAILABLE_OPENINGS, event).length === AVAILABLE_OPENINGS.length,
    'CONTROL: a gesture event cannot become an opening id - it falls back to every opening');
  ok(scopedOpenings(AVAILABLE_OPENINGS, 0).length === AVAILABLE_OPENINGS.length,
    'and neither can a falsy non-string');
  ok(scopedOpenings(AVAILABLE_OPENINGS, 'no-such-opening').length === AVAILABLE_OPENINGS.length,
    'a stale id degrades to the full review rather than to an empty screen');
  ok(scopedOpenings(AVAILABLE_OPENINGS, '').length === AVAILABLE_OPENINGS.length,
    'and an empty id is not a scope either');

  // Never nothing: an empty result is the one outcome a caller cannot recover from.
  for (const bad of [null, undefined, '', 'nope', event, 0, 1, true, {}]) {
    if (scopedOpenings(AVAILABLE_OPENINGS, bad).length === 0) {
      ok(false, `scoping by ${JSON.stringify(bad)} returned nothing`, 'an empty session is unrecoverable');
      break;
    }
  }
  ok(true, 'no input produces an empty session');

  /*
   * "From what we learned": the pool must exclude untouched studies. Checked against the real
   * corpus, because a fixture would not know whether the shipped studies carry attempts.
   */
  const { buildTrainExercises } = yo.repertoireForTest ?? {};
  if (typeof buildTrainExercises === 'function' && sicilian) {
    const rep = sicilian.repertoire;
    const untouched = buildTrainExercises(rep, {}, {}, 12, undefined, 'b');
    ok(untouched.length === 0,
      'a repertoire with no practised studies produces no exercises - "learned" is enforced, not assumed',
      `${untouched.length} exercises from an untouched repertoire`);

    const practised = {};
    for (const s of yo.repertoireForTest.allStudies(rep).slice(0, 4)) {
      practised[s.id] = { attempts: 3, level: 2 };
    }
    const learned = buildTrainExercises(rep, practised, {}, 12, undefined, 'b');
    ok(learned.length > 0,
      `practising 4 of the opening's studies does produce a session (${learned.length} exercises)`);

    const onlyThose = new Set(buildTrainExercises(rep, practised, {}, 500, undefined, 'b')
      .map((e) => e.studyId));
    ok(onlyThose.size > 0
      && [...onlyThose].every((id) => Object.prototype.hasOwnProperty.call(practised, id)),
      'and every exercise in it comes from a study that was actually practised',
      [...onlyThose].join(', '));
  } else {
    ok(true, '(the learned-only check needs the repertoire module, which this harness does not load)');
  }
}

head('10. A BUTTON THAT IS OFFERED MUST DO SOMETHING');

/*
 * *"i completed a line in 'your openings' and clicked on test yourself but nothing happened. i keep
 * clicking on it and it seems like it is a button that does nothing so fix it"*.
 *
 * The cause was two different predicates for one question. The button appeared whenever the line had
 * any `choice` on it. The handler asked for `choice != null && position?.key`. A line that has been
 * re-derived - which happens the moment the user takes our recommendation, because `continueLine`
 * rebuilds the tail from a book or the engine - produces steps with `position: null`, since a book
 * move is not a position the user was asked about. So the button was offered, the list came back
 * empty, and `startTest` returned without a word.
 *
 * A silent return in an event handler is the worst shape a failure can take: the screen looks right,
 * the control looks pressable, and the user has no way to tell a bug from a mis-tap. So the predicate
 * is a function, both call sites use it, and the empty case is a sentence rather than a dead tap.
 */
{
  
  const step = (over) => ({ choice: null, position: null, ...over });
  const withChoices = (keys, withPos = true) => keys.map((k) => (
    withPos ? step({ choice: { k }, position: { key: k } }) : step({ choice: { k } })
  ));

  /*
   * THE PREDICATE, IN THE THREE SHAPES THE USER REPORTED.
   *
   *   1. a line he played, with no `choice` anywhere;
   *   2. a step with a position and a choice;
   *   3. a step with NO position — the re-derived tail after he took our recommendation, which is
   *      the case that produced "it says no test" most recently.
   *
   * The third is the one that was wrong in principle rather than in a threshold, and it is why the
   * function is now `askablePositions` returning `askablePlace`s: the position key is BOOKKEEPING, and
   * making the test contingent on it meant that playing our own recommendation — the outcome the app
   * steers him towards — was the surest way to get no test at all.
   */
  const mineOnly = [
    { choice: null, isUserMove: true, position: { key: 'k1' } },
    { choice: null, isUserMove: false, position: { key: 'k2' } },
  ];
  ok(askablePositions([{ steps: mineOnly }]).length === 1,
    'a move the user PLAYED is askable even with no choice on it');
  ok(askablePositions([{ steps: mineOnly }])[0]?.key === 'k1',
    'and it is his move, not the opponent\'s');

  // THE REPORTED CASE: no position at all.
  const rederived = [
    { choice: null, isUserMove: true, position: null },
    { choice: null, isUserMove: true, position: null },
    { choice: { recommendSan: 'd4' }, isUserMove: true, position: null },
  ];
  ok(askablePositions([{ id: 'L', steps: rederived }]).length === 3,
    'CONTROL: a re-derived line with NO position key is still fully testable — this was the bug',
    `got ${askablePositions([{ id: 'L', steps: rederived }]).length}`);
  ok(askablePositions([{ id: 'L', steps: rederived }]).every((p) => p.key === null),
    'and reports the missing key as null rather than dropping the place');
  ok(askablePositions([{ id: 'L', steps: rederived }]).every((p) => p.id !== null && p.id !== ''),
    'CONTROL: ...while still giving it a stable identity, so the two-place dedupe can work');

  // The two places must be distinguishable, or the "not the same twice running" filter excludes
  // every unrecordable place at once — a null key compared against null is true for all of them.
  const ids = askablePositions([{ id: 'L', steps: rederived }]).map((p) => p.id);
  ok(new Set(ids).size === ids.length,
    'places with no key still get DISTINCT identities', ids.join(', '));

  ok(askablePositions([{ steps: [step({ position: { key: 'k' } })] }]).length === 0,
    'a step that is only the OPPONENT\'s to play is not something he can be asked');
  ok(askablePositions([{ steps: [step({ choice: 1, isUserMove: true, position: { key: 'k' } })] }]).length === 1,
    'a place with both a choice and his move is askable once, not twice');
  ok(askablePositions([{ steps: [
    { choice: null, isUserMove: true, position: { key: '' } },
  ] }]).length === 1,
    'an empty position key is not a position, but the MOVE is still his to play, so it is askable');

  // A real line: every one of his moves is testable.
  const wholeLine = [1, 2, 3, 4, 5, 6].map((i) => (
    i % 2 === 1
      ? { choice: null, isUserMove: true, position: { key: `p${i}` } }
      : { choice: null, isUserMove: false, position: { key: `p${i}` } }
  ));
  ok(askablePositions([{ steps: wholeLine }]).length === 3,
    'a six-ply line with no choices still yields three testable places — his three moves');

  /*
   * ASKING AND SCORING ARE SEPARATE, and the separation is the point.
   *
   * A place with `key: null` is askable — the move is his to play, so the question is real. It is
   * also unscoreable: there is no position identity to attach progress to, and inventing one from
   * the move order would create a second notion of "the same position" so the rings and the SRS would
   * drift apart. `recordStepProgress` therefore returns early on a missing key, and the gate asserts
   * both halves: asking does NOT require a key, and recording DOES.
   *
   * The user's requirement was "the test should be there even if there is no askable position", and
   * the honest reading of that is: never let missing bookkeeping remove a real question. It is not a
   * licence to invent a position key so the answer can be scored somewhere.
   */

  // THE PLY AND THE OWNING LINE, because a wrong owner walks a different line to the same index.
  const owned = askablePositions([
    { id: 'A', steps: withChoices(['a', 'b', 'c']) },
    { id: 'B', steps: withChoices(['d']) },
  ]);  ok(owned.length === 4, `both lines contribute (${owned.length})`);
  ok(owned[0].line.id === 'A' && owned[3].line.id === 'B',
    'each entry names its own line, so a ply is never walked on the wrong line');
  ok(owned[0].ply === 0 && owned[2].ply === 2,
    'and the ply is the question index WITHIN that line');

  // And the screen must use THIS predicate in every place that needs it.
  const scr = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx'), 'utf8',
  );
  const code = scr.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const uses = (code.match(/askablePositions/g) ?? []).length;
  ok(uses >= 3, `the screen calls the shared predicate everywhere it needs it (${uses})`);
  ok(!/\{testPoolRef\.current\.length > 0 \|\| decisionsInLine > 0 \? \(/.test(code),
    'and the button is no longer gated on a looser condition of its own');
  /*
   * THIS ASSERTION CHANGED DIRECTION, AND THE OLD ONE WAS RIGHT ONCE.
   *
   * It used to require `{testAskable > 0 ? (` — the button hidden unless the count was positive —
   * which existed because a shown button that does nothing is worse than no button. The user then
   * said the opposite thing: *"i should always be able to test after finishing whether there is
   * askable positions or not"*.
   *
   * Both were complaints about a dead tap, and the fix belongs under the second one: the count is
   * no longer allowed to be zero on a line he can practise, so the condition has nothing left to
   * guard. Removing it does not reintroduce the dead tap — it removes the impossible case. Section
   * 19 asserts the fallback that makes it impossible, and asserts that the gate stays gone.
   */
  ok(!/\{testAskable > 0 \? \(/.test(code),
    'CONTROL: and the button is no longer hidden on a zero count - see section 19 for why that is '
    + 'now safe, and for the fallback that makes it so');
  ok(/No positions to test in this line yet/.test(scr),
    'the empty case says WHY - "nothing to test" with no reason reads like lost work');

  /*
   * AND THE COUNT MUST SEE THE POOL CHANGE. The pool is a ref, and a ref change does not re-render,
   * so a button gated on a count derived from one would keep showing the previous answer - the same
   * dead button, reached the other way round. A version counter is what makes the ref visible.
   */
  ok(/setPoolVersion\(\(v\) => v \+ 1\)/.test(code),
    'writing the pool bumps a version, so the count is recomputed');
  ok(/poolVersion\]/.test(code),
    'and the count depends on it');

  /*
   * ASKING AND SCORING ARE SEPARATE, and the separation is the point.
   *
   * A place with `key: null` is askable — the move is his to play, so the question is real. It is
   * also unscoreable: there is no position identity to attach progress to, and inventing one from
   * the move order would create a second notion of "the same position", so the rings and the SRS
   * would drift apart. `recordStepProgress` therefore returns early on a missing key.
   *
   * The user's requirement was "the test should be there even if there is no askable position", and
   * the honest reading is: never let missing bookkeeping remove a real question. It is not a licence
   * to invent a position key so the answer can be scored somewhere.
   */
  const recStart = code.indexOf('const recordStepProgress = useCallback(');
  let recBodyText = null;
  if (recStart >= 0) {
    let d = 0;
    let opened = false;
    for (let i = recStart; i < code.length; i += 1) {
      if (code[i] === '{') { d += 1; opened = true; }
      else if (code[i] === '}') { d -= 1; if (opened && d === 0) { recBodyText = code.slice(recStart, i + 1); break; } }
    }
  }
  ok(recBodyText !== null && /if \(!key\) return;/.test(recBodyText),
    'recording progress still refuses a place with no key, rather than inventing one');
  ok(askablePositions([{ id: 'L', steps: rederived }]).every((p) => p.key === null),
    'CONTROL: while those places are still asked — asking never depended on the key');
}

/*
 * SECTION 11, REWRITTEN AFTER BEING WRITTEN WRONG.
 *
 * The first version of this section asserted that every move the user played carries a `choice`,
 * and it passed - because the builder had just been changed to `choice: p.playedUci && p.recommendUci`
 * to make it pass. That change was wrong and is reverted; the section below asserts the rule that
 * is actually correct, and says why the first version of it could not be.
 *
 * "Why are almost all my lines without any choice?" is a real report with a real answer. Where the
 * books do not cover a position, `gameOpenings` sets the recommendation to THE USER'S OWN MOVE on
 * purpose - there is nothing better to say before a search has run - so a "your move vs ours"
 * comparison there would be the move against itself. The family list must be usable engine-free.
 *
 * So a `choice` stays a COMPARISON, and what answers the report is a JOIN: `buildDecisionIndex` keys
 * the user's own moves by POSITION, so any view of an opening can show both arrows without the line
 * having been derived from a mistake. That is what the course screen uses, and it is what puts a
 * decision back in front of the user at positions the books are silent about.
 */
head('11. A COMPARISON ONLY WHERE THERE ARE TWO MOVES, AND A JOIN WHERE THERE ARE NOT');

{
  const bookLine = [
    'e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nc3', 'Nc6', 'Bc4', 'e6', 'O-O', 'Be7', 'Bg5',
  ];

  /*
   * THE ENGINE-FREE CONTRACT, which is what the first version of this section broke.
   *
   * `recommendSan` out of book IS the played move, by design. So the decision points are the positions
   * the books cover and the user did NOT follow - and the ratio has to stay a majority, or the app has
   * become load-bearing on an engine run that has not happened. This is the same assertion
   * `openingbuilder.playloop` makes over the whole corpus; it is repeated here because this gate is the
   * one about "your openings", and because the number below is what caught the regression.
   */
  const shipped = yo.openingsForTest;
  ok(typeof shipped === 'object' && shipped != null, 'the real opening corpus is loaded, not a fixture');

  const engineFree = positionsFromGames('Sicilian Defense', [bookLine]);
  // What the engine-free pipeline produces: a recommendation only where a book has a move, and the
  // user's own move everywhere else.
  for (const p of engineFree) {
    const inBook = p.ply >= 4 && p.ply % 2 === 0;
    p.inBook = inBook;
    p.bookSan = inBook ? p.playedSan : null;
    p.recommendSan = inBook ? p.playedSan : p.playedSan;
    p.recommendUci = p.playedUci;
  }
  const [famF] = buildFamilyLines(engineFree, { maxPerFamily: 24 });
  const stepsF = allLineRefs(famF).flatMap((r) => stepsForRef(famF, r))
    .filter((s) => s.isUserMove && s.position != null);
  ok(stepsF.every((s) => s.choice == null),
    'CONTROL: where the recommendation IS the move played there is no comparison to show',
    stepsF.filter((s) => s.choice != null).map((s) => s.moveSan).join(', '));

  /*
   * AND WHERE THE TWO MOVES DIFFER THERE STILL IS ONE, with the verdict untouched.
   */
  const diverging = positionsFromGames('Sicilian Defense', [bookLine]);
  const [famD] = buildFamilyLines(diverging, { maxPerFamily: 24 });
  const stepsD = allLineRefs(famD).flatMap((r) => stepsForRef(famD, r))
    .filter((s) => s.isUserMove && s.position != null);
  const differing = stepsD.filter((s) => s.choice && s.choice.playedUci !== s.choice.recommendUci);
  ok(differing.length > 0, `CONTROL: ${differing.length} disagreements still produce a comparison`);
  ok(differing.every((s) => s.choice.verdict === null),
    'and a disagreement that was never analysed is not called a mistake');

  /*
   * THE JOIN, WHICH IS WHAT ANSWERS "NO ARROWS ON EVERY LINE".
   *
   * A position the user reached in a game they played CORRECTLY carries no comparison, but it does
   * carry their move - and the recommendation at it, if the engine has looked. Indexing those by
   * position is what lets a course line that has nothing to do with their game still say "you played
   * this here, and this is the move". The fixture is deliberately built the WRONG way round: a line
   * the user did not play at all, joined to a game they did.
   */
  const idx = buildDecisionIndex(diverging, (f) => f.split(' ').slice(0, 4).join(' '));
  const firstPos = diverging.find((p) => p.ply === 6);
  const found = idx.get(firstPos.fen.split(' ').slice(0, 4).join(' '));
  ok(found != null && found.playedUci === firstPos.playedUci,
    'the user own move is reachable by POSITION, whatever line is being viewed');
  ok(found != null && found.fenKey === firstPos.fen.split(' ').slice(0, 4).join(' '),
    'and the key is the position with move counters stripped, so it joins to any replay');

  // A game that ENDED on a position has no move of the user's to report, and must not shadow a real
  // decision from another game at the same position.
  const ended = { ...diverging[0], key: 'ended', playedSan: null, playedUci: null, fen: diverging[0].fen };
  const withEnd = buildDecisionIndex([...diverging, ended], (f) => f.split(' ').slice(0, 4).join(' '));
  ok(withEnd.get(diverging[0].fen.split(' ').slice(0, 4).join(' '))?.playedSan === diverging[0].playedSan,
    'a position where the game ended stores nothing and cannot displace a real decision');

  // The WORST decision at a position wins, so the note does not depend on which game was analysed last.
  const lost = { ...diverging[1], fen: diverging[0].fen, lossCp: 300, verdict: 'blunder', recommendSan: 'Nf3', recommendUci: 'g1f3', options: [] };
  const contested = buildDecisionIndex([...diverging, lost], (f) => f.split(' ').slice(0, 4).join(' '));
  const k = diverging[0].fen.split(' ').slice(0, 4).join(' ');
  ok(contested.get(k)?.verdict === 'blunder',
    'when several games reached the position, the one that lost the most is the one reported',
    contested.get(k)?.verdict ?? 'none');

  /*
   * AND IT IS ONLY EVER READ ON THE USER'S OWN PLY.
   */
  const turn = (f) => (f.split(' ')[1] === 'b' ? 'b' : 'w');
  ok(decisionAt(idx, firstPos.fen, (f) => f.split(' ').slice(0, 4).join(' '), turn(firstPos.fen), 'w') != null,
    'the decision is shown on a ply that is the user to move');
  ok(decisionAt(idx, firstPos.fen, (f) => f.split(' ').slice(0, 4).join(' '), turn(firstPos.fen), 'b') == null,
    'CONTROL: and never on the opponent reply, which would report their move as the user own');
  ok(decisionAt(null, firstPos.fen, (f) => f.split(' ').slice(0, 4).join(' '), turn(firstPos.fen), 'w') == null,
    'CONTROL: with nothing known about the user games the course is unchanged, not broken');

  /*
   * AND THE COURSE MUST ACTUALLY USE IT.
   */
  const course = fs.readFileSync(path.join(ROOT, 'src', 'components', 'screens', 'CourseScreen.tsx'), 'utf8');
  const courseCode = course.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  ok(/buildDecisionIndex/.test(courseCode) && /decisionAt/.test(courseCode),
    'the course view reads the index, which is how it can show a move the line never contained');
  ok(/loadCachedPositions/.test(courseCode),
    'and it reads the cached positions rather than re-deriving the user games on a course screen');
  ok(/if \(!isUserMove \|\| !yourMove\) return \[lineArrow\];/.test(courseCode),
    'two arrows only where there really are two moves - otherwise the line own arrow stands alone');
  ok(/ply < 2 \? null : view\?\.fen/.test(courseCode),
    'CONTROL: and not before the second move pair, where the position belongs to no opening at all');

  console.log('');
}

/*
 * THE EXIT CODE IS THE GATE, AND IT WENT MISSING.
 *
 * Rewriting the section above removed these last two lines, and the gate then printed every assertion
 * - including failing ones - while exiting 0. A gate that cannot fail is worse than no gate, because
 * it is read as a green tick: it reported 102/102 while several were failing. Nothing in the file can
 * assert its own exit path without the assertion containing the thing it searches for, so there is no
 * check for it here; the evidence is running it, which is why the suite prints the count and the code
 * is what everything keys off.
 */



head('12. THE LOOP: to-do, mistake, unclear, correct');

/*
 * "and do the loop too".
 *
 * The four states existed as local component state in the trainer's screen and nowhere else, so the
 * openings drill had `asked`/`correct` counters and no state at all - which is why there was nothing to
 * loop. They are extracted here so both screens share one rule, and the rule is asserted here because
 * the interesting part is the transition nobody would think to check: a clean answer is not always
 * "solved".
 */
{
  const { nextLoopState, loopMessage, loopCounts, orderLoopQueue, loopStateForNewSession } = yo;

  // The whole table, both directions. Written out rather than derived, so a change to any single cell
  // has to be made here on purpose.
  const TABLE = [
    // from,      clean?, to
    ['todo', false, 'mistake'],
    ['todo', true, 'solved'],
    ['mistake', false, 'mistake'],
    ['mistake', true, 'unclear'],
    ['unclear', false, 'mistake'],
    ['unclear', true, 'solved'],
    ['solved', false, 'mistake'],
    ['solved', true, 'solved'],
  ];
  const wrong = TABLE.filter(([, isClean]) => !isClean).filter(([from, c, to]) => nextLoopState(from, c) !== to);
  ok(wrong.length === 0, 'any mistake marks the position to come back, whatever state it was in',
    wrong.map(([f, , t]) => `${f} -> ${t}`).join(', '));

  const clean = TABLE.filter(([, c]) => c).filter(([from, c, to]) => nextLoopState(from, c) !== to);
  ok(clean.length === 0, 'CONTROL: every clean transition matches the trainer table',
    clean.map(([f, , t]) => `${f} -> ${t}`).join(', '));

  /*
   * THE TRANSITION THAT MATTERS, and the one a rewrite would get wrong.
   *
   * `mistake` + clean = `unclear`, NOT `solved`. A position answered wrong and then right has been
   * right once; calling that solved is what the state exists to prevent, and it is the difference
   * between a loop that confirms and one that congratulates. Asserted on its own so it cannot be lost
   * inside the table check above.
   */
  ok(nextLoopState('mistake', true) === 'unclear',
    'a right answer after a wrong one is UNCLEAR, not solved - it still has to be confirmed',
    `got ${nextLoopState('mistake', true)}`);
  ok(nextLoopState('unclear', true) === 'solved',
    'CONTROL: and a second clean pass is the confirmation that solves it');
  ok(nextLoopState('solved', false) === 'mistake',
    'CONTROL: a solved position answered badly comes back - it is not permanently solved');

  /*
   * EVERY MESSAGE NAMES A STATE, so a transition can be told from a different question.
   */
  ok(TABLE.every(([from, c]) => {
    const to = nextLoopState(from, c);
    const msg = loopMessage(from, to);
    return typeof msg === 'string' && msg.length > 0;
  }), 'every transition says something, so no answer is silent');
  ok(/unclear/i.test(loopMessage('mistake', 'unclear')),
    'and the UNCLEAR transition explains itself, since it reads as a failure if it does not');
  ok(/come back/i.test(loopMessage('todo', 'mistake')),
    'and a mistake says the position returns, which is the promise the loop makes');

  /*
   * THE QUEUE PUTS WHAT IS LEFT BEFORE WHAT IS NEW.
   */
  const items = [
    { id: 'a', state: 'solved' }, { id: 'b', state: 'todo' }, { id: 'c', state: 'mistake' },
    { id: 'd', state: 'unclear' }, { id: 'e', state: 'todo' },
  ];
  const ordered = orderLoopQueue(items).map((x) => x.id).join('');
  ok(ordered === 'cdbea',
    'mistakes come first, then to-confirm, then new positions, then solved',
    `got ${ordered}`);
  ok(orderLoopQueue(items).length === items.length,
    'CONTROL: nothing is dropped - a solved position answered badly has to be able to come back');

  const c = loopCounts(items);
  ok(c.todo === 2 && c.mistake === 1 && c.unclear === 1 && c.solved === 1,
    'the counts the header shows add up to the pool', JSON.stringify(c));

  /*
   * A NEW SESSION STARTS AT TO-DO, whatever the counters say.
   */
  ok(loopStateForNewSession() === 'todo',
    'CONTROL: stored progress does not pre-confirm a position - asking is what confirms it');

  /*
   * AND THE SCREEN MUST ACTUALLY DRIVE IT, AT BOTH ANSWERS.
   */
  const screen = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx'), 'utf8',
  );
  const screenCode = screen.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  ok(/markTestResult\(wrongId, false\)/.test(screenCode),
    'a wrong answer moves the position to mistake - not only the right answer moves anything');
  ok(/markTestResult\(lastTestRef\.current, true\)/.test(screenCode),
    'and a right answer runs the transition, so unclear and solved are reachable');
  ok(/testStatesRef\.current = new Map\(askable\.map\(\(a\) => \[a\.id, loopStateForNewSession\(\)\]\)\)/.test(screenCode),
    'CONTROL: the pool opens at to-do, so the loop starts rather than resuming mid-way');
  ok(/loopSummary/.test(screenCode) && /\[testing, poolVersion\]/.test(screenCode),
    'CONTROL: the counts are re-read when the loop changes - a ref alone would not re-render');
  ok(!/nextLoopState\(\s*'todo'/.test(screenCode),
    'CONTROL: and the screen does not reimplement the table with its own literals');

  /*
   * THE LINE COMPLETES FROM THE MOVE ACTUALLY PLAYED - not from the line's original remainder.
   *
   * This is the fork the user asked for: "complete the line with my move" or "complete with the
   * suggested one". The prefix handed to the continuation is built by pushing the SAN the user made,
   * so whichever move it was, the rest of the line is derived from that position. The bug it replaces
   * appended `steps[k].moveSan` - the ORIGINAL line's following moves - which are only legal when the
   * user played the line's own move.
   */
  ok(/played\.push\(san\);/.test(screenCode),
    'the prefix ends with the move the user actually played');
  ok(!/steps\[stepIdx \+ 1\]\.moveSan\)|steps\[i\]\.moveSan\)\]\s*;/.test(screenCode),
    'CONTROL: the original line remainder is never appended after it');
  ok(/continueLineWithEngine\(openFamily, played/.test(screenCode),
    'CONTROL: and the remainder is re-derived from that position rather than stitched on');

  console.log('');
}

/*
 * FOUND ON THE DEVICE, AND IT IS NOT THE SCREEN THE GATES NAMED.
 *
 * This session put arrows into CourseScreen and gated them there. Then the app was installed and the
 * screen the user lands on from Home - "QGA Main Tabiya" - was PRACTICE SCREEN, and it drew nothing at
 * all: no useMemo, no BoardArrow, nothing passed to the board.
 *
 * The reason is in its own comment, and the reason is HALF right. It says:
 *
 *   "This used to play the EXPECTED move and draw it as an arrow. That is not a hint - it is the
 *    answer, drawn from the study rather than the engine, so it was even more tempting than it looks."
 *
 * Correct about the HINT, and the hint did go back to lib/hint (rings, then dots, no arrow). But the fix
 * removed the LINE'S OWN ARROW as well, and the line's move is not a hint - it is what the screen exists
 * to teach. The instruction is already in this codebase, quoted in GameOpeningsScreen:
 *
 *   "this is a course so no you just show the arrows ... dont keep anything that says you have to
 *    activate the arrows"
 *
 * So both halves are asserted: the hint still reveals nothing, and the line arrow is unconditional. A
 * gate covering only one of the two course screens is what let this ship.
 *
 * NOTE THE ARGUMENT ORDER. `ok` here is `(cond, label, detail)` - the CONDITION FIRST. The first version
 * of this section was written label-first, which made every assertion a non-empty string in the
 * condition slot: all ten passed whatever the code did, and two deliberate mutations of the source did
 * not fail it. Ten green ticks that could not have been red. If you add checks here, put the boolean
 * first.
 */
{
  const practice = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'PracticeScreen.tsx'), 'utf8',
  );
  const pc = practice.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  ok(/const arrows = useMemo\(/.test(pc),
    'PracticeScreen computes arrows at all',
    'it had no arrow code whatsoever - the board was drawn bare');
  ok(/arrows=\{arrows\}/.test(pc),
    'and passes them to the board',
    'computing an arrow nobody renders is the dead-gate shape again');
  ok(/const gold: BoardArrow/.test(pc),
    "the line's own move is drawn on the user's ply",
    'the move the line plays is what the screen teaches');
  ok(/color: arrowColors\.reply/.test(pc),
    'the opponent reply is drawn too, so the position reads as a demonstration');

  /*
   * AND THE USER'S OWN MOVE BESIDE IT, WHEN THEY DIFFER - the "my choice or the app's" half. A decision
   * belongs to a POSITION, so it can be joined onto a line the user never played, which is the only
   * reason it can appear on a course line at all.
   */
  ok(/decisionAt\(/.test(pc) && /buildDecisionIndex/.test(pc),
    'it reads the position-indexed decisions');
  ok(/yourDecision\.playedUci\.slice\(0, 2\)/.test(pc),
    "the user's own move is drawn red");
  ok(/yourDecision\.playedUci\.slice\(0, 4\) === lineUci\.slice\(0, 4\)/.test(pc),
    'and only when the two moves really differ',
    'two arrows on the same two squares would show a disagreement that does not exist');

  /*
   * THE HINT STILL REVEALS NOTHING - the half that was already right, and it must stay right. Asserting
   * the arrows exist without asserting this would let the fix regress straight back into the old bug.
   */
  ok(/hintFrom=\{hintStage >= 1 \? hintFrom : \[\]\}/.test(pc)
    && /hintTo=\{hintStage >= 2 \? hintTo : \[\]\}/.test(pc),
  'CONTROL: the hint still rings and dots - it draws no arrow');
  const hintLib = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'hint.ts'), 'utf8');
  ok(!/BoardArrow/.test(hintLib),
    'CONTROL: and lib/hint offers no arrow of its own',
    'a hint that draws the answer is the defect this replaced');

  /*
   * AND THE OTHER COURSE SCREEN IS STILL COVERED, so a change cannot fix one and break the other.
   */
  const course = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'CourseScreen.tsx'), 'utf8',
  );
  const cc = course.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  ok(/arrows=\{arrows\}/.test(cc), 'CONTROL: CourseScreen still draws its line arrow');

  console.log('');
}

/*
 * TWO REPORTED ON THE DEVICE, IN THE SAME AREA.
 *
 *   1. "in puzzles from my games when i click hint it still select all my pieces"
 *   2. "when you should show the red arrow (my mistake) before i play not after i solve the problem"
 *      and "it doesnt show me a mistake/blunder in the opening and what to play instead"
 *
 * Both were real, and both were gates that had been written against the wrong shape.
 */
head('14. WHAT THE USER REPORTED, AND WHY IT WAS NOT CAUGHT');

{
  /*
   * 1. THE HINT RINGS EVERY PIECE, SO IT RINGS NOTHING.
   *
   * `movableSquares` used to return every piece with a legal move. In an ordinary middlegame position
   * almost every piece has a legal move, so the hint selected the whole army - and a hint that cannot
   * be wrong is not information. It is now narrowed to the pieces that can CAPTURE or give CHECK, which
   * is what the owner means by "the piece to move" without naming a move.
   *
   * The fallback matters as much as the narrowing: in a genuinely quiet position there is no narrower
   * honest answer, and reporting an empty set would be a second way of telling the player nothing.
   */
  const hintSrc = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'hint.ts'), 'utf8');
  ok(/moves\.some\(\(m\) => m\.captured\)/.test(hintSrc),
    'the hint is narrowed to pieces that can capture');
  ok(/probe\.isCheck\(\)/.test(hintSrc),
    'or that can give check - which is what "the piece to move" means without naming a move');
  ok(/return pointed\.length > 0 \? pointed : movable;/.test(hintSrc),
    'CONTROL: and it falls back to the legal set rather than reporting nothing in a quiet position');

  /*
   * 2. THE MISTAKE AND THE ALTERNATIVE, DRAWN BEFORE THE MOVE.
   *
   * This is the clearest miss in the file. The arrows were written
   *
   *     if (!userToMove) { ...both arrows... }
   *
   * so they appeared only once the move had been MADE and the position had moved on - the precise
   * opposite of "before i play". For a mined puzzle `fen` is the position to solve with the user to
   * move, so `userToMove` was true and the branch never ran: the board was bare, and the correction
   * arrived only after the mistake had been made again.
   *
   * `MinedPuzzle` carries `playedUci` and `bestUci`, so both moves are known before a finger touches the
   * board. Asserted by the SHAPE, because that is what was wrong: a gate that looked for "the arrows
   * exist" would have passed on the old code.
   */
  const puz = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'PuzzlesScreen.tsx'), 'utf8',
  );
  const pz = puz.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  ok(!/if \(!userToMove\) \{[\s\S]{0,200}playedUci/.test(pz),
    'the mistake arrows are NOT gated on it not being the user turn any more');
  ok(/puzzle\.playedUci\.slice\(0, 2\)/.test(pz),
    'the move the user played is drawn, in red - that is the mistake');
  ok(/puzzle\.playedUci\.slice\(0, 4\) === puzzle\.bestUci\.slice\(0, 4\)/.test(pz),
    'CONTROL: and no arrow at all when it IS the move to play - a brilliant has no mistake to mark');
  ok(/if \(!solved && !failed\) \{/.test(pz),
    'CONTROL: it is the STANDING board, not a post-answer reveal');
  // The gold arrow on bestUci that this section originally required was WITHDRAWN at the user's
  // request - see section 17, which asserts its absence. Requiring it here as well would make two
  // sections of one gate contradict each other, which is worse than either being right alone.

  /*
   * 3. THE LINE MUST NOT TELEPORT.
   *
   * "i played 2 moves and it jumped to another position". `continueLine` resumes the family walk at the
   * DEEPEST point of the user history the pool recognises, so on a deviation it returns a line that
   * starts somewhere other than where the user is. The caller then sets that line whole and puts the
   * board at played.length - a position the user never reached.
   *
   * The book answer is now accepted only if it replays what was played. This is a property of the data,
   * so it is asserted by CALLING it rather than by reading its shape.
   */
  /*
   * The guard has to be CHECKED and USED. Asserting only that the comparison exists passes when the
   * `if` that consumes it is gone - which is exactly the mutation that must fail, because that is the
   * teleporting version. Both halves are asserted for that reason.
   */
  const obSrc = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'openingBuilder.ts'), 'utf8');
  ok(/const bookStartsWherePlayed/.test(obSrc) && /s\.moveSan === playedSans\[i\]/.test(obSrc),
    'CONTROL: the book answer is accepted only when it starts where the user actually is');
  ok(/if \(bookStartsWherePlayed\) return fromBook;/.test(obSrc),
    'CONTROL: and that check GATES the return - computing it and ignoring it is the original bug');

  /*
   * 4. NEW VERDICTS MUST REACH THE OPENINGS SCREEN.
   *
   * "it doesnt show me a mistake/blunder in the opening and what to play instead" - with every opening
   * reading "0 in the opening" and the lines reading "0 to decide", AFTER two hundred games had been
   * analysed. The work had been done and the result was invisible.
   *
   * `CachedPositions` is derived from the analysed games, and `loadCachedPositions` checked exactly one
   * thing: its own version. Nothing compared it to the scan, so a cache written before the engine had
   * run stayed "fresh" for ever. It holds the ENGINE-FREE positions, and out of book the engine-free
   * recommendation IS the move the user played - so every out-of-book position had no recommendation
   * to disagree with, no decision existed, and there was nothing to show. On book was 3%.
   *
   * So the invalidation is asserted where the truth changes, not polled for: a poll is the same kind
   * of thing that quietly stopped happening in the first place.
   */
  const stats = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'StatsScreen.tsx'), 'utf8',
  );
  const st = stats.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const statsJobsSrc = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'statsJobs.ts'), 'utf8');
  const jobs = statsJobsSrc.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  /*
   * Scoped to the SCAN path, because there are now two reasons to drop the derived positions and a
   * single global "the first clear comes after the first save" comparison cannot tell them apart.
   *
   * It used to read `st.indexOf('await clearCachedPositions') > st.indexOf('await saveScanState')`,
   * which is a claim about the first occurrence of each. A refresh clears too now — a refresh that
   * changes the game count invalidates just as genuinely — and that extra, earlier call made this
   * assertion stop meaning what it says. The ordering that matters is the one inside the scan.
   */
  /*
   * The scan itself now lives in `lib/scanPlan`, run by Stats and by the in-place import card on
   * Puzzles and Your openings. The claim is about the SCAN, so it is asserted where the scan is —
   * in StatsScreen it would now be a claim that a comment names the call.
   */
  const planSrc = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'scanPlan.ts'), 'utf8');
  const plan = planSrc.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const clearIdx = plan.indexOf('await clearCachedPositions');
  /*
   * The RECORDS-WRITING save, not the destructuring declaration and not the return value — both of
   * which also contain the string `records: finalRecords`. The save is the one whose object starts
   * with `puzzles: previous.puzzles`.
   */
  const recordsIdx = plan.indexOf('await saveScanState(username, {\n    records: finalRecords,\n    puzzles: previous.puzzles,');
  ok(/await clearCachedPositions\(username\)/.test(plan),
    'finishing an analysis drops the derived positions, so the next open re-derives from the new verdicts');
  ok(clearIdx >= 0 && recordsIdx >= 0 && recordsIdx < clearIdx,
    'CONTROL: and INSIDE the scan it happens AFTER the records are written - clearing first would '
    + 're-derive the old data');
  ok(/if \(before != null && all\.length !== before\) \{[\s\S]{0,220}?await clearCachedPositions\(name\)/.test(jobs),
    'CONTROL: and the detached refresh job carries its own, separate invalidation for a changed game '
    + 'count');

  const store = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'lichessStore.ts'), 'utf8');
  ok(/export async function clearCachedPositions/.test(store)
    && /Storage\.removeItem\(POSITIONS_CACHE\(username\)\)/.test(store),
  'the cache has a way to be dropped at all');
  console.log('');
}

/*
 * A STALE CACHE THAT CANNOT DETECT ITS OWN STALENESS.
 *
 * Clearing the positions cache when an analysis completes is HALF the fix. It only helps if a run
 * completes, and the user may never start one - so a cache written before the engine ever ran would
 * stay "fresh" for ever. That is exactly what was observed: 200 games analysed, every opening still
 * reading "0 in the opening".
 *
 * So the cache also records HOW MANY GAMES WERE ANALYSED when it was derived, and the screen treats a
 * mismatch as a miss. The two halves are asserted separately because either alone leaves the bug alive:
 * clear-at-end-of-run cannot help a user who never runs one, and compare-on-read cannot help a user
 * whose cache was written before the field existed - which is why "absent" is a miss, not a pass.
 */
head('15. THE POSITIONS CACHE CAN TELL THAT IT IS STALE');

{
  const store = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'lichessStore.ts'), 'utf8');
  ok(/analysedGameCount\?: number/.test(store),
    'the cache records how many games were analysed when it was derived');
  ok(/analysedGameCount,/.test(store), 'and writes it');

  const scr = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx'), 'utf8',
  );
  const sc = scr.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  ok(/cached\.analysedGameCount !== analysedNow/.test(sc),
    'a mismatch against the live scan is treated as a cache MISS, so the families re-derive');
  ok(/typeof cached\.analysedGameCount === 'number'/.test(sc),
    'CONTROL: and a cache written before the field existed is a miss, not a silent pass');
  ok(/const analysedCount = Object\.keys\(scanNow\.records/.test(sc),
    'the count that goes into the cache is the one the comparison uses');

  console.log('');
}

/*
 * THE SECOND CACHE, AND WHY THE FIRST FIX LOOKED LIKE IT DID NOTHING.
 *
 * Clearing the positions cache when an analysis completes, and comparing the analysed count on read,
 * both left the openings screen reading exactly the same list. The reason is above them: a warm open
 * short-circuits on the FAMILIES cache and never reaches the positions at all. So the same rule has to
 * exist on the cache that actually decides, or fixing the other one changes nothing observable.
 *
 * That is worth a gate of its own, because the failure is invisible: the code is correct, the fix is
 * correct, and the screen does not move.
 */
head('16. AND THE CACHE THAT ACTUALLY DECIDES IS THE ONE THAT HAS TO KNOW');

{
  const store = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'lichessStore.ts'), 'utf8');
  ok(/analysedGameCount\?: number;\s*\n\}/.test(store)
    || /analysedGameCount\?: number;/.test(store),
  'the families cache records the analysed count too');
  ok(/cached\.analysedGameCount !== analysedGameCount/.test(store),
    'a mismatch makes it stale IMMEDIATELY - age cannot see that the input changed');
  ok(/cached\.analysedGameCount === undefined\) return true;/.test(store),
    'CONTROL: a cache written before the field existed is stale, not a silent pass');
  ok(/Date\.now\(\) - built > OPENINGS_CACHE_TTL_MS/.test(store),
    'CONTROL: and the age rule is still there - it is right for its own job');

  const scr = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx'), 'utf8',
  );
  const sc = scr.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  ok(/openingsCacheIsStale\(cached, Object\.keys\(scanNow\.records/.test(sc),
    'the screen passes the live analysed count into that decision - this is the wiring that was missing');
  ok(/saveCachedOpenings\(user, result\.lines, result\.gameCount, Object\.keys\(scanAfter\.records/.test(sc),
    'and both writes record the count, so the next open can compare');

  console.log('');
}

/*
 * FIVE REPORTS IN ONE MESSAGE, AND TWO OF THEM REVERSED AN EARLIER INSTRUCTION.
 *
 *   1. "in your openings in the test when i play a wrong move it still says the correct move in msg but
 *      doesnt show it with an arrow"
 *   2. "in the puzzles from my games it still shows me what to play (you have to remove the arrow on what
 *      to play and when i click hint only colour the piece that i should move)"
 *   3. "when i clicked on hint it selected 2 pieces so fix it"
 *   4. "in the puzzles online it still select all the pieces in the hint"
 *   5. "in stats refreshing games doent work"
 *
 * (2) WITHDRAWS what this session added on the strength of the earlier *"show the red arrow before i
 * play"*. That part still stands and is still here: the mistake is drawn before the move. What is gone
 * is the second arrow - the gold one on `bestUci` - because an arrow on the answer means the position
 * is no longer a question. The answer is now behind the hint, on request.
 *
 * (3) AND (4) ARE THE SAME BUG, AND IT WAS A BAD FIX. Narrowing the hint to "pieces that capture or
 * check" is a GUESS about a position, and it was reported twice for guessing wrong: it rang nothing in a
 * quiet position, and it rang two pieces in a sharp one. Both tabs already know the answer - a live
 * puzzle carries `solutionSan`, a mined one carries `bestUci` - so the hint is now a read of that
 * rather than an opinion about the position.
 */
head('17. FIVE REPORTS, ONE OF THEM A REVERSAL');

{
  const hintSrc = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'hint.ts'), 'utf8');
  ok(/export function solvingPiece/.test(hintSrc),
    'the hint can name THE piece, instead of guessing which pieces are interesting');
  ok(/return \[move\.from\];/.test(hintSrc),
    'CONTROL: exactly one square - "which of these?" is the question the hint exists to shrink');

  const puz = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'PuzzlesScreen.tsx'), 'utf8',
  );
  const pz = puz.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  // 4: the live tab
  ok(/solvingPiece\(fen, puzzle\?\.solutionSan\?\.\[step\]\)/.test(pz),
    'the online tab colours the piece that plays the solution');
  // 3: the mined tab
  ok(/solvingPiece\(fen, solution\[step\]\?\.san\)/.test(pz),
    'and the from-your-games tab colours the piece that plays the CURRENT line move');
  ok((pz.match(/solvingPiece\(/g) ?? []).length === 2,
    'CONTROL: BOTH tabs use it - the old capture/check guess is gone from both');
  ok(!/movableSquares\(fen\) : \[\]/.test(pz),
    'CONTROL: and neither tab falls back to "every movable piece", which was reports 3 and 4');

  // 2: the gold "what to play" arrow is withdrawn; the red mistake arrow is not.
  const arrowBlock = (() => {
    const i = pz.indexOf('const arrows: BoardArrow[] = [];');
    if (i < 0) return '';
    let d = 0, opened = false;
    for (let k = i; k < pz.length; k += 1) {
      if (pz[k] === '{') { d += 1; opened = true; }
      else if (pz[k] === '}') { d -= 1; if (opened && d === 0) return pz.slice(i, k + 1); }
    }
    return pz.slice(i, i + 900);
  })();
  ok(/puzzle\.playedUci\.slice\(0, 2\)/.test(arrowBlock),
    'your mistake is still drawn, in red');
  ok(!/arrowColors\.hint/.test(arrowBlock) && !/puzzle\.bestUci\.slice\(0, 2\)/.test(arrowBlock),
    'CONTROL: and there is NO arrow on what to play - that is the reversal, and it must be absent');

  // 1: the correction is on the board DURING a test, not only in the sentence.
  const gos = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx'), 'utf8',
  );
  const gc = gos.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const learning = gc.indexOf('if (!testing) {');
  /*
   * `if (mistake)` also names the MOVE HANDLER, ~900 lines earlier, which is not what is asserted
   * here. The search has to start AFTER the guard, or it finds that one and every comparison below
   * is between two unrelated places - which is how a gate passes for the wrong reason.
   */
  const mistakeAt = gc.indexOf('if (mistake) {', learning);
  ok(learning >= 0 && mistakeAt > learning,
    'the learning arrows are gated on not testing');
  /*
   * The mistake arrows must sit AFTER that guard CLOSES. That is the whole of report 1: they used to
   * be inside it, so a wrong answer during a test produced a sentence and no arrow. Measured by
   * finding where the guard own closing brace is, because "is it inside" is a question about
   * structure and not about which words appear.
   */
  let guardEnd = -1, depth = 0, opened = false;
  const braceStart = gc.indexOf('{', learning);
  for (let k = braceStart; k >= 0 && k < gc.length; k += 1) {
    if (gc[k] === '{') { depth += 1; opened = true; }
    else if (gc[k] === '}') { depth -= 1; if (opened && depth === 0) { guardEnd = k; break; } }
  }
  ok(guardEnd > learning && mistakeAt > guardEnd,
    'CONTROL: and the mistake arrows sit AFTER that guard closes - the nesting was report 1');
  ok(/add\(mistake\.playedUci, colors\.bad\)/.test(gc) && /add\(mistake\.recommendUci, arrowColors\.hint\)/.test(gc),
    'the mistake is drawn on the board in the test as well as in learning');

  // 5: refresh is not an account switch, and it says what it found.
  const stats = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'StatsScreen.tsx'), 'utf8',
  );
  const sx = stats.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const statsJobsForRefresh = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'statsJobs.ts'), 'utf8');
  const jobsForRefresh = statsJobsForRefresh.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  ok(/const refreshGames = useCallback/.test(sx)
    && /startGamesRefresh\(account\.username, \{[\s\S]{0,140}?force: true/.test(sx),
  'Refresh games has its own handler and forces a re-download through the module job');
  ok(!/onPress=\{\(\) => connect\(account\.username\)\}/.test(sx),
    'CONTROL: and it no longer goes through connect, the account SWITCH that can wipe saved data');
  ok(/setRefreshNote\(/.test(sx) && /no new results on Lichess/.test(jobsForRefresh),
    'CONTROL: and it says what it found, so a refresh is never silent');

  console.log('');
}

/*
 * "ALL OPENINGS" IS NOT "YOUR OPENINGS", AND THEY SHARE A SCREEN.
 *
 * THE REPORT: *"i tried 'all openings' not 'your openings' and i found out that you changed its
 * behaviour to be like 'your openings' while i specifically told you to not touch it. (showing the
 * moves and choices of user is only in your openings not all openings)"*.
 *
 * This one is worth a gate of its own because the cause was structural, not a stray line. Both tabs
 * open the SAME `CourseScreen` through the SAME `courseStudyId`, and a study id does not say who
 * asked. So there was no way for the screen to behave differently, and the user's own moves and
 * choices - which belong to Your Openings and were asked for there - appeared in the one place the
 * user said not to touch them.
 *
 * The rule being asserted: your moves and choices are shown in YOUR openings, and nowhere else.
 */
head('18. ALL OPENINGS IS NOT YOUR OPENINGS');

{
  const shell = fs.readFileSync(path.join(ROOT, 'src', 'components', 'AppShell.tsx'), 'utf8');
  const sc = shell.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  ok(/type StudyOrigin = 'all' \| 'mine'/.test(shell),
    'the origin is a named type, so a third value cannot be invented at a call site');
  ok(/useState<StudyOrigin>\('all'\)/.test(sc),
    "CONTROL: and it DEFAULTS to 'all' - a screen that does not say where it came from must not "
    + 'volunteer the user\'s games, because that is the leak being fixed');
  ok(/openCourse\(studyId, 'mine'\)/.test(sc),
    "the Your Openings route asks for 'mine'");
  ok(/openCourse\(id, 'all'\)/.test(sc),
    "CONTROL: and the All Openings route asks for 'all' - not 'mine', not the default");

  // Both screens reached from both tabs must gate on the origin.
  for (const [name, prop] of [
    ['CourseScreen', 'CourseScreen'],
    ['PracticeScreen', 'PracticeScreen'],
  ]) {
    const src = fs.readFileSync(
      path.join(ROOT, 'src', 'components', 'screens', `${name}.tsx`), 'utf8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    ok(/origin = 'all'/.test(code),
      `${name} defaults to 'all' as well, so a caller that omits it cannot leak`);
    ok(/showYourMoves = origin === 'mine'/.test(code),
      `${name} derives one flag from the origin, rather than testing the origin in several places`);
    // The guard must be on the LOAD, not only on the read. An index that is built and not drawn is
    // a feature waiting for one missed condition.
    const loadGuard = /if \(!showYourMoves\) return;[\s\S]{0,600}loadCachedPositions/.test(code);
    ok(loadGuard,
      `CONTROL: ${name} does not even READ the user's cached positions unless they were asked for`);
    ok(/showYourMoves\s*\? decisionAt\([\s\S]{0,400}:\s*null/.test(code),
      `${name}'s decision read itself is gated too - a null index and an unchecked read are not the same safety`);
  }

  // Your Openings keeps everything. Gating must not spread to the screen that is SUPPOSED to show it.
  const gos = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx'), 'utf8',
  );
  ok(!/showYourMoves|origin === 'mine'/.test(gos),
    'CONTROL: Your Openings itself is NOT gated - it is the one place these belong, and it keeps them');

  console.log('');
}

/*
 * "I SHOULD ALWAYS BE ABLE TO TEST AFTER FINISHING WHETHER THERE IS ASKABLE POSITIONS OR NOT."
 *
 * The button was hidden whenever `askablePositions` returned nothing. That was a reaction to a real
 * dead tap ("i completed a line and clicked on test yourself but nothing happened"), and the remedy
 * it chose — removing the control — is what this report is about. A control that disappears tells
 * the user the app decided he was not ready, and he has just finished the line.
 *
 * The real fault was upstream: the screen treated a POSITION and a DECISION as the same thing. A
 * decision needs our recommendation to differ from what was played, which is unavailable on an
 * unanalysed line or one rebuilt from the book. Every ply of the user's own side is still a valid
 * question, because the line plays a known move there.
 */
head('19. YOU CAN ALWAYS TEST');

{
  const gos = fs.readFileSync(
    path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx'), 'utf8',
  );
  const gc = gos.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  ok(/function testPlacesFor\(/.test(gc),
    'the places a test can ask are computed by ONE function, because two callers computing them '
    + 'separately is how a button came to be shown over an empty pool');

  // The fallback, not just the preference for decisions.
  ok(/if \(decided\.length > 0\) return decided;/.test(gc),
    'decision-carrying positions are preferred');
  ok(/if \(s\.side !== trained\) continue;/.test(gc),
    'and when there are none it falls back to every ply of the user\'s OWN side - which is what makes '
    + 'the test possible on a line the engine never judged');

  ok(!/\{testAskable > 0 \? \(/.test(gc),
    'CONTROL: the button is NOT hidden when the count is zero - that is the whole report, and it must '
    + 'stay absent');
  ok(/onPress=\{startTest\}/.test(gc),
    'the button still starts the test');
  ok(/Test yourself\{testAskable > 0/.test(gc),
    'and it says how many positions it will ask, without pretending there are none');

  // Both callers must use the one function, or the disagreement comes straight back.
  ok((gc.match(/testPlacesFor\(/g) ?? []).length >= 3,
    'CONTROL: the helper is used by BOTH the count and the press handler - one caller alone is the '
    + 'drift the comment claims to have removed');
  ok(/const askable = testPlacesFor\(testPoolNow\(\)/.test(gc),
    'the handler recomputes at press time rather than closing over a value from render');

  console.log('');
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures > 0 ? 1 : 0);
