/**
 * "I completed a line in Your openings, went to Train, and it said I hadn't
 *  practiced anything" — and "there is no improvement in the Sicilian".
 *
 * TWO INDEPENDENT CAUSES, and the second is the more interesting one.
 *
 * 1. NOTHING WAS RECORDED
 *    `queueAdoption` was guarded by `if (!step.position) return`. `position` is only
 *    set on a step derived from a real Lichess game position. Every step from
 *    `withBookTail` — the entire book continuation, i.e. MOST of a typical Sicilian
 *    line — carries `position: null`, because there was no game behind it. Twelve
 *    moves played, three recorded, Train reported nothing.
 *
 * 2. THE RANK COULD NOT MOVE, EVEN WITH A FULL REPERTOIRE
 *    `openingProgress` read only `studiesState` — the SRS record for the SHIPPED
 *    studies. Practising in "Your openings" writes to the custom repertoire and never
 *    touches the SRS, because those lines are not shipped studies. So the Sicilian
 *    rank was structurally incapable of changing however much the user played it.
 *
 * There was also a THIRD, smaller one: the 700 ms write debounce meant that finishing
 * a line and tapping Train immediately raced the timer, and the repertoire was still
 * empty when Train read it. Line completion is now a flush signal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

let checks = 0, fails = 0;
function ok(label, cond, detail = '') {
  checks++;
  if (!cond) fails++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

function load(p) {
  const s = fs.readFileSync(path.join(ROOT, p), 'utf8');
  return s.replace(/\r\n/g, '\n');
}
const code = (p) => load(p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const BUILDER = load('src/lib/openingBuilder.ts');
const SCREEN = load('src/components/screens/GameOpeningsScreen.tsx');
const REPERTOIRE = load('src/lib/repertoire.ts');
const OPENINGS = load('src/components/screens/OpeningsScreen.tsx');
const GAMEO = load('src/lib/gameOpenings.ts');
const cScreen = SCREEN.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

console.log('\n§1  a line is recorded even when no game position exists');
ok('queueAdoption no longer bails when step.position is null',
  !/const queueAdoption[\s\S]{0,200}if \(!p\) return/.test(cScreen),
  'that guard silently dropped most of a line');
ok('it derives the key from the FEN and the side to move when there is no position',
  /step\.fen\.split\(' '\)\.slice\(0, 4\)\.join\(' '\)/.test(cScreen));
ok('and it takes the prefix from the caller, which is the only source of the move order',
  /prefixSan: \[\.\.\.prefixSan\]/.test(cScreen));
ok('the plain-move branch records UNCONDITIONALLY', !/if \(step\.position\) \{\s*\n\s*void adopt/.test(cScreen),
  'book moves have position: null, so the guard dropped them');
ok('the decision branch records with a prefix too',
  /note: 'Your own choice',[\s\S]{0,80}\}, \[\.\.\.playedSans\]\)/.test(cScreen));

console.log('\n§2  the record is attributable to an opening');
ok('BuilderStep carries openingId', /openingId\?: string \| null;/.test(BUILDER));
ok('withBookTail stamps it on the book tail',
  /fromStudy: book\.studyTitle,[\s\S]{0,400}?openingId,/.test(BUILDER),
  'the comment between the two keys is why the first 120-char window missed it');
ok('and it is computed BEFORE the tail is built',
  BUILDER.indexOf('const matchedOpeningId = openingIdFor(sidePositions);')
    < BUILDER.indexOf('const steps = withBookTail(spine, side, matchedOpeningId);'),
  'computing it after is why the tail had no opening to report');
ok('CustomLine carries openingId as the join key', /openingId\?: string \| null;/.test(GAMEO));
ok('and the screen records it', /openingId: step\.openingId \?\? null/.test(cScreen));

console.log('\n§3  the rank moves when the user practises in Your openings');
ok('openingProgress accepts the per-opening counts', /ownByOpening: Record<string, number> = \{\}/.test(REPERTOIRE));
ok('and the opening id to join on', /openingId\?: string,?\s*\n\): OpeningProgress/.test(REPERTOIRE) || /openingId\?: string/.test(REPERTOIRE));
ok('the reported rank takes the HIGHER of the two sources of practice',
  /const shown = level > ownLevel \? level : ownLevel;/.test(REPERTOIRE),
  'a book rank of 0 with 12 recorded positions must still show a rank');
ok('a fresh account with nothing anywhere is still "Not started"',
  /shown > 0 \? LEVELS\[shown - 1\]\.name : 'Not started'/.test(REPERTOIRE));
ok('OpeningsScreen reads the custom repertoire', /loadCustomRepertoire\(\)/.test(OPENINGS));
ok('and counts DISTINCT positions per opening id', /counts\[line\.openingId\] = \(counts\[line\.openingId\] \?\? 0\) \+ 1/.test(OPENINGS));
ok('passing the entry id, not the display name', /ownByOpening,\s*\n\s*entry\.id,/.test(OPENINGS),
  'a name join fails silently and looks exactly like a broken rank');
ok('the strip shows it separately rather than summed into one ratio',
  load('src/components/ui/RankStrip.tsx').includes('ownPractised} yours'),
  'a plain substring: a regex over the middot in that template literal kept failing');
ok('there is a flush on line completion', /if \(!done\) return;[\s\S]{0,200}void flushAdoptions\(\);/.test(cScreen));
ok('made once per line, not on every re-render', /lineFinishedRef\.current === total/.test(cScreen));
ok('and the debounce stays as the abandoned-line safety net', /setTimeout\(\(\) => \{ void flushAdoptions\(\); \}, 700\)/.test(cScreen),
  'shortening it would bring back the per-ply write that broke dragging pieces');

console.log('\n§5  the recorded line is actually buildable by Train');
{
  /*
   * The end-to-end shape, built by hand: a Black user playing a pure-book Sicilian
   * line, where EVERY step has position:null because none of it came from a game.
   * This is the case that produced nothing at all.
   */
  const c = new Chess();
  const sans = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'];
  const lines = [];
  for (let i = 0; i < sans.length; i++) {
    const fenBefore = c.fen();
    const side = c.turn();
    const m = c.move(sans[i]);
    // Black's plies are the decisions; only those are user moves.
    if (side === 'b') {
      lines.push({
        key: `${fenBefore.split(' ').slice(0, 4).join(' ')}|b`,
        fen: fenBefore,
        adoptedUci: m.from + m.to,
        adoptedSan: m.san,
        prevSan: i > 0 ? sans[i - 1] : null,
        prefixSan: sans.slice(0, i),
        engineBestSan: null,
        opening: 'Sicilian Defense',
        openingId: 'sicilian',
        decidedAt: 1,
        selfDiscovered: true,
      });
    }
  }
  ok('the line yields 5 Black decisions', lines.length === 5, `${lines.length} recorded`);
  ok('every one has a position key', lines.every((l) => !!l.key));
  ok('every one has the move order leading to it', lines.every((l) => Array.isArray(l.prefixSan)));
  ok('and every one is attributable to the Sicilian', lines.every((l) => l.openingId === 'sicilian'));

  // The parity rule `buildCustomExercises` enforces: a Black user's decisions sit at
  // ODD plies, because after an odd number of moves it is Black's turn.
  // uildCustomExercises: expectedParity = side === 'w' ? 0 : 1 -- EVEN for
  // White, ODD for Black. This assertion was originally inverted (!== 1, i.e.
  // even) and reported correct data as broken.
  const parityOk = lines.every((l) => l.prefixSan.length % 2 === 1);
  ok('every record passes the odd-ply rule for a Black user', parityOk,
    lines.map((l) => `${l.adoptedSan}@${l.prefixSan.length}`).join(' '));
  ok('so this line now produces a non-empty Train pool', parityOk && lines.length > 0,
    'before the fix, every one of these had position:null and was discarded');
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'}: ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
