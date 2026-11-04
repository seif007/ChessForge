/**
 * THE MOMENTS FINALLY SAY SOMETHING — the celebration slot, and why it fires when it does.
 *
 * WHY THIS EXISTS
 * ===============
 * The profile has counted a day streak for a long time, and nothing in the app ever SAID so. A user
 * who trained today watched a small number on Home change and got nothing else: no moment, no
 * acknowledgement, and — because this is a habit app, not a scoreboard — no reason to come back
 * tomorrow. The opinions session asked for the missing half: an onboarding beat for the first
 * session ever, a visible streak loop after it, and a moment for the shapes a session can FINISH —
 * the line test, the last exercise of a train session, every line of a practice session.
 *
 * THE SHAPE THIS GATE HOLDS
 * -------------------------
 *   1. ONE SLOT, TWO RAISERS. `persistTrainResult` is the only code that computes the day streak,
 *      so it is the only code allowed to raise the streak event — under the exact test the streak
 *      maths uses. `completeSession` is the only raiser of the completion kinds, and the only code
 *      the screens call. Newest wins: a completion ABSORBS a pending streak moment (carrying the
 *      day and summing the XP), and a streak write that lands after a completion STAMPS the day
 *      onto it instead of replacing it — two constructs, one slot, and no ordering of the race can
 *      drop either moment.
 *   2. ONE CONSUMER. The banner reads the store and clears it, with one distinct copy per moment.
 *      No screen raises, schedules, or sizes a celebration, so none of them can claim a streak day
 *      that did not happen or invent an achievement figure of its own.
 *   3. ONE MOUNT, OVER EVERYTHING. AppShell renders it after the tab bar and every overlay, because
 *      React Native paints later siblings on top — the moment must not be buried under the screen
 *      that earned it. It is a banner and not a modal so it can never race a session summary for
 *      the same instant.
 *   4. THE MERGE IS NOT AN ASSERTION, IT IS TESTED. The one thing source pins cannot prove is what
 *      happens when the streak write and the session end land in the same tick — so section 4
 *      compiles the REAL store against a scripted database and drives the exact race.
 *
 * Run: node .bench/celebration.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Comments stripped, so a claim in a comment can never satisfy a claim about code. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
/** Whitespace collapsed, for the checks that measure a DISTANCE. */
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

const storeSrc = tight('src/lib/store.ts');
const bannerSrc = tight('src/components/CelebrationBanner.tsx');
const shellSrc = tight('src/components/AppShell.tsx');

// ---------------------------------------------------------------------------
head('1. THE STORE RAISES THE MOMENTS — THE DAY WHEN THE STREAK MOVES, THE COMPLETIONS WHEN A SCREEN ENDS');

ok(/export interface CelebrationEvent \{/.test(storeSrc),
  'the event shape lives with the store that raises it, so there is one definition of "a moment"');
ok(/export type SessionCelebrationKind = 'test' \| 'train' \| 'lines';/.test(storeSrc),
  'the three completions have their own kind vocabulary, separate from the two streak beats');
ok(/celebration: CelebrationEvent \| null;/.test(storeSrc),
  'the store carries the pending celebration; no screen has to remember to fire one');
ok(/clearCelebration: \(\) => set\(\{ celebration: null \}\),/.test(storeSrc),
  'and one action clears it, so the banner can always get out of the way');
ok(/completeSession: \(kind: SessionCelebrationKind, detail\?: string, xp\?: number\) => void;/.test(storeSrc),
  'the completion raiser is declared with its figure, so a screen never hand-rolls an event');

ok(/const streakBumped = stored\?\.lastActiveDate !== today;/.test(storeSrc),
  'the streak raise is decided by the SAME test the streak maths uses — a new day, or nothing');
ok(/kind: \(stored\?\.lastActiveDate == null \? 'first' : 'streak'\)/.test(storeSrc),
  'the first-ever scored session is told apart from a later day — that difference IS the onboarding beat');
ok(/xp: payload\.xp \|\| 0,/.test(storeSrc),
  "the streak banner's XP figure is the raising event's own gain, never the racy profile total");
ok(/\.\.\.\(streakBumped \? \{ celebration: stamped \?\? raised \} : \{\}\),/.test(storeSrc),
  'and it is raised under that condition, not unconditionally — the first session of a day '
  + 'celebrates, the second does not');
ok(/const stamped: CelebrationEvent \| null = pending != null && isSessionKind\(pending\.kind\)/.test(storeSrc)
  && /streakNote: true, n: Date\.now\(\)/.test(storeSrc),
  'a streak write that lands on a pending completion STAMPS the day onto it instead of replacing '
  + 'the moment the user just earned');

ok(/completeSession: \(kind, detail = '', xp = 0\) => set\(\(s\) => \{/.test(storeSrc),
  'the completion raiser is a store action, so the store remains the only event constructor');
ok(/xp: \(prev\?\.xp \?\? 0\) \+ xp,/.test(storeSrc),
  'a completion absorbs a pending moment and SUMS the XP a banner has not reported yet');
ok(/streakNote: prev != null && !isSessionKind\(prev\.kind\),/.test(storeSrc),
  'and it says so when the moment it absorbed was the day streak, rather than dropping the day');
ok(/streakDays: prev\?\.streakDays \?\? s\.profile\.streakDays,/.test(storeSrc),
  'the day it carries is the real streak day, either the absorbed one or the profile current');

/*
 * THREE CONSTRUCTORS, ON PURPOSE. The completion literal, the streak branch, and
 * `celebrate` (a game or a tournament was won). All three live in the store, so
 * no screen can hand-roll a banner — the architectural claim is "the store is
 * the only constructor", not "there are exactly two".
 */
ok((storeSrc.match(/celebration: \{/g) || []).length === 2
  && /celebration: stamped \?\? raised/.test(storeSrc)
  && /celebrate: \(kind, detail = ''\) => set\(\(s\) => \(\{/.test(storeSrc)
  && /celebration: \{\s*\n\s*kind,/.test(storeSrc),
  'CONTROL: every raiser is a store action — the completion, the day branch and `celebrate` — '
  + 'and no screen can construct an event');
ok(/type GlobalCelebrationKind = 'gamewin' \| 'champion'/.test(storeSrc),
  'the two victory moments are declared in the store, not invented by a screen');
ok((storeSrc.match(/celebration: null,/g) || []).length >= 2,
  'both the initial state and reset() clear it — wiping progress cannot resurrect a stale banner');

// The completions are raised from the three screens that finish a shape — nowhere else. The claim
// is architectural, so it is checked across the tree rather than at one call site.
function filesWith(needle) {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      if (fs.readFileSync(full, 'utf8').includes(needle)) {
        hits.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return hits.sort();
}
const callers = filesWith('completeSession');
ok(callers.join(', ')
  === 'src/components/screens/GameOpeningsScreen.tsx, src/components/screens/PracticeScreen.tsx, '
    + 'src/components/screens/TrainScreen.tsx, src/lib/store.ts',
  `CONTROL: only the three finishing screens (and the store) touch completeSession — got: ${callers.join(', ') || 'none'}`);
ok(/completeSession\('test',/.test(code('src/components/screens/GameOpeningsScreen.tsx')),
  'the line test raises its own moment when the queue empties');
ok(/completeSession\('train',/.test(code('src/components/screens/TrainScreen.tsx')),
  'the train session raises its moment when no exercise is left');
ok(/completeSession\('lines',/.test(code('src/components/screens/PracticeScreen.tsx')),
  'the practice session raises its moment when every line is done');
ok(/applyResult\(\{ type: 'opening', xp: XP_SESSION_BONUS, correct: 0, total: 0 \}\);[\s\S]{0,900}?completeSession\('lines'/
  .test(tight('src/components/screens/PracticeScreen.tsx')),
  'raised AFTER the result write, so the day that write may raise is absorbed into the completion, '
  + 'not the other way round');

// ---------------------------------------------------------------------------
head('2. THE BANNER SHOWS IT OVER THE SCREEN THAT EARNED IT, THEN GETS OUT OF THE WAY');

ok(/useAppStore\(\(s\) => s\.celebration\)/.test(bannerSrc),
  'the banner is a pure consumer of the store event');
ok(/useAppStore\(\(s\) => s\.clearCelebration\)/.test(bannerSrc),
  'and the only writer it holds is the clear action');
ok(/if \(!celebration\) return null;/.test(bannerSrc),
  'nothing renders while no event is pending, so it cannot sit invisibly over the app');
ok(/playEffect\('success'\)/.test(bannerSrc),
  'the moment gets its sound, through the same path every other success uses');
ok(/setTimeout\(\(\) => clear\(\), HOLD_MS\)/.test(bannerSrc),
  'and it hides itself — the user never has to dismiss it to reach the app');
ok(/pointerEvents="box-none"/.test(bannerSrc),
  'the wrapper takes no touches outside the card, so the screen underneath stays usable');
ok(!/\bModal\b/.test(bannerSrc),
  'CONTROL: it is deliberately NOT a modal, so it can never race a session summary for the same moment');

ok(/const \{ title, sub \} = copyFor\(celebration\);/.test(bannerSrc),
  'the copy comes from one mapper, so no branch can render the wrong moment');
ok((bannerSrc.match(/case '/g) || []).length === 7,
  'there is exactly one copy case per kind — seven moments, no default fallthrough');
ok(/case 'gamewin':/.test(bannerSrc) && /case 'champion':/.test(bannerSrc),
  'and the two victory moments have their own copy');
ok(/playTournamentWinSound\(\)/.test(bannerSrc),
  'winning a tournament plays the long fanfare rather than the short success chime');
/*
 * THE VICTORY RAISERS ARE THE SURFACES THAT FINISH A GAME OR AN EVENT.
 * `celebrate` must not be called from anywhere else, or a screen could claim a
 * win the game did not award.
 */
const celebrateCallers = filesWith('celebrate(')
  .filter((f) => f !== 'src/lib/store.ts');
ok(celebrateCallers.every((f) => [
  'src/components/screens/ArenaGameScreen.tsx',
  'src/components/screens/BotPlayScreen.tsx',
  'src/components/screens/TournamentScreen.tsx',
].includes(f)),
  `CONTROL: only the board and tournament screens raise a victory — got: ${celebrateCallers.join(', ') || 'none'}`);
ok(/case 'first':[\s\S]{0,260}?First session done!/.test(bannerSrc),
  'the onboarding beat keeps its copy');
ok(/case 'streak':[\s\S]{0,260}?Day \$\{e\.streakDays\} streak/.test(bannerSrc),
  'a surviving day names the streak it reached');
ok(/case 'test':[\s\S]{0,300}?Test complete!/.test(bannerSrc),
  'finishing the line test has its own voice');
ok(/case 'train':[\s\S]{0,300}?Training done!/.test(bannerSrc),
  'clearing a train session has its own — a passed test cannot read like a cleared session');
ok(/case 'lines':[\s\S]{0,300}?Lines complete!/.test(bannerSrc),
  'and finishing every line of a practice session has its own');
ok(/case 'test':[\s\S]{0,300}?e\.detail/.test(bannerSrc)
  && /case 'train':[\s\S]{0,300}?e\.detail/.test(bannerSrc)
  && /case 'lines':[\s\S]{0,300}?e\.detail/.test(bannerSrc),
  'the completion copy weaves in the screen-counted figure — the banner never invents one');
ok(/streakNote \? \([\s\S]{0,260}?Day \{celebration\.streakDays\} streak/.test(bannerSrc),
  'a completion that absorbed the day says so on its own line, so the streak beat is never lost');
ok(/\+{celebration\.xp} XP/.test(bannerSrc),
  'and the XP chip still reports only real XP');

// No screen raises or hosts a celebration of its own — the claim is architectural, so it is checked
// across the tree rather than at one call site.
function importsOfBanner(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { importsOfBanner(full, acc); continue; }
    if (!/\.tsx?$/.test(e.name)) continue;
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (rel === 'src/components/CelebrationBanner.tsx') continue;
    if (/from '@\/components\/CelebrationBanner'/.test(fs.readFileSync(full, 'utf8'))) acc.push(rel);
  }
  return acc;
}
const bannerImporters = importsOfBanner(path.join(ROOT, 'src')).sort();
ok(bannerImporters.length === 1 && bannerImporters[0] === 'src/components/AppShell.tsx',
  'CONTROL: exactly one module mounts or reaches the banner — AppShell — and no screen has its own '
  + `celebration plumbing (importers: ${bannerImporters.join(', ') || 'none'})`);

// ---------------------------------------------------------------------------
head('3. THE SHELL MOUNTS IT OVER THE TABS AND EVERY OVERLAY');

ok(/import \{ CelebrationBanner \} from '@\/components\/CelebrationBanner';/.test(shellSrc),
  'AppShell imports the banner');
ok(/<CelebrationBanner \/>/.test(shellSrc),
  'and renders it');
ok(shellSrc.indexOf('<CelebrationBanner />') > shellSrc.indexOf('<TabBar'),
  'after the tab bar and every overlay — later siblings paint on top in React Native, so the moment '
  + 'cannot be buried under the screen that just earned it');

// ---------------------------------------------------------------------------
head('4. THE SLOT MERGES THE DAY WITH THE SESSION — PROVEN ON THE COMPILED STORE');

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-celebration');
try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2021', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [path.join(ROOT, 'src', 'lib', 'store.ts')],
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

/*
 * THE DATABASE IS NOT WHAT THIS SECTION IS ABOUT. A scripted fake stands in for it so the exact
 * race under test — the async streak write of `applyResult` against the synchronous
 * `completeSession` of the same session end — is what actually runs, not something paraphrased.
 */
const fake = { today: '2026-10-19', yesterday: '2026-10-18', profileRow: null, writes: [] };
const db = {
  async getFirstAsync(sql) {
    if (/FROM Profile/.test(sql)) return fake.profileRow;
    return null;
  },
  async getAllAsync() { return []; },
  async runAsync(sql, ...args) { fake.writes.push([sql, args]); },
  async withTransactionAsync(fn) { await fn(); },
};
const dbStub = {
  getDatabase: async () => db,
  ensureProfile: async () => {},
  newId: () => `id_${fake.writes.length}`,
  todayString: () => fake.today,
  daysAgoString: () => fake.yesterday,
  SOLO: 'solo',
};

const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@/lib/db') return dbStub;
  /*
   * The store now scopes training progress by the active Lichess account, so it
   * reads that name at load. This gate is about the celebration slot, not
   * accounts: `null` means the legacy single-user pool, exactly as before.
   */
  if (request === '@/lib/lichessStore') return { loadActiveUsername: async () => null };
  if (request === 'expo-sqlite/kv-store') {
    return {
      default: {
        getItem: async () => null,
        setItem: async () => undefined,
        removeItem: async () => undefined,
      },
    };
  }
  if (typeof request === 'string' && request.startsWith('@/')) {
    return origLoad.call(this, path.join(BUILD_DIR, 'src', request.slice(2)), parent, isMain);
  }
  return origLoad.call(this, request, parent, isMain);
};

const storeMod = require(path.join(BUILD_DIR, 'src', 'lib', 'store.js'));
const useAppStore = storeMod.useAppStore;

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const resetStore = (profileRow) => {
  fake.profileRow = profileRow;
  useAppStore.setState({
    profile: { xp: 0, streakDays: 0, lastActiveDate: null, puzzleRating: 800, endgameRating: 800 },
    celebration: null,
  });
};
const state = () => useAppStore.getState();

// (a) the day's first session, with nothing else pending: the onboarding beat itself.
resetStore(null);
state().applyResult({ type: 'opening', xp: 25, correct: 0, total: 0 });
await flush();
let c = state().celebration;
ok(c && c.kind === 'first' && c.streakDays === 1 && c.xp === 25,
  'a fresh profile gets the onboarding beat with the payload own XP', JSON.stringify(c));
ok(fake.writes.some(([sql]) => /UPDATE Profile/.test(sql)),
  'and the profile write still happens alongside it');

// (b) THE RACE: the screen ends the session while the streak write is still in flight.
resetStore({ xp: 400, streakDays: 3, lastActiveDate: '2026-10-18', puzzleRating: 900, endgameRating: 900 });
state().applyResult({ type: 'opening', xp: 25, correct: 0, total: 0 });
state().completeSession('lines', '3 lines', 25);
await flush();
c = state().celebration;
ok(c && c.kind === 'lines',
  'the completion is what the banner shows — not the day counter it raced', JSON.stringify(c));
ok(c && c.streakDays === 4 && c.streakNote === true,
  'the day the write found is carried and said on its own line', JSON.stringify(c));
ok(c && c.xp === 25 && c.detail === '3 lines',
  'XP is neither double-counted nor dropped, and the count travels', JSON.stringify(c));

// (c) a streak moment is already waiting: the completion replaces it, with day and XP carried.
resetStore(null);
state().applyResult({ type: 'opening', xp: 40, correct: 0, total: 0 });
await flush();
c = state().celebration;
ok(c && c.kind === 'first', 'control: the streak moment is pending first', JSON.stringify(c));
state().completeSession('test', 'all 10 positions correct', 0);
c = state().celebration;
ok(c && c.kind === 'test' && c.streakNote === true && c.streakDays === 1 && c.xp === 40,
  'the completion absorbs the unseen streak moment — same day, summed XP', JSON.stringify(c));
ok(c && c.detail === 'all 10 positions correct', 'and carries the figure its screen counted');

// (d) two completions in a row: newest wins, XP sums, no false day note.
state().completeSession('train', '12 exercises solved', 25);
c = state().celebration;
ok(c && c.kind === 'train' && c.streakNote === false && c.xp === 65 && c.detail === '12 exercises solved',
  'a second completion replaces the first, summing what no banner has reported yet', JSON.stringify(c));

// (e) the second session of the same day: once/day still holds for the streak beat.
resetStore({ xp: 400, streakDays: 4, lastActiveDate: '2026-10-19', puzzleRating: 900, endgameRating: 900 });
state().applyResult({ type: 'opening', xp: 25, correct: 0, total: 0 });
await flush();
ok(state().celebration === null,
  'a later session of an already-counted day raises no streak banner');

// (f) and the completion still fires on that day, without pretending the streak moved.
state().completeSession('lines', '2 lines');
c = state().celebration;
ok(c && c.kind === 'lines' && c.streakNote === false && c.xp === 0 && c.streakDays === 4,
  'the completion fires on an already-counted day, honestly marked as not the streak', JSON.stringify(c));

// (g) clearing empties the slot.
state().clearCelebration();
ok(state().celebration === null, 'the banner can always get out of the way');

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures > 0 ? 1 : 0);
