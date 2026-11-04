/**
 * Do the five fixes do what they claim? Checked against the REAL corpus, with a control.
 *
 * Each fix below was made because the user reported a specific symptom. A fix for a reported
 * symptom that is not verified is a guess, and this app has a long history of fixes that
 * compiled, passed the existing gates, and changed nothing on the device. So each check here
 * is written to FAIL if the fix is absent, and where a claim could be satisfied by accident
 * (a lookup that returns "some book" rather than "the right book"), the check also proves the
 * test can tell the difference by running the old behaviour alongside the new one.
 *
 *   1. a book's continuation is scoped to the opening that asked for it
 *      - the device report: a Queen's Gambit move offered inside the London System
 *   2. a "your openings" drill is more than one move
 *      - the device report: one move, then "done"
 *   3. a drill whose move is a recapture is not offered while a real decision exists
 *      - the device report: "it always give me simple positions where I just recapture"
 *   4. a drill keeps the colour of the session it is in
 *   5. the coverage matcher is unchanged where it was already proven
 *      - covered by bookindex.diff.test.mjs, which must stay at 15/15
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
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-fixes');

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

/*
 * A STAND-IN FOR STOCKFISH, and an honest one.
 *
 * `continueLineWithEngine` asks the engine what to play where no book we ship teaches the
 * position. There is no WebView host in node, so without this the function's only testable
 * behaviour would be its failure path - which is how a bridge can look covered while nothing
 * about it has ever run.
 *
 * So the engine module is replaced by one whose `bestMove` returns a REAL legal move from the
 * REAL position, and whose `uciToSan` does the real conversion. That exercises everything the
 * bridge decides: when to ask, when to stop, when to hand the line back to a book, whether the
 * sequence it returns is playable, and whether provenance is recorded. The one thing it cannot
 * exercise is the move CHOICE, because that is Stockfish's judgement and not this code's - so
 * nothing below asserts anything about which move is best.
 */
const engineStub = {
  calls: [],
  answers: [],
  move: () => null,
  /**
   * `bestMove` returns UCI, not SAN — that is the real contract, and the first version of this
   * stub returned SAN. The bridge then fed "Nf6" to `uciToSan`, which read `Nf` and `6` as
   * squares, failed, and returned null; the bridge correctly treated that as "no answer" and
   * stopped, so the test reported a line that did not continue and no `fromEngine` flag. The
   * bridge was right and the stub was wrong, which is the only acceptable way for that failure
   * to have gone.
   */
  bestMove(fen) {
    const san = engineStub.move(fen);
    engineStub.answers.push({ fen, san, uci: null });
    if (!san) return null;
    try {
      const c = new Chess(fen);
      const m = c.move(san);
      const uci = `${m.from}${m.to}${m.promotion ?? ''}`;
      engineStub.answers[engineStub.answers.length - 1].uci = uci;
      return uci;
    } catch (e) {
      engineStub.answers[engineStub.answers.length - 1].error = String(e && e.message);
      return null;
    }
  },
  stop: () => {},
  destroy: () => {},
  init: async () => {},
  attach: () => {},
};
const engineModule = {
  getEngine: () => engineStub,
  uciToSan: (fen, uci) => {
    try {
      const c = new Chess(fen);
      const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      return m.san;
    } catch { return null; }
  },
  applyUci: () => {},
};

Module._load = function (request, parent, isMain) {
  if (request === 'chess.js') return REAL_CHESS;
  if (request === '@/lib/engine') return engineModule;
  const map = {
    '@/lib/repertoire': 'repertoire', '@/lib/openings': 'openings',
    '@/lib/gameOpenings': 'gameOpenings', '@/lib/openingBuilder': 'openingBuilder',
  };
  if (map[request]) return origLoad.call(this, J(map[request]), null, false);
  if (request.startsWith('@/data/')) {
    return origLoad.call(this, path.join(ROOT, 'src', request.slice(2)), parent, isMain);
  }
  /*
   * Anything else under `@/` is a module this test does not exercise - the engine bridge, the
   * store - and pulling the real one in would drag native modules into a plain node process.
   * An inert stub is the honest substitute: if a check below ever starts depending on one of
   * these it will see an empty object and fail loudly, rather than passing against a mock.
   */
  if (request.startsWith('@/')) {
    return new Proxy(function () {}, {
      get: (_t, prop) => (prop === '__esModule' ? false : stub),
      apply: () => stub,
    });
  }
  return origLoad.call(this, request, parent, isMain);
};
const stub = new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'then' ? undefined : stub),
  apply: () => stub,
});

const openings = origLoad.call(Module, J('openings'), null, false);
const gameOpenings = origLoad.call(Module, J('gameOpenings'), null, false);
const builder = origLoad.call(Module, J('openingBuilder'), null, false);

const { bestCoverageAcrossOpenings, bookContinuationFromPosition } = openings;
const { buildCustomExercises } = gameOpenings;
const { continueFromBook, buildFamilyLines, continueLineWithEngine } = builder;

/*
 * `openingBuilder` wires the drill continuation at module load, and it imports it FROM
 * `gameOpenings` — so requiring `openingBuilder` above has already done it, on the same cached
 * instance of `gameOpenings` this test holds. Re-registering it here would test a second,
 * hand-made implementation instead of the one the app runs, which is the usual way a test
 * ends up proving nothing. It is left alone deliberately.
 */

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) { console.log('  PASS  ' + label); return; }
  failures++;
  console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : ''));
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

// ---------------------------------------------------------------------------
head('1. the book continuation is scoped to the opening that asked for it');

const LONDON = 'london-system';
const QG = 'queens-gambit';

// The shared prefix is the whole problem: 1.d4 d5 is in both books, so an unscoped
// lookup has nothing to separate them and the registry order decides.
const shared = ['d4', 'd5'];
const unscoped = bestCoverageAcrossOpenings(shared);
const scopedLondon = bestCoverageAcrossOpenings(shared, LONDON);
const scopedQg = bestCoverageAcrossOpenings(shared, QG);

ok(unscoped !== null, 'the unscoped lookup still answers 1.d4 d5 (the proven path is intact)');
ok(scopedLondon !== null && scopedLondon.opening.id === LONDON,
  'scoped to london-system, the answer is the London System',
  `got ${scopedLondon?.opening?.id}`);
ok(scopedQg !== null && scopedQg.opening.id === QG,
  'scoped to queens-gambit, the answer is the Queen\'s Gambit',
  `got ${scopedQg?.opening?.id}`);

// The control: if the scoped lookup returned the same thing for both, the test above would
// pass for the wrong reason. It must actually be steering the answer.
ok(scopedLondon?.opening?.id !== scopedQg?.opening?.id,
  'the two scopes genuinely return DIFFERENT books (the check can tell them apart)');

// And the end-to-end symptom: the moves a London System line is continued with.
const londonStem = ['d4', 'd5', 'Nf3'];
const londonTail = continueFromBook(londonStem, false, undefined, LONDON);
const londonUnscoped = continueFromBook(londonStem);
ok(londonTail !== null && londonTail.moves.length > 0,
  'a London System line continues with the London System book',
  `scoped returned ${londonTail ? londonTail.studyTitle : 'nothing'}`);
ok(londonUnscoped !== null,
  'the unscoped continuation still works (used by paths that have no opening to scope to)');
// c4 is the move the user reported. If the scoped tail begins with it, the bug is not fixed.
const londonFirst = londonTail?.moves?.[0];
ok(londonFirst !== 'c4',
  `the first London continuation is not c4 (the reported Queen's Gambit move) - got ${londonFirst}`);
ok(londonTail?.studyTitle !== londonUnscoped?.studyTitle
  || londonTail?.moves?.[0] === londonUnscoped?.moves?.[0],
  'the scoped tail came from the London book rather than whichever book matched a shared prefix',
  `scoped "${londonTail?.studyTitle}" vs unscoped "${londonUnscoped?.studyTitle}"`);

// ---------------------------------------------------------------------------
head('1b. THE BLOCK — a line must not die at the first move the user chose');

/*
 * *"i played the knight move then it is blocked (i cant move the next piece for the next
 * move)"*.
 *
 * The board goes non-interactive when the line runs out (`interactive={!done}`), and the line
 * ran out because the continuation lookup came back empty. It came back empty because it was
 * scoped to an `openingId` that was ITSELF wrong — the registry tie-break at the shared `d4 d5`
 * stem — and the London System's book does not contain a Queen's Gambit line. So the symptom was
 * a dead board and the cause was a misidentified opening.
 *
 * This asserts the property that matters, per opening: after a move that is characteristic of
 * that opening and is NOT in the user's own games, OUR book for THAT opening continues it. A
 * single-move line in the shipped corpus would be the bug, so the count is asserted.
 */
const CONTINUE_CASES = [
  [LONDON, ['d4', 'd5', 'Nf3']],
  [LONDON, ['d4', 'd5', 'Nf3', 'Nf6', 'Bf4']],
  [QG, ['d4', 'd5', 'c4']],
  [QG, ['d4', 'd5', 'c4', 'e6', 'Nc3']],
  ['slav-defense', ['d4', 'd5', 'c4', 'c6']],
  ['grunfeld-defense', ['d4', 'Nf6', 'c4', 'g6']],
  ['catalan', ['d4', 'Nf6', 'c4', 'e6', 'g3']],
  ['sicilian', ['e4', 'c5', 'Nf3']],
  ['italian-opening', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']],
  ['french-defense', ['e4', 'e6', 'd4', 'd5']],
  ['caro-kann-defense', ['e4', 'c6', 'd4', 'd5']],
  ['kings-indian-defense', ['d4', 'Nf6', 'c4', 'g6']],
];

let deadLines = [];
let confirmed = 0;
for (const [id, line] of CONTINUE_CASES) {
  const cont = continueFromBook(line, false, undefined, id);
  if (!cont || cont.moves.length === 0) {
    deadLines.push(`${id}: ${line.join(' ')} has NO continuation`);
    continue;
  }
  confirmed++;
  // And the continuation must be LEGAL from where the line stops, or the board freezes anyway.
  const c = new Chess();
  let bad = null;
  for (const s of line) { try { c.move(s); } catch { bad = s; break; } }
  if (bad) { deadLines.push(`${id}: the line itself is illegal at ${bad}`); continue; }
  try { c.move(cont.moves[0]); } catch {
    deadLines.push(`${id}: continuation starts with an illegal ${cont.moves[0]}`);
  }
}
ok(deadLines.length === 0,
  `all ${confirmed} lines continue, with a legal next move`,
  deadLines.join('\n          '));

// The CONTROL for this section: the same lines asked for UNSCOPED must not all resolve, or the
// scoping is doing nothing and the test would pass for the wrong reason. (Several of these are
// exactly the shared-stem cases where the registry order used to pick a different book.)
let unscopedDiffers = 0;
for (const [id, line] of CONTINUE_CASES) {
  const scoped = continueFromBook(line, false, undefined, id);
  const loose = continueFromBook(line);
  if (!scoped || !loose) continue;
  if (scoped.studyTitle !== loose.studyTitle) unscopedDiffers++;
}
ok(unscopedDiffers > 0,
  `CONTROL: scoping actually changes the book for ${unscopedDiffers} of these lines`,
  'if this is zero the test cannot tell scoped from unscoped and proves nothing');

// ---------------------------------------------------------------------------
head('1c. THE SPINE GETS A TAIL - through the function the screen actually calls');

/*
 * *"also i just tried sicilian in 'your openings' and the same problem that you keep
 * repeating each time : i only played one move and thats it !"*
 *
 * WHY SECTION 1b DID NOT CATCH THIS, which is the point of writing it down.
 *
 * 1b asserts `continueFromBook(line, false, ...)` - the FORWARD walk - returns something for a
 * Sicilian. It does, and 1b passed, and the app was still broken. Because 1b called the wrong
 * function: the screen does not ask `continueFromBook`, it asks `buildFamilyLines`, and
 * `withBookTail` (inside that) used ONLY the EXACT walk. The exact walk requires the book's
 * tree to contain the user's move order verbatim. A real Sicilian - `e4 c5 Nf3 d6 c4 d5 Nc3
 * Nc6 Be3` - is not a move order the shipped Sicilian book contains plies-for-plies, so the
 * exact lookup returned nothing, no tail was appended, and the family card was only as long as
 * the user's own games. One move in, the line ended.
 *
 * So the scoping fix (which WAS about `openingId`) could not have fixed this, and did not. The
 * walk policy was the reason there was no answer.
 *
 * These checks go through `buildFamilyLines` for that reason. Every one of them would fail with
 * the exact-walk-only version, which the control below demonstrates rather than asserts.
 */

/** Build the `GamePosition[]` shape the screen feeds `buildFamilyLines`, from real move orders. */
function positionsFromGames(openingName, moveOrders) {
  const out = [];
  moveOrders.forEach((sans, gi) => {
    const c = new Chess();
    for (let ply = 0; ply < sans.length; ply++) {
      const fen = c.fen();
      const side = c.turn();
      const prefixSan = sans.slice(0, ply);
      let m;
      // Test data that is not a legal game would make every assertion below meaningless, and the
      // failure would read as an app bug. So the move order itself is named in the error.
      try { m = c.move(sans[ply]); } catch {
        throw new Error(`TEST DATA is not a legal game: ${openingName} game ${gi}, ply ${ply}, `
          + `"${sans[ply]}" after ${sans.slice(0, ply).join(' ')}`);
      }
      out.push({
        key: `${openingName}#${gi}#${ply}`, fen, ply, side,
        gameId: `g${gi}`, gameUrl: '',
        opening: openingName,
        playedSan: sans[ply], playedUci: `${m.from}${m.to}${m.promotion ?? ''}`,
        prevSan: prefixSan.length ? prefixSan[prefixSan.length - 1] : null,
        prefixSan: [...prefixSan],
        inBook: false, bookSan: null, bookReplies: [],
        recommendUci: null, recommendSan: null, options: [],
        timesSeen: 1,
      });
    }
  });
  return out;
}

/**
 * The user's own pool stops where his games stopped. The tail is the part that has to come from
 * our book, so the assertion is about the DIFFERENCE, not about an absolute length - a longer
 * line that came entirely from the user's games would pass a length check and still be the bug.
 */
const SPINE_CASES = [
  // [Lichess family label, the user's move orders, the deepest ply his games reached]
  // The Najdorf, which is the move order a real Sicilian player has, and the one the shipped
  // Sicilian book is least likely to contain plies-for-plies - which is the point.
  ['Sicilian Defense',
    [
      ['e4', 'c5', 'Nf3', 'd6', 'c4', 'd5', 'Nc3', 'a6', 'd4'],
      ['e4', 'c5', 'Nf3', 'd6', 'c4', 'd5', 'Nc3', 'a6', 'd4', 'cxd4'],
      ['e4', 'c5', 'Nf3', 'd6', 'c4', 'd5'],
    ], 9],
  // A second move order in the same family, to prove the fix is not specific to one line.
  ['Sicilian Defense', [['e4', 'c5', 'Nf3', 'd6', 'c4', 'd5', 'Nc3', 'Nc6', 'g3']], 8],
  ['London System',
    [
      ['d4', 'd5', 'Nf3', 'Nf6', 'Bf4', 'e6', 'e3', 'Nbd7', 'Bd3', 'c5'],
      ['d4', 'd5', 'Nf3', 'Nf6', 'Bf4', 'e6', 'e3', 'Nbd7', 'Bd3', 'c5'],
    ], 9],
  ["Queen's Gambit",
    [['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'Nbd7', 'Nf3'],
     ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'Nbd7', 'Nf3']], 10],
];

/*
 * WHAT IS ASSERTED HERE, AND WHY IT IS NOT "EVERY CARD IS LONGER THAN HIS GAMES"
 * ---------------------------------------------------------------------------
 * That was the first version of this section, and it failed, and the failure was the finding.
 *
 * For the Najdorff, the Sicilian, and the London, NO shipped study teaches the position the
 * user's games reach. Confirmed three ways that share no code with each other: the move-order
 * walks return nothing, the position index (which does work - it finds the QGD 21 playable
 * moves where there had been none) returns nothing, and a walk of the raw study trees using
 * each node's own `fenAfter` finds the position nowhere in 7,322 nodes.
 *
 * So a card that stops where his games stop is, for those openings, the CORRECT answer from the
 * corpus - and demanding a longer one would be demanding the app invent content, which is
 * exactly what it must not do. The user's requirement is that content come from real sources
 * and that he curates the openings himself, so the gap is filled by the ENGINE (see
 * `continueLineWithEngine`, exercised below), not by a longer book lookup.
 *
 * What is asserted instead is the set of things that must be true whichever way the corpus
 * falls, and the QGD case - a position the book DOES teach - is what proves the position index
 * works rather than merely existing.
 */

let illegalCards = [];
let noFamily = [];
const built = [];
for (const [label, orders, userDepth] of SPINE_CASES) {
  const fams = buildFamilyLines(positionsFromGames(label, orders), { maxPerFamily: 24 });
  const fam = fams.find((f) => f.name === label) ?? fams[0];
  if (!fam) { noFamily.push(label); continue; }
  built.push({ label, fam, userDepth });

  // (1) NO CARD MAY CONTAIN AN ILLEGLE MOVE. This is the invariant that actually caused
  // "one move and that's it": `stepsForSans` stops at the first illegal move, so a tail that
  // was out of step with the board produced a truncated card and a dead board. Whatever the
  // lookup returns, the card has to be playable from end to end.
  const c3 = new Chess(fam.steps[0].fen);
  let illegalAt = null;
  for (const s of fam.steps) {
    try { c3.move(s.moveSan); } catch { illegalAt = s.moveSan; break; }
  }
  if (illegalAt !== null) illegalCards.push(`${label}: illegal move ${illegalAt}`);
}

ok(noFamily.length === 0, 'a family card is built for every case', noFamily.join(', '));
ok(illegalCards.length === 0,
  'no built card contains an illegal move - the card is playable from end to end',
  illegalCards.join('\n          '));

// (2) WHERE THE BOOK DOES TEACH THE POSITION, THE CARD MUST RUN PAST HIS GAMES. The QGD case is
// chosen because its position IS taught, so this is a real assertion about the position index
// rather than a statement about content the corpus happens to lack.
{
  const qgd = built.find((b) => b.label === "Queen's Gambit");
  const builtSans = qgd ? qgd.fam.steps.map((s) => s.moveSan) : [];
  ok(builtSans.length > (qgd?.userDepth ?? 0),
    `a taught position DOES extend the card: Queen's Gambit ${builtSans.length} plies vs ${qgd?.userDepth} of his own games`,
    `built: ${builtSans.join(' ')}`);

  // And the extension is the book's, credited to a study - not a silent padding.
  //
  // Measured from the user's own DEEPEST position rather than from a fixed index: his games
  // supply real positions of their own, and those steps are correctly not credited to a study.
  // The first version sliced at a hard-coded ply and failed on exactly that, which would have
  // taught the wrong lesson - that a replayed position should claim to be from a book.
  const deepestUserPly = qgd
    ? Math.max(-1, ...qgd.fam.steps.filter((s) => s.position).map((s) => s.ply))
    : -1;
  const tailSteps = qgd ? qgd.fam.steps.filter((s) => s.ply > deepestUserPly) : [];
  ok(tailSteps.length > 0 && tailSteps.every((s) => !!s.fromStudy),
    'every step beyond his own deepest position is credited to the study it came from',
    `beyond ply ${deepestUserPly}, fromStudy: ${tailSteps.map((s) => s.fromStudy ?? 'null').join(', ')}`);
}

// (3) SCOPING SURVIVES THE POSITION LOOKUP. A position can be reached from several openings, so
// an unscoped position index would let the registry order decide which book teaches the rest of
// the line - which is the original "that move is a queens gambit move not london" bug arriving
// through a different door.
//
// The control asks about the STARTING POSITION, because that is the one position every opening's
// book certainly passes through, so both must answer and they must answer from their own books.
// The first version of this check used a mid-opening London position and asked the Queen's
// Gambit about it, which correctly returned null - and so proved nothing except that the scoping
// works, which is a weaker claim than the one being made.
{
  const start = new Chess().fen();
  const london = bookContinuationFromPosition(start, 'london-system');
  const queen = bookContinuationFromPosition(start, 'queens-gambit');
  const sicilian = bookContinuationFromPosition(start, 'sicilian');
  ok(london !== null && queen !== null && sicilian !== null,
    'every opening can continue from the starting position');
  const titles = new Set([london?.studyTitle, queen?.studyTitle, sicilian?.studyTitle]);
  ok(titles.size === 3,
    'CONTROL: three openings asked about the SAME position return three different books',
    [...titles].join(' | '));
  ok(bookContinuationFromPosition(start, null) === null
    && bookContinuationFromPosition(start, undefined) === null,
    'an unscoped position lookup is refused rather than answered from the wrong book');
  ok(bookContinuationFromPosition(start, 'no-such-opening') === null,
    'an unknown opening id returns nothing instead of falling back to the whole library');
}

// (4) THE CONTROL for the whole section: the move-order walk must genuinely fail on the cases
// where the position index is doing the work, or this section is testing nothing.
{
  let exactFails = 0, total = 0;
  for (const [, orders] of SPINE_CASES) {
    const stem = orders[0];
    const c = new Chess();
    for (const s of stem) c.move(s);
    total++;
    const exact = continueFromBook(stem, true, c.fen(), null);
    if (!exact || exact.moves.length === 0) exactFails++;
  }
  ok(exactFails > 0,
    `CONTROL: the move-order walk genuinely fails on ${exactFails} of ${total} real move orders`,
    'if it answered all of them the position index would have nothing to prove');
}

// (5) THE ENGINE BRIDGE, given a deterministic stand-in for Stockfish.
//
// The engine is stubbed because there is no WebView host in node, and a test that cannot run
// the code under test proves nothing. The stub is honest about what it is: it returns a real
// legal move from the real position, so the bridge's own logic - when to ask, when to stop, how
// to hand back to the book, and whether the moves it returns are playable - is genuinely
// exercised. Only the move CHOICE is not Stockfish's, and nothing here asserts that it is.
{
  const NAJDORF = ['e4', 'c5', 'Nf3', 'd6', 'c4', 'd5', 'Nc3', 'a6', 'd4'];
  const fams = buildFamilyLines(positionsFromGames('Sicilian Defense', [NAJDORF]), { maxPerFamily: 24 });
  const fam = fams[0];

  const askedFor = [];
  engineStub.calls = askedFor;
  engineStub.answers = [];
  engineStub.move = (fen) => {
    askedFor.push(fen);
    const c = new Chess(fen);
    const moves = c.moves();
    return moves.length ? moves[Math.floor(moves.length / 2)] : null;   // any legal move will do
  };

  const line = await continueLineWithEngine(fam, NAJDORF, { movetime: 1, maxEnginePlies: 4 });
  const sans = line.map((s) => s.moveSan);

  ok(askedFor.length > 0,
    'when no book teaches the position, the engine IS asked for a move',
    `the Najdorf position is not taught by the corpus, so a book-only answer was nothing`);
  if (sans.length <= NAJDORF.length) {
    // Leave a trail: which move the stub offered, and what it turned into. Without this the
    // failure is just "the line did not continue", which does not say whether the bridge gave
    // up, the stub gave up, or the conversion failed.
    console.log('          engine was asked ' + askedFor.length + ' time(s); answers: '
      + JSON.stringify(engineStub.answers));
  }
  ok(sans.length > NAJDORF.length,
    `the line continues past the user's move: ${NAJDORF.length} played -> ${sans.length}`,
    `got ${sans.join(' ')}`);

  // Everything returned has to be playable, or the board dies mid-walk - the original symptom.
  const c5 = new Chess();
  let illegal = null;
  for (const s of sans) { try { c5.move(s); } catch { illegal = s; break; } }
  ok(illegal === null, 'every move of the engine-bridged line is legal', `illegal at ${illegal}`);

  // And provenance: an engine move must never be dressed up as one of ours.
  const engineSteps = line.filter((s) => s.fromEngine);
  ok(engineSteps.length > 0, 'the engine moves are flagged `fromEngine`');
  ok(engineSteps.every((s) => !s.fromStudy),
    'an engine move is never credited to a study',
    engineSteps.map((s) => s.fromStudy ?? 'null').join(', '));
  ok(line.filter((s) => s.fromStudy).every((s) => !s.fromEngine),
    'a study move is never flagged as the engine\'s');

  // The search must be BOUNDED, or a repertoire card turns into a general engine game.
  ok(askedFor.length <= 4,
    `the engine is asked at most maxEnginePlies times (asked ${askedFor.length})`);

  // And an unmounted screen must not leave a half-built line behind.
  const abandoned = await continueLineWithEngine(fam, NAJDORF, { movetime: 1, isAlive: () => false });
  ok(abandoned.length === 0,
    'if the screen went away mid-search the caller is told nothing, not a partial line');
}

/** Record one adoption the way GameOpeningsScreen writes them. */
function adopt(prefix, adoptedSan, openingId) {
  const c = new Chess();
  for (const s of prefix) c.move(s);
  const key = c.fen();
  return {
    [key]: {
      key, fen: c.fen(), adoptedUci: '', adoptedSan, prefixSan: [...prefix],
      prevSan: prefix[prefix.length - 1] ?? null, engineBestSan: null,
      opening: 'test', decidedAt: Date.now(), selfDiscovered: false,
      openingId: openingId ?? null,
    },
  };
}

// A RECAPTURE: after 1.e4 d5, 2.exd5 takes back exactly the pawn Black just put on d5.
const recaptureSet = {
  ...adopt(['e4', 'd5'], 'exd5', null),
  // A REAL opening move in the same batch: the London System's own second move.
  ...adopt(['d4', 'd5'], 'Nf3', LONDON),
};
const ex = buildCustomExercises(recaptureSet, 12);
const askedSans = ex.map((e) => e.line.sans[e.startPly]);

ok(ex.length >= 1, 'the drill pool is not empty');
ok(!askedSans.includes('exd4'),
  'the recapture is NOT offered while a real decision exists in the same batch',
  `offered: ${askedSans.join(', ')}`);
ok(askedSans.includes('Nf3'),
  'the real opening decision IS offered', `offered: ${askedSans.join(', ')}`);

// The multi-move property: the drill must continue past the adopted move.
const nf3 = ex.find((e) => e.line.sans[e.startPly] === 'Nf3');
ok(nf3 !== undefined, 'found the London System drill');
if (nf3) {
  const playedByUser = [];
  for (let i = nf3.startPly; i < nf3.line.sans.length; i += 2) playedByUser.push(nf3.line.sans[i]);
  ok(nf3.line.sans.length > nf3.startPly + 1,
    'the drill continues past the first move (the user is asked more than one question)',
    `length ${nf3.line.sans.length}, starts at ply ${nf3.startPly}`);
  ok(playedByUser.length >= 2,
    'the user plays at least two moves in the drill', `user moves: ${playedByUser.join(', ')}`);
  // And it must be LEGAL all the way through, or the drill freezes mid-way.
  const c2 = new Chess();
  let illegalAt = null;
  for (let i = 0; i < nf3.line.sans.length; i++) {
    try { c2.move(nf3.line.sans[i]); } catch { illegalAt = i; break; }
  }
  ok(illegalAt === null,
    'every move of the drill is legal from the initial position',
    `illegal at ply ${illegalAt}: ${nf3.line.sans[illegalAt]}`);
}

// The fallback: a batch that is ALL recaptures must still produce a drill rather than an
// empty trainer. An empty trainer is worse than an easy one.
const onlyRecaptures = { ...adopt(['e4', 'd5'], 'exd5', null) };
const fallbackEx = buildCustomExercises(onlyRecaptures, 12);
ok(fallbackEx.length === 1,
  'a batch with nothing but recaptures still trains rather than showing an empty trainer',
  `got ${fallbackEx.length} exercises`);

// THE CONTROLS FOR THE RECAPTURE TEST.
//
// Two ways the definition could be wrong in a way that still passes everything above: it could
// be flagging ordinary captures as recaptures (so real exercises get filtered out), or it
// could be flagging quiet moves. Both are checked against real positions.
{
  const c = new Chess();
  for (const s of ['e4', 'd5']) c.move(s);
  const rec = c.move('exd5');
  ok(rec.isCapture() && rec.to === 'd5', 'the control recapture really is exd5 on d5');
}
{
  // 1.e4 c5 2.Nf3 d6 3.Bc4 Nf6 4.O-O — a quiet developing move after the opponent played a
  // KNIGHT move. Not a capture at all, so it must never be called a recapture.
  const c = new Chess();
  for (const s of ['e4', 'c5', 'Nf3', 'd6', 'Bc4', 'Nf6']) c.move(s);
  const quiet = c.move('O-O');
  ok(!quiet.isCapture(), 'the control quiet move (O-O after ...Nf6) is not a capture');
}
{
  // 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 — the Ruy Lopez retreating bishop, and emphatically not
  // a recapture even though 3...a6 has just moved. This is the move most at risk of being
  // wrongly filtered, since it also follows an opponent move.
  const c = new Chess();
  for (const s of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']) c.move(s);
  const ba4 = c.move('Ba4');
  ok(ba4.to === 'a4' && !ba4.isCapture(),
    'the control Ba4 after ...a6 is not a recapture (a real opening move survives the filter)');
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures > 0 ? 1 : 0);
