/*
 * THE TRAINING SCREEN, AND THE HINT EVERYWHERE.
 *
 * Three reports, one shape:
 *
 *   1. *"in the training when i make a mistake it should show a red arrow on the wrong move and the
 *       correct arrow on the right move then let me play it again"*
 *   2. *"the hint doesnt work in a place and selects all the pieces in another place (not sure in
 *       training or test or course or puzzle i dont remember but you have to fix it)"*
 *   3. *"when a piece capture sometimes it changes its colour"*
 *
 * (1) and (2) were both reported against "the training", and "the training" is TrainScreen — a
 * different screen from PracticeScreen, with its own copy of the move handler and its own hint. The
 * previous round fixed Practice, the puzzles and the course and left this one untouched, which is why
 * the same complaints came back looking like nothing had been done.
 *
 * (2) has a second half that is not TrainScreen. The hint is implemented in FIVE places, and "selects
 * all the pieces" was true of the two that still called `movableSquares`: Train and Endgames. A fix in
 * three of five places is a coin toss from the user's side of the screen.
 *
 * (3) is settled in the renderer, not in any screen: every piece is the same `<Svg>` with different
 * paint, and two pieces of the same KIND are the same path with a different `fill`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
/*
 * Comments blanked, character for character, so an explanation cannot satisfy an assertion about
 * behaviour — and so a fix that lives only in a comment reads as a failure.
 *
 * A regex cannot do this: `//` inside a string is not a comment, and `/*` inside a line comment opens
 * nothing. A single left-to-right scan that tracks strings, template literals, regex literals and
 * both comment forms is the only version that stays aligned with the source, and staying aligned is
 * the whole point — a masker that drops out of step erases real code and hides real bugs.
 */
const code = (s) => {
  let out = '';
  let i = 0;
  let prev = '';
  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '/' && d === '/') {
      while (i < s.length && s[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      out += '  ';
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) {
        out += s[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < s.length) { out += '  '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i += 1;
      while (i < s.length) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] ?? ''); i += 2; continue; }
        out += s[i];
        if (s[i] === c) { i += 1; break; }
        i += 1;
      }
      prev = c;
      continue;
    }
    // A `/` after a value is division (or a JSX self-close); anywhere else it opens a regex literal.
    // `}` counts as a value: `<Foo x={y} />` is the common case this has to survive.
    if (c === '/' && !/[\w$)\]}'"`]/.test(prev)) {
      out += ' '; i += 1;
      let inClass = false;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '\\') { out += '  '; i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if ((ch === '/' && !inClass) || ch === '\n') { out += ' '; i += 1; break; }
        out += ' '; i += 1;
      }
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
};

let checks = 0;
let failures = 0;
function ok(cond, label) {
  checks += 1;
  if (cond) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}`); }
}
function head(t) { console.log(`\n${'-'.repeat(78)}\n${t}\n${'-'.repeat(78)}`); }

const train = code(read('src', 'components', 'screens', 'TrainScreen.tsx'));
const endgames = code(read('src', 'components', 'screens', 'EndgamesScreen.tsx'));
const puzzles = code(read('src', 'components', 'screens', 'PuzzlesScreen.tsx'));
const practice = code(read('src', 'components', 'screens', 'PracticeScreen.tsx'));
const pieces = code(read('src', 'components', 'chess', 'pieces.tsx'));
const store = code(read('src', 'lib', 'lichessStore.ts'));
const yours = code(read('src', 'components', 'screens', 'GameOpeningsScreen.tsx'));

head('25. A MISTAKE IN TRAINING IS DRAWN, NOT ONLY SENTENCED');
{
  ok(/const \[mistakeUci, setMistakeUci\] = useState<string \| null>\(null\)/.test(train),
    'Train keeps the move that was actually played — necessary because a wrong answer BOUNCES, so '
    + 'the position still shows the question and cannot supply the answer to "what did I just do"');
  ok(/setMistakeUci\(m\.from \+ m\.to \+ \(m\.promotion \?\? ''\)\)/.test(train),
    'and records it on a wrong move, at the only moment it is known');
  ok(/setMistakeUci\(null\)/.test(train),
    'and clears it on the correct move, so a correction never outlives its question');
  ok(/const arrows: BoardArrow\[\] = useMemo\(\(\) => \{/.test(train),
    'CONTROL: Train has an arrows memo at all — it previously passed NO arrows to the board, so a '
    + 'mistake produced a shake, a sound and a sentence and not one square');
  ok(/color: colors\.bad/.test(train) && /color: colors\.gold/.test(train),
    'CONTROL: RED for what was played and GOLD for what the line plays — the two claims are different '
    + 'and either alone is a riddle');
  ok(/arrows=\{arrows\}/.test(train),
    'CONTROL: and the board is given them');
  ok(/if \(phase !== 'playing' \|\| !mistakeUci\) return \[\]/.test(train),
    'CONTROL: no arrows before a mistake — this is a recall test, so the line move on screen before '
    + 'the answer is the answer');
  ok(/Mistake \$\{mistakesThisPass \+ 1\} recorded\. Try that position again/.test(train),
    'and the notice sends the user back to the SAME position, which is where they are: the wrong move '
    + 'was played on a copy and bounced, so "play the line on" described a continuation that never '
    + 'happened and read as if the move had been accepted');
  ok(!/Play the line on/.test(train), 'CONTROL: and the old wording is gone');
  ok(/setMistakesThisPass\(\(n\) => n \+ 1\)/.test(train),
    'CONTROL: the mistake is still COUNTED — the user reported that the cards at the bottom counted '
    + 'it while nothing else happened, so the count was never the bug and must not become the '
    + 'casualty of fixing the drawing');
}

head('26. THE HINT NAMES ONE PIECE, IN ALL FIVE PLACES IT EXISTS');
{
  ok(!/movableSquares/.test(train),
    'Train no longer rings every movable piece — the count of pieces with a legal move is a fact '
    + 'about the position, not a hint, and it was the "selects all the pieces" report');
  ok(/solvingPiece\(fen, sans\[ply\]\)/.test(train),
    'it names the piece the line plays instead, read from the answer the drill already holds');
  ok(!/hintStage >= 1 && !explore \? movableSquares/.test(endgames),
    'CONTROL: Endgames no longer rings the movable set on the first press either');
  ok(/setHintPiece\(square \? \[square\] : movableSquares\(boardFen\)\)/.test(endgames),
    'CONTROL: it names the ONE square the engine would move, and widens only when the engine cannot '
    + 'answer at all — a fallback, not the default');
  ok(/engine\.bestMove\(boardFen, 400, lesson\.engineElo\)/.test(endgames),
    'asked of the engine already running on that screen, because an endgame is a play-out with no '
    + 'stored solution to read');
  ok(/if \(hintStage !== 1 \|\| explore\) return;/.test(endgames) && /cancelled = true/.test(endgames),
    'CONTROL: the reply is cancelled when the position moves on, so a late ring cannot land on a '
    + 'position the search was never about');
  ok(/solvingPiece\(fen, expectedForHint\)/.test(practice),
    'CONTROL: Practice still names one piece — this was the round that fixed it, and a regression '
    + 'here would be invisible to the other four');
  ok(/solvingPiece\(fen, puzzle\?\.solutionSan\?\.\[step\]\)/.test(puzzles)
    && /solvingPiece\(fen, solution\[step\]\?\.san\)/.test(puzzles),
    'CONTROL: and both puzzle tabs do, at the current step of their line');
  ok(!/movableSquares/.test(practice) && !/movableSquares/.test(puzzles),
    'CONTROL: `movableSquares` is not referenced by any screen whose answer is known — the whole '
    + 'reason a hint could be one piece here and eight there');
}

head('27. AN INERT BUTTON IS NOT A BROKEN ONE');
{
  const hintButtons = [...puzzles.matchAll(/label="Show hint"/g)].map((m) => m.index);
  ok(hintButtons.length === 2,
    'CONTROL: there are two hint buttons — the deck and the lesson are separate components, and a fix '
    + 'in one of them is invisible from the other');
  ok(hintButtons.every((at) => {
    const guard = puzzles.slice(0, at).lastIndexOf('{!solved && !failed ? (');
    if (guard < 0) return false;
    const between = puzzles.slice(guard, at);
    return !/: null\}?\)?\}/.test(between) && !/\{!/.test(between.slice(2));
  }),
    'and both sit inside a `!solved && !failed` conditional: the button is HIDDEN once the puzzle is '
    + 'over rather than left on screen doing nothing, because an inert control is indistinguishable '
    + 'from a broken one — the "hint doesnt work in a place" half of the report');
}

head('28. A CAPTURED SQUARE KEEPS THE WORKING PIECE’S COLOUR');
{
  ok(/export function PieceSvg\(\{ piece, size \}: Props\) \{\s*\n\s*return <PieceArtwork key=\{piece\} piece=\{piece\} size=\{size\} \/>;/.test(pieces),
    'the piece renderer is re-keyed by the piece code, which makes React unmount the old native SVG '
    + 'rather than re-point its props');
  ok(/function PieceArtwork\(\{ piece, size \}: Props\) \{/.test(pieces),
    'CONTROL: and the artwork itself moved into that inner component, so the key has something to '
    + 'key');
  ok(/fill="#ffffff"/.test(pieces) && /fill="#000000"/.test(pieces),
    'CONTROL: white and black pieces really are the same geometry with different paint — a pawn on a '
    + 'pawn is one `<Path>` with an identical `d`, which is why only SOME captures went wrong');
}

head('29. THE ENGINE PASS SURVIVES A LAUNCH');
{
  ok(/export async function loadCachedVerdicts/.test(store)
    && /export async function saveCachedVerdicts/.test(store),
    'verdicts can be read back and written — they lived in a `useRef`, which dies with the process, '
    + 'so every cold launch re-bought up to 24 searches per opening');
  ok(/VERDICTS_CACHE_VERSION/.test(store) && /if \(!raw \|\| raw\.v !== VERDICTS_CACHE_VERSION\) return null;/.test(store),
    'CONTROL: the blob is versioned, like every other cache in this file — `GamePosition` gains '
    + 'fields over time and an old blob must read as absent, not as current');
  ok(/if \(Object\.keys\(families\)\.length === 0\) return;/.test(store),
    'CONTROL: it refuses to write an empty map — the state before the pass is not a finding of it, '
    + 'and overwriting good verdicts with nothing would re-buy the wait it removes');
  ok(/if \(analysedRef\.current\.size === 0\) \{\s*\n\s*const storedVerdicts = await loadCachedVerdicts\(user\);/.test(yours),
    'Your Openings restores them on open, BEFORE the cache branch, so a family whose verdicts are '
    + 'known skips the engine on the very first tap');
  {
    /*
     * ORDER, NOT PRESENCE. Both halves of this existed and the screen was still slow on the second
     * account: the restore ran first, the account-switch reset ran second, and the reset threw the
     * verdicts that had just been read into the bin. A gate that only checks that both lines exist
     * cannot see that, which is the whole reason this one compares positions in the file.
     */
    const switchReset = yours.indexOf('analysedRef.current = new Map();');
    const seedAt = yours.indexOf('const storedVerdicts = await loadCachedVerdicts(');
    ok(switchReset >= 0 && seedAt > switchReset,
      'CONTROL: the restore runs AFTER the account-switch reset — the other order discards the new '
      + 'account\'s verdicts on every switch, so it pays for the engine pass while its own answers sit '
      + 'on disk unread');
  }
  ok(/void saveCachedVerdicts\(\s*\n\s*username,/.test(yours),
    'CONTROL: and writes them where they become true — at the publish, which is the same moment the '
    + 'screen learns them');
  ok(/if \(Array\.isArray\(positions\) && positions\.length > 0\)/.test(yours),
    'CONTROL: a stored entry is validated before it is trusted, so a corrupt blob degrades to "not '
    + 'cached" rather than to a family with no positions');
}

head('30. NEW DATA IS PICKED UP, NOT WAITED FOR');
{
  /*
   * The refresh is now a module job in `lib/statsJobs`; the invalidation moved
   * with the work, not with the screen that used to own it.
   */
  ok(/if \(before != null && all\.length !== before\) \{[\s\S]{0,220}?await clearCachedPositions\(name\)/.test(
    read('src', 'lib', 'statsJobs.ts')),
    'a refresh that changed the game count drops the derived positions, so Your Openings re-derives '
    + 'from the new games with no instruction from the user');
  ok(/cached\.gameCount !== have/.test(yours),
    'CONTROL: and the screen can notice a changed game count by itself — one place making this true '
    + 'means the behaviour depends on a caller remembering to clear a cache');
  ok(/export function openingsCacheGameCountIsStale\(/.test(store),
    'the count rule lives with the other staleness rule, so "is this cached list still the truth" has '
    + 'ONE answer rather than whichever screen is asking');
  ok(/if \(typeof gameCount !== 'number'\) return false;/.test(store)
    && /if \(typeof cached\.gameCount !== 'number'\) return false;/.test(store),
    'CONTROL: and unknown is not stale — a missing count on either side cannot be answered, and '
    + 'guessing "rebuild" would throw away a warm cache on no evidence');
  ok(/openingsCacheGameCountIsStale\(cached, gamesNow\?\.games\.length\)/.test(yours)
    && /const gamesNow = await loadCachedGames\(user\);/.test(yours),
    'Your Openings asks it while PAINTING, against the games the last fetch wrote — the painted list '
    + 'is correct about the games it was built from and blind to the ones just refreshed, and '
    + '`openingsCacheIsStale` cannot see that because a refresh moves neither the analysis count nor '
    + 'the clock');
  ok(/const scanNow = await loadScanState\(user\);\s*\n\s*const gamesNow = await loadCachedGames\(user\);\s*\n\s*if \(!aliveRef\.current\) return;/.test(yours),
    'CONTROL: and the games are read before the staleness decision, with the alive check kept between '
    + 'the await and the work — a build that outlives its screen must not touch it');
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
