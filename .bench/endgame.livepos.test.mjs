/**
 * The "real position from the internet" path, proven to work on real PGNs.
 *
 * This feature was dead and looked alive. `fetchLiveEndgame` had a six-second
 * timeout, a fallback to the local pool, and ~40 lines of commentary explaining how
 * it found a real endgame — and it returned null on essentially every response,
 * because `fenAtPly` tokenised the PGN with `split(/\s+/)` and filtered inline. A
 * three-word `{ comment }` in the header was enough to make it `break` out of the
 * whole replay, and `if (/^\d+\./.test(san)) continue` meant every `1.e4`-style
 * token was SKIPPED rather than played.
 *
 * So the trainer always served a generated or pooled position, and nothing anywhere
 * reported a problem — the fallback is silent by design, which is correct for a
 * network feature and catastrophic for a broken one.
 *
 * The tests below use PGNs shaped like the ones the endpoint actually returns: header
 * block, `{ comments }`, `1.e4` compound tokens, NAGs, a nested sideline, and the
 * result token. If `pgnMainline` regresses, these fail — which is the only reason to
 * believe the feature is alive at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');

/* ---- compile the trainer with the standard bench harness ----------------- */
const BUILD = path.join(ROOT, 'node_modules', '.cache', 'chessforge-eglive');
try { execFileSync('rm', ['-rf', BUILD], { stdio: 'pipe' }); } catch { /* */ }
fs.mkdirSync(BUILD, { recursive: true });
fs.writeFileSync(path.join(BUILD, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'endgameTrainer.ts'),
    path.join(ROOT, 'src', 'lib', 'repertoire.ts'),
    path.join(ROOT, 'src', 'lib', 'openings.ts'),
  ],
}, null, 2));
try {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project', path.join(BUILD, 'tsconfig.json')], { stdio: 'pipe' });
} catch (e) { console.error('tsc failed:', e.stdout?.toString()?.slice(0, 1200)); process.exit(2); }

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
const ET = findEmitted(BUILD, 'endgameTrainer.js');
Module._load = function (request, parent, isMain) {
  if (request === 'chess.js') return REAL;
  if (request.startsWith('@/')) {
    const abs = path.join(ROOT, 'src', request.slice(2));
    for (const cand of [abs, `${abs}.ts`, `${abs}.js`, path.join(abs, 'index.ts')]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return origLoad.call(this, cand, parent, isMain);
    }
  }
  return origLoad.call(this, request, parent, isMain);
};
const trainer = origLoad.call(Module, ET, null, false);

let checks = 0, fails = 0;
function ok(label, cond, detail = '') {
  checks++;
  if (!cond) fails++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/* ---- the source-level contract ------------------------------------------- */
const RAW = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'endgameTrainer.ts'), 'utf8');

/*
 * MATCH CODE, NOT PROSE.
 *
 * These checks used to run against the raw source and reported two failures that
 * were not defects: the function bodies now CARRY the explanation, and the patterns
 * were matching the sentences in those comments — "maxMoves: 20 and engineElo:
 * 1800 were both constants of convenience" is precisely the text `maxMoves:\s*20`
 * looks for. A test that reads the comment describing the fix as evidence the fix
 * is absent is worse than no test, because it sends you to re-break working code.
 *
 * So comments are stripped before anything is matched. What is left is what the
 * program actually executes.
 */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const SRC = stripComments(RAW);

const fenAtPly = /function fenAtPly[\s\S]*?\n\}/.exec(SRC)?.[0] ?? '';
const pgnMainline = /function pgnMainline[\s\S]*?\n\}/.exec(SRC)?.[0] ?? '';
const fetchLive = /export async function fetchLiveEndgame[\s\S]*?\n\}/.exec(SRC)?.[0] ?? '';

console.log('\n§1  the PGN reader handles what real PGNs contain');
ok('a dedicated mainline extractor exists', pgnMainline.length > 0);
ok('it strips { comments } before tokenising', /replace\(\/\\\{\[\^}\]\*\\\}\/g/.test(pgnMainline));
ok('it strips [header] pairs', /\[\^\\n\]\*\\\]/.test(pgnMainline));
ok('it removes nested ( sidelines )', /indexOf\('\('\)/.test(pgnMainline) && /depth/.test(pgnMainline));
ok('it strips NAGs like $1', /\$\\d\+/.test(pgnMainline));
ok('and splits `1.e4` into a move instead of skipping it',
  /replace\(\/\^\\d\+\\\./.test(pgnMainline),
  'the old code SKIPPED these, dropping every move after the first');

console.log('\n§2  the ply contract matches the rest of the app');
ok('fenAtPly was found', fenAtPly.length > 0);
ok('it replays to initialPly + 1, per puzzleProvider.ts', /initialPly\s*\+\s*1/.test(fenAtPly),
  'puzzleProvider.ts: "the puzzle position sits after initialPly+1 plies"');
ok('and it no longer uses ply-parity to guess the side', !/%\s*2\s*===?\s*0\s*\?\s*'w'/.test(fenAtPly));

/*
 * BOTH live fetchers must go through the fixed reader.
 *
 * `fetchLiveEndgame` and `fetchLessonExample` are the only two places a PGN is parsed
 * in this file, and an earlier note listed the second one as still-broken. It is not:
 * it already calls `fenAtPly`, so the fix covers it. That is worth an assertion rather
 * than a memory note, because the failure mode is invisible — a second hand-rolled
 * tokeniser would reintroduce the whole bug with no error anywhere.
 */
const fetchLesson = /export async function fetchLessonExample[\s\S]*?\n\}/.exec(SRC)?.[0] ?? '';
ok('fetchLessonExample was found', fetchLesson.length > 0);
ok('and it uses the same fixed reader, not its own tokeniser',
  /fenAtPly\(/.test(fetchLesson) && !/pgn\.split/.test(fetchLesson),
  'a second hand-rolled PGN parser here would silently reintroduce the whole bug');
ok('neither live path tokenises a PGN itself',
  !/pgn\.split\(\/\\s\+\/\)/.test(fetchLive) && !/pgn\.split\(\/\\s\+\/\)/.test(fetchLesson));

console.log('\n§3  the live path respects the tier, and labels itself honestly');
ok('fetchLiveEndgame was found', fetchLive.length > 0);
ok('maxMoves is not hardcoded to 20', !/maxMoves:\s*20\b/.test(fetchLive),
  'a fixed 20 overrode the tier for every position the network served');
ok('engineElo is not floored at 1800', !/1800\s*\+\s*clamp/.test(fetchLive),
  'an 800-rated player was served a 1800+ engine whatever the band said');
ok('a fetched position is not labelled "generated"', !/source:\s*'generated'/.test(fetchLive),
  'a real game position was indistinguishable from a synthesised one');

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'}: ${checks - fails}/${checks} checks passed`);

/*
 * And a live behavioural check of the reader itself, driven through the compiled
 * module by re-implementing the call the way `fetchLiveEndgame` makes it. The
 * function is module-private, so the contract is asserted on the source above and
 * the BEHAVIOUR is asserted here on a hand-run replay of the same logic against PGNs
 * shaped like the real ones.
 */
console.log('\n§4  behaviour: the REAL exported reader, on real-shaped PGNs');
{
  /*
   * THE SHIPPED FUNCTION, NOT A COPY OF IT.
   *
   * The first version of this section re-implemented the reader inline. It then
   * failed — the copy had no RAV handling, so `(3. Bc4 Bc5)` survived and the replay
   * died on `(3.` — which is exactly what a duplicated implementation does: it
   * reports a defect that is not in the code, and it will keep doing so the moment
   * the real function changes. A test that re-implements the thing it is testing
   * tests nothing.
   *
   * So this calls the exported `pgnMainline`. If it regresses, this fails.
   */
  ok('pgnMainline is exported so it can be tested directly', typeof trainer.pgnMainline === 'function');

  const PGN = `[Event "Rated correspondence game"]
[Site "https://lichess.org/abc"]
[Result "1-0"]

1. e4 { a king pawn opening} e5 2. Nf3 Nc6 3. Bb5 (3. Bc4 Bc5) 3... a6 $1 4. Ba4 Nf6 1-0`;
  const sans = trainer.pgnMainline(PGN);

  ok('headers, comments, NAGs and the result token are all removed',
    !sans.some((t) => t.startsWith('[') || t.startsWith('{') || t.startsWith('$') || /^(1-0|0-1|\*)$/.test(t)),
    `tokens: ${sans.join(' ')}`);
  ok('the sideline `3. Bc4 Bc5` is removed', !sans.includes('Bc4') && !sans.includes('Bc5'),
    `mainline: ${sans.join(' ')}`);
  ok('`3... a6` keeps its move', sans.includes('a6'));
  ok('the compound `1.e4` yields a move, not a skip', sans[0] === 'e4', `first token: ${sans[0]}`);

  const c = new Chess();
  let played = 0, bad = null;
  for (const san of sans) {
    try { c.move(san); played++; } catch { bad = san; break; }
  }
  ok('the whole mainline replays legally', bad === null, bad ? `failed at "${bad}" after ${played}` : `${played} plies`);

  const expect = new Chess();
  for (const s of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6']) expect.move(s);
  ok('and reaches the expected position', c.fen() === expect.fen(),
    `${played} plies -> ${c.turn()} to move`);

  // The off-by-one, on the real token list: initialPly is the index of the LAST
  // played move, so the served position is after initialPly + 1 plies.
  const initialPly = 7;
  const d = new Chess();
  for (let i = 0; i < initialPly + 1; i++) d.move(sans[i]);
  ok('initialPly+1 lands on the 8th ply, matching puzzleProvider.ts',
    d.fen() === expect.fen(), `${initialPly + 1} plies -> ${d.turn()} to move`);

  // A PGN with no headers or comments at all — the simplest real case.
  const bare = '1. d4 d5 2. c4 e6 1/2-1/2';
  ok('and a bare PGN works too', JSON.stringify(trainer.pgnMainline(bare)) === JSON.stringify(['d4', 'd5', 'c4', 'e6']),
    trainer.pgnMainline(bare).join(' '));

  // A nested RAV, which is the case a flat paren-strip gets wrong.
  const nested = '1. e4 (1. d4 d5 (1... Nf6 2. c4) 2. c4) 1... e5 2. Nf3';
  ok('a NESTED sideline is removed whole',
    !trainer.pgnMainline(nested).includes('Nf6'), trainer.pgnMainline(nested).join(' '));
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'}: ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
