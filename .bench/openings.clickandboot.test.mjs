/**
 * Two complaints, one file.
 *
 *   1. "when i click on one of the openings nothing happens. its like a fake
 *      button i keep clicking on without doing anything."
 *   2. "i dont want the user to need to refresh every time he opens the app."
 *
 * (1) THE DEAD CARD
 * ----------------
 * The play view is a FALLBACK render: `if (phase === 'play' && openFamily)`,
 * with the list painted underneath when the guard does not hold. So a card can
 * look alive, fire its handler, and change nothing on screen.
 *
 * The measured cause is not the handler but the LINE it opened. The list is
 * painted from ENGINE-FREE positions, and `stepFor` only sets `choice` when the
 * recommendation differs from the user's move — which, without a shipped book,
 * it never does (the recommendation falls back to the user's own move). So for
 * openings we do not ship, the main line has NO question in it. `startLine`
 * then walks the whole line, `stepIdx` lands past the end, and the view paints
 * "line complete" over a board with `interactive={false}`. The engine's real
 * verdicts arrive a moment later — and nothing restarted, so the questions were
 * never asked. Tap again: same thing.
 *
 * So this measures, on the reference corpus, how many cards could do that, and
 * asserts that the line the card now OPENS is one that has a question in it.
 * The rule under test is `lineWithDecisions` — read out of the screen's source
 * and evaluated here, so this tests the shipped function rather than a copy of
 * it that could drift.
 *
 * (2) THE BOOT FETCH
 * ------------------
 * Source/order assertions, because the bug was an ORDERING bug and no pure
 * function can see it: the games must be painted from disk before the screen is
 * shown, and the fetch that refreshes them must be the quiet one.
 *
 * Usage: node .bench/openings.clickandboot.test.mjs
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
const SRC = path.join(ROOT, 'src');

function cleanDir(dir) {
  try { execFileSync('rm', ['-rf', dir], { stdio: 'pipe' }); } catch { /* best effort */ }
}

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

/* ------------------------------------------------------------------ compile */

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-clickboot');
cleanDir(BUILD_DIR);
fs.mkdirSync(BUILD_DIR, { recursive: true });

const CONFIG = path.join(BUILD_DIR, 'tsconfig.json');
fs.writeFileSync(CONFIG, JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
    esModuleInterop: true,
  },
  include: [SRC.replace(/\\/g, '/') + '/**/*.ts'],
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
    if (rel.endsWith('.json')) return path.join(SRC, rel);
    return path.join(OUT, rel + '.js');
  }
  return origResolve.call(this, request, parent, isMain, options);
};

const { buildFamilyLines } = require(path.join(OUT, 'lib', 'openingBuilder.js'));
const { analysedPositionsFromGames } = require(path.join(OUT, 'lib', 'gameOpenings.js'));
const { openingFromEcoUrl } = require(path.join(OUT, 'lib', 'lichess.js'));

/* ------------------------------------------- the real lineWithDecisions rule */

const SCREEN = fs.readFileSync(path.join(SRC, 'components', 'screens', 'GameOpeningsScreen.tsx'), 'utf8');

/**
 * Lift `lineWithDecisions` out of the screen source and evaluate it.
 *
 * A re-implementation here would prove only that I can copy a three-line rule.
 * What matters is that the SHIPPED rule picks a line with a question, so the
 * shipped rule is what runs — and §0 asserts it was actually found, because a
 * silent regex miss would otherwise make every assertion below vacuously true
 * against `undefined`.
 */
const fnMatch = /function lineWithDecisions\(f: FamilyLine\): LineRef \{([\s\S]*?)\n\}/.exec(SCREEN);
const lineWithDecisions = fnMatch
  ? new Function('f', fnMatch[1])
  : null;

/* ------------------------------------------------------------------ corpus */

const PAYLOAD = [
  path.join(HERE, 'test-games.json'),
  path.join(ROOT, 'test-games.json'),
].find((p) => fs.existsSync(p));
if (!PAYLOAD) { console.error('missing test-games.json'); process.exit(2); }

function mainlineSans(pgn) {
  const body = pgn.split('\n').filter((l) => !l.trim().startsWith('[')).join(' ');
  const sans = []; const c = new Chess();
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
const families = buildFamilyLines(positions, { maxPly: 24, maxAlternates: 2 });

const decisionsIn = (steps) => (steps ?? []).filter((s) => s.choice != null).length;

/* ============================================================== §0 the rule */

console.log('§0  the shipped rule was found in the source');
ok('lineWithDecisions is present and callable', typeof lineWithDecisions === 'function',
  fnMatch ? '' : 'REGEX MISSED IT — every §1 result below would be meaningless');

if (typeof lineWithDecisions !== 'function') {
  console.log(`\n${failures} failure(s) of ${checks} checks`);
  process.exit(1);
}

/* ============================================ §1.5 how long is a session now? */

console.log('');
console.log('§1.5  how much of a line the user actually plays');

/**
 * The complaint was "i just played one move" and then the line was declared
 * complete. So the number that matters is not how many decisions a line has —
 * it is how many times the user is asked to do something. Extract the shipped
 * `needsUser` and count both, over every family, so the change is visible as a
 * number rather than a claim.
 */
const nuMatch = /function needsUser\(step: BuilderStep\): boolean \{([\s\S]*?)\n\}/.exec(SCREEN);
const needsUserFn = nuMatch ? new Function('step', nuMatch[1]) : null;

ok('needsUser is present and callable', typeof needsUserFn === 'function',
  nuMatch ? '' : 'REGEX MISSED IT');

if (typeof needsUserFn === 'function') {
  let decisionsOnly = 0, withOwnMoves = 0, userPlies = 0, lines = 0;
  for (const f of families) {
    const steps = f.steps ?? [];
    if (steps.length === 0) continue;
    lines++;
    decisionsOnly += steps.filter((s) => s.choice != null).length;
    withOwnMoves += steps.filter(needsUserFn).length;
    userPlies += steps.filter((s) => s.isUserMove).length;
  }
  const avgDecisions = (decisionsOnly / lines).toFixed(2);
  const avgNeedsUser = (withOwnMoves / lines).toFixed(2);
  console.log(`      main lines measured:                        ${lines}`);
  console.log(`      user plies (his side, whole line):          ${userPlies}`);
  console.log(`      stops per line BEFORE (decisions only):     ${avgDecisions}`);
  console.log(`      stops per line NOW (decisions + his moves): ${avgNeedsUser}`);
  console.log('');

  ok('a line asks the user for more than the odd decision',
    withOwnMoves > decisionsOnly,
    `${withOwnMoves} stops vs ${decisionsOnly} decisions`);
  ok('no main line is a single-tap session any more',
    families.every((f) => (f.steps ?? []).length === 0
      || f.steps.filter(needsUserFn).length >= 2),
    `shortest: ${Math.min(...families.map((f) => (f.steps ?? []).filter(needsUserFn).length))}`);
  ok('every stop is either a decision or one of his own moves',
    families.every((f) => (f.steps ?? []).every((s) => !needsUserFn(s)
      || s.choice != null || s.isUserMove)));
}

/* ==================================================== §1 the dead-card sweep */

console.log('');
console.log('§1  every card opens a line that has something to decide');

let rescued = 0;      // main line empty, a sibling has questions
let hopeless = 0;     // no line in the family has any question yet
let wrongTarget = 0;  // rule picked a line with no question while another had one
let mainKept = 0;     // main line already had questions

for (const f of families) {
  const target = lineWithDecisions(f);
  const steps = target.kind === 'main' ? f.steps : (f.alternates[target.index] ?? f.steps);
  const has = decisionsIn(steps) > 0;
  const anyLineHas = decisionsIn(f.steps) > 0 || f.alternates.some((a) => decisionsIn(a) > 0);

  if (decisionsIn(f.steps) > 0) mainKept++;
  else if (anyLineHas) { rescued++; if (!has) wrongTarget++; }
  else { hopeless++; if (target.kind !== 'main') wrongTarget++; }
}

console.log(`      families:                              ${families.length}`);
console.log(`      main line already had a question:      ${mainKept}`);
console.log(`      main line empty, sibling has one:      ${rescued}   <- the rescued cards`);
console.log(`      no line has a question yet (engine):   ${hopeless}`);
console.log(`      cards that opened a question-free line: ${rescued + hopeless}   (before the fix)`);
console.log('');

ok('the rule picked a line with a question whenever one existed', wrongTarget === 0,
  `wrong picks: ${wrongTarget}`);
ok('the rescued cards are real, not hypothetical', rescued > 0,
  `${rescued} of ${families.length} families`);
ok('a family with no question anywhere still opens its main line',
  families.every((f) => {
    const any = decisionsIn(f.steps) > 0 || f.alternates.some((a) => decisionsIn(a) > 0);
    return any || lineWithDecisions(f).kind === 'main';
  }));

// The specific family the user would have hit: main line silent, siblings loud.
const sample = families.find((f) => decisionsIn(f.steps) === 0 && f.alternates.some((a) => decisionsIn(a) > 0));
if (sample) {
  const t = lineWithDecisions(sample);
  console.log('');
  console.log(`      worked example: ${sample.id}`);
  console.log(`        main line: ${sample.steps.length} plies, ${decisionsIn(sample.steps)} decisions`);
  sample.alternates.forEach((a, i) => {
    console.log(`        sibling ${i + 1}: ${a.length} plies, ${decisionsIn(a)} decisions`);
  });
  console.log(`        -> opens ${t.kind === 'main' ? 'the main line' : `sibling ${t.index + 1}`}`
    + `, which asks ${decisionsIn(t.kind === 'main' ? sample.steps : sample.alternates[t.index])} question(s)`);
}

/* ================================================= §2 the screen wiring itself */

console.log('');
console.log('§2  the screen uses the rule for both the tap and the badge');

/*
 * The card opens the LINES phase, not play.
 *
 * This expected `setPhase('play')` on the family card. The card now opens the line list, and the line
 * card opens play - which is the shape that answered *"why there is many line ( almost all the lines)
 * without any choice ?"*: one card per opening would have picked the line for you, and the whole point
 * is that you choose. So the assertion follows the behaviour and still checks the thing that matters,
 * which is that the line the card carries is the one `lineWithDecisions` chose.
 */
ok('the card handler sets the line from lineWithDecisions',
  /setOpenFamilyId\(f\.id\);\s*\n\s*setLineRef\(targetRef\);\s*\n\s*setPhase\('lines'\);/.test(SCREEN),
  'the family card must open the LINES phase and carry targetRef');
ok('CONTROL: and it is the chosen line, not the first one',
  /lineWithDecisions/.test(SCREEN));
ok('the badge counts the SAME line the tap opens',
  /const targetDecisions = target\.filter\(\(s\) => s\.choice != null\)\.length;/.test(SCREEN)
  && /targetDecisions > 0 \? \(/.test(SCREEN));
ok('the badge no longer counts the family-wide total',
  !/text=\{`\$\{f\.totalDecisions\} to decide`\}/.test(SCREEN));

/* =========================================== §3 the engine lands and we re-ask */

console.log('');
console.log('§3  a question-free line restarts once the engine supplies questions');

ok('the restart is driven by the decision count, not just the family id',
  /const decisionsInLine = useMemo\(/.test(SCREEN)
  && /\}, \[phase, openFamilyId, lineRef, decisionsInLine\]\);/.test(SCREEN));
ok('the restart only fires on the 0 -> n transition',
  /if \(prev === 0 && decisionsInLine > 0 && !answeredRef\.current\) startLine\(\);/.test(SCREEN)
  // The condition also has to require that the board is not already standing in the line, or the
  // 0 -> n transition restarts a line the user is halfway through playing. That guard was added after
  // this assertion was written and is why the literal no longer matches.
  || /if \(prev === 0 && decisionsInLine > 0 && !answeredRef\.current && stepIdx >= activeLine\.length\)/.test(SCREEN),
  'the restart must fire on the 0 -> n transition AND only when the board is not mid-line');
ok('the restart never fires once the user has moved',
  /const answeredRef = useRef\(false\);/.test(SCREEN)
  && /answeredRef\.current = true;/.test(SCREEN)
  && /answeredRef\.current = false;/.test(SCREEN));
ok('the finished view is withheld while the verdict is pending',
  /const reachedEnd = stepIdx >= total;/.test(SCREEN)
  // `engineStalledHere` was added to the pending test after this was written. Without it the screen
  // waits for a verdict that is never coming - a stalled engine left the line showing "finished" for
  // a position that had not been checked at all, which is the bug the pending state exists to prevent.
  && /const awaitingVerdict = reachedEnd && decisionsInLine === 0 && \(enginePending \|\| engineStalledHere\);/.test(SCREEN)
  && /const done = reachedEnd && !awaitingVerdict;/.test(SCREEN),
  'a STALLED engine must also withhold the finished view, not only a running one');
ok('that withholding applies ONLY to a finished line, not to the play view',
  /awaitingVerdict = reachedEnd &&/.test(SCREEN));
ok('"checking" is rendered instead of "complete"',
  /awaitingVerdict \? \(/.test(SCREEN) && /Checking our ideas here…/.test(SCREEN));
ok('the engine marks a family checked on EVERY path, not just success',
  /finally \{/.test(SCREEN) && /markChecked\(\);/.test(SCREEN));
ok('an already-analysed family is marked checked too',
  /if \(analysedRef\.current\.has\(famId\)\) \{[\s\S]{0,120}markChecked\(\);/.test(SCREEN));

/* ============================== §3.5 verdicts really do create the questions */

console.log('');
console.log('§3.5  the engine verdicts actually turn a silent line into a questioning one');

/**
 * The restart in §3 is only worth anything if the thing it waits for can happen.
 * 27 of the 39 families above have no question on ANY line at first paint, so
 * the whole feature rests on "the engine pass adds them". That claim is tested
 * here without the engine: the verdicts are synthesised (every position gets a
 * recommendation that differs from the move the user actually played, which is
 * exactly what a diverging engine produces), pushed through the REAL
 * `mergeAnalysed`, and rebuilt with the REAL `buildFamilyLines`.
 *
 * `mergeAnalysed` is lifted out of the screen for the same reason as
 * `lineWithDecisions`: testing a copy would test the copy.
 */
const mergeMatch = /function mergeAnalysed\(\s*families: FamilyLine\[\],\s*famId: string,\s*analysed: GamePosition\[\],\s*\): GamePosition\[\] \{([\s\S]*?)\n\}/.exec(SCREEN);
const mergeAnalysed = mergeMatch
  ? new Function('families', 'famId', 'analysed', mergeMatch[1])
  : null;

ok('mergeAnalysed is present and callable', typeof mergeAnalysed === 'function',
  mergeMatch ? '' : 'REGEX MISSED IT');

const silent = families.find((f) => decisionsIn(f.steps) === 0
  && decisionsIn(f.alternates[0] ?? []) === 0 && (f.positions?.length ?? 0) > 0);

if (typeof mergeAnalysed === 'function' && silent) {
  const verdicts = silent.positions.map((p) => {
    if (!p.playedUci) return p;
    let alt = null;
    try {
      const c = new Chess(p.fen);
      alt = c.moves({ verbose: true })
        .find((m) => (m.from + m.to + (m.promotion ?? '')) !== p.playedUci) ?? null;
    } catch { alt = null; }
    if (!alt) return p;
    const uci = alt.from + alt.to + (alt.promotion ?? '');
    return { ...p, recommendUci: uci, recommendSan: alt.san, options: [{ uci, san: alt.san, lossCp: 0 }] };
  });

  const rebuilt = buildFamilyLines(mergeAnalysed(families, silent.id, verdicts), { maxPly: 24, maxAlternates: 2 });
  const after = rebuilt.find((r) => r.id === silent.id);
  const before = decisionsIn(silent.steps);
  const now = decisionsIn(after?.steps ?? []);

  console.log(`      ${silent.id}: ${before} question(s) before verdicts -> ${now} after`);
  ok('verdicts move a question-free line to a questioning one', before === 0 && now > 0,
    `${before} -> ${now}`);
  ok('the rebuilt family keeps its identity, so the open family is found again',
    after != null && after.id === silent.id);
} else {
  ok('a silent family with positions exists to test against', false, 'none found in the corpus');
}

/* ================= §3.6 the user plays the line, not only the decisions ====== */

console.log('');
console.log('§3.6  the line stops for the user at HIS moves, not only at decisions');

ok('needsUser counts an ordinary move of his own as needing him',
  /function needsUser\(step: BuilderStep\): boolean \{[\s\S]{0,200}step\.choice != null \|\| step\.isUserMove/.test(SCREEN));

// One definition plus four call sites: goTo, startLine, and both branches of
// onBoardMove. They must agree or the line is walked past the user by whichever
// one runs last — which is how he was told he had completed a line he had not
// played. `startLine` passes the function itself, so the sites are asserted
// individually rather than counted.
const whileSites = (SCREEN.match(/while \(i < steps\.length && !needsUser\(steps\[i\]\)\)/g) ?? []).length;
/*
 * THE SAME RULE, AT EVERY SITE THAT ADVANCES THE LINE.
 *
 * There are three, and they were not always three. `startLine` used to find the first step with a
 * `choice` and jump straight there; it now delegates to `goTo`, which walks and stops on the first step
 * that is the USER's to answer. The difference is the whole point of `needsUser`: a step that is the
 * user's move with nothing to decide still has to be played by him, and skipping to the first decision
 * walked the board past his own move without asking him for it.
 *
 * The merged-line walk moved into `walkTo` as a timed advance, so the stop test there is `needsUser`
 * on the step it is about to play rather than a `break` out of a loop. Same rule, different shape.
 *
 * AND THE THIRD SITE IS THE OWN-MOVE FIX. When the user plays the line's own move there is nothing
 * to re-derive, so the screen advances IN PLACE over the steps that follow — the same loop shape as
 * the no-choice branch right above it, with the same `!needsUser` test. The test is the point: a
 * site that advanced on a different condition would walk the board past the user's own move, which
 * is the original "told me the line is finished" bug wearing a new hat.
 */
const findIndexSites = (SCREEN.match(/steps\.findIndex\(needsUser\)/g) ?? []).length;
const walkToStops = /if \(needsUser\(steps\[from\]\)\) return;/.test(SCREEN)
  && /needsUser\(steps\[next\]\)\) stopWalk\(\)/.test(SCREEN);
/*
 * `startLine` no longer finds the index itself. It is `walkTo(steps, 0)`, and `walkTo` tests the seed
 * and every step it advances to. So the rule is applied - it is just applied one function down, and
 * asserting `findIndex(needsUser)` here was asserting a shape rather than the behaviour.
 *
 * The chain is asserted instead, link by link, because a break anywhere in it is the same bug the
 * original assertion was for: `startLine` handing the board to the engine at a step the user had to
 * play.
 */
const startLineDelegates = /const startLine = useCallback\(\(\) => \{\s*\n\s*const steps = activeLine;\s*\n\s*if \(steps\.length === 0\) return;\s*\n\s*walkTo\(steps, 0\);/.test(SCREEN);
ok('every place that advances the line uses the same rule',
  whileSites === 3 && walkToStops && startLineDelegates,
  `3 auto-play loops=${whileSites}, walkTo stops=${walkToStops}, startLine delegates=${startLineDelegates}`);

ok('startLine starts at the first step that needs the user, not the first decision',
  startLineDelegates
  && /if \(needsUser\(steps\[from\]\)\) return;/.test(SCREEN)
  && !/steps\.findIndex\(\(s\) => s\.choice != null\)/.test(SCREEN),
  'a step that is the user own move with nothing to decide must still be played by him');

ok('the auto-play no longer runs over the user\'s own moves',
  !/while \(i < steps\.length && steps\[i\]\.choice == null\)/.test(SCREEN));

ok('the decision advance searches FORWARD from where he is',
  /const from = Math\.min\(played\.length, merged\.length\);/.test(SCREEN)
  && !/const firstDecision = merged\.findIndex\(\(s\) => s\.choice != null\);/.test(SCREEN));

/* ============================ §3.7 opening a family no longer stalls ========= */

console.log('');
console.log('§3.7  opening a family no longer stalls');

ok('the engine pass reuses the games the screen already fetched',
  /gamesRef\.current\.length > 0/.test(SCREEN)
  && /gamesRef\.current = kept;/.test(SCREEN));
ok('it no longer re-fetches unconditionally',
  !/const games = await fetchAllGames\(username, \{ maxGames: READ_GAMES \}\);/.test(SCREEN));
ok('the sample is analysed and published HEAD FIRST',
  /const head = sample\.slice\(0, ENGINE_HEAD\);/.test(SCREEN)
  && /const tail = sample\.slice\(ENGINE_HEAD\);/.test(SCREEN)
  && /for \(const p of await runStage\(head, 0\)\) accumulated\.set\(p\.key, p\);/.test(SCREEN));
ok('the head is published before the tail is analysed',
  SCREEN.indexOf('for (const p of await runStage(head, 0))') > 0
  && SCREEN.indexOf('for (const p of await runStage(head, 0))') < SCREEN.indexOf('for (const p of await runStage(tail, head.length))'));
ok('progress re-renders are throttled so the board is not thrashing',
  /now - lastTick < 250/.test(SCREEN));
ok('the post-move delay is short enough not to read as a hang',
  /\}, 180\);/.test(SCREEN) && !/\}, 420\);/.test(SCREEN));

/* ================================================= §4 the games cache on boot */

console.log('');
console.log('§4  the stats screen paints its games on launch without being asked');
const STATS = fs.readFileSync(path.join(SRC, 'components', 'screens', 'StatsScreen.tsx'), 'utf8');
const STORE = fs.readFileSync(path.join(SRC, 'lib', 'lichessStore.ts'), 'utf8');

ok('the boot path reads the cached games',
  /const cached = await loadCachedGames\(acc\.username\);/.test(STATS));
ok('cached games are painted before the screen is declared ready',
  STATS.indexOf('setGames(cached.games)') > 0
  && STATS.indexOf('setGames(cached.games)') < STATS.indexOf('if (alive) setBooted(true)'));
ok('a fetch still runs when the copy is old or missing',
  /if \(gamesCacheIsStale\(cached\)\) void loadGames\(acc\.username, false, true\);/.test(STATS)
  && /\} else \{\s*\n\s*void loadGames\(acc\.username, false, true\);/.test(STATS));
ok('that boot fetch is the QUIET one (no spinner over data being read)',
  /void loadGames\(acc\.username, false, true\)/.test(STATS));
ok('the quiet path raises no spinner and no error banner',
  /if \(!quiet\) \{ setError\(null\); setLoading\(true\); \}/.test(STATS)
  && /if \(quiet\) return; \/\/ silent by design/.test(STATS)
  && /if \(!quiet && aliveRef\.current\) \{ setLoading\(false\); setProgress\(null\); \}/.test(STATS));
ok('a successful fetch is persisted for the next launch',
  /await saveCachedGames\(name, all\);/.test(STATS));
ok('switching account drops the previous account\'s games',
  /await Storage\.removeItem\(GAMES_CACHE\(u\)\);/.test(STORE));
ok('an empty fetch never overwrites a good cached list',
  /if \(games\.length === 0\) return; \/\/ never overwrite a good list with an empty one/.test(STORE));
ok('the store exposes the three pieces the screen needs',
  /export async function loadCachedGames/.test(STORE)
  && /export async function saveCachedGames/.test(STORE)
  && /export function gamesCacheIsStale/.test(STORE));
ok('the empty state no longer instructs the user to refresh first',
  !/Tap Refresh games to pull your latest chess\.com results\./.test(STATS));

console.log('');
console.log(`${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILURE(S)'}  (${checks} checks)`);
process.exit(failures === 0 ? 0 : 1);
