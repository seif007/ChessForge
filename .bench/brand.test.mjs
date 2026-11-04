/**
 * GATE 1h - the old brand name appears nowhere in this project. Not in code, not in comments, not in
 * the docs, not anywhere. There are no exemptions and no carve-outs.
 *
 * WHAT THIS GATE IS
 * -----------------
 * A rename is exactly the kind of change that is silently undone. Someone copies a line from an old
 * branch, or a new screen imports the old component name from muscle memory, or a comment is pasted
 * from a doc that predates the rename - and nothing complains, because the colour token and the
 * component both still exist in whatever form they were left in. This fails the build instead.
 *
 * THE RENAME, IN THREE PASSES
 * ---------------------------
 * 1. Code. The board component, the brand colour tokens, the docs, and the product token in the
 *    User-Agent Lichess is given. 80 files.
 * 2. Identity. The repository, the checkout directory, the Expo slug, the npm package name, the
 *    Gradle home.
 * 3. Data. The SQLite filename and the fourteen storage keys, plus the Android applicationId.
 *
 * Pass 3 is the one with a price, and it was paid deliberately. Those identifiers are where the
 * user's data is filed, so renaming them opens a fresh database, drops the linked Lichess account
 * and the cached archive scan, and - for the applicationId - makes the app a different app, which
 * `adb install -r` refuses to upgrade into. The cost was put to the owner in plain terms before it
 * was paid, and the answer was to pay it. See the section on the rename in `docs/DEVELOPMENT.md`.
 *
 * WHY THERE IS NOT A PROTECTED LIST
 * ---------------------------------
 * There used to be exemptions here, and every one of them was a judgement made by whoever was
 * holding the keyboard rather than by the person the decision belonged to. That is the actual
 * failure this file now records: **a protected list nobody was asked about is a rename that stopped
 * early and called itself finished.** The owner was asked what the rule should be, and the answer
 * was that not one occurrence should remain - in code, in prose, or anywhere else.
 *
 * So there is no list. One occurrence, in any scanned file, fails the build.
 *
 * ONE EXCEPTION, AND IT CANNOT BE REMOVED
 * ---------------------------------------
 * This file contains the word it searches for. A detector that does not hold its own needle cannot
 * detect, so it is excluded from its own scan - the same trade any lint rule makes about its own
 * source. It is excluded by name in SKIP_FILES below, it is the ONLY file excluded, and the count is
 * printed on every run so the exclusion is visible rather than being somewhere a thing could hide.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/**
 * The old brand name, and the only reason this file is exempt from itself.
 *
 * It is deliberately NOT built from fragments to keep the literal out of this file's own source.
 * A rule you have to de-obfuscate to read is a rule the next person either cannot verify or works
 * around, and "the gate cannot be checked by looking at the gate" is a worse failure than one
 * counted occurrence in a file that is already exempt.
 */
const OLD_BRAND = 'lotus';
const NEEDLE = new RegExp(OLD_BRAND, 'i');

/**
 * Not ours to rename, and mostly not ours to read.
 *
 * `.cxx` was added after the gate started failing on 500+ files under
 * `android/app/.cxx/RelWithDebInfo/…`: CMake's own build records, which contain absolute paths to
 * this machine and are regenerated on every build. They are build output, not source, and a gate
 * that reads them is only reporting on the state of the last compile.
 *
 * Everything else that is excluded is excluded BY NAME and is listed in SKIP_FILES. A directory
 * added here is a hole in the rule, so each one carries the reason it is not a hole.
 */
const SKIP_DIRS = new Set(['node_modules', 'build', '.cxx', '.expo', '.gradle-home', 'probe', '.git']);

/**
 * This file only.
 *
 * It has to WRITE the word in order to police it - the regex above and this comment. A checker that
 * fails on its own source is a checker nobody keeps switched on.
 *
 * `package-lock.json` used to be here too and no longer is. It was exempt while it still contained
 * the name; it does not now, so the exemption was removed rather than left as an unreviewed gap in a
 * rule whose whole purpose is having no gaps. A future dependency whose name trips the gate fails
 * visibly, with the package name in the message, which is a cheaper problem than a silent hole.
 */
const SKIP_FILES = new Set(['brand.test.mjs']);
const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.sh', '.ps1', '.py', '.html', '.xml'];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (EXTS.some((x) => e.name.endsWith(x)) && !SKIP_FILES.has(e.name)) yield p;
  }
}

const files = [...walk(ROOT)];
const offenders = [];

/**
 * Every line, in every file, with no exemptions at all.
 *
 * There used to be two carve-outs here and both are gone. Docs and the README were "scanned and
 * reported but not enforced", on the grounds that failing a build over a sentence in a markdown file
 * does not make anyone rename anything. That was a judgement about what is worth enforcing, made by
 * whoever was holding the keyboard, and the owner has since said otherwise - so `docs/` and
 * `README.md` are enforced now like everything else, and this section has nothing left to skip.
 */
for (const file of files) {
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!NEEDLE.test(line)) return;
    offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
  });
}

/**
 * How many times this file names what it forbids.
 *
 * Printed on every run, counted rather than hidden. The exclusion in SKIP_FILES is the single place
 * the old name is still allowed to exist, so the number of times it is used there is the number a
 * reviewer would otherwise have to take on trust.
 */
const selfCount = fs
  .readFileSync(fileURLToPath(import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => NEEDLE.test(l)).length;

/**
 * THE GATES THEMSELVES ARE IN VERSION CONTROL.
 *
 * Found by looking at what the repository actually contained rather than at what it should have.
 * Every gate from 1c-a to 1n lives inside `.bench/`, which `.gitignore` ignored wholesale on the
 * reasoning that the directory held "harnesses and their scratch bundles". It holds both - and the
 * gates are the part that matters, because `build-apk.sh` REFUSES TO BUILD unless they pass. A gate
 * that is not tracked is a gate that exists only on the machine that wrote it.
 *
 * That is this project's entire defence against its recurring bugs: a check runs on every build. A
 * reviewer who cloned the repository could not have run one of them, and could not have discovered
 * that by reading the build script - it invokes the gates by path, and the paths were not there.
 */
const GATES_BUILD_RUNS = [
  'openingid.test.mjs', 'openingfix.test.mjs', 'movelist.numbering.test.mjs',
  'levels.test.mjs', 'movequality.test.mjs', 'bookindex.diff.test.mjs',
  'brand.test.mjs', 'youropenings.test.mjs', 'hooks.test.mjs',
  'lineloop.test.mjs', 'dailyplan.test.mjs', 'puzzles.test.mjs',
  'engine.boot.test.mjs', 'engine.init.test.mjs', 'qualitysign.test.mjs',
];

const untrackedGates = [];
let gitAvailable = true;
try {
  const tracked = new Set(
    execFileSync('git', ['ls-files', '--', '.bench', 'scripts/bundlecheck.py'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean),
  );
  for (const g of GATES_BUILD_RUNS) if (!tracked.has(`.bench/${g}`)) untrackedGates.push(`.bench/${g}`);
  if (!tracked.has('scripts/bundlecheck.py')) untrackedGates.push('scripts/bundlecheck.py');
} catch {
  // No git in this environment (a tarball, a build image). Skipped rather than failed: whether
  // this working copy is a git checkout is not a property of the product.
  gitAvailable = false;
}

console.log(`  files scanned : ${files.length}`);
console.log(`  lines naming the old brand outside this gate: ${offenders.length}`);
console.log(`  this file necessarily names it ${selfCount}x to police it (excluded, and counted here)`);

if (offenders.length === 0 && (untrackedGates.length === 0 || !gitAvailable)) {
  console.log(`  gates in the repository : ${GATES_BUILD_RUNS.length}${gitAvailable ? '' : ' (unchecked: no git here)'}`);
  console.log('\n  OK - no old-brand name survives anywhere in the project');
  process.exit(0);
}

if (offenders.length > 0) {
  console.log(`\n  ${offenders.length} line(s) name the old brand:`);
  for (const o of offenders.slice(0, 30)) console.log('    ' + o);
  if (offenders.length > 30) console.log(`    ... and ${offenders.length - 30} more`);
}

if (untrackedGates.length > 0) {
  console.log(`\n  ${untrackedGates.length} gate(s) the build depends on are NOT in version control:`);
  for (const g of untrackedGates) console.log(`    ${g}`);
  console.log('    A gate nobody can clone is a gate that only runs on the machine that wrote it.');
}

process.exit(1);