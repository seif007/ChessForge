/**
 * GATE 1k - a line the user opened is the line the user keeps.
 *
 * THE REPORT, AND WHY IT IS ONE BUG AND NOT FOUR
 * ==============================================
 *
 * The user, after four rounds of fixes on this screen:
 *
 *     "as always you keep deliver the same mistakes : when i tried an opening in
 *      'your openings' it plays automatically 3 times then i get a different new position
 *      to play. and of course after you fix it wi will get the 2 moves line complete error,
 *      then we will get the crashing error and we will stay in that circle !"
 *
 * He is right, and the reason is that three of the reports are ONE defect:
 *
 *   1. "plays automatically 3 times"
 *   2. "then I get a different new position to play"
 *   3. "I play one or two moves and it says the line is done"
 *
 * THE MECHANISM, in full, because each earlier fix stopped at one link in this chain:
 *
 *   - The user taps a line. It is identified by `{kind:'alt', index:n}` — a POSITION in
 *     `family.alternates`.
 *   - The engine pass runs. To turn a question-free walkthrough into a quiz it calls
 *     `publish()`, which calls `buildFamilyLines(...)` again. That re-runs the POOL ROTATION,
 *     and the rotation PREFERS POSITIONS THAT CARRY DECISIONS.
 *   - So `alternates` is not merely re-derived, it is a DIFFERENT LIST. And it is published
 *     TWICE - once for the head of the sample, once for the tail. Two swaps.
 *   - `activeLine` is a new array, so the re-sync effect runs. It compares SANs, disagrees,
 *     and calls `startLine()`: walk from move 1 again.
 *     => the initial walk, plus one per publish. "Three times."
 *   - `resolveLine` cannot find the recorded moves in the new list, so it falls back to
 *     `alternates[lineRef.index]` — which now names somebody else's move order.
 *     => "a different new position to play."
 *   - And the line the rotation chose is a SHORT DECISION-BEARING FRAGMENT, because fragments
 *     are what carry decisions.
 *     => "one or two moves and it says done." The 8-ply floor could not catch this, and the
 *        reason matters: the line genuinely WAS that short. Nothing was lying. The floor was
 *        honest and the line was wrong.
 *
 * That last point is why this gate exists rather than a taller floor. Every previous fix
 * attacked one link: the index (fixed, then bypassed by the fallback), the SAN comparison
 * (fixed, then fed a list it could not match), the floor (added, guarding a line that was
 * short for a reason upstream of it). The defect is the ROTATION RUNNING AT ALL under a live
 * session.
 *
 * WHAT IS ASSERTED
 * ----------------
 * The engine pass must not change the line a session is playing. Not "must not replay it" -
 * must not change it, because a changed line is what produces all three symptoms at once.
 *
 * This is checked against the source, because the defect lives in an effect inside a component
 * and there is no pure function to call. That is stated plainly rather than dressed up: a source
 * check cannot prove the app behaves, only that the mechanism is gone. The device is still the
 * test for behaviour, and this gate is what stops the mechanism being reintroduced before a
 * forty-minute build is spent finding out.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREEN = path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx');

let checks = 0;
let failures = 0;
function ok(cond, label, detail) {
  checks += 1;
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    if (detail) for (const l of String(detail).split('\n')) console.log(`          ${l}`);
  }
}
function head(t) { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }

const src = fs.readFileSync(SCREEN, 'utf8');
const lines = src.split('\n');

/**
 * Blank out comments, preserving offsets.
 *
 * This file is mostly prose explaining the bug, and a check that scans raw source will find the
 * function calls it is looking for INSIDE the explanation of why they were removed. The first
 * version of the `startLine()` ordering check did exactly that and reported a correctly-placed
 * guard as misplaced.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/** The lines of the `publish` function body, which is where the rebuild happens. */
function bodyOf(fnName) {
  return bodyOfFrom(src, `const ${fnName} = `);
}

/** As `bodyOf`, but against an arbitrary copy of the source — used by the control section. */
function bodyOfFrom(text, marker) {
  const ls = text.split('\n');
  const at = ls.findIndex((l) => l.includes(marker));
  if (at < 0) return null;
  let depth = 0;
  let started = false;
  const out = [];
  for (let i = at; i < ls.length; i += 1) {
    out.push(ls[i]);
    for (const ch of ls[i]) {
      if (ch === '{') { depth += 1; started = true; }
      else if (ch === '}') depth -= 1;
    }
    if (started && depth <= 0) return out.join('\n');
  }
  return out.join('\n');
}

const publish = bodyOf('publish');
const publishCode = publish === null ? null : stripComments(publish);

// ---------------------------------------------------------------------------
head('1. THE ENGINE PASS CANNOT REBUILD THE FAMILY UNDER A LIVE SESSION');

/*
 * The rebuild is the defect. Everything else is a consequence, so this is checked first and on its
 * own: `setFamilies` — the call that replaces the arrays the line is resolved from — must be
 * unreachable while a session is on the board.
 */
ok(publish !== null, 'the `publish` function is found, so this gate is checking the real thing');

if (publish) {
  /*
   * A guard has to come BEFORE the rebuild, and it has to name the session. Ordered by position
   * rather than by presence: a guard placed after `setFamilies` is a comment, not a guard, and a
   * version of this file has already had a guard in the wrong place.
   *
   * The window searched is the CODE. The long note above the guard quotes `buildFamilyLines`,
   * `resolveLine` and the pool rotation, so a raw scan finds all of them in the explanation.
   */
  const guardAt = publishCode.search(/if \(sessionLiveRef\.current\) return;/);
  const rebuildAt = publishCode.search(/setFamilies/);

  ok(guardAt >= 0,
    'the rebuild is guarded by whether a SESSION is live, not by whether the user has answered',
    publish.trim().split('\n').slice(0, 3).join('\n'));
  ok(rebuildAt >= 0, 'the rebuild itself is still there — it is deferred, not deleted');
  ok(guardAt >= 0 && rebuildAt > guardAt,
    'and the guard comes BEFORE the rebuild, so it can actually prevent it',
    `guard at ${guardAt}, rebuild at ${rebuildAt}`);

  /*
   * `answeredRef` ALONE is the bug, and this asserts the specific substitution that was wrong: the
   * last guard before the rebuild must name the session. `answeredRef` may still be checked — it
   * says something true and useful — but a run of guards that never mentions `sessionLiveRef` is
   * the defect, and the name `answeredRef` reads as though it would cover this case.
   */
  const beforeRebuild = guardAt >= 0 ? publishCode.slice(0, rebuildAt) : publishCode;
  ok(/sessionLiveRef\.current/.test(beforeRebuild),
    'the guard immediately before the rebuild names the SESSION, not just `answeredRef`',
    beforeRebuild.split('\n').filter((l) => l.includes('if (') && l.includes(') return;')).join('\n'));
}

// ---------------------------------------------------------------------------
head('2. A SESSION IS NOT SWAPPED OUT FROM UNDER THE BOARD');

{
  /*
   * Two other doors into the same room. The rebuild is stopped at the source; these are the
   * consequences, and a fix that only closes the front door leaves them open.
   */

  // The re-sync effect must not restart on a DISAGREEMENT while a session is live.
  const syncAt = src.indexOf('if (syncedLineRef.current === activeLine) return;');
  ok(syncAt > 0, 'the re-sync effect is found');
  /*
   * Search the effect's CODE, not its prose. The first version of this check scanned raw source for
   * `startLine()` and found the one in the comment block that explains what the effect used to do -
   * so it reported the guard as misplaced when it was correctly placed. A gate that reads its own
   * documentation as code is worse than no gate, so comments are blanked first.
   */
  const syncWindow = syncAt > 0 ? stripComments(src.slice(syncAt, syncAt + 4000)) : '';
  const startLineCall = syncWindow.indexOf('startLine()');
  const sessionGuard = syncWindow.indexOf('if (sessionLiveRef.current) return;');
  ok(sessionGuard >= 0,
    'the re-sync effect refuses to restart while a session is live');
  ok(sessionGuard >= 0 && startLineCall > sessionGuard,
    'and that refusal comes before its `startLine()`, so the restart cannot happen',
    `guard at ${sessionGuard}, startLine at ${startLineCall}`);

  // The index fallback must not substitute a different line mid-session.
  const resolveAt = src.indexOf('const resolved = resolveLine(');
  ok(resolveAt > 0, 'the `activeLine` resolver is found');
  const resolveWindow = resolveAt > 0 ? stripComments(src.slice(resolveAt, resolveAt + 2600)) : '';
  const indexFallback = resolveWindow.indexOf('openFamily.alternates[lineRef.index]');
  const holdWindow = resolveWindow.indexOf('lastLineRef.current.length > 0');
  ok(holdWindow >= 0,
    'the index fallback holds the current line while a session is live');
  ok(indexFallback < 0 || (holdWindow >= 0 && holdWindow < indexFallback),
    'and does so BEFORE the index fallback, which is the line that was never chosen',
    `hold at ${holdWindow}, index fallback at ${indexFallback}`);
}

// ---------------------------------------------------------------------------
head('3. THE SESSION FLAG IS SET WHERE A SESSION ACTUALLY STARTS');

/*
 * A guard that is never set is a guard that does not exist, and one that cannot be CLEARED is worse
 * than either: the app stops learning and reports nothing.
 *
 * Both mistakes were made in the writing of this fix, and this section is what catches them. The
 * flag was first written at the BOTTOM of an effect whose first line is
 * `if (phase !== 'play') return;` — so leaving the play phase skipped the assignment and the flag
 * stayed `true` for the rest of the screen's life. Nothing threw, nothing logged, and the engine
 * silently stopped applying verdicts to any opening, ever again.
 */
{
  const code = stripComments(src);
  const set = code.match(/sessionLiveRef\.current\s*=\s*[^;]+;/g) ?? [];
  ok(set.length >= 1, `the session flag is assigned (${set.length} write(s))`);
  ok(set.some((w) => /phase\s*===\s*'play'/.test(w)),
    'it is derived from the PLAY PHASE, so it covers a sibling switch as well as the tap',
    set.join(' | '));
  ok(set.length === 1,
    'in exactly ONE place — two writers would let one of them win and neither would be reviewed',
    set.join(' | '));

  /*
   * AND THAT ONE PLACE IS ABOVE THE EFFECT'S EARLY RETURN. This is the check that catches a guard
   * which can never be turned off, and it is the one that would have caught the bug above.
   *
   * `code`, not `src`: the note explaining this very defect contains the string
   * `if (phase !== 'play') return;` in prose, so an unstripped scan finds an early return in the
   * middle of a comment and concludes the guard is misplaced. It is the same mistake the first
   * version of §2 made, in the other direction.
   */
  const assign = "sessionLiveRef.current = phase === 'play';";
  const earlyRet = "if (phase !== 'play') return;";
  const assignAt = code.indexOf(assign);
  ok(assignAt > 0, 'the assignment is found in the code');
  const effectAt = code.lastIndexOf('useEffect(() => {', assignAt);
  const earlyReturnAt = code.indexOf(earlyRet, effectAt);
  ok(effectAt >= 0 && assignAt > effectAt,
    'the assignment is inside an effect',
    `effect at ${effectAt}, assignment at ${assignAt}`);
  ok(earlyReturnAt > effectAt && assignAt < earlyReturnAt,
    "and it comes BEFORE that effect's `if (phase !== 'play') return;`",
    `effect at ${effectAt}, early return at ${earlyReturnAt}, assignment at ${assignAt}`);
}

// ---------------------------------------------------------------------------
head('4. THE FLOOR STILL STANDS, AND IS NOT WHAT IS BEING RELIED ON');

/*
 * The 8-ply floor stays, and the point of keeping the check here is that it could NOT have caught
 * this bug. The rotated line was genuinely that short - the rotation prefers decision-bearing
 * fragments - so a floor on length was honest and irrelevant. Worth keeping in view: a real check
 * that is the wrong tool is still a real check, and the failure was never the absence of one.
 */
{
  const yo = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'yourOpenings.ts'), 'utf8');
  const m = /export const MIN_DRILL_PLIES = (\d+)/.exec(yo);
  ok(!!m && Number(m[1]) >= 8,
    `the short-line floor is still defined at 8 plies or more (${m ? m[1] : 'not found'})`);

  const bench = fs.readFileSync(path.join(ROOT, '.bench', 'youropenings.test.mjs'), 'utf8');
  ok(/no rank offers a line shorter than/.test(bench),
    'and GATE 1i still checks it against the real corpus, so this is not where it is enforced');
}

// ---------------------------------------------------------------------------
head('5. THE GATE IS NOT VACUOUS');

/*
 * Every assertion above is about a pattern being ABSENT or ORDERED, which is exactly the shape of
 * a check that passes on a file it cannot read. So: strip the guards from an in-memory copy and
 * require the assertions to fail. If they still pass, this gate is decoration.
 */
{
  const weak = stripComments(src);

  // (a) Remove the guards. The rebuild must then be reachable and unprotected.
  const noGuards = weak
    .replace(/if \(sessionLiveRef\.current\) return;/g, '')
    .replace(/if \(sessionLiveRef\.current && lastLineRef\.current\.length > 0\) \{/g, 'if (false) {');
  const pubNoGuards = bodyOfFrom(noGuards, 'const publish = ');
  ok(pubNoGuards !== null
    && !/sessionLiveRef\.current/.test(pubNoGuards)
    && /setFamilies/.test(pubNoGuards),
    'CONTROL: with the session guard removed, the rebuild is reachable and unprotected');

  // (b) Remove the flag assignment. A guard nothing writes is a guard that does not exist.
  const noFlag = weak.replace(/sessionLiveRef\.current = phase === 'play';/g, '');
  ok(!/sessionLiveRef\.current = phase/.test(noFlag)
    && /sessionLiveRef\.current/.test(noFlag),
    'CONTROL: a guard whose flag is never assigned is detected as unassigned');

  // (c) Move the assignment BELOW the effect's early return — the bug this gate was written for.
  const earlyRet = "if (phase !== 'play') return;";
  const assign = "sessionLiveRef.current = phase === 'play';";
  const retAt = weak.indexOf(earlyRet);
  const assignAt = weak.indexOf(assign);
  const moved = retAt >= 0 && assignAt > retAt
    ? weak.slice(0, assignAt) + earlyRet + ' ' + assign + weak.slice(assignAt + assign.length)
    : null;
  ok(moved !== null,
    'CONTROL: the assignment can be relocated below the early return for the test');
  if (moved) {
    const movedAssign = moved.indexOf(assign);
    ok(movedAssign > moved.indexOf(earlyRet),
      'CONTROL: and once below it, it is unreachable — which is the defect §3 exists to catch',
      `assignment at ${movedAssign}, early return at ${moved.indexOf(earlyRet)}`);
  }
}

head('6. NO REF IS WRITTEN BEFORE IT IS DECLARED');

/*
 * The crash this section was added for, verbatim from the device:
 *
 *     TypeError: Cannot set property 'current' of undefined
 *
 * `activeLine` is a `useMemo`, and a `useMemo` callback runs INLINE during the render pass, at the
 * line where it is written. A ref written inside it must therefore already exist. Both refs were
 * declared 250 and 470 lines further down the component, next to the other line-identity refs,
 * which is where they tidily belong and where they do not work.
 *
 * WHY NOTHING ELSE CAUGHT IT
 *
 *   - `tsc` is clean. A use-before-declaration inside a closure is a legal program; the type
 *     checker has nothing to say about it.
 *   - GATE 1j is clean. The hooks are all called unconditionally and in order; the refs are
 *     perfectly good hooks. The bug is not the rules of hooks, it is that this hook's RESULT is
 *     consumed earlier in the function than it is created.
 *   - It does not crash on arrival. It crashes on the first tap of an opening - the first render
 *     that reaches the `useMemo`. So the screen paints, looks correct, and dies on use. Again the
 *     failure presents as a missing feature rather than as a defect.
 *
 * The release bundle is what makes it a `TypeError` rather than a `ReferenceError`: Metro transpiles
 * `const` to `var`, so the binding exists and is `undefined` rather than being in the temporal dead
 * zone. A dev build would have failed differently and just as silently.
 */
{
  const code = stripComments(src);
  const ls = code.split('\n');
  const at = (i) => ls.slice(0, i).join('\n').length;

  /*
   * The lines a `useMemo`/`useEffect` CALLBACK body occupies, mapped back to top-level line
   * numbers. Effects are excluded on purpose: an effect body runs after the whole component body,
   * so a ref declared anywhere in the component is available to it. A `useMemo` body is the
   * opposite - it runs at the point of the call - which is the whole of this check.
   */
  const earlyUse = [];
  for (let i = 0; i < ls.length; i += 1) {
    // A type annotation may sit between the name and the `=`, as in
    // `const activeLine: BuilderStep[] = useMemo(...)`. The first version of this regex did not
    // allow for it, so it did not find `activeLine` — the very memo the bug was in — and the check
    // below it passed over an empty set, which is how a vacuous check reports success.
    const m = /const\s+(\w+)\s*(?::[^=]*?)?=\s*use(Memo|Callback)\s*\(/.exec(ls[i]);
    if (!m) continue;
    const name = m[1];
    if (!name) continue;                       // `useEffect(() => {` is an effect, not a memo
    /*
     * FIND THE CALLBACK BODY — BOTH SHAPES OF IT.
     *
     * A block body (`() => { ... }`) spans from its opening brace to the matching close brace, and
     * that is all this loop used to look for. A CONCISE body (`() => withVerdicts(resolvedLine,
     * livePositions)`) has no braces at all, and the old loop simply skipped those memos — so when
     * `activeLine` was rewritten concisely (the verdict join is one expression) the memo this whole
     * check exists for fell out of the located set, and the assertion below is what noticed. A
     * memo the check cannot see is not a memo that passed.
     *
     * The body brace is the `{` after the arrow (`=> {`), NOT the first `{` in the call — an object
     * type in the parameters (`(m: { from: string }) =>`) or an object-literal expression would
     * otherwise be mistaken for the body and the brace scan would close on the wrong `}`.
     */
    let j = i; let paren = 0; let seen = false; let bodyAt = -1; let callEnd = -1;
    for (; j < ls.length; j += 1) {
      for (const ch of ls[j]) {
        if (ch === '(') { paren += 1; seen = true; }
        else if (ch === ')') paren -= 1;
      }
      if (bodyAt < 0 && /=>\s*\{/.test(ls[j])) bodyAt = j;
      if (seen && paren <= 0) { callEnd = j; break; }
    }
    if (callEnd < 0) continue;
    if (bodyAt < 0) {
      // concise body: the expression lines are the body, and nothing in them runs later than the
      // call site — the property this check is about.
      earlyUse.push({ name, from: i + 1, to: callEnd + 1 });
      continue;
    }
    // the block body ends at the matching close brace
    let depth = 0; let end = bodyAt;
    for (let k = bodyAt; k < ls.length; k += 1) {
      for (const ch of ls[k]) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1; }
      if (depth === 0) { end = k; break; }
    }
    earlyUse.push({ name, from: i + 1, to: end + 1 });
  }

  const foundNames = earlyUse.map((u) => u.name).join(', ');
  ok(earlyUse.some((u) => u.name === 'activeLine'),
    `the in-line useMemos are located (${earlyUse.length} found: ${foundNames})`);

  const offenders = [];
  for (const ref of ['sessionLiveRef', 'lastLineRef']) {
    const decl = ls.findIndex((l) => new RegExp(`const\\s+${ref}\\s*=`).test(l)) + 1;
    ok(decl > 0, `${ref} is declared somewhere in the component (line ${decl})`);
    for (const u of earlyUse) {
      for (let k = u.from; k <= u.to; k += 1) {
        if (new RegExp(`\\b${ref}\\b`).test(ls[k - 1]) && k < decl) {
          offenders.push(`${ref} is used at line ${k}, inside useMemo('${u.name}'), but declared at line ${decl}`);
        }
      }
    }
  }
  ok(offenders.length === 0,
    'and is declared BEFORE every useMemo body that touches it',
    offenders.join('\n'));

  // And the whole file, not just the two refs this bug was about.
  const anyEarly = [];
  for (const u of earlyUse) {
    for (let k = u.from; k <= u.to; k += 1) {
      for (const m of ls[k - 1].matchAll(/\b([a-zA-Z_$][\w$]*)Ref\.current\s*=/g)) {
        const name = m[1];
        const decl = ls.findIndex((l) => new RegExp(`const\\s+${name}\\s*=\\s*useRef`).test(l)) + 1;
        if (decl > 0 && k < decl) {
          anyEarly.push(`${name}Ref written at line ${k} (useMemo '${u.name}') but declared at ${decl}`);
        }
      }
    }
  }
  ok(anyEarly.length === 0,
    'CONTROL: no ref anywhere in the file is written before its declaration',
    anyEarly.join('\n'));

  /*
   * AND THE CHECK HAS TEETH. Relocate each declaration to the end of the component in memory and
   * require the offenders list to become non-empty — which is the state the file was actually in
   * when the device reported `Cannot set property 'current' of undefined`.
   */
  for (const ref of ['sessionLiveRef', 'lastLineRef']) {
    const declLine = ls.findIndex((l) => new RegExp(`const\\s+${ref}\\s*=\\s*useRef`).test(l));
    const moved = [...ls];
    moved.splice(declLine, 1);
    moved.push(ls[declLine]);                        // same statement, at the end
    const movedLs = moved;
    const movedEarly = [];
    for (const u of earlyUse) {
      for (let k = u.from; k <= u.to; k += 1) {
        if (new RegExp(`\\b${ref}\\b`).test(movedLs[k - 1] ?? '') && k < movedLs.length - 1) {
          movedEarly.push(`${ref} at line ${k} vs declaration at ${movedLs.length - 1}`);
        }
      }
    }
    ok(movedEarly.length > 0,
      `CONTROL: moving \`${ref}\` to the bottom of the component IS detected`,
      movedEarly.join('\n'));
  }
}

head('7. PROGRESS MOVES, MISTAKES REPLAY, AND A TEST IS A TEST');

/*
 * Three things the user asked for in one message, all in the same screen:
 *
 *   - *"there is no progress shown ( always 0%)"*
 *   - *"when i complete a line i want you to give me random positions like the train do (from what i
 *      studed: the current line and the previous ones)"*
 *   - *"when i make a mistake when i am learning (not train mode), the app shows me that it is wrong
 *      and what is the right move and then repeat the movement automatically until it get to the
 *      wrong move and let me play it myself then we contine"*
 *
 * None of them is a rendering change, and that is the point of checking them here. The 0% is a
 * MISSING WRITER: every ring reads `positions[key].mastery` and only the Train path wrote that map,
 * so a line drilled to the end moved nothing. A display fix would have looked like work and changed
 * nothing.
 */
{
  const code = stripComments(src);

  // (a) A WRITER FOR THE RINGS, in the store rather than in this screen.
  const store = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'store.ts'), 'utf8');
  ok(/recordPositions:/.test(store), 'the store exposes `recordPositions`');
  // The ACTION BODY, not a character window. The note explaining why the action exists is 5,000
  // characters long and sits between the action and the call, so any window short enough to be
  // meaningful is also too short to reach it — and a check that has to be loosened until it passes
  // is a check that will pass on a file it cannot read.
  //
  // The marker includes `=> {` so it finds the IMPLEMENTATION and not the type declaration in the
  // interface, which carries the same name and no body at all. Matching the name alone found the
  // declaration, and the check then reported a correct file as broken.
  const storeCode = stripComments(store);
  const recordBody = bodyOfFrom(storeCode, 'recordPositions: (rows: { key: string; correct: boolean; studyId?: string }[]) => {');
  ok(recordBody !== null && /mergePositionMastery/.test(recordBody),
    'and it moves mastery through the shared curve, not a second copy of it');

  /*
   * ONE COPY OF THE CURVE. There were two and they disagreed — the optimistic in-memory merge used a
   * flat `+0.25` and the persistence pass used a decaying step — so the ring the user watched while
   * drilling was computed differently from the one stored, and moved on the next launch. That is why
   * the assertion is on the COUNT of the formula, not on its presence.
   */
  const formula = /Math\.max\(0\.08, \(1 - prev\.mastery\) \* 0\.25\)/g;
  const hits = (store.match(formula) ?? []).length;
  ok(hits === 1,
    'the mastery curve exists in exactly ONE place in the store, not two that can drift',
    `found ${hits} — the first version of this check read the same file twice and always said 2`);

  ok(/recordStepProgress\(/.test(code), 'the drill records a step');
  ok(/recordStepProgress\(step, false\)/.test(code),
    'a wrong move is recorded as wrong, whether or not he retries it');
  ok(/recordStepProgress\(step, true\)/.test(code), 'and a right move is recorded as right');

  // (b) THE MISTAKE REPLAY, and the two things that make it a correction rather than a message.
  // Tolerates the record being written across several lines, which it now is: the mistake carries
  // both moves so they can be drawn as arrows, and a one-line regex for `san:` would fail on the
  // formatting rather than on the behaviour.
  ok(/setMistake\(\{[\s\n]*ply: stepIdx,[\s\n]*san: /.test(code),
    'a wrong move records WHERE it happened and WHAT belongs there');
  ok(/setMistake\(\{[\s\S]*?playedUci: uci,[\s\S]*?recommendUci: /.test(code),
    'CONTROL: and BOTH moves as UCI, so a mistake can be drawn on the board and not only described');
  ok(/replayTo\(activeLine, stepIdx\)/.test(code),
    'and the line is played back to that position');
  ok(/interactive=\{!done && !replaying && !awaitingVerdict && pendingFen == null\}/.test(code),
    'the board is not his while the moves are being replayed, NOT while the engine is '
    + 'still checking the line either — a touch there had no step to land on and was silently '
    + 'rejected ("i cant play any move") — and not while the position his own move reached '
    + 'is being caught up with (a second move queued behind the first would be graded twice)');
  /*
   * THE FAMILY PASS IS BOUNDED IN TIME, NOT ONLY IN COUNT.
   *
   * The wait the user hit — "it took too much in 'checking our ideas here' then i
   * get stuck there" — was this pass: up to 24 depth-10 MultiPV-3 searches, plus a
   * probe per position, and the host ignored the requested movetime whenever a depth
   * was set, so each search ran to completion however long that took on the phone.
   * The screen must ask for a hard cap per search; the host turns it into
   * `go depth N movetime M`, which stops at whichever limit lands first. The cap must
   * also be a REAL budget: a token constant or a minute-long "cap" would leave the
   * freeze in place.
   *
   * The probe now has its OWN, smaller cap: it ranks no alternatives, so it must not
   * pay the MultiPV search's price. Both are asserted because either one regressing
   * to an unbounded search is the same freeze again.
   */
  const capMatch = /const ENGINE_SEARCH_CAP_MS = (\d+);/.exec(code);
  const cap = capMatch ? Number(capMatch[1]) : NaN;
  ok(Number.isFinite(cap) && cap >= 100 && cap <= 500,
    'the main per-search cap is a real, sub-second budget — not a token value and not minutes',
    capMatch ? `(${capMatch[1]}ms)` : '(no constant found)');
  ok(/movetime: ENGINE_SEARCH_CAP_MS,/.test(code),
    'and the MultiPV search carries it, so "checking" cannot become a freeze');
  const probeMatch = /const ENGINE_PROBE_CAP_MS = (\d+);/.exec(code);
  const probe = probeMatch ? Number(probeMatch[1]) : NaN;
  ok(Number.isFinite(probe) && probe > 0 && probe <= cap,
    'the played-move probe has its own cap, no larger than the main search',
    probeMatch ? `(${probeMatch[1]}ms)` : '(no constant found)');
  ok(/probeMovetime: ENGINE_PROBE_CAP_MS,/.test(code),
    'and every family-check call passes it, so an unranked move cannot cost a full search');
  ok(/stepIdx >= replayTarget\) setReplayTarget\(null\)/.test(code),
    'and the board unlocks when the replay lands — otherwise it stays locked for the session');

  /*
   * THE RETRY IS GRADED, NOT SWALLOWED. Without this the whole feature is a message and a rewind: the
   * user would be walked back to the position and any move at all would carry on as though it were
   * right.
   */
  const handler = bodyOfFrom(code, 'const onBoardMove = useCallback(');
  ok(handler !== null && /if \(mistake\)/.test(handler),
    'the move handler has a branch for a position being retried');
  ok(handler !== null && /san !== mistake\.san/.test(handler),
    'which compares the move against the one that belongs there');
  ok(handler !== null && /Not yet/.test(handler),
    'and says so rather than ignoring the attempt');

  // (c) A TEST GRADES DIFFERENTLY FROM LEARNING, AND ONLY A TEST DOES.
  ok(/if \(testing && choice\.recommendUci && !isOurs\)/.test(code),
    'in a test, anything but the move we teach is a mistake');
  ok(/recordStepProgress\(step, isOurs \|\| !testing\)/.test(code),
    'and learning still records the user\'s own move as correct, because the repertoire is his');
  ok(/testPoolRef\.current = \[/.test(code),
    'a finished line joins the test pool');
  ok(/askablePositions/.test(code),
    'and only real positions are asked about — the predicate now lives in one function, which is what'
    + ' stopped the button and the handler disagreeing (GATE 1i §10 tests it)');
  ok(/lastTestRef\.current/.test(code),
    'a test does not ask the same position twice running when it has a choice');
  ok(/\{testing \? 'Test · ' : ''\}/.test(code),
    'the header says when a test is running, so grading cannot look arbitrary');
  ok(/onPress=\{endTest\}/.test(code), 'and there is a way out of a test while it is running');

  // (d) THE OPENINGS TAB COUNTS ADVANCE TOO — the user reported 0 there as well.
  /*
   * *"in the apps openings there is no advancement for your progress ( always 0)"* — which is the
   * same missing writer one level up. `0/114 started` counts studies with `attempts > 0`, and only a
   * Train session ever wrote an attempt, so the screen where the user spends his time could not move
   * the number.
   */
  ok(/recordStudiedStudies/.test(code), 'a completed line records the studies it covered');
  ok(/recordStudiedStudies\(activeLine\.map\(\(s\) => s\.moveSan\)\)/.test(code),
    'and it is called with the line that was actually played');

  /*
   * HONESTLY, WHICH IS THE PART THAT MATTERS. A study is credited when the line REACHED it, not
   * because the line belongs to the same opening — "you drilled a Sicilian line" is not evidence you
   * have touched the Sveshnikov, and crediting all 114 on the first line would make the number move
   * and mean nothing. So the credit comes from the study lookup, not from the opening id.
   */
  const cover = bodyOfFrom(code, 'const studiesCoveredBy = useCallback(');
  ok(cover !== null && /studyForLine\(sans\)/.test(cover),
    'a study is credited from the study the line actually reaches, not from the opening alone');
  ok(!/openingId.*forEach.*allStudies/.test(cover),
    'and NOT by crediting every study in the opening');

  /*
   * AND IT IS NOT SCORED AS A SESSION. `applyResult` is the shared writer so a study cannot acquire
   * two definitions of "attempted", but it also adds XP and touches the streak. Zero on both, or the
   * drill would pay out every time a line was finished.
   */
  const study = bodyOfFrom(code, 'const recordStudiedStudies = useCallback(');
  ok(study !== null && /xp: 0/.test(study), 'and it awards no XP');
  ok(study !== null && /correct: 0/.test(study) && /total: 0/.test(study),
    'and reports no quiz result, so it is not scored as a session');

  // (e) A BLUNDER IS CORRECTED WHILE LEARNING, NOT ONLY IN A TEST.
  /*
   * *"make sure the app gives me also positions in the openings where i make a mistake and it shows
   * me that it is a mistake and tell me what to play instead (not just give me a good move of mine and
   * suggests another move)"*.
   *
   * The `else` branch used to say "kept, your own move - our move was X" with `ok: true` for EVERY
   * deviation. A position the engine rates a blunder and a sideline the user prefers were the same
   * shape of event to that code: a move that throws away a queen got the same tone and the same green
   * tick as a move he simply likes. The engine's own verdict was on the step and was not read there —
   * it was read in `yourOpenings.ts`, for the ring, and nowhere the user could see it.
   */
  const h = bodyOfFrom(code, 'const onBoardMove = useCallback(');
  ok(h !== null && /choice\.verdict/.test(h),
    'the decision branch reads the engine verdict the step already carries');
  ok(h !== null && /verdict === 'mistake' \|\| verdict === 'blunder'/.test(h),
    'and treats a mistake or a blunder as a mistake');
  ok(h !== null && /isRealMistake/.test(h) && /!testing && isRealMistake/.test(h),
    'and the correction happens while LEARNING, not only in a test');
  ok(h !== null && /Play \$\{want\} instead/.test(h),
    'and it tells him what to play instead, which is what he asked for');
  ok(h !== null && /blunder/.test(h) && /That is a blunder/.test(h),
    'a blunder is named as a blunder, in different words from a mistake');

  /*
   * AND THE BLUNDER IS NOT ADOPTED. The only adoption at that step is the corrected move, because the
   * correction returns before `adopt` is reached. Otherwise the app would tell him a move is wrong
   * and keep it in his repertoire in the same breath.
   */
  const mistakeBlock = h === null ? '' : h.slice(
    h.indexOf('!testing && isRealMistake'),
    h.indexOf('recordStepProgress(step, isOurs || !testing)'),
  );
  ok(mistakeBlock.length > 0 && !/adopt\(/.test(mistakeBlock),
    'and the mistake itself is NOT written to his repertoire');
  ok(mistakeBlock.includes('return false'),
    'the step returns before the normal adoption path runs');

  /*
   * BELOW THE THRESHOLD IT IS STILL HIS MOVE. The repertoire is his, and the app is showing him
   * where he actually goes. Only above the threshold is it a mistake, or the app would be lecturing
   * him about a preference — and the wording says which of the two it is.
   */
  ok(h !== null && /is your own move/.test(h),
    'a deviation that is not a mistake is still recorded as his own move');
  ok(!/kept, your own move/.test(code),
    'CONTROL: the old wording, which covered blunders as well as preferences, is gone');

  /*
   * A TEST SHOWS NO ARROWS.
   *
   * *"in test yourself it shows me arrows. it is a test it shouldnt show me what to play i should
   * know that myself"*
   *
   * The arrows in this screen are deliberately permanent, because the user said so twice and gave
   * the reason: *"because this is a course so no you just show the arrows"*. That is right for
   * LEARNING. It is the opposite of right for a test, where the arrow is the answer already drawn on
   * the board — so the two must differ, or the test asks the user to look at the answer.
   *
   * The guard wraps the CHOICE arrows: a test must not have the recommendation on the board before the
   * question is answered. It does NOT wrap the MISTAKE arrows, which is a reversal - see below for why
   * a wrong answer is a correction rather than part of the test, and why that is not a spoiler.
   */
  const guardAt = code.indexOf('if (!testing) {');
  ok(guardAt > 0, 'the arrow block is guarded by the testing flag');
  {
    /*
     * BRACE-MATCH THE GUARD, AND THEN LOOK AT BOTH SIDES OF IT.
     *
     * This used to slice a fixed 900 characters after `if (!testing) {` and assert no `add(` appeared
     * in the next 600. That is a WINDOW, not a boundary: it passes only while the guarded block happens
     * to be shorter than the window. Adding code inside the block pushed the mistake arrows into the
     * window and failed a correct change.
     *
     * A window gate gets "fixed" by making the code shorter, which is backwards. This finds the real
     * closing brace of the guard and then looks at each side of it separately, because after the
     * reversal below the two sides carry DIFFERENT and individually meaningful rules.
     */
    const block = (() => {
      if (guardAt <= 0) return { inner: '', end: 0 };
      let depth = 0;
      for (let i = code.indexOf('{', guardAt); i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}') {
          depth--;
          if (depth === 0) return { inner: code.slice(guardAt, i), end: i };
        }
      }
      return { inner: code.slice(guardAt, guardAt + 900), end: guardAt + 900 };
    })();
    const afterGuard = code.slice(block.end);
    // The helper and the mistake block sit just BEFORE the guard, which is still "outside" it.
    const beforeGuard = code.slice(Math.max(0, guardAt - 900), guardAt);

    ok(/const add = \(uci: string \| null \| undefined, color: string\)/.test(afterGuard)
      || /const add = \(uci: string \| null \| undefined, color: string\)/.test(beforeGuard),
      'the arrow helper is OUTSIDE the guard, because the mistake block needs it too');
    ok(/add\(choice\.playedUci, arrowColors\.reply\)/.test(block.inner)
      && /add\(choice\.recommendUci, arrowColors\.hint\)/.test(block.inner)
      && /add\(userMoveHere\.moveUci, arrowColors\.hint\)/.test(block.inner),
      'CONTROL: but the CHOICE arrows stay inside it - in a test the recommendation is the answer, '
      + 'and it must not be on the board before the question is answered');
    /*
     * THE MISTAKE ARROWS MOVED OUT OF THE GUARD, AND THIS IS A REVERSAL.
     *
     * They used to be inside it, and this section used to require that. The report that changed it:
     * *"in your openings in the test when i play a wrong move it still says the correct move in msg
     * but doesnt show it with an arrow"*.
     *
     * Both positions were defensible and they are not the same position:
     *
     *   INSIDE   a test never draws anything. Defensible until the player answers wrongly - and at
     *            that moment it stops being a test and becomes a correction, where withholding the
     *            correction is just silence.
     *   OUTSIDE  before an answer there is no mistake, so there is nothing to draw: the arrows are
     *            driven by `mistake`, which is null until the player has answered. Drawing nothing
     *            and drawing the answer are not the same state.
     *
     * So the spoiler concern is answered by WHEN the arrows are driven, not by hiding the code path.
     * A gate that asserted the arrows were "inside the guard" was really asserting that a wrong
     * answer gets no arrow, and that is the thing the user reported.
     */
    ok(/if \(mistake\)/.test(afterGuard)
      && /add\(mistake\.recommendUci, arrowColors\.hint\)/.test(afterGuard)
      && /add\(mistake\.playedUci, colors\.bad\)/.test(afterGuard),
      'CONTROL: the MISTAKE arrows are after the guard closes, so a wrong answer in a test is shown '
      + 'on the board and not only in a sentence - this was the report');
    ok(/const sameMove = !!mistake\.playedUci && mistake\.playedUci === mistake\.recommendUci;/.test(afterGuard)
      && /!sameMove\) add\(mistake\.playedUci/.test(afterGuard),
      'CONTROL: when the move played IS the move we recommend there is ONE arrow, not two - there is '
      + 'only one thing to point at');
    /*
     * THE ARROW IS NOT A VERDICT, AND THE COPY STILL IS.
     *
     * The red arrow says what you played and that it is not what we recommend here - a fact. The words
     * "mistake" and "blunder", and the centipawn figure, are claims about quality and still come only
     * from the engine verdict. Both halves are asserted, because keeping only the first is how a red
     * arrow ends up implying a judgement nobody made.
     */
    ok(/const isRealMistake = verdict === 'mistake' \|\| verdict === 'blunder'/.test(code),
      'CONTROL: and the words mistake and blunder remain gated on the engine verdict, so no arrow '
      + 'ever implies a quality judgement the engine did not make');
    ok(/severity: 'deviation'/.test(code) && /severity: 'mistake'/.test(code),
      'both severities are actually produced, so none of this is vacuous');
    ok(/That leaves this line/.test(code),
      'and a deviation still says so in neutral words, because not this line and that was bad are '
      + 'different facts');
  }
  // Train is untouched: the user asked to KEEP it.
  const train = fs.readFileSync(path.join(ROOT, 'src', 'components', 'screens', 'TrainScreen.tsx'), 'utf8');
  ok(!/testing/.test(train) && /scopedOpenings/.test(train),
    'Train still practises lines, unchanged, and is scoped to the opening in view');
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
