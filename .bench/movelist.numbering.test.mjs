/**
 * Does the move list tell the truth about WHO moved and WHICH move it was?
 *
 * The user asked: *"i want the last move to be showed like in lichess so i know that i am
 * playing with white or black and what is the last move."*
 *
 * The numbering was the part that could quietly be wrong in a way nobody would catch by
 * looking. The list counted from 1 and always put the first move in the White column, which is
 * right for a game recorded from move 1 and wrong for everything else - and most of this app is
 * not a game from move 1. Endgame lessons start in the middle of a game and puzzles start at
 * whatever ply was mined. On a Black-to-move position the first move is BLACK's, and printing
 * it in the White column does not merely misnumber it, it tells the reader the wrong player
 * made it. A list like that looks entirely plausible, which is why it has to be checked rather
 * than eyeballed.
 *
 * Every case below is written from the FEN itself, and the controls assert the OLD behaviour
 * would have failed them - so a `buildMoveRows` that always numbered from one and always put
 * the first move on the left cannot pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-movelist');

try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });

// MoveList is a .tsx with no runtime dependency beyond react-native's View/Text, so it is
// compiled and then loaded with those stubbed. Only `buildMoveRows` is under test; it is pure.
fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true, jsx: 'react-jsx',
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [path.join(ROOT, 'src', 'components', 'chess', 'MoveList.tsx')],
}, null, 2));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project',
    path.join(BUILD_DIR, 'tsconfig.json'),
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 2000));
  process.exit(2);
}

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
const host = { View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', StyleSheet: { hairlineWidth: 1 } };
Module._load = function (request, parent, isMain) {
  if (request === 'react-native') return host;
  if (request.startsWith('@/lib/moveQuality')) return { QUALITY_META: {}, };
  if (request.endsWith('/QualityBadge') || request.includes('QualityBadge')) return { QualityBadge: 'QualityBadge' };
  if (request === '@/theme/tokens') {
    return {
      colors: { mutedForeground: '#888' }, fonts: { mono: 'm', sans: 's' },
      radii: { sm: 4 }, themedStyles: (f) => f(),
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

const mod = origLoad.call(Module, findEmitted(BUILD_DIR, 'MoveList.js'), null, false);
const { buildMoveRows } = mod;

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};

/** Compact rendering of a row so a failure prints something readable. */
const show = (rows) => rows.map((r) =>
  `${r.no}${r.white && !r.black ? ' White:' + r.white.san : ''}${r.black && !r.white ? ' Black:' + r.black.san : ''}`
  + `${r.white && r.black ? ' W:' + r.white.san + ' B:' + r.black.san : ''}`).join(' | ');

const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

// ---------------------------------------------------------------------------
head('1. a game from move 1 is unchanged (the common case must not regress)');

const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const rows = buildMoveRows(['e4', 'e5', 'Nf3', 'Nc6'], start);
ok(rows.length === 2, 'two rows for four plies', show(rows));
ok(rows[0].no === 1 && rows[0].white?.san === 'e4' && rows[0].black?.san === 'e5',
  'move 1 is e4 e5, White then Black', show(rows));
ok(rows[1].no === 2 && rows[1].white?.san === 'Nf3' && rows[1].black?.san === 'Nc6',
  'move 2 is Nf3 Nc6', show(rows));
// Omitting startFen must behave identically - four other screens pass no startFen.
const noFen = buildMoveRows(['e4', 'e5', 'Nf3', 'Nc6']);
ok(JSON.stringify(noFen) === JSON.stringify(rows),
  'omitting startFen gives exactly the old behaviour (backwards compatible)');

// ---------------------------------------------------------------------------
head('2. a mid-game position keeps its real move number');

const midGame = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 4';
const mid = buildMoveRows(['Nc3', 'Nf6'], midGame);
ok(mid[0].no === 4, 'the position is move 4, so the first row is numbered 4', show(mid));
ok(mid[0].black?.san === 'Nc3', 'with Black to move, Nc3 is BLACK\'s move', show(mid));
ok(mid[0].white === undefined, 'and nothing is attributed to White', show(mid));

const blackThenWhite = buildMoveRows(['Nc3', 'Nf6', 'Bg5'], midGame);
ok(blackThenWhite[0].no === 4 && blackThenWhite[0].black?.san === 'Nc3',
  'still move 4 Black after one ply', show(blackThenWhite));
ok(blackThenWhite[1].no === 5 && blackThenWhite[1].white?.san === 'Nf6',
  'White\'s reply belongs to move 5', show(blackThenWhite));

// ---------------------------------------------------------------------------
head('3. THE CONTROLS - the old behaviour must fail these');

/*
 * If `buildMoveRows` ignored `startFen` and numbered from one with the first move always on
 * the left, it would produce `1. White: Nc3` for the mid-game Black position above. That is
 * the exact defect: a plausible-looking list that tells the reader White made Black's move.
 * Asserting the wrong answer explicitly, so the test fails if the fix is undone.
 */
const naive = (sans) => {
  const out = [];
  for (let i = 0; i < sans.length; i += 2) {
    out.push({
      no: i / 2 + 1,
      white: sans[i] !== undefined ? { san: sans[i], ply: i } : undefined,
      black: sans[i + 1] !== undefined ? { san: sans[i + 1], ply: i + 1 } : undefined,
    });
  }
  return out;
};
const naiveMid = naive(['Nc3', 'Nf6']);
ok(naiveMid[0].no === 1 && naiveMid[0].white?.san === 'Nc3',
  'CONTROL: the old code numbered this 1. and called Nc3 White\'s move',
  'so this test would have failed before the fix');
ok(!(mid[0].no === naiveMid[0].no && mid[0].white?.san === naiveMid[0].white?.san),
  'the fixed output differs from the old output on this position');

// ---------------------------------------------------------------------------
head('4. odd plies are White and even plies are Black, from a Black start');

const asSeen = ['Nc3', 'Nf6', 'Bg5', 'Be7', 'O-O', 'O-O'];
const rows2 = buildMoveRows(asSeen, midGame);
const whiteSans = [];
const blackSans = [];
for (const r of rows2) {
  if (r.white) whiteSans.push(r.white.san);
  if (r.black) blackSans.push(r.black.san);
}
ok(whiteSans.join(',') === 'Nf6,Be7,O-O',
  'White\'s moves are the even plies from a Black start', `got ${whiteSans.join(',')}`);
ok(blackSans.join(',') === 'Nc3,Bg5,O-O',
  'Black\'s moves are the odd plies from a Black start', `got ${blackSans.join(',')}`);
/*
 * Six plies starting from a BLACK-to-move position at move 4 span FOUR move numbers, not
 * three, and that is the whole point of the offset: Black played in move 4, so the sequence
 * is 4...Nf6 Bg5 5.Be7 O-O 6.O-O — six plies, ending with White's move in move 7. A test that
 * expected 4,5,6 here would have been asserting the bug.
 */
ok(rows2.map((r) => r.no).join(',') === '4,5,6,7',
  'and the numbers run 4, 5, 6, 7 — Black\'s first move is in move 4, so six plies span four numbers',
  show(rows2));
ok(rows2[3].no === 7 && rows2[3].white?.san === 'O-O' && rows2[3].black === undefined,
  'the final row is move 7 with only White\'s O-O', show(rows2));

// A White-to-move position must be the mirror image of the above.
const whiteStart = midGame.replace(' b KQkq - 3 4', ' w KQkq - 4 5');
const rows3 = buildMoveRows(asSeen, whiteStart);
ok(rows3[0].no === 5 && rows3[0].white?.san === 'Nc3',
  'from a White-to-move position the first move is White\'s, at move 5', show(rows3));

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures > 0 ? 1 : 0);
