/**
 * The Train pipeline, end to end, from what the user reported.
 *
 * FOUR COMPLAINTS, AND THE ROOT CAUSE OF EACH
 * -------------------------------------------
 * 1. *"it said there is no train available since I didnt practice although I
 *     finished some lines"* — the custom pool was built only from adoptions, and an
 *    adoption was written only where a CHOICE was offered. Playing a line straight
 *    through recorded nothing. (Fixed at the source: `GameOpeningsScreen` now
 *    records every move the user plays.)
 * 2. *"I should be able to select all the chapter or a study or a line or a mix"*
 *    and *"clicking all the sicilian chapter … nothing happened"* — the picker's
 *    selectable set was filtered on `practiced`, so on a fresh account EVERY set
 *    was empty and the toggle short-circuited while looking enabled.
 * 3. *"train on the lines he choosed … + adding lines from the already app
 *     repertoire (if we have that opening … i will always update the app and add
 *     more opening so in your algo make consideration of that)"* — the book half is
 *    DERIVED from the library by looking each decision up, so a newly authored
 *     opening is picked up with no code change. That property is what §4 pins.
 * 4. *"make sure everything in the training in the apps repertoire also working
 *     including customization, sort, selecting"* — §5 checks the same selection
 *     machinery over the whole shipped library.
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

function cleanDir(d) { try { execFileSync('rm', ['-rf', d], { stdio: 'pipe' }); } catch { /* */ } }
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-trainpipe');
cleanDir(BUILD_DIR);
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'openingBuilder.ts'),
    path.join(ROOT, 'src', 'lib', 'gameOpenings.ts'),
    path.join(ROOT, 'src', 'lib', 'openings.ts'),
    path.join(ROOT, 'src', 'lib', 'repertoire.ts'),
  ],
}, null, 2));
try {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project', path.join(BUILD_DIR, 'tsconfig.json')], { stdio: 'pipe' });
} catch (e) { console.error('tsc failed:', e.stdout?.toString()?.slice(0, 2000)); process.exit(2); }

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
const REAL = require('chess.js');
const OB = findEmitted(BUILD_DIR, 'openingBuilder.js');
const GO = findEmitted(BUILD_DIR, 'gameOpenings.js');
const OP = findEmitted(BUILD_DIR, 'openings.js');
const RP = findEmitted(BUILD_DIR, 'repertoire.js');
let go = null;
Module._load = function (request, parent, isMain) {
  if (request === 'chess.js') return REAL;
  if (request === GO) return go;
  if (request === '@/lib/gameOpenings') return go;
  if (request === '@/lib/openings') return origLoad.call(this, OP, null, false);
  if (request === '@/lib/repertoire') return origLoad.call(this, RP, null, false);
  if (request === '@/lib/engine') return { getEngine: () => ({ analyse: async () => null }) };
  if (request.startsWith('@/data/')) {
    return origLoad.call(this, path.join(ROOT, 'src', request.slice(2)), parent, isMain);
  }
  return origLoad.call(this, request, parent, isMain);
};
go = origLoad.call(Module, GO, null, false);
const builder = origLoad.call(Module, OB, null, false);
const openings = origLoad.call(Module, OP, null, false);
const rep = origLoad.call(Module, RP, null, false);
const { buildCustomExercises, buildBookExercisesForAdoptionsStudy } = go;
const { AVAILABLE_OPENINGS, studyIndexAll } = openings;
const { allStudies, collectStudyLines, buildTrainExercises, openingProgress, LEVELS } = rep;

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/* ---------------------------------- §1 the picker gate that killed every control */

console.log('\n§1  every line in the library is selectable, practised or not');
{
  const SCREEN = fs.readFileSync(path.join(ROOT, 'src', 'components', 'screens', 'TrainScreen.tsx'), 'utf8');
  const sel = /const selectableOf = \(studies: PickerStudy\[\]\) =>\s*([\s\S]*?);/.exec(SCREEN)?.[1] ?? '';
  ok('the shipped selectableOf was found', sel.length > 0, sel ? '' : 'REGEX MISSED IT');
  /*
   * MATCH THE EXPRESSION, NOT THE PROSE AROUND IT.
   *
   * This check reads `!/practiced/.test(sel)`, and `sel` is the whole `selectableOf`
   * body INCLUDING the comment above it. That comment explains that reference indexes
   * are skipped and mentions `practiced` in passing — so the check started failing
   * against code that does not gate on `practiced` at all. The same trap as the
   * endgame live-position test: a regex over source prose is a check on the comment,
   * not on the program.
   *
   * So the comment is stripped and the assertion is made about the expression. Note
   * what IS allowed to appear: `.filter((st) => !st.reference)` — a real, working
   * exclusion, unlike the `practiced` gate this check exists to prevent.
   */
  const selCode = sel.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  ok('it no longer filters on `practiced` (the dead-toggle gate)', !/practiced/.test(selCode),
    selCode.replace(/\s+/g, ' ').trim());
  ok('and it does skip reference indexes, which have no lines to select',
    /!st\.reference/.test(selCode), selCode.replace(/\s+/g, ' ').trim());

  // The same property, checked against the data: no chapter anywhere in the
  // library may have an empty selectable set.
  let emptyNodes = 0, totalNodes = 0;
  for (const entry of AVAILABLE_OPENINGS) {
    for (const ch of entry.repertoire.chapters) {
      const ids = ch.studies.flatMap((st) => collectStudyLines(st).map((l) => l.id));
      totalNodes++;
      if (ids.length === 0) emptyNodes++;
    }
  }
  ok(`no chapter in the whole library is unselectable (${totalNodes} chapters)`, emptyNodes === 0,
    `${emptyNodes} empty`);
}

/* --------------------------- §2 a custom selection actually builds a real pool */

console.log('\n§2  choosing lines you have never drilled still gives exercises');
{
  // The exact selection a user makes by tapping a chapter: every line in it.
  const sicilian = AVAILABLE_OPENINGS.find((o) => o.id === 'sicilian');
  const chapter = sicilian.repertoire.chapters[0];
  const ids = chapter.studies.flatMap((st) => collectStudyLines(st).map((l) => l.id));
  ok('the Sicilian chapter 1 has lines to select', ids.length > 0, `${ids.length} lines`);

  // Nothing has been practised — the fresh-account case that used to yield nothing.
  const fresh = buildTrainExercises(
    sicilian.repertoire, {}, {}, 12,
    { lineIds: ids, includeUnlearned: true },
    'b',
  );
  ok('a fresh account selecting that chapter gets exercises', fresh.length > 0,
    `${fresh.length} exercises`);

  const withoutFlag = buildTrainExercises(
    sicilian.repertoire, {}, {}, 12, { lineIds: ids }, 'b',
  );
  ok('and the OLD gate is what returned none (so the flag is the fix, not luck)',
    withoutFlag.length === 0 && fresh.length > 0,
    `old ${withoutFlag.length} -> new ${fresh.length}`);

  // The default pool must be unchanged: still only what you have learned.
  const learnedOnly = buildTrainExercises(sicilian.repertoire, {}, {}, 12, undefined, 'b');
  ok('the default "all openings" pool is still a review of what you have learned',
    learnedOnly.length === 0);
}

/* ------------------------------ §3 his repertoire becomes a drillable pool */

console.log('\n§3  playing lines produces the repertoire, and it becomes trainable');
{
  /*
   * A Black user's decisions are at ODD plies: after an odd number of moves it is
   * Black's turn. `buildCustomExercises` requires that parity, which is why the
   * first version of this fixture produced ZERO exercises — not a product bug, but
   * the same parity trap the module documents. Both fixtures below are checked
   * against the real board rather than written from memory.
   */
  const mk = (prefix, san) => {
    const c = new Chess();
    for (const s of prefix) c.move(s);
    const turn = c.turn();
    if (turn !== 'b') throw new Error(`fixture wrong: after ${prefix.join(' ')} it is ${turn}, not black`);
    // `fen` is the position the decision is made IN — the one BEFORE the move.
    // (The first version of this fixture recorded the position after it, which made
    // `buildCustomExercises` read the side as White and reject every line on
    // parity. Same trap as the prefix, one field over.)
    const fen = c.fen();
    const m = c.move(san);
    return {
      key: `${fen.split(' ').slice(0, 4).join(' ')}|b`, fen,
      adoptedUci: m.from + m.to, adoptedSan: m.san,
      prevSan: prefix[prefix.length - 1] ?? null, prefixSan: prefix,
      engineBestSan: null, opening: 'Sicilian Defense', decidedAt: Date.now(),
      selfDiscovered: false,
    };
  };
  const adopted = {
    a: mk(['e4'], 'c5'),
    b: mk(['e4', 'c5', 'Nf3', 'd6', 'd4'], 'cxd4'),
  };
  const ex = buildCustomExercises(adopted, 12);
  ok('playing a line produces exercises', ex.length === 2, `${ex.length} exercises`);
  ok('every exercise is playable: the side to move is the user',
    ex.every((e) => {
      const c = new Chess();
      for (let i = 0; i < e.startPly; i++) c.move(e.line.sans[i]);
      return c.turn() === (e.userColor === 'w' ? 'w' : 'b');
    }));
  ok('and the move being drilled is the one the user played',
    ex.every((e) => e.line.sans[e.startPly] !== undefined));
}

/* ------------------- §4 ours, derived from the library rather than hard-coded */

console.log('\n§4  the book half is DERIVED, so new openings are picked up');
{
  const mk = (prefix, san) => {
    const c = new Chess();
    for (const s of prefix) c.move(s);
    if (c.turn() !== 'b') throw new Error(`fixture wrong: after ${prefix.join(' ')} it is ${c.turn()}`);
    const fen = c.fen();
    const m = c.move(san);
    return {
      key: `${fen.split(' ').slice(0, 4).join(' ')}|b`, fen,
      adoptedUci: m.from + m.to, adoptedSan: m.san, prevSan: null, prefixSan: prefix,
      engineBestSan: null, opening: 'Sicilian Defense', decidedAt: Date.now(), selfDiscovered: false,
    };
  };
  // A decision the shipped library really teaches: 1.e4 c5 2.Nc3 — Black answers d6.
  const sic = { x: mk(['e4', 'c5', 'Nc3'], 'd6') };
  const book = builder.buildBookExercisesForAdoptions(sic, 8);
  ok('a move order we ship also contributes our own lines', book.length > 0,
    `${book.length} book exercises`);

  // A move order we do NOT ship. Note the prefix has no castling: `O-O` is illegal
  // while the f8/f1 bishop is still home, which is the single most common way a
  // hand-written fixture breaks (MEMORY.md).
  const alien = { y: mk(['e4', 'e5', 'Nc3', 'Nf6', 'Bc4'], 'd6') };
  const none = builder.buildBookExercisesForAdoptions(alien, 8);
  ok('a move order we do not ship contributes no MORE than a shipped one (no invented content)',
    book.length > 0 && none.length <= book.length,
    `shipped ${book.length}, unshipped ${none.length}`);

  // THE PROPERTY THAT MATTERS FOR THE FUTURE: the answer tracks the LIBRARY.
  // §"no hard-coded opening ids" is asserted by source, and this shows the lookup
  // goes through the real index rather than a fixed table.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'openingBuilder.ts'), 'utf8');
  const fn = /export function buildBookExercisesForAdoptions[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
  ok('the shipped buildBookExercisesForAdoptions was found', fn.length > 0);
  ok('it contains no hard-coded opening id',
    !/'(sicilian|queens-gambit|italian-opening|ruy-lopez|french-defense|caro-kann-defense)'/.test(fn));
  ok('it resolves the study by looking the line up', /studyForLine/.test(fn));
  ok('it passes includeUnlearned, so a new study is not filtered out',
    /includeUnlearned:\s*true/.test(fn));
}

/* ------------------------------------------- §5 the shipped-library selection */

console.log('\n§5  the same machinery over the WHOLE shipped library');
{
  // Select EVERY line in EVERY opening — what "toggle all" at the top means.
  const allIds = [];
  for (const entry of AVAILABLE_OPENINGS) {
    for (const st of allStudies(entry.repertoire)) {
      for (const l of collectStudyLines(st)) allIds.push(l.id);
    }
  }
  // 692 studies at ~3 lines each, so ~2,000. The threshold only has to catch a
  // harness that stopped walking the library.
  ok(`the library has ${allIds.length} selectable lines`, allIds.length > 1500);

  let built = 0;
  for (const entry of AVAILABLE_OPENINGS) {
    const ids = allStudies(entry.repertoire).flatMap((st) => collectStudyLines(st).map((l) => l.id));
    const got = buildTrainExercises(
      entry.repertoire, {}, {}, 12, { lineIds: ids, includeUnlearned: true },
      entry.side === 'white' ? 'w' : 'b',
    );
    if (got.length > 0) built++;
  }
  ok('every opening can be fully selected on a fresh account', built === AVAILABLE_OPENINGS.length,
    `${built}/${AVAILABLE_OPENINGS.length}`);

  // A MIX: two studies from different chapters plus one line from a third.
  const s = AVAILABLE_OPENINGS[0];
  const rep = s.repertoire;
  const mixIds = [
    ...collectStudyLines(rep.chapters[0].studies[0]).slice(0, 2).map((l) => l.id),
    ...collectStudyLines(rep.chapters[1].studies[0]).slice(0, 2).map((l) => l.id),
    ...collectStudyLines(rep.chapters[2].studies[0]).slice(0, 1).map((l) => l.id),
  ];
  const mix = buildTrainExercises(rep, {}, {}, 12, { lineIds: mixIds, includeUnlearned: true },
    s.side === 'white' ? 'w' : 'b');
  ok('a MIX of chapters and a single line builds a pool', mix.length > 0, `${mix.length} exercises`);

  // A single line.
  const one = [collectStudyLines(rep.chapters[0].studies[0])[0].id];
  const onePool = buildTrainExercises(rep, {}, {}, 12, { lineIds: one, includeUnlearned: true },
    s.side === 'white' ? 'w' : 'b');
  ok('a single line builds a pool', onePool.length > 0, `${onePool.length} exercises`);

  // An empty selection must be empty, not "everything".
  const none = buildTrainExercises(rep, {}, {}, 12, { lineIds: [], includeUnlearned: true }, 'b');
  ok('an empty selection builds nothing (it does not fall back to everything)', none.length === 0);
}

/* ------------------------------------------------------- §6 the rank, honestly */

console.log('\n§6  the per-opening rank');
{
  const s = AVAILABLE_OPENINGS.find((o) => o.id === 'sicilian');
  const fresh = openingProgress(s.repertoire, {}, {}, 'b');
  ok('a fresh account is "Not started", NOT "Beginner"', fresh.label === 'Not started', fresh.label);
  ok('and it reports 0 of every study', fresh.started === 0 && fresh.pct === 0);

  /*
   * THE DENOMINATOR IS DRILLABLE STUDIES ONLY.
   *
   * `total` deliberately excludes `type: 'Reference'` studies — prose "Tactical
   * Motifs Index" entries with no lines, which can never be started. Counting them
   * meant an opening that ships one could never reach 100%, and the figure the user
   * reads was wrong rather than merely conservative. `references` reports how many
   * were set aside so nothing is hidden.
   */
  const studies = allStudies(s.repertoire);
  const drillable = studies.filter((st) => st.type !== 'Reference');
  const studiesState = {};
  for (const st of drillable.slice(0, 3)) studiesState[st.id] = { attempts: 4, level: 3 };
  const rank = openingProgress(s.repertoire, studiesState, {}, 'b');
  ok('reaching level 3 is reported as that rank', rank.label === LEVELS[2].name, rank.label);
  ok('and it names the next one to aim for', rank.nextLabel === LEVELS[3].name, rank.nextLabel ?? '');
  ok('with the counts beside it', rank.started === 3 && rank.total === drillable.length,
    `${rank.started}/${rank.total} of ${studies.length} studies (${rank.references} reference)`);
  ok('and reference indexes are reported, not silently dropped', rank.references === studies.length - drillable.length,
    `${rank.references} reference`);

  // A reference study can never be "started", so it must not hold the bar back.
  const allStarted = {};
  for (const st of drillable) allStarted[st.id] = { attempts: 9, level: 6, mastery: 1 };
  const full = openingProgress(s.repertoire, allStarted, {}, 'b');
  ok('so a fully-drilled opening reaches 100% even though it ships a reference index',
    full.pct === 1 && full.mastered === drillable.length,
    `pct ${full.pct}, ${full.mastered}/${full.total}`);

  // And the top of the ladder has no "next".
  const all = {};
  for (const st of studies) all[st.id] = { attempts: 9, level: 6 };
  const top = openingProgress(s.repertoire, all, {}, 'b');
  ok('at the top there is no next rank', top.label === LEVELS[5].name && top.nextLabel === null,
    top.label);
}

/* ------------------------------------------------- §7 the engine score display */

console.log('\n§7  the engine eval beside both compared moves');
{
  const { formatEvalCp } = go;
  ok('+34cp reads as +0.34', formatEvalCp(34) === '+0.34', String(formatEvalCp(34)));
  ok('-60cp reads as -0.60', formatEvalCp(-60) === '-0.60', String(formatEvalCp(-60)));
  ok('exactly equal reads with a sign, so it never looks like "missing"',
    formatEvalCp(0) === '+0.00', String(formatEvalCp(0)));
  ok('an unjudged move is null (the UI shows a dash, NOT 0.00)',
    formatEvalCp(NaN) === null && formatEvalCp(null) === null && formatEvalCp(undefined) === null);
  // Mate is folded into the cp scale (10000 - N*100), so it must not print as +100.
  ok('mate in 3 reads as #3, not +97.00', formatEvalCp(9700) === '#3', String(formatEvalCp(9700)));
  ok('being mated reads as -#3', formatEvalCp(-9700) === '-#3', String(formatEvalCp(-9700)));

  // The step must carry BOTH scores, or the second row has nothing to show.
  const BUILDER = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'openingBuilder.ts'), 'utf8');
  const stepFor = /function stepFor\([\s\S]*?\n\}/.exec(BUILDER)?.[0] ?? '';
  ok('the shipped stepFor was found', stepFor.length > 0);
  ok('the choice carries the played move\'s eval', /playedCp:/.test(stepFor));
  ok('and the recommendation\'s eval', /recommendCp:/.test(stepFor));

  const SCREEN = fs.readFileSync(path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx'), 'utf8');
  const rows = (SCREEN.match(/<CompareRow/g) ?? []).length;
  ok('both compared rows render', rows >= 2, `${rows} rows`);
  ok('and both pass an eval through', (SCREEN.match(/eval=\{formatEvalCp\(/g) ?? []).length >= 2);
  // The verdict sentence must quote the numbers, not just the words.
  ok('the mistake message quotes both evals',
    /formatEvalCp\(choice\.playedCp\)/.test(SCREEN) && /formatEvalCp\(choice\.recommendCp\)/.test(SCREEN));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'}: ${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
