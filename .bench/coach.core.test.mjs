/**
 * THE COACH MAY ONLY SAY WHAT THE ENGINE VERIFIED — and this gate holds every wire that keeps it honest.
 *
 * WHY THIS EXISTS
 * ===============
 * A chess coach that hallucinates is worse than no coach: "play Nd4" from a position where Nd4 is
 * impossible teaches the student a lie. The prototype (a 95-test Kotlin program) established the
 * contract and THIS port must keep it:
 *
 *   1. ONE FACT FACTORY. All chess verbalization happens in `facts.ts` from the positional analyzer
 *      (`features.ts`) and the knowledge base (`kb.ts`). Narrators never invent chess content.
 *   2. ONE GUARD. `guard.ts` rejects any concrete MOVE mention that is neither legal in the
 *      reference position nor quoted verbatim in the facts; the orchestrator and every LLM narrator
 *      route their draft through it, and a rejected draft becomes the deterministic template.
 *   3. ONE SEAM. `llm.ts` is the only file that may talk to a model (fetch) or declare the local
 *      runtime interface, so the whole feature is testable in Node with a fake runtime.
 *   4. CHESS ONLY. `topic.ts` answers non-chess questions with an apology BEFORE any narrator runs.
 *
 * The feature checks below are ports of the prototype's verified suite (FeaturesTest, KbTest,
 * CoachTest) — same FENs, same expectations — plus the new fallbacks (fake LLM runtime, stubbed
 * endpoint) and the whole-game walkthrough. The KB rows are cross-checked by REPLAYING their SAN
 * lines on chess.js and requiring the stored FEN to match exactly, which is how the kb.db positions
 * stay honest without shipping the prototype's move generator.
 *
 * Deviation from the prototype, deliberate: a rejected LLM draft does NOT prefix the user-facing
 * text with "[grounded fallback: ...]". The student gets the clean template narration; the
 * rejection is logged for the developer (`console.warn`) and asserted here.
 *
 * Run: node .bench/coach.core.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-coach-core');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

const COACH_SRC = path.join(ROOT, 'src', 'lib', 'coach');
const FILES = [
  'board.ts', 'tables.ts', 'control.ts', 'features.ts', 'kb.ts', 'review.ts', 'san.ts',
  'facts.ts', 'guard.ts', 'template.ts', 'prompts.ts', 'coach.ts', 'llm.ts', 'topic.ts',
  'knowledge.ts', 'game.ts',
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

/*
 * tsc rewrites nothing: emitted `knowledge.js` still requires '@/data/coach_kb.json'.
 * Map the alias onto the emitted tree and make sure the JSON is actually there —
 * the gate must exercise the REAL shipped data file, not a copy authored for the test.
 */
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

const board = require(emitted('board.js'));
const features = require(emitted('features.js'));
const kbMod = require(emitted('kb.js'));
const factsMod = require(emitted('facts.js'));
const guard = require(emitted('guard.js'));
const template = require(emitted('template.js'));
const prompts = require(emitted('prompts.js'));
const coachMod = require(emitted('coach.js'));
const llmMod = require(emitted('llm.js'));
const topicMod = require(emitted('topic.js'));
const knowledgeMod = require(emitted('knowledge.js'));
const gameMod = require(emitted('game.js'));
const chessjs = require(path.join(ROOT, 'node_modules', 'chess.js'));

let checks = 0;
let failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const sq = (name) => board.sqFromName(name);
const rep = (fen) => features.analyzeFen(fen);
const namesOf = (arr) => arr.map((x) => x.name).join(',');

/* ==================================================================== 0. source pins */
head('0. source pins — one factory, one guard, one seam, one default');

const coachSrc = read('src/lib/coach/coach.ts');
const llmSrc = read('src/lib/coach/llm.ts');
const topicSrc = read('src/lib/coach/topic.ts');

ok(coachSrc.includes('private readonly narrator: CoachNarrator = TemplateNarrator'),
  'the orchestrator defaults to the deterministic template narrator');
ok(coachSrc.includes('guardCheck(') && llmSrc.includes('guardCheck('),
  'both the orchestrator and the LLM narrators route drafts through the guard');
ok(!read('src/lib/coach/facts.ts').includes('fetch(') && !coachSrc.includes('fetch('),
  'the core never talks to a network — only llm.ts may');
ok(llmSrc.includes('export interface LocalChatRuntime'),
  'the local model plugs into one declared seam');
ok(prompts.QwenPrompts.system().includes('only ever discuss chess'),
  'the LLM system prompt carries the chess-only rule');
ok(topicSrc.includes('CHESS_ONLY_APOLOGY'), 'the apology copy lives here');
ok(read('src/lib/coach/knowledge.ts').includes("'@/data/coach_kb.json'"),
  'the KB ships as the dumped JSON');
const kbJson = require(path.join(ROOT, 'src', 'data', 'coach_kb.json'));
ok(Array.isArray(kbJson) && kbJson.length === 64, 'the KB JSON has 64 rows', `got ${kbJson.length}`);

/* ==================================================================== 1. features */
head('1. positional features (ported FeaturesTest)');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const carlsbadFen = 'rnbqkb1r/ppp2ppp/5n2/3p4/3P4/2N5/PP2PPPP/R1BQKBNR w KQkq - 0 5';
const panovFen = 'rnbqkb1r/pp3ppp/5n2/3p4/3P4/2N5/PP3PPP/R1BQKBNR w KQkq - 0 7';
const lucenaFen = '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1';

{
  const bol = 'rnbqkb1r/pp3ppp/3p1n2/4p3/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6';
  const r = rep(bol);
  const blackHoles = r.holes.filter((h) => h.weakFor === board.BLACK).map((h) => h.sq);
  ok(blackHoles.includes(sq('d5')), 'boleslavsky: d5 is a black hole');
  ok(blackHoles.length <= 2, 'boleslavsky: at most two black holes',
    blackHoles.map(board.sqName).join(','));
  ok(r.backward[board.BLACK].includes(sq('d6')), 'boleslavsky: d6 is backward for black');
  ok(!r.isolated[board.BLACK].includes(sq('d6')), 'boleslavsky: d6 is not isolated (e5 adjacent)');
  ok(r.semiOpenFiles[board.WHITE].includes(3), 'boleslavsky: d-file semi-open for white');
  ok(r.semiOpenFiles[board.BLACK].includes(2), 'boleslavsky: c-file semi-open for black');
  ok(r.structureTags.includes('open_sicilian_center'), 'boleslavsky: open_sicilian_center tag');
  ok(r.phase === 'opening', 'boleslavsky: phase is opening');
}
{
  const r = rep(panovFen);
  ok(JSON.stringify(r.isolated[board.WHITE]) === JSON.stringify([sq('d4')]),
    'panov: white isolated pawn is exactly d4', r.isolated[board.WHITE].map(board.sqName).join(','));
  ok(JSON.stringify(r.isolated[board.BLACK]) === JSON.stringify([sq('d5')]),
    'panov: black isolated pawn is exactly d5');
  ok(r.structureTags.includes('iqp_white') && r.structureTags.includes('iqp_black'),
    'panov: both iqp tags present', r.structureTags.join(','));
  ok(r.islands[board.WHITE] === 3, 'panov: white pawn islands = 3', String(r.islands[board.WHITE]));
}
{
  const reach = rep('rnbqkbnr/pp3ppp/3p4/4p3/4P3/2N5/PPPP1PPP/R1BQKB1R w KQkq - 0 1');
  const op = reach.outposts.find((o) => o.sq === sq('d5') && o.forSide === board.WHITE);
  ok(!!op, 'outpost: white has an outpost on d5');
  ok(op && op.protectedByOwnPawn, 'outpost: the e4 pawn protects it');
  ok(op && op.knightReach.includes(sq('c3')), 'outpost: Nc3 reaches d5');
  ok(op && !op.occupiedByOwnMinor, 'outpost: not yet occupied');

  const occ = rep('rnbqkbnr/pp3ppp/3p4/3Np3/4P3/8/PPPP1PPP/R1BQKBNR b KQkq - 0 1');
  const op2 = occ.outposts.find((o) => o.sq === sq('d5') && o.forSide === board.WHITE);
  ok(!!op2 && op2.occupiedByOwnMinor, 'outpost: occupied by the white knight');
  ok(occ.knightsOnOutposts.includes(sq('d5')), 'outpost: d5 knight listed as on an outpost');
  const hole = occ.holes.find((h) => h.sq === sq('d5'));
  ok(!!hole && features.occupiedByEnemy(hole), 'hole: occupied by the enemy knight');
  ok(!!hole && hole.severity >= 4, 'hole: an occupied hole ranks high', hole && String(hole.severity));
}
{
  const ruy = rep('r1bqkbnr/1pp2ppp/p1p5/4p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 5');
  const doubled = ruy.doubled[board.BLACK];
  ok(doubled.length === 1 && doubled[0].length === 2
    && doubled[0].includes(sq('c6')) && doubled[0].includes(sq('c7')),
    'ruy exchange: black c-pawns doubled');
  ok(ruy.semiOpenFiles[board.BLACK].includes(3), 'ruy exchange: d-file semi-open for black');
}
ok(rep(carlsbadFen).structureTags.includes('carlsbad'), 'carlsbad tag detected');
ok(rep('rnbqkbnr/pp3ppp/4p3/8/2PP4/8/P4PPP/RNBQKBNR w KQkq - 0 1').structureTags.includes('hanging_pawns_white_cd'),
  'hanging pawns c+d detected');
ok(rep('rnbqkbnr/pppp1ppp/4p3/3pP3/3P4/8/PPP2PPP/RNBQKBNR w KQkq d6 0 3').structureTags.includes('closed_center'),
  'closed center detected (French advance)');
ok(!rep(START).structureTags.includes('closed_center'),
  'the starting position is not a closed centre');
ok(!rep('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2').structureTags.includes('closed_center'),
  '1.e4 e5 is not a closed centre — the d-pawns are still at home');
{
  const openE4 = rep('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  const facts = factsMod.structureFacts(openE4);
  ok(!facts.some((f) => /centre is closed/i.test(f.text)),
    'the coach never tells the student 1.e4 e5 has a closed centre');
}
{
  const symmetric = rep(START);
  ok(!factsMod.FactFactory.hookTokens(symmetric).includes('bishop_pair'),
    'two bishops each is symmetry, not a bishop-pair advantage');
  const onePair = rep('rnbqk1nr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ok(factsMod.FactFactory.hookTokens(onePair).includes('bishop_pair'),
    'the hook fires when only one side owns the bishop pair');
}
{
  const safe = rep('rnbq1rk1/pppp1ppp/8/2b1p3/8/5N2/PPPPPPPP/RNBQ1RK1 w - - 0 1');
  ok(safe.kingSafety[board.WHITE].danger === 'LOW', 'king safety: castled king is LOW danger');
  ok(safe.kingSafety[board.WHITE].shield === 3, 'king safety: shield counts three pawns');
  const exposed = rep('rnb1k1r1/pppp1ppp/8/2b1p3/7q/5N2/PPPPP3/RNBQ1RK1 w - - 0 1');
  const ks = exposed.kingSafety[board.WHITE];
  ok(ks.danger === 'HIGH', 'king safety: exposed king is HIGH danger');
  ok(ks.openFilesNearKing.includes(6), 'king safety: g-file open near the king');
  ok(ks.zoneAttackerSquares.length > 0, 'king safety: attackers listed in the king zone');
}
{
  const r = rep('r3k2r/8/8/1p3p2/p1p3b1/4B3/PPPPPPPP/5RK1 w - - 0 1');
  const cw = r.colorWeakness.find((c) => c.side === board.BLACK);
  ok(!!cw, 'colour complex: black weakness detected');
  ok(cw && cw.weakColor === 'dark', 'colour complex: the weak colour is dark');
  ok(cw && cw.pawnsOnWeakColor === 0 && cw.pawnsOnStrongColor === 4, 'colour complex: 4 pawns on light');
  ok(cw && !cw.ownBishopOnWeakColor, 'colour complex: black has no dark bishop');
  ok(cw && cw.enemyBishopOnWeakColor, 'colour complex: white keeps the dark bishop');
  ok(cw && cw.holesOnWeakColor.includes(sq('c5')) && cw.holesOnWeakColor.includes(sq('e5')),
    'colour complex: c5 and e5 are dark holes');
  ok(cw && cw.acute, 'colour complex: flagged acute');
}
ok(rep(START).phase === 'opening', 'phase: start position is the opening');
ok(rep('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1').phase === 'endgame', 'phase: K+P is an endgame');
ok(rep('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1').phase === 'middlegame',
  'phase: a developed position is the middlegame');
ok(JSON.stringify(rep('8/8/1P6/8/8/8/8/4K2k w - - 0 1').passed[board.WHITE]) === JSON.stringify([sq('b6')]),
  'passed pawn: b6 detected');
{
  const r = rep(START);
  ok(r.development[board.WHITE].homeMinors === 4 && r.development[board.BLACK].homeMinors === 4,
    'development: all four minors at home');
  ok(!r.development[board.WHITE].castled, 'development: not castled');
}
{
  const a = rep('rnbqkb1r/pp3ppp/3p1n2/4p3/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6');
  const b = rep(panovFen);
  const a2 = rep('rnbqkb1r/pp3ppp/3p1n2/4p3/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6');
  ok(JSON.stringify(a.holes) === JSON.stringify(a2.holes) && a.islands[board.WHITE] === a2.islands[board.WHITE],
    'analyzer is deterministic, no shared state');
  ok(b.islands[board.WHITE] === 3, 'analyzer islands stay per-call');
}

/* ==================================================================== 2. knowledge base */
head('2. knowledge base (ported KbTest, cross-validated on chess.js)');

const KB = knowledgeMod.COACH_KB;
ok(KB.size === 64, 'kb loads with 64 entries', String(KB.size));
ok(KB.all(new Set(['concept'])).length === 26, 'kb: 26 concepts');
ok(KB.all(new Set(['structure'])).length === 11, 'kb: 11 structures');
ok(KB.all(new Set(['opening'])).length === 17, 'kb: 17 openings');
ok(KB.all(new Set(['endgame'])).length === 10, 'kb: 10 endgames');

let shortSummary = 0;
let shortDetail = 0;
for (const e of KB.all()) {
  if (e.summary.length < 20) shortSummary++;
  if (e.detail.length < 80) shortDetail++;
}
ok(shortSummary === 0, 'every summary is at least 20 chars', `${shortSummary} short`);
ok(shortDetail === 0, 'every detail is at least 80 chars', `${shortDetail} short`);

let planProblem = '';
for (const e of [...KB.all(new Set(['opening'])), ...KB.all(new Set(['structure']))]) {
  if (e.whitePlan.length < 30) planProblem = `${e.name} white plan`;
  if (e.blackPlan.length < 30) planProblem = `${e.name} black plan`;
}
ok(planProblem === '', 'openings and structures carry concrete plans', planProblem);

{
  const bad = ['? use', '? no', '? honest', '? keep', '? hmm', '? final', 'wait,', 'no \u2014'];
  let residue = '';
  for (const e of KB.all()) {
    for (const field of [e.title, e.summary, e.detail, e.whitePlan, e.blackPlan]) {
      for (const marker of bad) if (field.includes(marker)) residue = `${e.name}: ${marker}`;
    }
  }
  ok(residue === '', 'text is publication grade — no authoring residue', residue);
}
for (const name of ['lucena', 'philidor', 'kpk', 'rook_pawn_draw']) {
  const e = KB.byName(name);
  ok(!!e && e.fen.length > 0 && e.example.startsWith('Engine line:'),
    `endgame ${name} carries an engine-verified example`);
}

{
  const MOVE_NUM = /^\d+\.+/;
  const sanTokens = (moves) => moves.split(/\s+/).map((t) => t.replace(MOVE_NUM, '')).filter(Boolean);
  let replayed = 0;
  let replayProblem = '';
  let fenProblem = '';
  for (const e of [...KB.all(new Set(['opening'])), ...KB.all(new Set(['structure']))]) {
    if (e.moves.length === 0) continue;
    const g = new chessjs.Chess();
    try {
      for (const t of sanTokens(e.moves)) g.move(t);
      replayed++;
    } catch (err) {
      replayProblem = `${e.name}: ${err.message}`;
      continue;
    }
    // For OPENINGS the stored FEN was computed from the line; replaying the SAN
    // on chess.js must land on the identical FEN (SAN, castling, en passant,
    // counters) — a cross-check of the two independent move generators.
    if (e.kind === 'opening' && g.fen() !== e.fen) fenProblem = `${e.name}: ${g.fen()} != ${e.fen}`;
  }
  ok(replayed >= 25, 'at least 25 KB lines replay legally on chess.js', String(replayed));
  ok(replayProblem === '', 'every KB SAN line is legal', replayProblem);
  ok(fenProblem === '', 'opening final FENs match chess.js exactly', fenProblem);
}

{
  const top = (q, n = 5) => KB.search(q, undefined, n).map((e) => e.name);
  ok(top('minority attack').includes('minority_attack') && top('minority attack').includes('carlsbad'),
    'search: minority attack finds the concept and the structure');
  ok(top('isolated queen pawn').includes('iqp') || top('isolated queen pawn').includes('iq_pawn'),
    'search: isolated queen pawn finds the iqp entries');
  ok(top('weak squares', 3).includes('weak_squares'), 'search: weak squares tops with the concept');
  ok(top('backward pawn', 3).includes('backward_pawn'), 'search: backward pawn');
  ok(top('lucena bridge', 2).includes('lucena'), 'search: lucena bridge');
  ok(top('my pieces are hanging and getting forked').includes('lpdo')
    || top('my pieces are hanging and getting forked').includes('tactics_vocabulary'),
    'search: natural language about hanging pieces');
  ok(top('is my king safe').includes('king_safety'), 'search: is my king safe');
  const openings = KB.search('minority attack', new Set(['opening']), 5);
  ok(openings.length > 0 && openings.every((e) => e.kind === 'opening') && openings.some((e) => e.name === 'qgd_exchange'),
    'search: kind filter keeps openings only');
  const endgames = KB.search('minority attack', new Set(['endgame']), 5);
  ok(endgames.every((e) => e.kind === 'endgame')
    && !endgames.some((e) => ['carlsbad', 'minority_attack', 'qgd_exchange'].includes(e.name)),
    'search: endgame filter never returns the minority-attack entries');
}
ok(KB.byName('Carlsbad') !== null && KB.byName('Carlsbad').title === 'Carlsbad structure',
  'byName is case-insensitive');
ok(KB.byName('qgd_exchange') && KB.byName('qgd_exchange').eco === 'D35', 'byName finds eco D35');

{
  ok(namesOf(KB.byHook(['carlsbad'])).includes('carlsbad')
    && namesOf(KB.byHook(['carlsbad'])).includes('minority_attack')
    && namesOf(KB.byHook(['carlsbad'])).includes('qgd_exchange'),
    'hook carlsbad pulls structure, concept and opening');
  const iqp = namesOf(KB.byHook(['iqp_black']));
  ok(iqp.includes('iqp') && iqp.includes('iq_pawn'), 'hook iqp_black finds both entries', iqp);
  ok(namesOf(KB.byHook(['holes'])).includes('weak_squares'), 'hook holes -> weak squares');
  ok(namesOf(KB.byHook(['outposts'])).includes('outpost'), 'hook outposts -> outpost');
  ok(namesOf(KB.byHook(['color_weakness'])).includes('color_complex'), 'hook color_weakness');
  ok(namesOf(KB.byHook(['loose_pieces'])).includes('lpdo'), 'hook loose_pieces -> LPDO');
  ok(namesOf(KB.byHook(['king_danger'])).includes('king_safety'), 'hook king_danger');
  ok(KB.byHook(['endgame'], new Set(['endgame']), 12).length >= 8, 'endgame phase hook finds endgames');
  ok(namesOf(KB.byHook(['blunder', 'mistake'])).includes('tactics_vocabulary'),
    'blunder hook finds the tactics vocabulary');
}

/* ==================================================================== 3. facts + narration */
head('3. grounded facts and template narration (ported CoachTest)');

{
  const ctx = factsMod.FactFactory.forPosition(rep(carlsbadFen), KB);
  const all = ctx.facts.map((f) => f.text).join(' ');
  ok(all.includes('Carlsbad'), 'carlsbad facts name the structure');
  ok(ctx.kbHits.some((e) => e.name === 'carlsbad') && ctx.kbHits.some((e) => e.name === 'minority_attack'),
    'carlsbad hooks pull carlsbad + minority_attack', namesOf(ctx.kbHits));
  ok(ctx.facts.some((f) => f.kind === 'phase') && ctx.facts.some((f) => f.kind === 'material'),
    'position facts carry phase and material');
}
{
  const ctx = factsMod.FactFactory.forPosition(rep(panovFen), KB);
  const all = ctx.facts.map((f) => f.text).join(' ').toLowerCase();
  ok(all.includes('isolated'), 'panov facts mention the isolated pawn');
  ok(ctx.kbHits.some((e) => e.name === 'iqp' || e.name === 'iq_pawn'), 'panov hooks find the iqp entries');
}
{
  const ctx = factsMod.FactFactory.forPositionFen(lucenaFen, KB);
  ok(ctx.kbHits.some((e) => e.kind === 'endgame'), 'lucena hooks endgame entries', namesOf(ctx.kbHits));
}

const mc = (p = 8, n = 2, b = 2, r = 2, q = 1) =>
  ({ side: 0, pawns: p, knights: n, bishops: b, rooks: r, queens: q, bishopPair: b >= 2 });
ok(factsMod.FactFactory.materialDiffPhrase(mc(), mc()) === 'Material is level.', 'material: level');
ok(factsMod.FactFactory.materialDiffPhrase(mc(9), mc()) === 'White is up a pawn.', 'material: up a pawn');
ok(factsMod.FactFactory.materialDiffPhrase(mc(6, 3), mc()) === 'White is up a knight for two pawns.',
  'material: knight for two pawns');
ok(factsMod.FactFactory.materialDiffPhrase(mc(8, 2, 2, 2), mc(8, 3, 2, 1)) === 'White is up the exchange.',
  'material: the exchange');
ok(factsMod.FactFactory.materialDiffPhrase(mc(8, 2, 3, 3, 0), mc(8, 2, 2, 2, 1))
  === 'Black is up a queen for a rook and a bishop.', 'material: queen for rook and bishop');

const f3Review = {
  moveNumber: 1, moverIsWhite: true, san: 'f3', uci: 'f2f3',
  fenBefore: START, fenAfter: 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1',
  isCapture: false, isCheck: false, grade: 'mistake',
  cpBefore: 20, cpAfter: -90, bestSan: 'Nf3', pvUci: ['g1f3', 'd7d5', 'd2d4', 'g8f6'], wpLoss: 0.11,
};

const coach = new coachMod.Coach(KB);
{
  const text = await coach.explainMove(f3Review);
  ok(text.includes('f3'), 'explain move names the move');
  ok(text.toLowerCase().includes('mistake'), 'explain move names the grade');
  ok(text.includes('Nf3'), 'explain move names the engine move');
  ok(guard.isGrounded(text, factsMod.FactFactory.forMove(f3Review, KB)), 'explain move stays grounded', text);
}
{
  const text = await coach.explainPosition(carlsbadFen);
  ok(text.includes('Carlsbad'), 'explain position on carlsbad names the structure');
  ok(text.toLowerCase().includes('minority attack'), 'explain position offers the minority attack plan', text);
  ok(guard.isGrounded(text, factsMod.FactFactory.forPositionFen(carlsbadFen, KB)), 'grounded', text);
}
{
  const text = await coach.explainPosition(lucenaFen);
  ok(/lucena|rook/i.test(text), 'explain position on lucena teaches the endgame');
}
{
  const answer = await coach.ask('what is a minority attack?', carlsbadFen);
  ok(answer.includes('FEWER pawns'), 'follow-up finds the minority attack summary', answer);
  ok(answer.includes('b4-b5'), 'follow-up offers the concrete plan', answer);
}
{
  const answer = await coach.ask('is my king safe?', 'rnbq1rk1/pppp1ppp/8/2b1p3/8/5N2/PPPPPPPP/RNBQ1RK1 w - - 0 1');
  ok(answer.length > 60, 'king-safety answer is substantial', String(answer.length));
}
{
  const h = [['what should I do here?', 'Play for the minority attack with b4-b5.']];
  const answer = await coach.ask('and what if he plays c5?', carlsbadFen, h);
  ok(answer.length > 0 && guard.isGrounded(answer, factsMod.FactFactory.forPositionFen(carlsbadFen, KB)),
    'multi-turn history is accepted and stays grounded', answer);
}
{
  const sys = prompts.QwenPrompts.system();
  ok(sys.includes('ONLY the provided facts'), 'qwen system states the grounding rule');
  const user = prompts.QwenPrompts.followUpPrompt(
    factsMod.FactFactory.forPositionFen(carlsbadFen, KB), 'what should I do?', [['hi', 'hello']]);
  ok(user.includes('VERIFIED FACTS') && user.includes('Carlsbad') && user.includes('what should I do?')
    && user.includes("STUDENT'S QUESTION"), 'qwen follow-up prompt renders facts and the question');
  const movePrompt = prompts.QwenPrompts.explainMovePrompt(factsMod.FactFactory.forMove(f3Review, KB), f3Review);
  ok(movePrompt.includes('Move played: 1.f3') && movePrompt.includes('Nf3') && movePrompt.includes('TASK'),
    'qwen move prompt contains the graded move facts');
}

/* ==================================================================== 3b. position relevance */
head('3b. follow-ups answer this board, not a random book page');

/*
 * The exact on-device position and move list from the bug report: a QGD
 * middlegame with one bishop each, White a pawn up, Black's king still in the
 * centre. The old question-driven KB merge answered "Explain this position"
 * with the bishop pair and King-and-pawn-vs-king, and "What is the plan here?"
 * with an English Opening line (Rc1, b4 against c5) that does not exist here.
 */
const BUG_FEN = 'r3kb1r/p2n1p1p/q1p1pn2/5p2/3P4/2N1PN2/PPQ2PPP/R1B2RK1 w kq - 2 12';
const BUG_MOVES = [
  'd4', 'd5', 'c4', 'Nf6', 'Nc3', 'Bf5', 'cxd5', 'c6', 'dxc6', 'bxc6',
  'Nf3', 'Nbd7', 'e3', 'g6', 'Bd3', 'Qb6', 'Bxf5', 'gxf5', 'Qc2', 'e6', 'O-O', 'Qa6',
];
{
  ok(KB.findMentioned('Explain this position.', 3).length === 0,
    'identity retrieval ignores the generic words "explain this position"');
  ok(KB.findMentioned('What is the plan here?', 3).length === 0,
    'identity retrieval ignores the generic word "plan"');
  ok(KB.findMentioned('What is the bishop pair?', 3).some((e) => e.name === 'bishop_pair'),
    'identity retrieval still finds an explicitly named concept');
  ok(KB.findMentioned('Where are the weak squares?', 3).some((e) => e.name === 'weak_squares'),
    'identity retrieval still finds "weak squares"');
}
{
  const text = await coach.ask('Explain this position.', BUG_FEN);
  const lower = text.toLowerCase();
  ok(lower.includes('middlegame') && lower.includes('up a pawn'),
    'position answer uses the actual phase and material', text);
  ok(lower.includes('c6') && lower.includes('weak square'),
    'position answer names this position\'s pawn and weak squares', text);
  ok(!lower.includes('bishop pair') && !lower.includes('king and pawn'),
    'position answer does not inject the bishop pair or K+P ending', text);
  ok(!lower.includes('from the coach\'s book'),
    'position answer is not a random book page', text);
  ok(guard.isGrounded(text, factsMod.FactFactory.forPositionFen(BUG_FEN, KB)),
    'position answer stays grounded', text);
}
{
  const text = await coach.ask('What is the plan here?', BUG_FEN);
  const lower = text.toLowerCase();
  ok(lower.startsWith('plan for white'),
    'plan answer is explicitly about the side to move', text);
  ok(lower.includes('c6') || lower.includes('weak square'),
    'plan answer uses this position\'s structure', text);
  ok(!/\\bRc1\\b/.test(text) && !/b4 against c5/i.test(text) && !lower.includes('english opening'),
    'plan answer does not paste an unrelated opening line', text);
  ok(!lower.includes('bishop pair') && !lower.includes('king and pawn'),
    'plan answer does not inject unrelated material/endgame pages', text);
}
{
  const text = await coach.ask('Where are the weak squares?', BUG_FEN);
  ok(text.startsWith('Weak squares and holes:') && text.includes('d3') && text.includes('c5'),
    'weak-square question returns the squares the analyzer found', text);
  ok(!text.toLowerCase().includes('lucena') && !text.toLowerCase().includes('bishop pair'),
    'weak-square answer does not list unrelated book entries', text);
}
{
  const text = await coach.ask('What was the last move?', BUG_FEN, [], BUG_MOVES);
  ok(text.includes('Qa6') && text.includes('Moves already played'),
    'chat receives the move list that produced the FEN', text);
}
{
  const ctx = factsMod.FactFactory.forPositionFen(BUG_FEN, KB);
  ok(!guard.check('Black has the bishop pair.', ctx).ok,
    'guard rejects a bishop-pair claim this position cannot support');
  ok(!guard.check('King and pawn vs king is the plan.', ctx).ok,
    'guard rejects a K+P ending claim in a middlegame');
  const supported = {
    ...ctx,
    kbHits: [...ctx.kbHits, KB.byName('bishop_pair')],
  };
  ok(guard.check('The bishop pair covers both colours.', supported).ok,
    'guard allows the bishop pair when the student explicitly asked about it');
}
{
  let slowCalls = 0;
  const slow = {
    name: 'slow',
    async explainHint() { slowCalls++; return 'should not be called'; },
  };
  const c = new coachMod.Coach(KB, slow);
  const text = await c.explainHint(BUG_FEN, 'Qd3');
  ok(slowCalls === 0 && text.includes('Qd3'),
    'hints use the instant deterministic narrator even when a model is attached', text);
}

/* ==================================================================== 3c. the survey */
head('3c. the coach over many positions — openings, middlegames, endgames');

/*
 * ONE POSITION IS NOT A SURVEY.
 *
 * The bug report was a middlegame, and fixing it left the openings and the
 * endgames untested: a K+P ending was taught "in rook endings activity beats
 * material" on a board with no rooks, an a-pawn was called an isolated pawn
 * because the b-pawn had left, and a king was reported "in danger from two
 * open files" in a pawnless ending.
 *
 * Every position below is replayed from real moves with chess.js, so the FEN
 * cannot be a typo and the position is legal by construction.
 */
const fenAfter = (moves) => {
  const c = new chessjs.Chess();
  for (const m of moves) {
    const r = c.move(m);
    if (!r) throw new Error(`illegal move ${m} in ${moves.join(' ')}`);
  }
  return { fen: c.fen(), moves: c.history() };
};
const SURVEY = [
  ['the Italian', fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4', 'cxd4', 'Bb4+'])],
  ['the Sicilian Najdorf', fenAfter(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'Be3', 'e5', 'Nb3', 'Be7', 'f3', 'Be6', 'Qd2', 'O-O', 'O-O-O', 'Nbd7', 'g4', 'b5'])],
  ['the King Indian', fenAfter(['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'Nf3', 'O-O', 'Be2', 'e5', 'O-O', 'Nc6', 'd5', 'Ne7'])],
  ['the reported QGD middlegame', fenAfter(['d4', 'd5', 'c4', 'Nf6', 'Nc3', 'Bf5', 'cxd5', 'c6', 'dxc6', 'bxc6', 'Nf3', 'Nbd7', 'e3', 'g6', 'Bd3', 'Qb6', 'Bxf5', 'gxf5', 'Qc2', 'e6', 'O-O', 'Qa6'])],
  ['the orthodox IQP', fenAfter(['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'O-O', 'Nf3', 'h6', 'Bh4', 'b6', 'cxd5', 'exd5', 'Bd3', 'Bb7', 'O-O', 'c5'])],
  ['a K+P vs K ending', { fen: '8/5pk1/8/8/8/8/5PK1/8 w - - 0 1', moves: [] }],
  ['a K+R vs K+P ending', { fen: '1K6/1P6/8/8/8/8/6k1/4R3 w - - 0 1', moves: [] }],
  ['a K+N vs K ending', { fen: '8/8/8/3K4/8/8/8/5N2 w - - 0 1', moves: [] }],
  ['a queen vs rook ending', { fen: '8/8/8/3k4/8/8/3K4/3Q4 w - - 0 1', moves: [] }],
];

for (const [name, pos] of SURVEY) {
  const ctx = factsMod.FactFactory.forPositionFen(pos.fen, KB);
  const report = features.analyzeFen(pos.fen);
  const text = await coach.explainPosition(pos.fen);
  const plan = await coach.ask('What is the plan here?', pos.fen, [], pos.moves);

  /*
   * AN EDGE PAWN IS NOT AN ISOLATED PAWN.
   *
   * A rook pawn can never be chased by an enemy pawn, so "isolated" on the
   * a- or h-file is a statement about the shape of the board rather than a
   * weakness in it. The old rule flagged every edge pawn in every position.
   */
  const edgeIsolated = report.isolated
    .flat()
    .filter((sq) => board.fileOf(sq) === 0 || board.fileOf(sq) === 7);
  ok(edgeIsolated.length === 0,
    `${name}: an edge pawn is never called an isolated pawn`,
    edgeIsolated.map(board.sqName).join(','));

  /*
   * A WEAK SQUARENESS NEEDS A PIECE THAT CAN USE IT.
   *
   * A K+P ending has no pieces to settle on a hole, so the squares are not
   * weaknesses, and saying so teaches the student the term for a situation
   * where it does not apply.
   */
  if (report.phase === 'endgame' && report.material[board.WHITE].rooks + report.material[board.BLACK].rooks === 0) {
    ok(!/is a weak square for/.test(text),
      `${name}: a pawnless ending does not report weak squares`, text.slice(0, 160));
  }

  /*
   * A PLAN IS ABOUT THE SIDE TO MOVE, AND SAYS WHICH THINGS ARE TARGETS.
   */
  const mover = pos.fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  ok(new RegExp(`plan \\(${mover}[,)]`).test(plan)
    || new RegExp(`plan for ${mover}`, 'i').test(plan),
    `${name}: the plan is addressed to the side to move`, plan.slice(0, 160));

  /*
   * AN ENDING IS TAUGHT BY ITS OWN TECHNIQUE.
   *
   * The KB holds the right answers for each kind of ending. What was missing
   * was the link from the board to the page, and a king-and-pawn ending was
   * answered with rook technique.
   */
  if (report.phase === 'endgame') {
    const lesson = ctx.endgameLesson;
    ok(!!lesson, `${name}: the ending has a technique attached`, String(lesson));
    if (lesson) {
      ok(plan.includes(lesson.plan.slice(0, 40)),
        `${name}: the plan IS the technique's plan for this ending`, plan.slice(0, 160));
      ok(!/rook ending|rooks behind passers/.test(plan.toLowerCase())
        || lesson.kbName.includes('rook'),
        `${name}: no rook technique in an ending with no rooks`, plan.slice(0, 160));
    }
  } else {
    ok(!/in rook endings/.test(plan.toLowerCase()),
      `${name}: a middlegame is not taught rook-endgame technique`, plan.slice(0, 160));
  }
}

/*
 * EVERY ENDING IS CLASSIFIED, AND ONLY ONCE.
 *
 * The endings were tested in sequence and each pushed a tag, so the last test
 * to fire won: opposite-coloured bishops were overwritten by the queen test
 * and the bishop-versus-knight ending was overwritten too. Every shape below
 * must reach its own lesson, and the KB has a page for each.
 */
{
  const ENDINGS = [
    ['K+P vs K', '8/8/8/8/8/4k3/4P3/4K3 w - - 0 1', /king and pawn/i],
    ['K+P vs K, black to move', '8/8/8/8/8/4k3/4P3/4K3 b - - 0 1', /king and pawn/i],
    ['R+P vs R', '8/8/8/8/8/1k6/2P5/1KR5 w - - 0 1', /rook/i],
    ['K+R vs K', '8/8/8/8/8/1k6/8/3KR3 w - - 0 1', /rook/i],
    ['K+N vs K', '8/8/8/8/8/8/8/3K1N1k w - - 0 1', /insufficient|drawn/i],
    ['K+B vs K', '8/8/8/8/8/8/8/3K1B1k w - - 0 1', /insufficient|drawn/i],
    ['K+Q vs K', '8/8/8/8/8/8/8/3K1Q1k w - - 0 1', /queen/i],
    ['Q vs R', '8/8/8/8/8/1k6/r7/3KQ3 w - - 0 1', /fortress|draw/i],
    ['opposite-coloured bishops', '8/6b1/8/8/8/8/2B5/4K2k w - - 0 1', /opposite/i],
    ['B vs N', '8/8/8/8/8/1n6/8/2B1K3 w - - 0 1', /bishop versus knight/i],
    ['P vs P', '8/3p4/8/8/8/8/3P4/3K1k2 w - - 0 1', /pawn/i],
  ];
  for (const [name, fen, expected] of ENDINGS) {
    const ctx = factsMod.FactFactory.forPositionFen(fen, KB);
    const lesson = ctx.endgameLesson;
    ok(!!lesson && expected.test(lesson.title),
      `${name}: the ending is taught its own technique`,
      lesson ? lesson.title : 'no lesson at all');
  }
  /*
   * THE DEAD POSITION IS NOT A CONVERSION.
   */
  const kn = factsMod.FactFactory.forPositionFen('8/8/8/8/8/8/8/3K1N1k w - - 0 1', KB);
  ok(kn.endgameLesson !== null && /drawn/i.test(kn.endgameLesson.title),
    'K+N against K is a dead position, and is called one',
    kn.endgameLesson ? kn.endgameLesson.title : 'no lesson');
}

/*
 * THE MODEL IS SHOWN THE PLAN FOR THE SIDE IT IS PLAYING.
 *
 * The prompt is what the on-device model reads, and it quotes the plan of
 * each book page. The isolated queen's pawn page is keyed by ROLE, so the
 * model was handed the attacker's plan while the side to move was the one
 * holding the weak pawn — and the model duly told the student to attack its
 * own weakness.
 */
{
  const panov = 'rnbqkb1r/pp3ppp/5n2/3p4/3P4/2N5/PP3PPP/R1BQKBNR w KQkq - 0 7';
  const ctx = factsMod.FactFactory.forPositionFen(panov, KB);
  const iqpPage = KB.byName('iqp');
  ok(!!iqpPage, 'the isolated pawn page is in the knowledge base');
  if (iqpPage) {
    const shown = prompts.QwenPrompts.planFor(ctx, iqpPage);
    ok(/hold|blockade|trade pieces/i.test(shown),
      'the model is shown the DEFENDER plan when the side to move holds the weak pawn', shown);
    ok(!/^Attack the isolated/i.test(shown),
      'and not the attacker plan', shown);
  }
}

/* The list of squares reads as a list, not as a file listing. */
{
  const text = await coach.explainPosition(BUG_FEN);
  ok(!/\band [a-h][1-8] and [a-h][1-8]\b/.test(text),
    'a list of three squares is not joined with "and" twice', text.slice(0, 200));
  /*
   * A LIST OF THREE REALLY DOES OCCUR, so the rule is tested on one: three
   * passed pawns on the a, d and h files.
   */
  const threePassed = '8/1P6/8/3P4/8/3P4/8/4K2k w - - 0 1';
  const t = await coach.explainPosition(threePassed);
  ok(/passed pawn on/.test(t), 'the three-passed-pawn position is described', t.slice(0, 200));
  ok(!/\band [a-h][1-8] and [a-h][1-8]\b/.test(t),
    'a list of three squares is not joined with "and" twice', t.slice(0, 240));
}

/* The plan separates the opponent's targets from the mover's own weaknesses. */
{
  const plan = await coach.ask('What is the plan here?', BUG_FEN);
  ok(/your targets/i.test(plan) && /watch out/i.test(plan),
    'the plan says what to attack and what to watch', plan.slice(0, 200));
}

/*
 * A MAJORITY IS NOT A WEAKNESS, AND A DRAW IS NOT A WIN.
 *
 * Two more things the answer got wrong, both from the same cause: facts
 * without a role. "Black has a queenside majority" was listed as a TARGET
 * for White, which is not a weakness of Black at all; and K+N vs K was
 * answered with "convert by opening a second front", advice for a win that
 * cannot happen because one minor piece cannot mate a bare king.
 */
{
  const italian = fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4',
    'exd4', 'cxd4', 'Bb4+']).fen;
  const plan = await coach.ask('What is the plan here?', italian, [], []);
  ok(!/targets:.*majority/i.test(plan),
    'a queenside majority is not listed as a target to attack', plan.slice(0, 240));
}
{
  const kn = '8/8/8/3K4/8/8/8/5N2 w - - 0 1';
  const plan = await coach.ask('What is the plan here?', kn, [], []);
  ok(/drawn|mate|insufficient/i.test(plan),
    'K+N against K is said to be drawn, not to be converted', plan.slice(0, 240));
  ok(!/second front|open a second/i.test(plan),
    'and is not told to open a second front', plan.slice(0, 240));
}

/* An explicit question about the bishop pair is answered, and says who has it. */
{
  const answer = await coach.ask('What is the bishop pair?', BUG_FEN);
  ok(/bishop pair/i.test(answer), 'the question about the bishop pair is answered', answer.slice(0, 160));
  ok(/neither side has the bishop pair/i.test(answer),
    'and the answer says nobody has the pair on this board', answer.slice(0, 240));
  const ownPair = await coach.ask('What is the bishop pair?', 'rnbqkb1r/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  ok(!/neither side has the bishop pair/i.test(ownPair),
    'a position where both sides have two bishops is not reported as having none', ownPair.slice(0, 240));
  ok(/both sides have the two bishops/i.test(ownPair),
    'and it says both sides have them', ownPair.slice(0, 240));
}

/*
 * A QUESTION MATCHES THE FACTS IT IS ABOUT, AND ONLY THOSE.
 *
 * "The" is in every fact sentence, so with it in the question's word set
 * every question matched every fact, and "What is the bishop pair?" came back
 * with "Black has doubled pawns on the f-file" as if that were an answer.
 */
{
  const answer = await coach.ask('What is the bishop pair?', BUG_FEN);
  ok(!/doubled pawns on the f-file/.test(answer),
    'a question about the bishop pair does not drag in an unrelated fact', answer.slice(0, 300));
}

/*
 * A CLOSED CENTRE IS A SPECIFIC STRUCTURE, AND ITS PLAN SAYS SO.
 *
 * The three closed centres have three different plans, and the Ruy Lopez one
 * was handed to a King's Indian: "Regroup with Nbd2-f1-g3 and Re1, play a4
 * against ...b5" is not a move sequence in that opening.
 */
{
  const kid = fenAfter(['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'Nf3', 'O-O',
    'Be2', 'e5', 'O-O', 'Nc6', 'd5', 'Ne7']).fen;
  const kidPlan = await coach.ask('What is the plan here?', kid, [], []);
  ok(/King's Indian closed centre/i.test(kidPlan),
    "a King's Indian is given the King's Indian plan", kidPlan.slice(0, 200));
  ok(!/Regroup with Nbd2/i.test(kidPlan),
    "and not the Ruy Lopez regrouping", kidPlan.slice(0, 200));
  const ruy = fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7',
    'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O', 'h3', 'Na5', 'Bc2', 'c5', 'd4']).fen;
  const ruyPlan = await coach.ask('What is the plan here?', ruy, [], []);
  ok(/Ruy Lopez/i.test(ruyPlan), 'the closed Ruy Lopez is given the Ruy Lopez plan', ruyPlan.slice(0, 200));
}

/*
 * THE DEFENDER IS NOT HANDED THE ATTACKER'S PLAN.
 *
 * The isolated queen's pawn page has two plans and they are the ATTACKER's
 * and the DEFENDER's, not White's and Black's. In the Panov both sides have
 * an isolated d-pawn, and the side to move is defending one of them, so it
 * must be told to hold, not to attack.
 */
{
  const panov = 'rnbqkb1r/pp3ppp/5n2/3p4/3P4/2N5/PP3PPP/R1BQKBNR w KQkq - 0 7';
  const plan = await coach.ask('What is the plan here?', panov, [], []);
  ok(/isolated queen's pawn/i.test(plan),
    "the Panov is taught the isolated queen's pawn", plan.slice(0, 200));
  ok(/hold|blockade|trade pieces/i.test(plan),
    'and the side holding the pawn is told to hold it', plan.slice(0, 240));
  ok(!/^Coach's plan \(White, from Isolated queen's pawn structures\): Attack/.test(plan),
    'and not told to attack its own weakness', plan.slice(0, 240));
}

/*
 * A KING IS NOT IN DANGER FROM FILES NO ROOK CAN REACH.
 *
 * The K+P vs K ending has no rook on it, and the analyzer reported "White's
 * king is in moderate danger: 2 open files nearby" — open files next to a
 * king that no rook can reach, with no rook on the board. The danger terms
 * are about a ROOK coming down a file, so with no enemy rook there is no
 * danger to report.
 */
{
  const kpk = '8/5pk1/8/8/8/8/5PK1/8 w - - 0 1';
  const text = await coach.explainPosition(kpk);
  ok(!/in (moderate|high) danger/.test(text),
    'a king with no enemy rook is not reported in danger', text.slice(0, 240));
  // And with a rook on the board the same king IS in danger, so the rule is
  // not simply "never report danger".
  const withRook = '6k1/8/8/8/8/8/6r1/6K1 w - - 0 1';
  const r = features.analyzeFen(withRook);
  const whiteKing = r.kingSafety[board.WHITE];
  ok(whiteKing.danger !== 'LOW',
    'a king facing an enemy rook on an open file IS in danger', whiteKing.danger);
}

/* ==================================================================== 4. grounding guard */
head('4. the grounding guard (ported CoachTest)');

{
  const ctx = factsMod.FactFactory.forPositionFen(START, KB);
  const v = guard.check('Develop with Nf3 or Nc3; avoid Qh5.', ctx);
  ok(v.violations.includes('Qh5'), 'guard flags Qh5 (blocked by the e2 pawn)', v.violations.join(','));
  ok(!v.violations.includes('Nf3') && !v.violations.includes('Nc3'), 'guard allows the legal Nf3/Nc3');
}
{
  const ctx = factsMod.FactFactory.forPositionFen(carlsbadFen, KB);
  ok(guard.isGrounded(
    'Your e4 pawn and the d5 square matter; watch the light squares around the king.', ctx),
    'guard allows bare square references');
}
{
  const ctx = factsMod.FactFactory.forPositionFen(START, KB);
  const v = guard.check('I recommend the strong move Nd4 followed by Nf4 and Be7.', ctx);
  ok(v.violations.includes('Nd4') && v.violations.includes('Nf4') && v.violations.includes('Be7') && !v.ok,
    'guard flags hallucinated piece moves', v.violations.join(','));
}
{
  const ctx = factsMod.FactFactory.forMove(f3Review, KB);
  ok(guard.isGrounded('Better was Nf3, developing toward the centre.', ctx),
    'guard allows moves quoted in the facts');
}
{
  const hallucinating = {
    name: 'hallucinating',
    async explainMove(ctx, mr) { return template.TemplateNarrator.explainMove(ctx, mr); },
    async explainPosition() { return 'Just play Nd4 and Nf4, trust me.'; },
    async explainGame(ctx) { return template.TemplateNarrator.explainGame(ctx); },
    async answer(ctx, q, h) { return template.TemplateNarrator.answer(ctx, q, h); },
  };
  const dirty = new coachMod.Coach(KB, hallucinating);
  const out = await dirty.explainPosition(START);
  ok(!out.includes('Nd4') && !out.includes('Nf4'),
    'a hallucinating narrator never reaches the student', out.slice(0, 120));
  ok(guard.isGrounded(out, factsMod.FactFactory.forPositionFen(START, KB)),
    'the fallback narration is grounded');
}

/* ==================================================================== 5. LLM fallbacks */
head('5. LLM narrators — grounded drafts in, template fallback on any failure');

const startCtx = factsMod.FactFactory.forPositionFen(START, KB);
{
  const runtime = {
    label: 'fake', ready: true,
    calls: 0,
    async complete() { this.calls++; return startCtx.facts[0].text; },
  };
  const n = new llmMod.LocalModelNarrator(runtime);
  const out = await n.explainPosition(startCtx);
  ok(out === startCtx.facts[0].text && runtime.calls === 1, 'an on-device draft quoting facts is used as-is');
}
{
  const runtime = {
    label: 'fake', ready: true,
    async complete() { return 'Just play Nd4 and Nf4, trust me.'; },
  };
  const n = new llmMod.LocalModelNarrator(runtime);
  const out = await n.explainPosition(startCtx);
  ok(!out.includes('Nd4') && guard.isGrounded(out, startCtx),
    'an ungrounded on-device draft falls back to the template', out.slice(0, 120));
}
{
  const runtime = { label: 'fake', ready: true, async complete() { throw new Error('no model file'); } };
  const n = new llmMod.LocalModelNarrator(runtime);
  const out = await n.explainPosition(startCtx);
  ok(out.length > 0 && guard.isGrounded(out, startCtx), 'a failing runtime falls back to the template');
}
{
  let calls = 0;
  const runtime = { label: 'fake', ready: false, async complete() { calls++; return 'x'; } };
  const n = new llmMod.LocalModelNarrator(runtime);
  const out = await n.explainPosition(startCtx);
  ok(calls === 0 && guard.isGrounded(out, startCtx), 'a runtime without a loaded model is never asked');
}
{
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'Play Nd4 now!' } }] }) });
    const n = new llmMod.ChatCompletionNarrator({ baseUrl: 'http://127.0.0.1:9/v1', model: 'test' });
    const out = await n.explainPosition(startCtx);
    ok(!out.includes('Nd4') && guard.isGrounded(out, startCtx), 'an endpoint draft is still guard-checked');

    globalThis.fetch = async () => { throw new Error('connection refused'); };
    const n2 = new llmMod.ChatCompletionNarrator({ baseUrl: 'http://127.0.0.1:9/v1', model: 'test' });
    const out2 = await n2.explainPosition(startCtx);
    ok(out2.length > 0 && guard.isGrounded(out2, startCtx), 'an unreachable endpoint falls back offline');

    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const n3 = new llmMod.ChatCompletionNarrator({ baseUrl: 'http://127.0.0.1:9/v1', model: 'test' });
    const out3 = await n3.answer(startCtx, 'is my king safe?');
    ok(out3.length > 0 && guard.isGrounded(out3, startCtx), 'an HTTP error falls back offline');
  } finally {
    globalThis.fetch = origFetch;
  }
}

/* ==================================================================== 6. chess only */
head('6. chess only — off-topic questions never reach a narrator');

{
  let spyCalls = 0;
  const spy = {
    name: 'spy',
    async explainMove(ctx, mr) { spyCalls++; return template.TemplateNarrator.explainMove(ctx, mr); },
    async explainPosition(ctx) { spyCalls++; return template.TemplateNarrator.explainPosition(ctx); },
    async explainGame(ctx) { spyCalls++; return template.TemplateNarrator.explainGame(ctx); },
    async answer(ctx, q, h) { spyCalls++; return template.TemplateNarrator.answer(ctx, q, h); },
  };
  const c = new coachMod.Coach(KB, spy);
  const off = await c.ask('what is the capital of France?', START);
  ok(off === topicMod.CHESS_ONLY_APOLOGY, 'off-topic gets exactly the apology', off.slice(0, 80));
  ok(spyCalls === 0, 'the narrator was never asked', String(spyCalls));
  const on = await c.ask('is my king safe?', START);
  ok(spyCalls === 1 && on.length > 0, 'a chess question does reach the narrator');
  ok(topicMod.isChessRelated('why?', KB) && topicMod.isChessRelated('what about e4?', KB)
    && topicMod.isChessRelated('explain more', KB), 'follow-ups and square mentions stay open');
  ok(!topicMod.isChessRelated('recommend a movie for tonight', KB), 'a movie question is refused');
  /*
   * The gate leaked in both directions and both classes are pinned now:
   *  - "how do I make pasta?" scored a KB hit on prose ("make" appears in a
   *    summary), so common English questions were let through;
   *  - "what should I aim for here?" had no chess term, so real follow-ups
   *    about the shown board were refused.
   */
  const shouldOpen = [
    'What should I aim for here?',
    'What do I do now?',
    'Tell me about the London System',
    'tell me about the caro-kann defence',
  ];
  for (const q of shouldOpen) ok(topicMod.isChessRelated(q, KB), `chess intent stays open: "${q}"`);
  const shouldRefuse = [
    'Who won the 2022 world cup?',
    'How do I make pasta?',
    'What was the weather like yesterday?',
    'I am hungry',
  ];
  for (const q of shouldRefuse) ok(!topicMod.isChessRelated(q, KB), `off-table stays refused: "${q}"`);
  ok(KB.matchesCurated(['london']) && !KB.matchesCurated(['make', 'pasta']),
    'the curated probe separates chess vocabulary from prose words');
}

/* ==================================================================== 7. walkthrough */
head('7. the whole-game walkthrough — opening to endgame from real review data');

{
  const g = new chessjs.Chess();
  const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'];
  const fens = [g.fen()];
  for (const s of sans) { g.move(s); fens.push(g.fen()); }
  const reviews = sans.map((san, i) => ({
    moveNumber: Math.floor(i / 2) + 1, moverIsWhite: i % 2 === 0, san, uci: '',
    fenBefore: fens[i], fenAfter: fens[i + 1], isCapture: false, isCheck: false,
    grade: 'book', cpBefore: 20, cpAfter: 20, bestSan: san, pvUci: [], wpLoss: 0,
  }));
  const ctx = gameMod.forGame({ reviews, openingName: 'Spanish Opening' }, KB);
  ok(ctx.facts.some((f) => f.kind === 'game-summary' && f.text.includes('3 moves')),
    'walkthrough facts state the game length');
  ok(ctx.facts.some((f) => f.text.includes('Spanish Opening')), 'walkthrough facts carry the app-known opening name');
  ok(ctx.facts.some((f) => f.kind === 'game-key' && f.text.includes('no turning point')),
    'walkthrough says honestly when nothing decisive happened');
  const text = await new coachMod.Coach(KB).explainGame({ reviews, openingName: 'Spanish Opening' });
  ok(text.includes('The game in brief'), 'walkthrough narrates the game in brief', text.slice(0, 120));
  ok(guard.isGrounded(text, ctx), 'walkthrough narration is grounded', text);

  const blunder = { ...reviews[3], grade: 'blunder', wpLoss: 0.45, cpBefore: 20, cpAfter: -200, bestSan: 'Nf6' };
  const ctx2 = gameMod.forGame({ reviews: [...reviews.slice(0, 3), blunder], openingName: null }, KB);
  ok(ctx2.facts.some((f) => f.kind === 'game-key' && f.text.includes('Nc6') && f.text.includes('Nf6')),
    'walkthrough names the turning point with the engine move');
  ok(gameMod.turningPointPlies([...reviews.slice(0, 3), blunder]).includes(3),
    'the UI can highlight the turning-point ply');
}

/* ==================================================================== summary */
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
