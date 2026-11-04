/*
 * FIVE REPORTS FROM ONE TESTING PASS.
 *
 *   1. "when i make a mistake it still doesnt show me red arrow for my move and an arrow for the
 *       correct move (neither in course or in practice)"
 *   2. "there is nothing indicating i am in practice a,d how many exercises there are"
 *   3. "when i click hint it sometimes select one piece and sometimes all the pieces"
 *   4. "when i click hint and then play the move it still select the piece (that i should move) in the
 *       next move"
 *   5. "when the user refresh games or try another account the creation of your openings is automatic
 *       (maybe there are new openings played) and also the same for the suggestions move"
 *
 * (1) and (2) are the same class of mistake and came from the same place. Both drill screens bounce
 * a wrong answer straight back, so the position never changes and everything drawn from the position
 * had nothing new to read; and the header counted LINES when the player is asked for one move in one
 * position, which is not a unit they can check their progress against.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
/** Comments blanked, so an explanation cannot satisfy an assertion about behaviour. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

let checks = 0;
let failures = 0;
function ok(cond, label) {
  checks += 1;
  if (cond) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}`); }
}
function head(t) { console.log(`\n${'-'.repeat(78)}\n${t}\n${'-'.repeat(78)}`); }

const practice = code(read('src', 'components', 'screens', 'PracticeScreen.tsx'));
const course = code(read('src', 'components', 'screens', 'CourseScreen.tsx'));
const puzzles = code(read('src', 'components', 'screens', 'PuzzlesScreen.tsx'));
const stats = code(read('src', 'components', 'screens', 'StatsScreen.tsx'));
const statsJobs = code(read('src', 'lib', 'statsJobs.ts'));
const yours = code(read('src', 'components', 'screens', 'GameOpeningsScreen.tsx'));
const hintLib = code(read('src', 'lib', 'hint.ts'));

head('20. A MISTAKE IS DRAWN, IN BOTH DRILL SCREENS');
{
  ok(/const \[mistakeUci, setMistakeUci\] = useState/.test(practice),
    'Practice remembers the move that was actually played, which the position cannot supply because '
    + 'a wrong answer bounces back and leaves it unchanged');
  ok(/setMistakeUci\(m\.from \+ m\.to/.test(practice),
    'and it records the real move on a wrong answer');
  ok(/if \(mistakeUci && lineUci\)/.test(practice),
    'Practice draws from it');
  ok(/startSquare: mistakeUci\.slice\(0, 2\)/.test(practice)
    && /endSquare: mistakeUci\.slice\(2, 4\)/.test(practice),
    'CONTROL: in RED - the move that was played');
  ok(/if \(mistakeUci\.slice\(0, 4\) === lineUci\.slice\(0, 4\)\)/.test(practice),
    'CONTROL: and one arrow, not two, when it IS the move that was asked for');
  ok(/setMistakeUci\(null\)/.test(practice),
    'and it is cleared when the position moves on, because a correction belongs to its question');

  ok(/if \(deviation\) \{/.test(course) && /probe\.move\(deviation\.sans\[0\]\)/.test(course),
    'Course replays the deviation to recover the squares that were played');
  ok(/startSquare: playedUci\.slice\(0, 2\)/.test(course)
    && /color: colors\.bad/.test(course),
    'CONTROL: and draws them in red next to the suggestion, instead of the suggestion alone');
  ok(!/if \(deviation\) return best \? \[best\.arrow\] : \[\];/.test(course),
    'CONTROL: the old one-arrow deviation path is gone - that was the whole report');
}

head('21. THE HEADER SAYS WHAT THIS IS, AND HOW MUCH OF IT IS LEFT');
{
  ok(/Practice · Line/.test(practice),
    'the word Practice is on screen, because arriving from All Openings gave no way to tell a drill '
    + 'from a lesson');
  ok(/Exercise \$\{exercise\.number \|\| 1\}\/\$\{exercise\.total\}/.test(practice),
    'and the exercise counter is shown');
  ok(/if \(\(i % 2 === 0 \? 'w' : 'b'\) !== userColor\) continue;/.test(practice),
    'an exercise is one position where it is the player\'s turn - the same unit `expectedUserMove` '
    + 'asks about, so the number moves exactly when the work does');
  ok(/Line \{Math\.min\(lineIdx \+ 1, studyLineCount \|\| 1\)\}/.test(practice),
    'CONTROL: and the line count is kept - they are different units and both are true, so removing '
    + 'one to add the other would be a trade the user did not ask for');
}

head('22. THE HINT IS ONE PIECE, EVERYWHERE IT EXISTS');
{
  ok(!/movableSquares/.test(practice),
    'CONTROL: Practice no longer rings every movable piece - that count is whatever the position '
    + 'offers, which is why it was sometimes one and sometimes eight');
  ok(/solvingPiece\(fen, expectedForHint\)/.test(practice),
    'it names the piece that plays the line\'s move instead, which the screen already knows');
  ok(/export function solvingPiece/.test(hintLib) && /return \[move\.from\];/.test(hintLib),
    'CONTROL: and that helper returns exactly one square, so the answer cannot vary by position');
  ok(/solvingPiece\(fen, puzzle\?\.solutionSan\?\.\[step\]\)/.test(puzzles)
    && /solvingPiece\(fen, solution\[step\]\?\.san\)/.test(puzzles),
    'both puzzle tabs name the piece for the CURRENT step, not the first move');
}

head('23. THE HINT ENDS WITH THE POSITION IT WAS FOR');
{
  ok((puzzles.match(/setShowHint\(false\);\s*\n\s*setHintStage\(0\);/g) ?? []).length >= 4,
    'the hint is cleared wherever the position actually changes: the player\'s move and the reply, on '
    + 'both tabs');
  ok(/setShowHint\(false\);\s*\n\s*setHintStage\(0\);\s*\n\s*setFen\(c\.fen\(\)\);/.test(puzzles),
    'CONTROL: before the new FEN is stored, so there is no render in between with the old ring on '
    + 'the new board');
}

head('24. YOUR OPENINGS REBUILDS ITSELF WHEN THE DATA CHANGES');
{
  const refreshBlock = statsJobs.slice(
    statsJobs.indexOf('export function startGamesRefresh'),
    statsJobs.indexOf('export interface ScanJobResult'),
  );
  ok(/if \(before != null && all\.length !== before\) \{[\s\S]{0,220}?await clearCachedPositions\(name\)/
    .test(refreshBlock),
  'a refresh that CHANGED the game count drops the derived positions');
  ok((refreshBlock.match(/clearCachedPositions/g) ?? []).length === 1,
    'CONTROL: exactly once, and only inside the guard - a refresh that found nothing new must not '
    + 'make the openings screen rebuild for nothing');

  ok(/loadCachedGames/.test(yours),
    'Your Openings can read how many games it is looking at');
  ok(/cached\.gameCount !== have/.test(yours),
    'and treats a different game count as a different answer - an unanalysed game is exactly the one '
    + 'that can be a new opening, and the analysed-count check alone cannot see it');
  ok(/cached\.analysedGameCount !== analysedNow/.test(yours),
    'CONTROL: the analysed-count check is KEPT as well - the two are different reasons to rebuild');
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);