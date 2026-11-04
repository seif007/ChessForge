/**
 * WHAT THE END OF A BOT GAME OWES THE USER — the result, the review, and the PGN.
 *
 * THE REPORT: *"when the game is over i want you to show which one win and wich one lose like in
 * Lichess (add something to the king piece indicating win or lose) and the user should be able
 * to see the game from start to end with arrows to advance to next moce and the app provide a pgn
 * which he can copy to analyse the game."*
 *
 * Three deliverables, and this gate covers each on the two levels it can be checked at:
 *
 *   1. WHO WON. `resultToken` is the PGN's truth table; `kingSquare` is where the crown and the
 *      cross are painted. Both are pure and are tested directly (sections 1 and 2). The screen
 *      wiring — the overlay on the FINAL position only, the marks on the kings — is probed in
 *      section 4.
 *   2. THE REVIEW. `reviewAt` is the ply the board shows; the replayed FEN and the highlighted
 *      move are derived from the stored history. Probed in section 4: the board must read the
 *      replayed position, must stop accepting moves, and the nav arrows must be bounded.
 *   3. THE PGN. `buildBotPgn` is asserted byte-for-byte (section 3), including the wrap at 80
 *      columns and header sanitisation, because the string's only consumer is a paste into
 *      somebody else's analysis tool.
 *
 * Run: node .bench/bots.postgame.test.mjs
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

try { execFileSync('rm', ['-rf', path.join(ROOT, 'node_modules', '.cache', 'chessforge-bots-postgame')], { stdio: 'pipe' }); } catch { /* best effort */ }

let checks = 0, failures = 0;
function ok(cond, label, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}
function head(t) { console.log('\n' + t + '\n' + '-'.repeat(t.length)); }

/* ------------------------------------------------------------------ compile */

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-bots-postgame');
fs.mkdirSync(BUILD_DIR, { recursive: true });

const CONFIG = path.join(BUILD_DIR, 'tsconfig.json');
fs.writeFileSync(CONFIG, JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [path.join(ROOT, 'src', 'lib', 'bots', 'postgame.ts')],
}, null, 2));
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', CONFIG,
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 2000));
  process.exit(2);
}

const post = require(path.join(BUILD_DIR, 'src', 'lib', 'bots', 'postgame.js'));
const { buildBotPgn, kingSquare, pgnDate, resultToken } = post;

/* ===========================================================================
 * 1. WHO WON — the PGN token
 * ======================================================================== */
head('1. `resultToken` — the result the user reads and the PGN carries');

ok(resultToken('white') === '1-0', 'White won -> 1-0');
ok(resultToken('black') === '0-1', 'Black won -> 0-1');
ok(resultToken(null) === '1/2-1/2',
  'nobody won -> 1/2-1/2 (a finished game with no winner IS a draw: stalemate, repetition, 50-move)');
ok(new Set([resultToken('white'), resultToken('black'), resultToken(null)]).size === 3,
  'CONTROL: the three tokens are distinct — no two outcomes collapse into one');

/* ===========================================================================
 * 2. WHERE THE KINGS ARE — what the crown/cross overlays are keyed on
 * ======================================================================== */
head('2. `kingSquare` — reading the king off the FEN the board is showing');

ok(kingSquare(new Chess().fen(), 'w') === 'e1', 'the start: White king e1');
ok(kingSquare(new Chess().fen(), 'b') === 'e8', 'the start: Black king e8');

const castled = (() => {
  const c = new Chess();
  for (const m of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'd3', 'O-O']) c.move(m);
  return c.fen();
})();
ok(kingSquare(castled, 'w') === 'g1', 'after White castles short, the White king is g1');
ok(kingSquare(castled, 'b') === 'g8', 'and after Black castles, the Black king is g8');

ok(kingSquare('k7/8/8/8/8/8/8/K7 w - - 0 1', 'w') === 'a1',
  'file/rank mapping is exact at the a-file edge');
ok(kingSquare('7k/8/8/8/8/8/8/8 b - - 0 1', 'b') === 'h8',
  'and at the h-file edge, on an empty board');
ok(kingSquare('8/7k/8/8/8/8/8/8 b - - 0 1', 'b') === 'h7',
  'one rank in, the rank arithmetic still holds');
ok(kingSquare('8/8/8/8/8/8/8/8 w - - 0 1', 'w') === null,
  'no king -> null, not a wrong square');
ok(kingSquare('nonsense', 'w') === null, 'a malformed FEN -> null, and does not throw');

/* ===========================================================================
 * 3. THE PGN — byte-for-byte, because its destination is another program
 * ======================================================================== */
head('3. `buildBotPgn` — headers, movetext, wrap, result');

const DATE = '2026.10.18';

const scholars = [
  { san: 'e4', color: 'w' }, { san: 'e5', color: 'b' },
  { san: 'Bc4', color: 'w' }, { san: 'Nc6', color: 'b' },
  { san: 'Qh5', color: 'w' }, { san: 'Nf6', color: 'b' },
  { san: 'Qxf7#', color: 'w' },
];
const pgnWin = buildBotPgn({
  moves: scholars, white: 'You', black: 'Magnus', result: '1-0', date: DATE,
});
const EXPECTED_WIN = [
  '[Event "ChessForge bot game"]',
  '[Site "ChessForge"]',
  '[Date "2026.10.18"]',
  '[White "You"]',
  '[Black "Magnus"]',
  '[Result "1-0"]',
  '',
  '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0',
  '',
].join('\n');
ok(pgnWin === EXPECTED_WIN,
  'a White win reads exactly as a PGN reader expects, move numbers and all',
  pgnWin === EXPECTED_WIN ? '' : JSON.stringify(pgnWin));

const fools = [
  { san: 'f3', color: 'w' }, { san: 'e5', color: 'b' },
  { san: 'g4', color: 'w' }, { san: 'Qh4#', color: 'b' },
];
const pgnLoss = buildBotPgn({
  moves: fools, white: 'Magnus', black: 'You', result: '0-1', date: DATE,
});
ok(/\n\n1\. f3 e5 2\. g4 Qh4# 0-1\n$/.test(pgnLoss),
  'and a Black win ends with the result AFTER Black\'s move — the other legal shape',
  JSON.stringify(pgnLoss.slice(pgnLoss.indexOf('\n\n'))));
ok(/\[White "Magnus"\]\n\[Black "You"\]/.test(pgnLoss),
  'the header names follow who played which colour');

const pgnDraw = buildBotPgn({ moves: [], white: 'You', black: 'Bot', result: '1/2-1/2', date: DATE });
ok(pgnDraw.endsWith('\n\n1/2-1/2\n'),
  'a drawn game with no moves still carries its result token');
ok((pgnDraw.match(/1\/2-1\/2/g) ?? []).length === 2,
  'CONTROL: the token appears exactly twice — once in the header, once in the movetext');

const long = [];
for (let i = 0; i < 60; i++) {
  long.push({ san: i % 2 === 0 ? 'Nf3' : 'Nf6', color: i % 2 === 0 ? 'w' : 'b' });
}
const pgnLong = buildBotPgn({ moves: long, white: 'You', black: 'Bot', result: '1/2-1/2', date: DATE });
const movetext = pgnLong.split('\n\n')[1].trimEnd().split('\n');
ok(movetext.length > 1, 'a long game wraps onto several lines', `${movetext.length} lines`);
ok(movetext.every((l) => l.length <= 80),
  'and no movetext line exceeds 80 columns — long single lines are what pastes mangle',
  movetext.map((l) => l.length).join(','));

const flattened = movetext.join(' ');
let expectTokens = [];
long.forEach((m, i) => { if (m.color === 'w') expectTokens.push(`${Math.floor(i / 2) + 1}.`); expectTokens.push(m.san); });
expectTokens.push('1/2-1/2');
ok(flattened === expectTokens.join(' '),
  'CONTROL: wrapping changed line breaks and NOTHING else — the token stream is identical');

const quoted = buildBotPgn({
  moves: scholars, white: 'He said "hi"\nand left', black: 'Bot', result: '1-0', date: DATE,
});
ok(/^\[White "[^"]*"\]$/m.test(quoted.split('\n')[3]),
  'a name containing quotes/newlines cannot break the roster block',
  JSON.stringify(quoted.split('\n')[3]));
ok((quoted.split('\n')[3].match(/"/g) ?? []).length === 2,
  'CONTROL: exactly the two delimiters — no smuggled quote');

/* ===========================================================================
 * 4. THE SCREEN — the kings, the review, the clipboard
 * ======================================================================== */
head('4. THE PLAY SCREEN — marks on the kings, arrows through the game, copyable PGN');

const screenSrc = fs.readFileSync(
  path.join(ROOT, 'src', 'components', 'screens', 'BotPlayScreen.tsx'), 'utf8',
);
const code = screenSrc.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

// — the king marks
ok(/squareOverlays=\{kingOverlays\}/.test(code),
  'the board is given the king overlays at all');
ok(/const kingOverlays = useMemo/.test(code)
  && /kingSquare\(fen, winnerColor === 'white' \? 'w' : 'b'\)/.test(code)
  && /kingSquare\(fen, winnerColor === 'white' \? 'b' : 'w'\)/.test(code),
  'the WINNER\'s king gets one mark and the LOSER\'s the other, from the final FEN');
ok(/<KingMark kind="win" \/>/.test(code) && /<KingMark kind="loss" \/>/.test(code),
  'crown and cross, both rendered');
ok(/reviewAt != null\) return out;/.test(code),
  'and the marks are on the FINAL position only — while stepping through the game, kings are kings');

const kingMarkSrc = fs.readFileSync(
  path.join(ROOT, 'src', 'components', 'chess', 'KingMark.tsx'), 'utf8',
);
ok(/kind: 'win' \| 'loss'/.test(kingMarkSrc),
  'KingMark takes the two verdicts and nothing else (cannot be asked for a third state)');
ok(/fill=\{win \? colors\.gold : colors\.bad\}/.test(kingMarkSrc),
  'gold for the winner, the bad colour for the loser');

// — the review
ok(/const \[reviewAt, setReviewAt\] = useState<number \| null>\(null\);/.test(code),
  'the review state exists (null = live)');
ok(/fen=\{reviewFen \?\? fen\}/.test(code),
  'the board shows the replayed position while reviewing, and the live one otherwise');
ok(/interactive=\{reviewAt == null && userTurn\}/.test(code),
  'CONTROL: the board takes no input during a review — the game is over');
ok(/lastMove=\{reviewAt == null \? lastMove : reviewLastMove\}/.test(code),
  'and the highlighted move is the reviewed one');
ok(/setReviewAt\(Math\.max\(0, reviewAt - 1\)\)/.test(code)
  && /setReviewAt\(Math\.min\(history\.length, reviewAt \+ 1\)\)/.test(code),
  'the arrows step one ply at a time and are clamped to the game');
ok(/setReviewAt\(0\)/.test(code) && /setReviewAt\(history\.length\)/.test(code),
  'and there are jumps to the start and to the end — "see the game from start to end"');
ok(/disabled=\{reviewAt === 0\}/.test(code) && /disabled=\{reviewAt >= history\.length\}/.test(code),
  'CONTROL: the ends of the game are disabled rather than allowed to run off it');
ok(/setReviewAt\(null\)/.test(code),
  'leaving the review returns to the result');
ok(/\{over && reviewAt == null \? \(/.test(code),
  'and the result overlay steps aside while reviewing, so the board is visible');

// — the PGN
ok(/buildBotPgn\(\{/.test(code) && /resultToken\(winnerColor\)/.test(code),
  'the screen builds the PGN with the measured winner');
ok(/moves: history,/.test(code),
  'from the whole move history');
ok(/Clipboard\.setString\(pgn\)/.test(code),
  'one tap puts the PGN in the system clipboard');
ok(/selectable/.test(code),
  'and the PGN card is selectable as the no-clipboard fallback');
ok(/Share\.share\(\{ message: pgn/.test(code),
  'with a share sheet for getting it off the phone entirely');
ok(/setReviewAt\(null\);\n\s*setCopied\(false\);/.test(code) || /setCopied\(false\);/.test(code),
  'CONTROL: the copied flash resets, so "PGN copied" cannot become a permanent label');

/* ===========================================================================
 * 5. GAME REVIEW REACHES THE ANALYSIS PAGE, WITH THE PGN IN THE BOX
 * ======================================================================== */
head('5. GAME REVIEW HANDS THE FINISHED GAME TO THE ANALYSE PAGE');

/*
 * THE REPORT: *"there is a button for game review that does nothing: it shouild take me to the
 * analyse page where i can find the pgn of my game copied there and i can choose the depth then
 * click on analyse"*.
 *
 * Three hops, all pinned: the button builds the PGN and calls the handler; the shell stores it and
 * switches tabs (the play screen is an overlay, Analyse is a tab — no common parent prop exists);
 * the analysis screen copies it into the same box the user types into and reports it consumed, so
 * a later visit to the tab cannot re-fill over newer work.
 */
ok(/onAnalyse\?: \(pgn: string\) => void;/.test(code),
  'the play screen takes the hand-off as a prop');
ok(/onPress=\{\(\) => \(onAnalyse \? onAnalyse\(pgn\) : setReviewAt\(history\.length\)\)\}/.test(code),
  '"Game review" calls it with the built PGN');
ok(/label="Step through"/.test(code) && /setReviewAt\(history\.length\)/.test(code),
  'CONTROL: the in-place review keeps its own button — the two routes are not the same door');

const shellSrc = fs.readFileSync(path.join(ROOT, 'src', 'components', 'AppShell.tsx'), 'utf8');
const shellCode = shellSrc.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
ok(/const \[analysisPgn, setAnalysisPgn\] = useState<string \| null>\(null\);/.test(shellCode),
  'the shell holds the handed-over PGN for one hop');
ok(/onAnalyse=\{\(pgn\) => \{[\s\S]{0,240}setBotPlayId\(null\);[\s\S]{0,160}setAnalysisPgn\(pgn\);[\s\S]{0,160}setTab\('analysis'\);/.test(shellCode),
  'the handler closes the game, stores the PGN, and switches to the Analyse tab');
ok(/<AnalysisScreen initialPgn=\{analysisPgn\} onConsumeInitialPgn=\{onAnalysisPgnConsumed\} \/>/.test(shellCode),
  'the Analyse tab is mounted with that PGN');
ok(/onAnalysisPgnConsumed=\{\(\) => setAnalysisPgn\(null\)\}/.test(shellCode),
  'CONTROL: and the shell clears it once consumed, so a later visit does not re-fill the box');

const analysisSrc = fs.readFileSync(
  path.join(ROOT, 'src', 'components', 'screens', 'AnalysisScreen.tsx'), 'utf8',
);
ok(/export function AnalysisScreen\(\{/.test(analysisSrc) && /initialPgn = null,/.test(analysisSrc),
  'the analysis screen accepts the hand-over');
ok(/setPgnText\(initialPgn\);/.test(analysisSrc),
  'and copies it into the same box the user types into — depth picker and Analyze follow');
ok(/onConsumeInitialPgn\?\.\(\);/.test(analysisSrc),
  'reporting the copy as consumed, so it can never be offered twice');

/* ------------------------------------------------------------------ report */

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
