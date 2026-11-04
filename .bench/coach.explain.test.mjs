/**
 * GATE — DOES THE COACH ACTUALLY EXPLAIN CHESS?
 *
 * The owner's request: *"do many tests on the coach (the offline coach and the
 * online coach with the little qwen model not the large one) and see whether it
 * really explains positions and games, strategies, endgames, tactics etc."*
 *
 * `coach.core` proves the wiring (one fact factory, one guard, one seam). This
 * gate asks the user's question directly, on concrete positions:
 *
 *   1. a position where material hangs — does it NAME the loose squares?
 *   2. structures — isolated/doubled/backward pawns, the Carlsbad, the bishop pair?
 *   3. endgames — does it identify the shape (K+P, rook) and give the method?
 *   4. a move — does it say why it was a blunder and name the better move?
 *   5. a whole game — opening, errors, turning point?
 *   6. the small Qwen layer — registry, grounded prompt, runtime routing, and the
 *      fallback when the model invents a move or is not loaded.
 *
 * Run: node .bench/coach.explain.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-coach-explain');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

const COACH_SRC = path.join(ROOT, 'src', 'lib', 'coach');
const FILES = [
  'board.ts', 'tables.ts', 'control.ts', 'features.ts', 'kb.ts', 'review.ts', 'san.ts',
  'facts.ts', 'guard.ts', 'template.ts', 'prompts.ts', 'coach.ts', 'llm.ts', 'topic.ts',
  'knowledge.ts', 'game.ts', 'endgame.ts', 'session.ts',
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
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 3000));
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
const emitted = (name) => path.join(BUILD_DIR, 'src', 'lib', 'coach', name);

const features = require(emitted('features.js'));
const factsMod = require(emitted('facts.js'));
const template = require(emitted('template.js'));
const prompts = require(emitted('prompts.js'));
const llm = require(emitted('llm.js'));
const session = require(emitted('session.js'));
const endgame = require(emitted('endgame.js'));
const game = require(emitted('game.js'));
const knowledge = require(emitted('knowledge.js'));

const KB = knowledge.COACH_KB;
const FactFactory = factsMod.FactFactory;
const ctxFor = (fen) => FactFactory.forPositionFen(fen, KB);
const factText = (ctx) => ctx.facts.map((f) => `${f.kind}:${f.text}`).join(' | ');
const has = (text, re) => re.test(text);

let checks = 0;
const failures = [];
function ok(cond, label, detail = '') {
  checks += 1;
  if (cond) { console.log(`  PASS  ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
}
const head = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

/* ================================================ 1. positions / tactics */

head('1. A POSITION: material, loose pieces and king safety are named');

{
  // Black's queen is on d5, attacked by the e4 bishop and undefended; White's
  // bishop on e4 is equally loose. A coach that cannot name d5 is not coaching.
  const fen = '4k3/8/8/3q4/4B3/8/8/4K3 b - - 0 1';
  const ctx = ctxFor(fen);
  const text = factText(ctx);
  ok(has(text, /up a queen for a bishop/), 'material is stated exactly', text);
  ok(has(text, /loose pieces: d5/), 'the hanging queen on d5 is named', text);
  ok(has(text, /loose pieces: e4/), 'and the loose bishop on e4', text);
  ok(has(text, /Black to move; endgame/), 'side to move and phase are stated', text);

  const narration = await template.TemplateNarrator.explainPosition(ctx);
  ok(has(narration, /Black to move/), 'the narration says whose turn it is');
  ok(has(narration, /d5/), 'and repeats the concrete square a student can look at', narration);
  ok(narration.length > 120, 'the explanation is a real paragraph, not a label');
}

/* ====================================================== 2. strategy */

head('2. STRATEGY: structures are recognised and their plans explained');

{
  const fen = '8/5pk1/6p1/8/8/5PK1/5P2/8 w - - 0 1';
  const report = features.analyzeFen(fen);
  ok(report.structureTags.includes('isolated_pawn_white_f'),
    'an isolated f-pawn is tagged', JSON.stringify(report.structureTags));
  ok(report.structureTags.includes('doubled_pawns_white_f'),
    'and the doubled f-pawns', JSON.stringify(report.structureTags));
  const text = factText(ctxFor(fen));
  ok(has(text, /isolated pawn on f2/), 'the isolated pawn is named on its square', text);
  ok(has(text, /doubled pawns/), 'and the doubled pawns', text);
}

{
  const fen = 'r4rk1/pp3ppp/2n1b3/2pp4/3P4/2N1P3/PP3PPP/R3K2R w KQ - 0 1';
  const report = features.analyzeFen(fen);
  const text = factText(ctxFor(fen));
  ok(report.structureTags.includes('carlsbad'), 'the Carlsbad structure is tagged',
    JSON.stringify(report.structureTags));
  ok(has(text, /Carlsbad structure/), 'and explained by name', text);
  ok(has(text, /backward/), 'the backward pawn on d5 is named', text);
  ok(has(text, /weak square for white/), 'a weak square is named with a severity', text);
  const narration = await template.TemplateNarrator.explainPosition(ctxFor(fen));
  ok(has(narration, /Carlsbad/), 'the narration teaches the structure the student is looking at', narration);
}

{
  // One side owns the bishop pair; the hook must fire (the starting position
  // must not, or the concept is taught at move one where it means nothing).
  const pairFen = '4k3/8/8/8/8/8/4B3/2B1K3 w - - 0 1';
  ok(FactFactory.hookTokens(features.analyzeFen(pairFen)).includes('bishop_pair'),
    'the bishop pair is a hook when only one side has it');
  ok(!FactFactory.hookTokens(features.analyzeFen(game.START_FEN)).includes('bishop_pair'),
    'and is NOT taught from the starting position');
  ok(has(factText(ctxFor(pairFen)), /up two bishops/), 'the material fact says it plainly');
}

/* ====================================================== 3. endgames */

head('3. ENDGAMES: the shape is identified and the method given');

{
  const kp = '8/8/4k3/8/4P3/4K3/8/8 w - - 0 1';
  const report = features.analyzeFen(kp);
  ok(endgame.describeShape(report).startsWith('endgame_kpk'),
    'king and pawn is identified', endgame.describeShape(report));
  ok(has(factText(ctxFor(kp)), /passed pawn on e4/), 'the passed pawn is named on e4');
  const lesson = endgame.endgameLessonFor(report, KB);
  ok(!!lesson, 'a matching endgame lesson is found');
  const method = lesson ? String(lesson.why ?? lesson.plan ?? '') : '';
  ok(/king/i.test(method), 'and its method talks about the king', method);

  const rook = '8/8/4k3/8/8/4K3/4P3/4R3 w - - 0 1';
  const rookReport = features.analyzeFen(rook);
  ok(endgame.describeShape(rookReport).startsWith('endgame_rook'),
    'the rook ending has its own shape', endgame.describeShape(rookReport));
  const rookLesson = endgame.endgameLessonFor(rookReport, KB);
  const rookMethod = rookLesson ? String(rookLesson.why ?? rookLesson.plan ?? '') : '';
  ok(/rook/i.test(rookMethod), 'and its method talks about the rook', rookMethod);
  ok(has(factText(ctxFor(rook)), /open files nearby/),
    'king danger counts the open files, not a vague "unsafe"', factText(ctxFor(rook)));
}

/* ====================================================== 4. a move */

head('4. A MOVE: why it was bad, and what was better');

{
  // 1.f3 e5 2.g4?? — the Fool's mate blunder. The engine preferred 2.d4.
  const mr = {
    moveNumber: 2,
    moverIsWhite: true,
    san: 'g4',
    uci: 'g2g4',
    fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2',
    fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2',
    isCapture: false,
    isCheck: false,
    grade: 'blunder',
    cpBefore: 0,
    cpAfter: -900,
    bestSan: 'd4',
    pvUci: [],
    wpLoss: 0.9,
  };
  const ctx = FactFactory.forMove(mr, KB);
  const text = factText(ctx);
  ok(has(text, /blunder/i), 'the grade is in the facts', text);
  ok(has(text, /d4/), 'and the engine preferred move, d4', text);
  const narration = await template.TemplateNarrator.explainMove(ctx, mr);
  ok(/blunder/i.test(narration), 'the narration says it was a blunder', narration);
  ok(/d4/.test(narration), 'and names the better move', narration);
}

/* ====================================================== 5. a game */

head('5. A GAME: opening, error counts and the turning point');

{
  const line = [
    { san: 'f3', uci: 'f2f3', white: true, grade: 'inaccuracy', before: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', after: 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1' },
    { san: 'e5', uci: 'e7e5', white: false, grade: 'best', before: 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1', after: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2' },
    { san: 'g4', uci: 'g2g4', white: true, grade: 'blunder', before: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2', after: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2' },
    { san: 'Qh4', uci: 'd8h4', white: false, grade: 'best', before: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2', after: 'rnbqkbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3' },
  ];
  const reviews = line.map((m, i) => ({
    moveNumber: Math.floor(i / 2) + 1,
    moverIsWhite: m.white,
    san: m.san,
    uci: m.uci,
    fenBefore: m.before,
    fenAfter: m.after,
    isCapture: false,
    isCheck: m.san === 'Qh4',
    grade: m.grade,
    cpBefore: m.grade === 'blunder' ? 0 : 20,
    cpAfter: m.grade === 'blunder' ? -900 : 20,
    bestSan: m.grade === 'blunder' ? 'd4' : null,
    pvUci: [],
    wpLoss: m.grade === 'blunder' ? 0.9 : 0,
  }));
  const counts = game.errorCounts(reviews);
  ok(counts.w.blunder === 1 && counts.w.inaccuracy === 1 && counts.b.blunder === 0,
    'the error counts are per side and per grade', JSON.stringify(counts));
  const ctx = game.forGame({ reviews, openingName: "King's Pawn Game", result: '0-1' }, KB);
  const text = factText(ctx);
  ok(has(text, /King's Pawn Game|opening/i), 'the opening is in the walkthrough facts', text);
  ok(has(text, /blunder/i), 'and the game-level error summary', text);
  const turning = game.turningPointPlies(reviews, 2);
  ok(Array.isArray(turning) && turning.length >= 1, 'a turning point is identified', JSON.stringify(turning));
  const narration = await template.TemplateNarrator.explainGame(ctx);
  ok(narration.length > 150, 'the game walkthrough is a real explanation', String(narration.length));
  ok(/blunder/i.test(narration), 'which names the blunder', narration);
}

/* ================================ 6. the small Qwen model layer */

head('6. THE ONLINE COACH: the small (0.5B) Qwen layer');

{
  const modelSrc = fs.readFileSync(path.join(COACH_SRC, 'model.ts'), 'utf8');
  const ids = [...modelSrc.matchAll(/id: '(qwen[^']+)'/g)].map((m) => m[1]);
  ok(ids[0] === 'qwen2.5-0.5b',
    'the SMALL model is the first entry in the picker', ids.join(', '));
  ok(ids.includes('qwen2.5-1.5b'), 'and the larger one is offered separately', ids.join(', '));
  ok(/Qwen2\.5-0\.5B-Instruct-GGUF/.test(modelSrc)
    && /qwen2\.5-0\.5b-instruct-q4_k_m\.gguf/.test(modelSrc),
    'the 0.5B entry points at the Qwen 2.5 0.5B Instruct GGUF');
  const smallBytes = Number(modelSrc.match(/id: 'qwen2\.5-0\.5b'[\s\S]{0,600}?bytes: (\d+)/)?.[1] ?? 0);
  const largeBytes = Number(modelSrc.match(/id: 'qwen2\.5-1\.5b'[\s\S]{0,600}?bytes: (\d+)/)?.[1] ?? 0);
  ok(smallBytes > 0 && largeBytes > smallBytes,
    'the "quick" model is the smaller download', `${smallBytes} vs ${largeBytes}`);
  ok(/ensureActiveModel/.test(modelSrc), 'the app can select the active model');
  const manager = fs.readFileSync(path.join(ROOT, 'src/components/CoachModelManager.tsx'), 'utf8');
  ok(/COACH_MODELS/.test(manager) && /startModelDownload/.test(manager) && /deleteModel/.test(manager),
    'the manager lists, downloads and deletes the models');
}

{
  const system = prompts.QwenPrompts.system();
  ok(/Use ONLY the provided facts/.test(system), 'the Qwen prompt forbids outside knowledge');
  ok(/Never invent moves/.test(system), 'and explicitly forbids inventing moves');
  ok(/only ever discuss chess/.test(system), 'and keeps the coach chess-only');

  const ctx = ctxFor('4k3/8/8/3q4/4B3/8/8/4K3 b - - 0 1');
  const prompt = prompts.QwenPrompts.explainPositionPrompt(ctx);
  ok(prompt.includes('VERIFIED FACTS'), 'the position prompt carries the verified facts');
  ok(prompt.includes('d5'), 'including the concrete loose square, so the model does not guess');
  ok(/material, structure/.test(prompt), 'and asks for the explanation the user wants');
  const hint = prompts.QwenPrompts.hintPrompt(ctx, 'Qxd5');
  ok(hint.includes('Qxd5') && /Do not suggest any other move/.test(hint),
    'a hint prompt names the engine move and forbids alternatives');
}

{
  const ctx = ctxFor('4k3/8/8/3q4/4B3/8/8/4K3 b - - 0 1');
  const grounded = 'Black is a queen up, and the white bishop on e4 is loose.';
  const goodRuntime = {
    label: 'Qwen2.5-0.5B · on device',
    ready: true,
    complete: async () => grounded,
  };
  const narrator = new llm.LocalModelNarrator(goodRuntime);
  ok(narrator.name.includes('0.5B'), 'the narrator reports the small model it is running');
  const answer = await narrator.explainPosition(ctx);
  ok(answer === grounded, 'a grounded draft is returned verbatim');

  const lyingRuntime = {
    label: 'Qwen2.5-0.5B · on device',
    ready: true,
    // A move that CANNOT be legal here (the d5 queen is blocked from h1 and
    // nothing else on the board plays it): the guard must reject the draft and
    // the deterministic template must answer instead.
    complete: async () => 'The winning idea is Qh1, which simply wins the bishop.',
  };
  const guarded = await new llm.LocalModelNarrator(lyingRuntime).explainPosition(ctx);
  ok(!guarded.includes('Qh1'), 'a hallucinated move is rejected and replaced', guarded);
  ok(/Black to move/.test(guarded), 'by the grounded template narration');

  const coldRuntime = { label: 'Qwen2.5-0.5B · on device', ready: false, complete: async () => grounded };
  const cold = await new llm.LocalModelNarrator(coldRuntime).explainPosition(ctx);
  ok(/Black to move/.test(cold), 'a model that is not loaded falls back to the offline coach');
  ok(session.attachRuntime(coldRuntime, 'qwen2.5-0.5b').includes('0.5B'),
    'attaching the small model makes it the active narrator');
  ok(session.coachSession().modelId === 'qwen2.5-0.5b',
    'and the session reports which model is loaded');
  session.attachRuntime(null);
  ok(session.coachSession().modelId === null
    && /Rulebook/.test(session.coachSession().narrator),
    'detaching returns to the offline rulebook');
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.log('FAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');