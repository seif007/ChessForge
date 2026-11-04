/**
 * Coach bot gate — the opponent, the level, and the coaching during the game.
 *
 * What this proves, in the order the feature is used:
 *
 *   1. THE LEVEL IS REAL — every offered strength is inside the engine's
 *      UCI_Elo limiter, and the chosen value is the one sent to the engine on
 *      every move (not a label over one fixed opponent).
 *   2. THE MOVE IS LEGAL — the engine's UCI answer is converted to SAN on the
 *      actual position, including captures and mate, and an impossible answer
 *      is refused rather than played.
 *   3. THE HINT IS GROUNDED — the hint explanation is built around the move the
 *      engine actually chose; the model is asked about that move, and a draft
 *      that invents another move is replaced by the deterministic narration.
 *   4. THE CHAT STAYS CHESS-ONLY — the in-game path is `Coach.ask`, so an
 *      off-topic question gets the apology without waking the model.
 *   5. THE SCREENS ARE WIRED — Bots -> shell -> play keeps the chosen level,
 *      and the play screen shows the coach chat in coach mode.
 *
 * Run: node .bench/coachbot.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-coachbot');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

const COACH_SRC = path.join(ROOT, 'src', 'lib', 'coach');
const BOTS_SRC = path.join(ROOT, 'src', 'lib', 'bots');
const FILES = [
  'board.ts', 'tables.ts', 'control.ts', 'features.ts', 'kb.ts', 'review.ts', 'san.ts',
  'facts.ts', 'guard.ts', 'template.ts', 'prompts.ts', 'coach.ts', 'llm.ts', 'topic.ts',
  'knowledge.ts', 'game.ts', 'session.ts',
].map((f) => path.join(COACH_SRC, f)).concat([
  path.join(BOTS_SRC, 'types.ts'),
  path.join(BOTS_SRC, 'mimic.ts'),
  path.join(BOTS_SRC, 'play.ts'),
  path.join(BOTS_SRC, 'coachBot.ts'),
]);

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

const emitted = (...parts) => {
  const p = path.join(BUILD_DIR, 'src', 'lib', ...parts);
  if (!fs.existsSync(p)) { console.error('missing emitted module', p); process.exit(2); }
  return p;
};

const session = require(emitted('coach', 'session.js'));
const coachBot = require(emitted('bots', 'coachBot.js'));

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

async function main() {
  head('1. the chosen level is the level the engine is asked for');

  const levels = coachBot.COACH_LEVELS;
  const elos = levels.map((l) => l.elo);
  ok(levels.length >= 6, 'there is a real choice of strengths', `${levels.length} levels`);
  ok(elos.every((e) => Number.isInteger(e) && e >= 1400 && e <= 2850),
    'every offered level is inside the engine limiter (1400..2850)', JSON.stringify(elos));
  ok(new Set(elos).size === elos.length && elos.every((e, i) => i === 0 || e > elos[i - 1]),
    'the levels are distinct and ordered weakest to strongest', JSON.stringify(elos));
  ok(elos.includes(coachBot.DEFAULT_COACH_ELO),
    'the default level is one of the offered levels');

  const profile = coachBot.coachProfile(1800);
  ok(profile.name === 'Coach' && profile.rating === 1800 && profile.ratingLabel === 'Coach level',
    'the play screen sees the chosen level as the opponent',
    `${profile.name}/${profile.rating}/${profile.ratingLabel}`);

  const calls = [];
  const fakeAnalyse = async (fen, opts) => {
    calls.push({ fen, opts });
    return { bestMoveUci: 'e2e4', scoreCp: 20, mateIn: null, depth: 12, pvUci: ['e2e4'] };
  };

  const move = await coachBot.coachMoveFor(fakeAnalyse, START, 2000);
  ok(move?.decision.uci === 'e2e4' && move?.decision.san === 'e4',
    'the engine move becomes a legal SAN on the position', JSON.stringify(move?.decision));
  ok(calls[0]?.opts.elo === 2000 && calls[0]?.opts.multipv === 1,
    'the engine is limited to the chosen level and asked for one line',
    JSON.stringify(calls[0]?.opts));
  ok(typeof move?.decision.reason === 'string' && move.decision.reason.length > 5,
    'the move carries a reason for the board', move?.decision.reason);

  await coachBot.coachMoveFor(fakeAnalyse, START, 1400);
  ok(calls[1]?.opts.elo === 1400,
    'a different choice reaches the engine as a different limit',
    JSON.stringify(calls[1]?.opts));

  const none = await coachBot.coachMoveFor(
    async () => ({ bestMoveUci: null, scoreCp: null, mateIn: null, depth: 0, pvUci: [] }),
    START, 1600,
  );
  ok(none === null, 'an engine with no move does not produce a phantom move');

  const illegal = await coachBot.coachMoveFor(
    async () => ({ bestMoveUci: 'e2e5', scoreCp: 0, mateIn: null, depth: 5, pvUci: [] }),
    START, 1600,
  );
  ok(illegal === null, 'an illegal engine answer is refused rather than played');

  const capture = await coachBot.coachMoveFor(
    async () => ({ bestMoveUci: 'e4d5', scoreCp: 0, mateIn: null, depth: 5, pvUci: [] }),
    '4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', 1600,
  );
  ok(capture?.decision.san === 'exd5' && /takes the pawn/.test(capture.decision.reason),
    'a capture is named as a capture, not as an anonymous engine move',
    `${capture?.decision.san} — ${capture?.decision.reason}`);

  const mate = await coachBot.coachMoveFor(
    async () => ({ bestMoveUci: 'g7h7', scoreCp: null, mateIn: 1, depth: 5, pvUci: [] }),
    '7k/6Q1/6K1/8/8/8/8/8 w - - 0 1', 1600,
  );
  ok(mate?.decision.san === 'Qh7#' && /mate/.test(mate.decision.reason),
    'a mating move is announced as mate',
    `${mate?.decision.san} — ${mate?.decision.reason}`);

  head('2. the hint explains the move the engine actually chose');

  session.attachRuntime(null);
  const offline = await session.activeCoach().explainHint(START, 'e4');
  ok(offline.includes('e4'), 'the offline hint names the engine move', offline.slice(0, 140));
  ok(offline.length > 20, 'the offline hint says more than the move alone', offline.slice(0, 140));

  /*
   * THE EXACT COMPLAINT: 1.e4 e5 must not be called a closed centre, and the
   * hint must not tack on the Ruy Lopez regrouping or an opening Black never
   * played. These are full-answer checks, not just tag checks, because the
   * student reads the assembled paragraph.
   */
  const openCentre = await session.activeCoach().explainHint(
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'Nf3');
  ok(!/centre is closed/i.test(openCentre),
    '1.e4 e5 is not narrated as a closed centre', openCentre.slice(0, 220));
  ok(!/Ruy Lopez|Nbd2|Caro-Kann/i.test(openCentre),
    'the hint does not prescribe a plan or opening that is not on the board',
    openCentre.slice(0, 220));

  /*
   * HINTS DO NOT WAIT FOR THE MODEL.
   *
   * The engine move is already verified and the template arranges the position
   * facts around it; a local 1.5B round-trip only adds seconds of "thinking".
   * The spinner that prompted this test was real, but the repair is not a
   * shorter prompt — it is not calling the model at all. Chat and full
   * explanations still use it.
   */
  let modelCalls = 0;
  const fakeRuntime = {
    label: 'Fake model',
    ready: true,
    async complete() {
      modelCalls++;
      return 'The engine likes e4 here: it takes the centre e4 and opens lines for the pieces.';
    },
  };
  session.attachRuntime(fakeRuntime);
  const withModel = await session.activeCoach().explainHint(START, 'e4');
  ok(withModel.includes('e4'), 'the hint keeps the engine move', withModel.slice(0, 140));
  ok(modelCalls === 0,
    'the hint never calls the model, even when one is loaded', `calls ${modelCalls}`);

  session.attachRuntime({
    label: 'Unsafe model',
    ready: true,
    async complete() { return 'Play Nf6 and then Qh5 — that wins.'; },
  });
  const safe = await session.activeCoach().explainHint(START, 'e4');
  ok(safe.includes('e4') && !/Nf6|Qh5/.test(safe),
    'a hint cannot be contaminated by an ungrounded model draft', safe.slice(0, 140));

  session.attachRuntime(null);

  head('3. the in-game chat is still chess-only');

  let offTopicCalls = 0;
  session.attachRuntime({
    label: 'Counting model',
    ready: true,
    async complete() { offTopicCalls++; return 'I can help with that.'; },
  });
  const apology = await session.activeCoach().ask('Who won the 2022 World Cup?', START, []);
  ok(/chess/i.test(apology) && offTopicCalls === 0,
    'an off-topic question gets the apology without waking the model', apology);
  session.attachRuntime(null);

  head('4. the screens carry the level and show the coach chat');

  const botsSrc = read('src/components/screens/BotsScreen.tsx');
  const shellSrc = read('src/components/AppShell.tsx');
  const playSrc = read('src/components/screens/BotPlayScreen.tsx');

  ok(botsSrc.includes("import { COACH_BOT_ID, COACH_LEVELS, DEFAULT_COACH_ELO } from '@/lib/bots/coachBot'"),
    'the Bots screen offers the coach levels');
  ok(/COACH_LEVELS\.map\(/.test(botsSrc) && /onPlay\(COACH_BOT_ID, coachElo\)/.test(botsSrc),
    'picking a level starts the coach at that level');
  ok(shellSrc.includes('const [coachElo, setCoachElo]'),
    'the shell keeps the chosen level beside the game id');
  ok(/<BotPlayScreen[\s\S]{0,260}?coachElo=\{coachElo\}/.test(shellSrc),
    'the play screen receives the chosen level');
  ok(/coachElo != null \? `coach:\$\{coachElo\}` : botPlayId/.test(shellSrc),
    'a different level remounts the game instead of reusing the old opponent');

  ok(/coachElo != null[\s\S]{0,140}?await coachMoveFor\(/.test(playSrc),
    'coach mode uses the strength-limited engine move');
  ok(/await coach\.explainHint\(fen, hintSan\)/.test(playSrc),
    'a hint asks the coach to explain the engine move');
  ok(/await coach\.ask\(question, fen, coachHistoryRef\.current, gameAt\.history\(\)\)/.test(playSrc),
    'free chat goes through the chess-only coach with the game moves');
  ok(/await askCoach\('Hint, please\.', fresh\.san\)/.test(playSrc),
    'the lightbulb feeds the explanation into the same chat');
  ok(/<CoachGameChat[\s\S]{0,400}?onAsk=/.test(playSrc),
    'the play screen renders the in-game chat');
  ok(/<IconBtn[\s\S]{0,160}?label="Undo"[\s\S]{0,160}?<IconUndo/.test(playSrc),
    'undo is an icon button, not a text button');
  ok(/coachMode \? \(/.test(playSrc),
    'coach mode shows the chat instead of the stored-bot tuning card');

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

void main();
