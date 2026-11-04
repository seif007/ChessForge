/**
 * The background-job store and the screens that must keep using it.
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * The owner's report was not "a spinner is missing"; it was that long jobs
 * stopped when they left the page. The failure mode is structural: a promise
 * owned by a screen dies with the screen's progress, even when the native work
 * continues, and a returning mount cannot tell that work is still alive. The
 * only durable shape is a module-level job with observable state, which is what
 * `src/lib/background.ts` provides.
 *
 * These checks exercise the real store (not a copy) and then pin the four
 * call sites to it: model download, bot build, game refresh and the shared
 * engine scan/mine job. The source checks are deliberately about imports and
 * order, because the bug was exactly "the screen owns the work".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD = path.join(ROOT, 'node_modules', '.cache', 'chessforge-background');

try { execFileSync('rm', ['-rf', BUILD], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD, { recursive: true });
fs.writeFileSync(path.join(BUILD, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2021', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    esModuleInterop: true, rootDir: path.join(ROOT, 'src'), outDir: BUILD,
  },
  files: [path.join(ROOT, 'src', 'lib', 'background.ts')],
}, null, 2));
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project',
    path.join(BUILD, 'tsconfig.json'),
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 2000));
  process.exit(2);
}

const jobs = require(path.join(BUILD, 'lib', 'background.js'));

let checks = 0;
let failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`); }
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('\n[1] a job outlives its starter');

{
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let progressEvents = 0;
  let terminalStillRunning = null;
  const unsubscribe = jobs.subscribeJobs(() => {
    progressEvents++;
    const s = jobs.jobState('demo');
    if (s?.status === 'done') terminalStillRunning = jobs.isJobRunning('demo');
  });
  const promise = jobs.runJob('demo', 'Demo job', async ({ progress }) => {
    progress({ pct: 10, label: 'step one' });
    await gate;
    progress({ pct: 60, label: 'step two', indeterminate: true });
    return { answer: 42 };
  });
  // The caller (a screen) does nothing else. The job state already exists.
  const running = jobs.jobState('demo');
  ok(running?.status === 'running', 'the job is observable while its starter is gone');
  ok(running?.progress.pct === 10 && running?.progress.label === 'step one',
    'progress is published without any component state', JSON.stringify(running?.progress));
  release();
  const result = await promise;
  const done = jobs.jobState('demo');
  ok(result?.answer === 42 && done?.status === 'done' && done?.result?.answer === 42,
    'the result is retained after completion');
  ok(done?.progress.pct === 100 && done?.progress.label === 'Done',
    'completion publishes a terminal progress state');
  ok(progressEvents >= 4, 'subscribers were notified while the job ran', `events ${progressEvents}`);
  ok(terminalStillRunning === false,
    'the terminal state is published only after the job leaves the running map');
  unsubscribe();
  ok(jobs.isJobRunning('demo') === false, 'a finished job is no longer reported as running');
  jobs.clearJob('demo');
  ok(jobs.jobState('demo') === null, 'a consumed job can actually be cleared');
}

console.log('\n[2] one job id, one execution');

{
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const work = async () => { runs++; await gate; return 'one'; };
  const first = jobs.runJob('single', 'Single', work, { owner: 'alice' });
  const second = jobs.runJob('single', 'Single', work, { owner: 'alice' });
  ok(first === second, 'a second caller joins the same promise');
  const other = jobs.runJob('single', 'Single', work, { owner: 'bob' });
  ok((await other) === null, 'a different owner cannot steal the running result');
  release();
  await first;
  ok(runs === 1, 'the work function ran exactly once', `runs ${runs}`);
  jobs.clearJob('single');
}

console.log('\n[3] failure, cancellation and unknown jobs');

{
  const err = new Error('the network went away');
  const result = await jobs.runJob('bad', 'Bad', async () => { throw err; });
  const state = jobs.jobState('bad');
  ok(result === null && state?.status === 'error' && state?.error === err.message,
    'a thrown error is handed to the UI, not left as an unhandled rejection');
  ok(state?.errorData === err, 'the original error is retained for typed cases');
  jobs.clearJob('bad');
}
{
  const promise = jobs.runJob('cancel', 'Cancel', async ({ signal }) => {
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
    return 'never';
  });
  await tick();
  jobs.cancelJob('cancel');
  const result = await promise;
  const state = jobs.jobState('cancel');
  ok(result === null && (state?.status === 'cancelled' || state?.status === 'error'),
    'cancellation is observable and does not return a fake success', JSON.stringify(state));
  jobs.clearJob('cancel');
}
ok(jobs.jobState('never-started') === null, 'an unknown job has no invented state');
ok(jobs.isJobRunning('never-started') === false, 'an unknown job is not running');

{
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const promise = jobs.runJob('settle', 'Settle', async () => {
    await gate;
    return 'saved';
  });
  let settled = false;
  const waiting = jobs.waitForJob('settle').then(() => { settled = true; });
  await tick();
  ok(settled === false, 'waitForJob waits while the job is still running');
  release();
  await promise;
  await waiting;
  ok(settled === true && jobs.isJobRunning('settle') === false,
    'and settles only after the worker has left the running map');
  jobs.clearJob('settle');
}

console.log('\n[4] the four long workflows are module jobs, not screen promises');

const model = read('src/lib/coach/model.ts');
const manager = read('src/components/CoachModelManager.tsx');
const bots = read('src/components/screens/BotsScreen.tsx');
const botJob = read('src/lib/bots/buildJob.ts');
const stats = read('src/components/screens/StatsScreen.tsx');
const statsJobs = read('src/lib/statsJobs.ts');
const inline = read('src/components/GameImportInline.tsx');

ok(model.includes('COACH_MODEL_JOB') && model.includes('runJob<CoachModelJobResult>')
  && model.includes('downloadModel(def') && model.includes('loadModel(def)'),
  'the model download and load are one module job');
ok(manager.includes('useJob<CoachModelJobResult>(COACH_MODEL_JOB)')
  && !manager.includes('await downloadModel('),
  'the model card observes the job instead of owning the download');
ok(botJob.includes('runJob<BotBuildResult>') && botJob.includes('saveBot(profile)'),
  'the bot build saves its profile from inside the job');
ok(bots.includes('startBotBuild(') && bots.includes('useJob<BotBuildResult>(BOT_BUILD_JOB)')
  && !bots.includes('fetchLichessBotGames('),
  'Bots starts and observes the build job instead of fetching in the screen');
ok(statsJobs.includes('export function startScanJob')
  && statsJobs.includes('shouldStop: () => signal.aborted')
  && statsJobs.includes('export function startGamesRefresh'),
  'the scan and refresh are detached jobs with cooperative stop');
ok(stats.includes('startScanJob(') && stats.includes('useJob<ScanJobResult>(SCAN_JOB)')
  && stats.includes('startGamesRefresh(') && !stats.includes('importGames('),
  'Stats observes the shared scan and refresh instead of owning either');
ok(inline.includes('startScanJob(') && inline.includes('useJob<ScanJobResult>(SCAN_JOB)')
  && !inline.includes('importGames('),
  'the inline import card uses the same scan job');

console.log('\n[5] the page can be left without losing the downloaded games');

const loadStart = stats.indexOf('const loadGames = useCallback');
const loadBody = loadStart >= 0 ? stats.slice(loadStart, loadStart + 4500) : '';
const saveAt = loadBody.indexOf('await saveCachedGames(');
const aliveAt = loadBody.indexOf('if (!aliveRef.current) return;');
ok(saveAt >= 0 && aliveAt >= 0 && saveAt < aliveAt,
  'loadGames persists the downloaded list before checking whether the screen is mounted',
  saveAt >= 0 && aliveAt >= 0 ? `save +${saveAt} < alive +${aliveAt}` : '');

if (failures > 0) {
  console.error(`\n${checks - failures}/${checks} checks passed`);
  process.exit(1);
}
console.log(`\n${checks}/${checks} checks passed`);
