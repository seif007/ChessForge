/**
 * Coach app wiring gate — the Analyse screen's review shapes -> coach shapes,
 * the runtime swap seam, and the UI hooks that use them.
 *
 * Functional: compiles the real `src/lib/coach/*.ts` (adapter + session
 * included) and exercises `reviewFromAppMove`, `walkthroughFromAppReport` and
 * `attachRuntime` against a fake runtime. Source pins guard the panel/screen
 * wiring that cannot be executed here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-coach-app');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

const COACH_SRC = path.join(ROOT, 'src', 'lib', 'coach');
const FILES = [
  'board.ts', 'tables.ts', 'control.ts', 'features.ts', 'kb.ts', 'review.ts', 'san.ts',
  'facts.ts', 'guard.ts', 'template.ts', 'prompts.ts', 'coach.ts', 'llm.ts', 'topic.ts',
  'knowledge.ts', 'game.ts', 'app.ts', 'session.ts',
].map((f) => path.join(COACH_SRC, f));

fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2021', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    esModuleInterop: true, resolveJsonModule: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: FILES,
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

fs.mkdirSync(path.join(BUILD_DIR, 'src', 'data'), { recursive: true });
fs.copyFileSync(
  path.join(ROOT, 'src', 'data', 'coach_kb.json'),
  path.join(BUILD_DIR, 'src', 'data', 'coach_kb.json'),
);
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    return origLoad.call(this, path.join(BUILD_DIR, 'src', request.slice(2)), parent, isMain);
  }
  return origLoad.call(this, request, parent, isMain);
};

const emitted = (name) => {
  const p = path.join(BUILD_DIR, 'src', 'lib', 'coach', name);
  if (!fs.existsSync(p)) { console.error('missing emitted module', p); process.exit(2); }
  return p;
};

const app = require(emitted('app.js'));
const session = require(emitted('session.js'));
const reviewMod = require(emitted('review.js'));

let checks = 0;
let failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

/* ==================================================================== 0. source pins */
head('0. source pins — the screen wires the panel, the panel asks the live coach');

const analysisSrc = read('src/components/screens/AnalysisScreen.tsx');
const panelSrc = read('src/components/CoachPanel.tsx');
const modelSrc = read('src/lib/coach/model.ts');
const sessionSrc = read('src/lib/coach/session.ts');

ok(analysisSrc.includes("import { CoachPanel } from '@/components/CoachPanel'"),
  'the Analyse screen imports the coach panel');
ok(/<CoachPanel\b[\s\S]{0,260}?fen=\{boardFen \?\? viewFen\}[\s\S]{0,120}?move=\{exploring \? null : currentMove\}/.test(analysisSrc),
  'the panel gets the shown position and withholds a stale move while exploring');
ok(/pvUci: evals\[i\]\.lines\?\.\[0\]\?\.pvUci \?\? evals\[i\]\.pvUci \?\? \[\]/.test(analysisSrc),
  'the analysed move keeps the engine PV for the coach');
ok(/interface MoveAnalysis \{[^}]*pvUci: string\[\];/.test(analysisSrc),
  'MoveAnalysis carries the PV field');

ok((panelSrc.match(/activeCoach\(\)/g) ?? []).length >= 3,
  'the panel resolves the coach at press time, never captures an instance');
ok(panelSrc.includes('explainGame(walkthroughFromAppReport(report))'),
  'the whole-game button feeds the walkthrough');
ok(/ask\(q, fen, history, moves\)/.test(panelSrc),
  'follow-ups go through Coach.ask with the chat history and the moves actually played');
ok(panelSrc.includes('<CoachModelManager />') && panelSrc.includes('useCoachSession()'),
  'the model manager and the live tier are part of the panel');
ok(!panelSrc.includes('CHESS_ONLY_APOLOGY') && !panelSrc.includes('isChessRelated'),
  'the chess-only gate stays in the coach core, not duplicated in the view');

/*
 * THE BRAIN IS SHARED, NOT COPIED INTO EACH SCREEN.
 * A user who only opens Bots must be able to download it there; a download
 * started anywhere must relabel every open coach surface; and restoring it
 * must be single-flight so two mounts cannot load the weights twice.
 */
const botsSrc = read('src/components/screens/BotsScreen.tsx');
const chatSrc = read('src/components/CoachGameChat.tsx');
ok(botsSrc.includes('<CoachModelManager />'),
  'the Bots screen can download the coach brain without visiting Analyse');
ok(sessionSrc.includes('subscribeCoach') && sessionSrc.includes('coachSession()'),
  'narrator changes are observable by already-mounted screens');
ok(modelSrc.includes('restoreAttempt ??= restoreActiveModel()'),
  'restoring the saved model is single-flight across entry paths');
ok(modelSrc.includes('def.id,\n  );') || /attachRuntime\([\s\S]{0,160}?def\.id,/.test(modelSrc),
  'loading a model records its catalog id for the shared UI');
ok(!chatSrc.includes('chess only'),
  'the in-game chat header no longer advertises the rulebook tier');

ok(sessionSrc.includes('new LocalModelNarrator(rt)'),
  'attaching a runtime switches the narrator through the one seam');
ok(sessionSrc.includes('coach = rt ? createCoach(new LocalModelNarrator(rt)) : createCoach();'),
  'detaching returns to the offline default');

ok(/idempotent:\s*true,/.test(modelSrc),
  'a retried download overwrites its half-written file instead of failing');
ok(modelSrc.includes('f.size === def.bytes'),
  'a half-written weight file is not advertised as installed');
ok(modelSrc.includes('\n  attachRuntime(null);'),
  'unloading falls back to the template narrator');
ok(/if \(activeRuntime\(\) !== null\) return def\.id;/.test(modelSrc),
  'restoring twice in one run cannot re-init the context');
ok(!modelSrc.includes('n_gpu_layers: 99'),
  'the runtime ships CPU-only (OpenCL needs manifest entries this build does not add)');
ok(read('app.json').includes('expo-sqlite') && read('app.json').includes('expo-audio'),
  'the existing Expo plugin list is untouched by the model feature');

/* ==================================================================== 1. adapter */
head('1. reviewFromAppMove — the app review becomes a coach review');

const baseMove = {
  ply: 0, san: 'e4', uci: 'e2e4', mover: 'w',
  fenBefore: START, fenAfter: AFTER_E4,
  cpBefore: 20, cpAfter: 25, bestMoveSan: 'e4', bestMoveUci: 'e2e4',
  kind: 'best', drop: 0, pvUci: ['e2e4', 'e7e5'],
};

{
  const r = app.reviewFromAppMove(baseMove);
  ok(r.moveNumber === 1 && r.moverIsWhite, 'ply 0 maps to White\'s move 1', JSON.stringify(r));
  ok(r.fenBefore === START && r.fenAfter === AFTER_E4, 'both FENs survive');
  ok(r.grade === 'best' && r.bestSan === 'e4', 'grade and best move survive');
  ok(r.pvUci.join(' ') === 'e2e4 e7e5', 'the engine PV passes through');
  ok(r.uci === 'e2e4' && r.wpLoss === 0, 'uci survives and no drop yields no loss');
}

{
  const r = app.reviewFromAppMove({ ...baseMove, ply: 3, mover: 'b', san: 'exd5+', isCapture: undefined });
  ok(r.moveNumber === 2 && !r.moverIsWhite, 'ply 3 maps to Black\'s move 2');
  ok(r.isCapture && r.isCheck, 'capture and check are read from the SAN');
}

{
  const r = app.reviewFromAppMove({ ...baseMove, san: 'O-O', kind: 'brilliant' });
  ok(r.grade === 'best' && !r.isCapture && !r.isCheck, 'castling grades as best, no capture/check flags');
  ok(app.reviewFromAppMove({ ...baseMove, kind: 'miss' }).grade === 'mistake', 'miss narrates as a mistake');
  ok(app.reviewFromAppMove({ ...baseMove, kind: 'great' }).grade === 'excellent', 'great narrates as excellent');
  ok(app.reviewFromAppMove({ ...baseMove, kind: 'book' }).grade === 'book', 'book stays book');
}

{
  const r = app.reviewFromAppMove({ ...baseMove, cpBefore: 0, cpAfter: -300 });
  ok(Math.abs(r.wpLoss - 0.5028) < 0.01, 'a 300cp giveaway is about half the winning chances', String(r.wpLoss));
  ok(reviewMod.gradeFromWpLoss(r.wpLoss) === 'blunder', 'that drop grades as a blunder');
  const noise = app.reviewFromAppMove({ ...baseMove, cpBefore: 10, cpAfter: 40 });
  ok(noise.wpLoss === 0, 'a move that gains is never a loss');
}

{
  const r = app.reviewFromAppMove({ ...baseMove, pvUci: [] });
  ok(r.pvUci.join(' ') === 'e2e4', 'an empty PV falls back to the engine best move');
  const r2 = app.reviewFromAppMove({ ...baseMove, pvUci: [], bestMoveUci: null, bestMoveSan: null });
  ok(r2.pvUci.length === 0 && r2.bestSan === null, 'no engine move at all stays empty, not invented');
}

{
  const moves = [
    baseMove,
    { ...baseMove, ply: 1, mover: 'b', san: 'e5', uci: 'e7e5', kind: 'good', cpBefore: 25, cpAfter: 20 },
  ];
  const w = app.walkthroughFromAppReport({ moves, openingName: 'King\'s Pawn', result: '1-0' });
  ok(w.reviews.length === 2, 'every ply is forwarded to the walkthrough');
  ok(w.openingName === 'King\'s Pawn' && w.result === '1-0', 'the app-known opening and result survive');
  ok(w.reviews[1].moveNumber === 1 && !w.reviews[1].moverIsWhite, 'the second ply is Black\'s move 1');
}

/* ==================================================================== 2. session */
head('2. attachRuntime — the narrator swap and its fallback');

const answerFen = START;

async function main() {
  ok(session.activeCoach().narratorName === 'Rulebook (offline)',
    'with no runtime attached the coach narrates with the rulebook');

  let calls = 0;
  let mode = 'good';
  const fake = {
    label: 'Fake model · on device',
    ready: true,
    async complete(messages) {
      calls++;
      const user = messages[messages.length - 1]?.content ?? '';
      void user;
      if (mode === 'bad') return 'Play Nh6 immediately and you win.';
      return 'The king is safe enough for now, and the pawns decide the result.';
    },
  };
  const name = session.attachRuntime(fake);
  ok(name === 'Fake model · on device', 'attaching swaps the tier name shown in the UI', name);
  ok(session.activeRuntime() === fake, 'the attached runtime is the one later lookups see');

  const good = await session.activeCoach().ask('What should I aim for here?', answerFen, []);
  ok(good.includes('pawns decide the result'), 'a grounded draft reaches the student verbatim', good);
  ok(calls === 1, 'the runtime was actually asked');

  // The same fake now authors a hallucinated move; the guard must replace it.
  mode = 'bad';
  const bad = await session.activeCoach().ask('How do I win from this position?', answerFen, []);
  ok(!bad.includes('Nh6'), 'an ungrounded draft never reaches the student', bad);
  mode = 'good';

  let offTopicCalls = 0;
  const counting = { ...fake, async complete(m) { offTopicCalls++; return fake.complete(m); } };
  session.attachRuntime(counting);
  const apology = await session.activeCoach().ask('Who won the 2022 world cup?', answerFen, []);
  ok(/chess/i.test(apology) && offTopicCalls === 0,
    'an off-topic question gets the apology without waking the model', apology);

  const notReady = {
    label: 'Loading model · on device',
    ready: false,
    async complete() { throw new Error('must not be called while not ready'); },
  };
  session.attachRuntime(notReady);
  const fallback = await session.activeCoach().ask('How is the center going?', answerFen, []);
  ok(fallback.length > 20 && !fallback.includes('must not be called'),
    'a not-ready runtime falls back to the template narration', fallback.slice(0, 80));

  session.attachRuntime(null);
  ok(session.activeCoach().narratorName === 'Rulebook (offline)',
    'detaching returns to the offline narrator');
  ok(session.activeRuntime() === null, 'detaching clears the recorded runtime');

  /*
   * A SCREEN THAT IS ALREADY OPEN MUST RELABEL WHEN THE TIER CHANGES.
   * Without this subscription the Bots card could download a model while the
   * Analyse panel (or an in-game chat) kept showing the stale rulebook name.
   */
  let notices = 0;
  const unsubscribe = session.subscribeCoach(() => { notices += 1; });
  session.attachRuntime(fake);
  session.attachRuntime(null);
  unsubscribe();
  session.attachRuntime(fake);
  ok(notices === 2,
    'tier listeners fire on attach and detach, and stop after unsubscribe', String(notices));
  ok(session.coachSession().modelId === null,
    'a runtime attached without an id is not reported as an installed model');
  session.attachRuntime(null);

  /* ==================================================================== summary */
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

void main();
