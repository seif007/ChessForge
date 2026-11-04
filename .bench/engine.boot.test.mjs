/**
 * GATE 1o — the engine must be able to recover from a failed boot, and a scan must never be silent.
 *
 * WHAT THIS EXISTS BECAUSE OF
 * ==========================
 * The report: *"i clicked on analyse games in stats, it doesnt show the progress of analysing and
 * then it stops without doing anything (no move quality in stats and no puzzles generated from my
 * games)"* — against an account holding 318 games, 20 of them analysed.
 *
 * Three faults stacked, and only the outermost was visible:
 *
 *   1. THE ENGINE NEVER BOOTED. `attach()` posted the `init` handshake exactly once, guarded by
 *      `bootSent`, and `init()` gave up on a single 20-second deadline. The device said:
 *
 *          [engine] init timed out after 20s - engine never reported ready
 *          [engine] no reply after 300ms + 30s for rnbqkbnr/... - returning a null eval
 *
 *      A WebView fetching a 7.3 MB wasm from a `file://` base fails for reasons that are not the
 *      code's fault — the page's message handler not yet registered when `onLoadEnd` fires, a
 *      WebView process reclaimed under memory pressure, a slow first read off disk. Lose the one
 *      `init` and nothing ever retried, so the engine stayed dead for the whole session. Anyone who
 *      downloads this app can hit it; it is not specific to this device.
 *
 *   2. A DEAD `init()` RESOLVED ANYWAY, so every `analyse()` was queued to a host that would never
 *      answer, burned its full 30-second timeout, and returned a null eval.
 *
 *   3. THE FAILURE WAS INVISIBLE. `scanGame` returns null when it cannot evaluate a move, and
 *      `runGameScan` counted that in `summary.failed` — which no screen ever read. `onGame` fired
 *      only on success, so with every game failing nothing called back at all: no progress row, no
 *      error, no puzzles, no move quality. "Stops without doing anything" is exactly what a silent
 *      total failure looks like from the outside.
 *
 * WHICH IS WHY THESE CHECKS ARE MOSTLY ABOUT ABEHAVIOUR THAT MUST BE TRUE
 * -----------------------------------------------------------------------
 * Every assertion here is about the app being able to TELL SOMEONE. A build that cannot name its
 * own failure is a build that fails the same way twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Comments stripped, so a claim in a comment can never satisfy a claim about code. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
/**
 * And whitespace collapsed, for the checks that measure a DISTANCE.
 *
 * `code()` blanks a comment but keeps its length, so a `{0,400}` window can be spent entirely on
 * spaces and fail against working code. Collapsing makes a character budget mean characters of code.
 */
const tight = (p) => code(p).replace(/[ \t]+/g, ' ');

let checks = 0;
let failures = 0;
function ok(cond, label, detail) {
  checks += 1;
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    if (detail) for (const l of String(detail).split('\n')) console.log(`          ${l}`);
  }
}
const head = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

const engineSrc = tight('src/lib/engine.ts');
const scanSrc = tight('src/lib/gameScan.ts');
const statsSrc = tight('src/components/screens/StatsScreen.tsx');
const jobsSrc = tight('src/lib/statsJobs.ts');
const planSrc = tight('src/lib/scanPlan.ts');
const hostSrc = tight('src/components/EngineHost.tsx');
const appShellSrc = tight('src/components/AppShell.tsx');

// ---------------------------------------------------------------------------
head('1. THE BOOT HANDSHAKE IS RETRIED, NOT ATTEMPTED ONCE');

// The one-shot guard is the defect, so it has to be gone. `attach` posting `init` behind a plain
// `if (!this.ready)` with no retry in reach is exactly the shape that shipped.
ok(!/attach\(host: WebViewHandle \| null\): void \{[\s\S]{0,400}bootSent = true;[\s\S]{0,200}postMessage/.test(engineSrc),
  'CONTROL: attach() no longer posts init as a single unguarded one-shot',
  'attach() still posts init directly rather than through a retrying path');

ok(/private bootAttempts = 0;/.test(engineSrc), 'the engine counts boot attempts');
ok(/BOOT_MAX_ATTEMPTS/.test(engineSrc), 'and the number of attempts is bounded');
ok(/private postBoot\(\): void \{[\s\S]{0,600}?postMessage\(JSON\.stringify\(\{ cmd: 'init' \}\)\)/.test(engineSrc),
  'the handshake is posted from one place, so every attempt goes through it');
ok(/this\.bootAttempts\+\+/.test(engineSrc), 'each attempt increments the counter');

// A retry that re-boots over a live search is the bug `bootSent` was originally added to prevent:
// the host treats `init` as a fresh boot and clears its own search state, so the in-flight request
// would never be answered.
ok(/if \(this\.running\) \{[\s\S]{0,120}?armBootRetry\(\)/.test(engineSrc),
  'a retry is skipped while a search is in flight, and re-arms itself to try again');
ok(/if \(this\.stopping\) \{[\s\S]{0,400}?this\.pump\(\)/.test(engineSrc),
  'CONTROL: the abandon-and-continue path still exists (an aborted search releases the pipeline)');

// Giving up must be LOUD and must leave `ready` false, so a caller can tell "booted" from "gave up".
ok(/console\.error\(\s*`\[engine\] the engine did not start after/.test(engineSrc),
  'exhausting the retries logs an error naming the cause');
/*
 * This used to assert the literal `resolve?.(); return;` of an inline give-up branch. That branch is
 * gone: releasing a pending `init()` is now `settleInit()`, the single place one is allowed to end,
 * and `engine.init.test.mjs` (GATE 1p) proves behaviourally that it actually settles — including
 * against a source where it does not. Asserting the new shape here keeps the two gates honest about
 * each other: 1p would still pass if `settleInit` stopped resolving, and 1o still notices if the
 * give-up stops calling it.
 */
ok(/bootAttempts >= ChessEngine\.BOOT_MAX_ATTEMPTS[\s\S]{0,900}?settleInit\(/.test(engineSrc)
  && /private settleInit\(reason: string\): void \{[\s\S]{0,900}?resolve\(\);/.test(engineSrc),
  'and still releases every waiter, via settleInit — the single place a pending init may end');

// A leaked retry timer would re-boot the engine after `destroy()`, i.e. after the WebView is gone.
ok(/destroy\(\): void \{[\s\S]{0,900}?bootTimer[\s\S]{0,120}?clearTimeout/.test(engineSrc),
  'destroy() clears the boot retry timer');

// ---------------------------------------------------------------------------
head('1b. THE HANDSHAKE MUST NOT DEPEND ON onLoadEnd');

/*
 * THE FAULT EVERYTHING ELSE WAS BUILT ON TOP OF.
 *
 * `onLoadEnd` was the ONLY thing that ever called `engine.attach(...)`, and on the device it does not
 * fire. The WebView is genuinely created — `RNCWebViewManagerImpl.createRNCWebViewInstance` is in
 * logcat — and the page is genuinely served, but no load-completion callback ever arrives. So:
 *
 *   attach() never ran  ->  the engine's `host` stayed null  ->  postBoot returned immediately on
 *   `!this.host`        ->  the `init` handshake was NEVER POSTED
 *                        ->  the engine never booted          ->  every analyse() timed out
 *
 * The log now says this outright: "init deadline of 25s passed with no "ready" (0 handshake(s)
 * sent)". That last number is the whole diagnosis — zero attempts means the question was never asked.
 *
 * From there every downstream fault was innocent and unreachable. It presented as a dead engine. It
 * was a handshake that was never sent.
 *
 * An early post is recoverable — the page queues what it cannot accept yet and the engine re-posts
 * every 6s. A post gated behind an event that may never arrive is not. So the mount path attaches
 * and `onLoadEnd` is only a second chance.
 */
ok(/useEffect\(\(\) => \{[\s\S]{0,600}?engine\.attach\(handle\)/.test(hostSrc),
  'CONTROL: the WebView is handed to the engine when it MOUNTS, so a missing onLoadEnd cannot stop '
  + 'the engine from ever being asked to boot');

ok(!/onLoadEnd=\{\(\) => engine\.attach\(ref\.current\)\}/.test(hostSrc),
  'CONTROL: onLoadEnd no longer passes ref.current straight through — a null handle there reads as '
  + '"the host went away" and tears down a boot that is working perfectly well');

ok(/onLoadStart=\{\(\) => console\.warn/.test(hostSrc) && /onLoadEnd=\{attachIfPresent\}/.test(hostSrc),
  'the page lifecycle is traced with console.warn, which survives release stripping where '
  + 'console.log does not — which is exactly why this fault was invisible in logcat');

ok(/console\.warn\('\[EngineHost\] wasm asset resolved:'/.test(hostSrc),
  'and so is the resolved asset URI, since the WebView cannot mount at all without it');

/* ---------------------------------------------------------------------------
head('1c. EVERY ENGINE-USING SCREEN GETS THE ENGINE');

/*
 * THE FAULT THAT MADE THE SCAN LOOK BROKEN.
 *
 * `AppShell` mounts the WebView host conditionally, on a hand-written condition. The condition was
 * written from the claim that "only three screens touch the engine - Analysis, Endgames and
 * Course", and it named Stats explicitly among the screens that do NOT.
 *
 * Stats calls `getEngine().init()` and then `analyse()` on every position of every game it scans.
 * It touches the engine more than any screen in the app.
 *
 * So the host was never mounted for Stats, and the failure had no failure in it:
 *
 *     init()  ->  postBoot() returns immediately, this.host is null
 *             ->  the init handshake is never posted
 *             ->  the engine never boots
 *             ->  every analyse() burns its timeout and returns a null eval
 *
 * The screen showed a progress bar and nothing else, and the engine page had nothing to report
 * because it had never been asked anything. It read as "the scan is broken" for long enough that
 * three separate fixes went into the scan, the depth, the progress reporting and the boot retry,
 * every one of them correct, and none of them reached the actual fault.
 *
 * Your openings had already been dropped from this same list once, for the same reason, and the
 * comment above it says in as many words that "a grep cannot answer that question". It was then
 * asked the same question again and gave the same wrong answer.
 *
 * So the roster below is checked in BOTH directions. A new screen that reaches the engine and is
 * not in `engineNeeded` fails the build, and so does a roster entry quietly removed from it.
 */
const ENGINE_CALL = /getEngine\(\)|\.analyse\(|\.bestMove\(|engine\.init\(/;

/**
 * Modules under src/ that reach the engine, excluding the engine itself and the host that owns it.
 *
 * Returns both kinds, because they carry different obligations:
 *   - a SCREEN is a user-facing surface, so it must be named in `engineNeeded` itself;
 *   - a LIBRARY is plumbing, so what matters is that some accounted-for screen reaches it.
 */
function engineUsersIn(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { engineUsersIn(full, acc); continue; }
    if (!/\.tsx?$/.test(e.name)) continue;
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (rel === 'src/lib/engine.ts') continue;             // the engine itself
    if (rel === 'src/components/EngineHost.tsx') continue; // it OWNS the host
    const body = fs.readFileSync(full, 'utf8');
    if (ENGINE_CALL.test(body)) acc.push(rel);
  }
  return acc;
}

const users = engineUsersIn(path.join(ROOT, 'src')).sort();
const screens = users.filter((u) => u.startsWith('src/components/screens/'));
const libs = users.filter((u) => !u.startsWith('src/components/screens/') && u !== 'src/components/AppShell.tsx');

/*
 * The roster is deliberately explicit rather than derived: deriving it from the same grep is what
 * produced the wrong answer in the first place. What the gate adds is the second direction - every
 * screen in it must still be reachable from `engineNeeded`, every screen found using the engine must
 * be in it, and every engine-using library must be reachable from one of those screens.
 */
const ROSTER = [
  // screen / module                       the condition that mounts the host for it
  ['screens/AnalysisScreen.tsx', "tab === 'analysis'"],
  ['screens/EndgamesScreen.tsx', "tab === 'endgames'"],
  ['screens/CourseScreen.tsx', 'courseStudyId !== null'],
  /*
   * The bot game, not the Bots tab. The list and the builder never ask the
   * engine for anything; the opponent's move does — five MultiPV lines per
   * move — and a move only exists inside a game.
   */
  ['screens/BotPlayScreen.tsx', 'botPlayId !== null'],
  /*
   * Arena games auto-play bot turns. The lobby and tournament sheet do not
   * touch the engine; the board does, on every bot move and for the whole
   * bot-vs-bot match. AppShell mounts the host only while a game is open.
   */
  ['screens/ArenaGameScreen.tsx', 'arenaGameId !== null'],
  /*
   * "Your openings" has always run the engine INDIRECTLY (the family pass in
   * `lib/gameOpenings`), and since the stall view grew its Retry button it
   * reaches the engine directly too (`getEngine().restart`). AppShell has
   * mounted the host for `myOpeningsOpen` all along; this entry makes that
   * honest in the same direction the roster checks everything else.
   */
  ['screens/GameOpeningsScreen.tsx', 'myOpeningsOpen'],
];

for (const [mod, cond] of ROSTER) {
  const rel = `src/components/${mod}`;
  ok(screens.includes(rel), `CONTROL: ${mod} still reaches the engine, so its roster entry is honest`);
  ok(appShellSrc.includes(cond), `and AppShell mounts the engine host for it (\`${cond}\`)`);
}
/*
 * Stats no longer touches the engine in the screen: the scan is a module job in
 * `lib/statsJobs`. The host still has to be mounted for that job, and AppShell
 * mounts it on the Stats tab. Asserted separately so removing the screen from
 * the direct-engine roster cannot silently remove the mount condition too.
 */
ok(appShellSrc.includes("tab === 'stats'"),
  "AppShell still mounts the engine host for the Stats scan job");

// THE DIRECTION THAT FAILED: a screen reaches the engine and nothing in AppShell accounts for it.
const accounted = ROSTER.map(([m]) => m);
const orphanScreens = screens.map((s) => s.replace(/^src\/components\//, ''))
  .filter((s) => !accounted.includes(s));
ok(orphanScreens.length === 0,
  'CONTROL: every SCREEN that reaches the engine is named in `engineNeeded` — orphans: '
  + (orphanScreens.length ? orphanScreens.join(', ') : 'none'));

/*
 * And the plumbing has to be reachable from a screen that IS accounted for.
 *
 * One hop is not enough, and one hop is what a grep gives you: `gameOpenings` is reached through
 * `openingBuilder`, which is reached through a screen. That is precisely the shape that let "Your
 * openings runs the engine INDIRECTLY" be missed once already, so this walks the import graph to a
 * fixed point instead of trusting the first reference it finds.
 */
function resolveSpecifier(fromRel, spec) {
  let base;
  if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(ROOT, path.dirname(fromRel), spec);
  else return null; // a package, not our problem
  for (const cand of [base, base + '.ts', base + '.tsx',
    path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      return path.relative(ROOT, cand).replace(/\\/g, '/');
    }
  }
  return null;
}

const IMPORT_RE = /(?:from|require\()\s*['"]([^'"]+)['"]/g;

function reachableFrom(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const body = fs.readFileSync(abs, 'utf8');
    for (const m of body.matchAll(IMPORT_RE)) {
      const to = resolveSpecifier(rel, m[1]);
      if (to && !seen.has(to)) queue.push(to);
    }
  }
  return seen;
}

const reachable = reachableFrom([
  ...ROSTER.map(([m]) => `src/components/${m}`),
  'src/components/AppShell.tsx',
]);

for (const lib of libs) {
  ok(reachable.has(lib),
    `CONTROL: ${lib} is reachable from a screen AppShell already accounts for`);
}

/*
 * An analysis with no host must say so at the point of use.
 *
 * A dead engine used to be indistinguishable from a slow one: every call timed out and returned a
 * null eval, which reads as "this position is equal". Three rounds of fixes went into the wrong end
 * of the pipeline because nothing said "there is no engine here" at the moment it mattered.
 */
ok(/if \(!this\.host && !this\.reportedNoHost\) \{[\s\S]{0,900}?console\.error\(/.test(engineSrc),
  'asking for an analysis with no host logs an error naming the cause, not a timeout');

/*
 * The host must survive leaving the screen, or "you can leave this screen" is a lie.
 *
 * `engineNeeded` going false unmounts the host, and unmounting calls `engine.destroy()` — which kills
 * the WebView and resolves every in-flight search as null, mid-scan. The mount is therefore sticky
 * once needed, which keeps the memory optimisation for a user who never analyses anything while
 * making that promise true for everyone who does.
 */
ok(/engineEverNeeded/.test(appShellSrc) && /mountEngine = engineNeeded \|\| engineEverNeeded/.test(appShellSrc),
  'CONTROL: once needed, the engine host stays mounted — leaving the tab must not destroy the '
  + 'engine in the middle of a scan');
ok(/\{mountEngine \? <EngineHost \/> : null\}/.test(appShellSrc),
  'and it is that sticky flag which decides the mount, not the transient one');

/* --------------------------------------------------------------------------- */
head('2. A FAILED GAME IS NOT INVISIBLE');

ok(/onFail\?: \(done: number, total: number\) => void;/.test(scanSrc),
  'runGameScan offers a callback for a game it could not read');
ok(/summary\.failed\+\+;[\s\S]{0,1200}?opts\.onFail\?\.\(summary\.scanned \+ summary\.failed/.test(scanSrc),
  'and calls it when a game fails, with the same done/total a success would report',
  scanSrc.slice(scanSrc.indexOf('summary.failed++'), scanSrc.indexOf('summary.failed++') + 900));
ok(/onGame\?: \(game: ScanRecord/.test(scanSrc),
  'CONTROL: onGame is still success-only — the two callbacks must not be merged');

/*
 * PROGRESS MUST MOVE WHILE A GAME IS BEING READ, NOT ONLY WHEN ONE FINISHES.
 *
 * A game costs up to `maxPliesPerGame` engine searches — 120 by default at depth 10 — so one game
 * runs for MINUTES. The only progress callback the caller had was `onGame`, which fires when a game
 * is complete, so the screen sat unchanged for the whole of it. Measured on a phone: four minutes
 * with no bar, no count and no error, which reads as a hang and is indistinguishable from the
 * engine-dead failure above. The two defects look identical from the outside and have opposite
 * causes, which is why the fix has to be "keep telling the user", not only "stop failing".
 */
ok(/onPly\?: \(gameId: string, ply: number, totalPlies: number/.test(scanSrc),
  'runGameScan offers a callback for progress WITHIN a game');
ok(/onPly && ply > 0[\s\S]{0,80}?onPly\(ply, totalPlies\)/.test(scanSrc),
  'scanGame calls it while it loops over the moves');
ok(/ply > 0 && ply % PLY_PROGRESS_EVERY === 0/.test(scanSrc),
  'and throttles it — a setState per ply would be ~120 renders a minute for no extra information');
ok(/onPly: \(gameId, ply, totalPlies, done, total\) =>/.test(planSrc)
  && /Analysing game \$\{done \+ 1\} of \$\{total\}/.test(planSrc),
  'the scan says which game it is on and how far through it is');

// ---------------------------------------------------------------------------
head('5. A FAILED GAME MUST NOT BE WRITTEN OFF AS DONE');

/*
 * THE ONE THAT ACTUALLY MADE THE BUTTON DEAD, AND IT IS NOT THE ENGINE.
 *
 * `runGameScan` recorded a FAILED game as an empty placeholder in `records` — "so a resumed run does
 * not retry it for ever" — and skipped any game already present in `records`. Those two lines
 * together meant that one session with a dead engine permanently marked every game in the archive as
 * done. Every later run then skipped all of them instantly.
 *
 * Measured on the device, after the engine was fixed and the scan made cheap and given per-ply
 * progress: the scan started, the button flipped to "Stop", NO progress appeared, no error appeared,
 * the screen still said "20 analysed", and the WebView sat at 0% CPU throughout — because there was
 * nothing left to do. The fixes were all correct and none of them were reached, because the work had
 * been marked complete before they existed.
 *
 * It is also silent in a way that is worse than a crash: a skipped game increments `summary.skipped`,
 * not `summary.failed`, so not even the failure count the screen reports could see it.
 */
{
  ok(/const attempted = new Set<string>\(\)/.test(scanSrc),
    'games tried and failed this run are remembered for THIS RUN only');
  ok(/existing && existing\.depthReached > 0/.test(scanSrc),
    'a record only counts as done if it actually contains an analysis (depthReached > 0)');
  ok(!/summary\.failed\+\+;[\s\S]{0,400}?records\[game\.id\] = \{/.test(scanSrc),
    'CONTROL: no failure branch writes a placeholder record — a failure leaves nothing behind');
  ok(/if \(attempted\.has\(game\.id\)\) \{[\s\S]{0,80}?summary\.failed\+\+/.test(scanSrc),
    'so an unreadable game is not retried all run, but IS retried next time');

  // The progress row must exist from the tap, not from the first engine callback.
  ok(/setScanning\(true\);[\s\S]{0,400}?setProgress\(\{[\s\S]{0,120}?phase: 'Starting up…'/.test(statsSrc),
    "CONTROL: the progress row is set synchronously on the tap, before any await — the owner's "
    + "instruction was 'from the moment i type the button'");
}

// ---------------------------------------------------------------------------
head('5. YOUR OPENINGS DOES NOT CALL AN UNCHECKED LINE COMPLETE');

/*
 * THE SAME ENGINE, A SECOND SCREEN, AND THREE MORE REPORTS FROM ONE CAUSE.
 *
 * *"i completed a line in your openings but it gave me just one position for the test and thats it"*
 * *"it showed nothing to play then after a few time it says we are done while i didnt play anything"*
 * *"it never showed me a mistake or blunder of mine and shows me how to correct it. always a good
 * move of mine and suggests another good move"*
 *
 * One cause: the engine pass produced no verdicts, and the screen said nothing about it.
 *
 *   - a verdict is what puts a `choice` on a step, so `askablePositions` had almost nothing to ask
 *     about and the test came to one position;
 *   - a verdict is what sets `verdict`, so without it the user's move was never a mistake or a blunder
 *     and the recommendation was just another reasonable move;
 *   - and the pass's `finally` marked the family `engineChecked` on EVERY path, including the path
 *     where it had checked nothing. That made `enginePending` false, `awaitingVerdict` false and
 *     `done` true — a line the app had never examined, reported as finished.
 *
 * The third is the one a gate can hold: a screen must not be able to reach a "complete" state by
 * failing at the thing the state claims.
 */
{
  const openings = tight('src/components/screens/GameOpeningsScreen.tsx');
  ok(/const \[engineStalled, setEngineStalled\] = useState<string\[\]>\(\[\]\)/.test(openings),
    "the screen has a distinct state for 'checked nothing', rather than conflating it with 'checked'");
  ok(/sampleSize > 0 && accumulated\.size === 0/.test(openings),
    'a family that OFFERED positions and received none is recorded as stalled');
  ok(/awaitingVerdict = reachedEnd && decisionsInLine === 0 && \(enginePending \|\| engineStalledHere\)/.test(openings),
    'a stalled family still blocks `done`, so the line is never reported complete');
  ok(/engineStalledHere \? \([\s\S]{0,400}?The engine did not answer/.test(openings),
    'and the screen names the cause instead of showing a spinner for ever');
  ok(/if \(engineStalledHere\) \{[\s\S]{0,200}?The engine did not answer/.test(openings),
    'CONTROL: the test button declines to offer a one-position test, and says why');
}

// ---------------------------------------------------------------------------
head('3. THE SCREEN WAITS FOR THE ENGINE AND SAYS WHEN IT IS NOT THERE');

ok(/await getEngine\(\)\.init\(\);/.test(jobsSrc),
  'the detached scan waits for the engine before promising the user anything');
ok(/if \(!getEngine\(\)\.isReady\) \{[\s\S]{0,700}?throw new Error\(/.test(jobsSrc),
  'and refuses to start — with a message — when the engine is not up',
  'the scan can start with a dead engine');
ok(/did not start/.test(jobsSrc), 'the message names the actual fault rather than a generic failure');

// A run that fails entirely is the case that produced the report, so it gets its own sentence and
// must not be the same as "we skipped a couple".
ok(/r\.scanned === 0/.test(statsSrc),
  'a run where nothing at all could be analysed is told apart from a partial one');
ok(/games could be analysed/.test(statsSrc),
  'and the user is told in words, not by omission',
  'expected a sentence saying the games could not be analysed');
ok(/r\.failed > 0/.test(statsSrc),
  'partial failures are reported too, rather than counted and dropped');

// The button must not offer a scan that cannot work.
ok(/disabled=\{loading \|\| games\.length === 0\}/.test(statsSrc),
  'CONTROL: the button is still gated on having games to scan');

// ---------------------------------------------------------------------------
head('4. NOTHING ABOUT THIS IS A NEW SCREEN, A NEW FIELD, OR A NEW DEPENDENCY');

ok(/from '@\/lib\/engine'/.test(jobsSrc), 'getEngine comes from the one engine module');
ok(/r\.stopped/.test(statsSrc) && /complete: !summary\.stopped/.test(planSrc),
  'CONTROL: the interrupted-scan path is untouched, so a stopped scan still resumes');

// ---------------------------------------------------------------------------
head('5. THE ENGINE REPAIRS ITSELF — WATCHDOG, HONEST READY, AND A RETRY BUTTON');

/*
 * WHAT THIS SECTION EXISTS BECAUSE OF
 * ===================================
 * The round before this one ended with the same sentence printed on two screens: "Close the app and
 * open it again". It was true about the remedy — a rebuilt host is what fixes a dead engine — and
 * useless to the user holding the phone. Three repairs let the app do it itself, and each is pinned
 * at the level it can be checked:
 *
 *   1. THE HOST WATCHES ITS OWN SEARCHES. A search that never answered used to leave the host busy
 *      for ever: every later request was superseded, the app-side grace expired, and nobody said
 *      why. The host now arms a timer past the search's own budget (deliberately LONGER than the
 *      app's grace, so an engine that obeys the app's `stop` is never rebuilt mid-reply) and takes
 *      the same `markDead` path a crash takes.
 *   2. THE HOST STOPPED ANSWERING `ready` WITHOUT AN ENGINE. `initDone` was set by the FIRST
 *      `init` and never cleared by a failed boot, so after one `Stockfish()` throw every later
 *      handshake was answered with a lie and every search went into a page with no engine.
 *   3. THE USER CAN PRESS RETRY. `engine.restart()` releases waiters, tells the host to replace the
 *      engine, and re-posts the handshake; both screens with the old copy now call it.
 */
{
  const sfHostSrc = tight('src/engine/stockfish-host.js');
  const shippedHost = read('src/engine/assets.ts');
  const gameOpeningsSrc = tight('src/components/screens/GameOpeningsScreen.tsx');

  // (a) a search that never answers is a dead engine, not a slow one
  const hostGrace = Number((/var SEARCH_NO_REPLY_GRACE_MS = (\d+);/.exec(sfHostSrc) || [])[1] || 0);
  const appGrace = Number(String((/NO_REPLY_GRACE_MS = ([\d_]+)/.exec(engineSrc) || [])[1] || 0).replace(/_/g, ''));
  ok(appGrace === 8000, 'CONTROL: the app still gives every search its 8s of grace before giving up');
  ok(hostGrace > appGrace,
    `the host rebuilds only AFTER that grace has fully expired (host ${hostGrace}ms > app ${appGrace}ms), `
    + 'so an engine that honours `stop` a moment late is never killed mid-reply');
  ok(/searchOutstanding = true;[\s\S]{0,700}?searchWatch = setTimeout\(function \(\) \{[\s\S]{0,400}?markDead\('a search never answered'\)/.test(sfHostSrc),
    'a search that outlives its whole budget plus the grace is rebuilt, not waited on for ever');
  ok(/if \(line\.indexOf\('bestmove'\) === 0\) \{[\s\S]{0,400}?searchOutstanding = false;[\s\S]{0,400}?clearTimeout\(searchWatch\)/.test(sfHostSrc),
    'and an arriving `bestmove` disarms the watchdog, so a healthy engine is never rebuilt');

  // (b) `ready` means ready
  ok(!/initDone/.test(sfHostSrc),
    'CONTROL: the flag that answered `ready` without an engine is gone from the host entirely');
  ok(/if \(msg\.cmd === 'init'\)[\s\S]{0,1600}?if \(booting\) return;[\s\S]{0,400}?if \(engine\) \{[\s\S]{0,200}?engine\.postMessage\('uci'\)/.test(sfHostSrc),
    'an `init` with no engine rebuilds — or redoes the handshake when one exists but lost it — and '
    + 'never answers `ready` it cannot back');
  ok(/if \(ready\) \{[\s\S]{0,140}?send\(\{ type: 'ready' \}\);/.test(sfHostSrc),
    'and an `init` with a live engine still answers honestly');

  // (c) the host can be told to replace the engine
  ok(/if \(msg\.cmd === 'restart'\)[\s\S]{0,600}?markDead\('restart requested by the app'\)/.test(sfHostSrc),
    'the host replaces the engine on request instead of waiting for a crash');
  ok(/if \(booting\) \{[\s\S]{0,400}?restart skipped/.test(sfHostSrc),
    'and a restart during a boot is declined by name — that boot is already the fresh instance');

  // (d) the RN side of the retry
  ok(/restart\(reason: string\): void \{/.test(engineSrc),
    'the engine exposes restart() as the user-visible recovery');
  ok(/restart\(reason: string\)[\s\S]{0,4000}?this\.post\(\{ cmd: 'restart' \}\);/.test(engineSrc),
    'and it tells the host to replace the engine rather than only dropping its own waiters');
  ok(/restart\(reason: string\)[\s\S]{0,3000}?settleInit\('restarting the engine'\)/.test(engineSrc),
    'a caller awaiting the old engine is released, not left hanging on an instance being rebuilt');

  // (e) the wasm asset read survives a transient failure
  ok(/const WASM_ASSET_ATTEMPTS = 3;/.test(hostSrc),
    'the asset that must exist for the WebView to mount AT ALL is read with retries, not once');
  ok(/AppState\.addEventListener\('change'/.test(hostSrc),
    'and coming back to the foreground gets another attempt, because that is when a user tries again');
  ok(/retryTimer = setTimeout\(\(\) => void resolveAsset\(\), WASM_ASSET_RETRY_MS \* attempts\);/.test(hostSrc),
    'a failed attempt schedules the next one with a widening gap, instead of leaving the host empty');
  ok(/attempt \$\{attempts\}\/\$\{WASM_ASSET_ATTEMPTS\} failed/.test(hostSrc),
    'each failed attempt names its number, so the silent empty View cannot happen again');

  // (f) the buttons on the two screens that used to say "close the app"
  ok(/getEngine\(\)\.restart\('retry from the Stats scan'\)/.test(jobsSrc),
    'the scan job restarts the engine before giving up on it');
  ok(/getEngine\(\)\.restart\('retry from Your openings'\)/.test(gameOpeningsSrc),
    'Your openings restarts the engine from the stall view');
  ok(/label="Retry the engine"/.test(gameOpeningsSrc),
    'and offers a button that says so, instead of instructions about the app switcher');
  ok(/\[phase, openFamilyId, username, engineRetry\]/.test(gameOpeningsSrc),
    'the retry re-runs the engine pass for the family ON SCREEN, not whenever it is next opened');
  ok(!/Close the app and open it again/.test(statsSrc) && !/Close the app and open it again/.test(gameOpeningsSrc),
    'CONTROL: the app-reopen remedy is gone from both screens it used to be printed on');

  // (g) and the copy that SHIPS is the fixed one
  ok(shippedHost.includes('a search never answered') && shippedHost.includes("msg.cmd === 'restart'"),
    'the host inlined into assets.ts contains the watchdog and the restart command — the generator '
    + 'was re-run, so the APK cannot ship the old host');
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures > 0 ? 1 : 0);
