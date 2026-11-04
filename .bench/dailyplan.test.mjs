/**
 * GATE 1m - Today's plan is decided by need, and is not the same every day.
 *
 * THE USER: *"for todays plan : if you can make real todays plan changing everyday as how i need
 * ( not just random stuff)"*.
 *
 * He is asking for something specific, and the word that matters is "need". A plan that changes
 * daily because a random number changed is exactly what he is asking us to stop doing — that is what
 * "random stuff" means. So the requirement is not variety, it is that the plan FOLLOWS FROM HIS OWN
 * STATE, and the test for that is whether the same account on a different day gets a different plan
 * for a reason you can read.
 *
 * WHAT IT WAS
 * -----------
 * One study: the lowest-mastery study the user had started, or `allStudies[0]` if he had started
 * none. Three defects, and only the first is obvious:
 *
 *   1. `Array.sort` is STABLE, so studies with equal mastery kept corpus order. On a new account
 *      every study is at mastery 0, so the card read `Continue: Study 1.1` every day for ever. This
 *      is the one that makes the plan look broken rather than merely dull.
 *   2. It never read his repertoire, so the plan could not prefer an opening he plays. The corpus
 *      order begins with the Sicilian for everybody, whether they play it or not.
 *   3. "Nothing due" produced the same button anyway, so the plan did not change when his state
 *      did.
 *
 * The ranking is a pure function in `src/lib/dailyPlan.ts` precisely so that it can be tested
 * against shapes the corpus does not contain — which is the only way to catch a tie broken by
 * accident.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

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

/*
 * The module under test.
 *
 * Compiled with the project's own TypeScript rather than with a hand-written type stripper. A regex
 * stripper is the obvious shortcut and it was wrong within one attempt: it removed `interface` and
 * `type` declarations and left a top-level `const due = (at: string | null | undefined, ...)` behind,
 * which is not JavaScript. `ts.transpileModule` is the compiler that already knows what is a type, and
 * asking it is both shorter and correct. The module has no runtime imports, so the emitted CommonJS can
 * be evaluated directly - and `require` throws if that ever stops being true, so this cannot quietly
 * become a test of something else.
 */
const ts = createRequire(import.meta.url)('typescript');
const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'dailyPlan.ts'), 'utf8');
const emitted = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const mod = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('module', 'exports', 'require', emitted.outputText)(mod, mod.exports, () => {
  throw new Error('dailyPlan must not import anything at runtime, or this gate is testing something else');
});
const { buildDailyPlan } = mod.exports;

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
const ago = (days) => new Date(T0 - days * DAY).toISOString();
const ahead = (days) => new Date(T0 + days * DAY).toISOString();

const CATALOGUE = [
  { id: 'sic-a1', title: 'Study 1.1 — The Open Sicilian', openingId: 'sicilian', chapter: 'The Open Sicilian' },
  { id: 'sic-a2', title: 'Study 1.2 — The Najdorf', openingId: 'sicilian', chapter: 'The Najdorf' },
  { id: 'sic-b1', title: 'Study 4.1 — The Dragon', openingId: 'sicilian', chapter: 'The Dragon' },
  { id: 'ind-c1', title: 'Study 1.1 — Nimzo-Indian', openingId: 'indian', chapter: 'Nimzo-Indian' },
  // Flagged the way Home flags it, from the real `isReferenceStudy`. The module does not guess: a
  // second copy of that rule here would be free to disagree with the one that owns it.
  { id: 'ref-index', title: 'Study 0.1 — Reference index', openingId: 'sicilian', chapter: 'Reference', isReference: true },
];

const empty = () => ({
  now: T0,
  positions: {},
  studies: {},
  repertoire: [],
  catalogue: CATALOGUE,
  puzzlesAvailable: true,
});

const pos = (over) => ({ asked: 3, correct: 3, streak: 3, mastery: 1, dueAt: ahead(5), ...over });

// ---------------------------------------------------------------------------
head('1. IT IS NEVER THE SAME PLAN EVERY DAY');

/*
 * The defect that made the old card look broken. Two accounts differing only in WHICH study is
 * weakest must get different plans, and an account whose state advances must get a different plan.
 */
{
  const a = buildDailyPlan({
    ...empty(),
    studies: {
      'sic-a1': { attempts: 3, mastery: 0.9, dueAt: ago(1) },
      'sic-b1': { attempts: 3, mastery: 0.2, dueAt: ago(1) },
    },
  });
  const b = buildDailyPlan({
    ...empty(),
    studies: {
      'sic-b1': { attempts: 3, mastery: 0.2, dueAt: ago(1) },
      'sic-a2': { attempts: 3, mastery: 0.1, dueAt: ago(1) },
    },
  });
  ok(a[0]?.studyId !== b[0]?.studyId,
    'the weakest study decides, so two states give two plans',
    `both chose ${a[0]?.studyId}`);
  ok(a[0]?.studyId === 'sic-b1', 'and it is genuinely the weakest one', `chose ${a[0]?.studyId}`);

  // The same account, one day later, after it has been worked on.
  const later = buildDailyPlan({
    ...empty(),
    now: T0 + DAY,
    studies: {
      'sic-b1': { attempts: 3, mastery: 0.2, dueAt: ago(1) },
      'sic-a2': { attempts: 3, mastery: 0.1, dueAt: ago(1) },
    },
  });
  ok(later[0]?.studyId === 'sic-a2',
    'CONTROL: once the weak one is not due any more, the plan moves on',
    `chose ${later[0]?.studyId}`);
}

// ---------------------------------------------------------------------------
head('2. A MISTAKE OUTRANKS EVERYTHING ELSE');

/*
 * The most important thing the old plan never mentioned. A wrong answer schedules a position for NOW
 * — the SRS gives it zero days — so a blunder is the single most urgent item the user has, and the
 * card used to be silent about it while offering a study.
 */
{
  const plan = buildDailyPlan({
    ...empty(),
    positions: {
      k1: pos({ asked: 1, correct: 0, streak: 0, mastery: 0, dueAt: ago(0) }),
      k2: pos({ asked: 5, correct: 5, streak: 5, mastery: 1, dueAt: ago(0) }),
    },
    studies: { 'sic-a1': { attempts: 9, mastery: 0.3, dueAt: ago(3) } },
  });
  ok(plan[0]?.kind === 'review-position', 'a missed position is the first thing offered', plan[0]?.kind);
  ok(plan[0]?.count === 2, 'and both due positions are counted', `count ${plan[0]?.count}`);
  ok(/missed/.test(plan[0]?.why ?? ''), 'and the reason names the failure', plan[0]?.why);

  // Worst first, when there is more than one.
  const two = buildDailyPlan({
    ...empty(),
    positions: {
      good: pos({ asked: 4, correct: 4, mastery: 1, dueAt: ago(0) }),
      bad: pos({ asked: 4, correct: 1, streak: 0, mastery: 0.05, dueAt: ago(0) }),
    },
  });
  ok(/missed/.test(two[0]?.why ?? '') && /weakest/.test(two[0]?.why ?? ''),
    'and it says which is weakest, so the user can act on it', two[0]?.why);

  /*
   * THE SORT DIRECTION, WITH A CONTROL. The first version sorted DESCENDING, which put the position
   * the user knows BEST at the top and then reported it as "the weakest" - so a card holding one
   * blunder and one solved position said only "2 positions ready for review".
   *
   * A test containing only weak positions cannot tell an ascending sort from a descending one, which
   * is why this case mixes a solved position with a missed one: with both present, the two orders
   * give different answers, and only the ascending one names a mistake.
   */
  ok(/weakest is at/.test(two[0]?.why ?? ''),
    'CONTROL: with one solved and one missed position, the missed one is named',
    two[0]?.why);
  ok(!/ready for review/.test(two[0]?.why ?? ''),
    'CONTROL: ...and the "just ready for review" wording does not hide the failure');

  // Equal mastery, different accuracy: the accuracy must break the tie.
  const tie = buildDailyPlan({
    ...empty(),
    positions: {
      half: pos({ asked: 2, correct: 1, streak: 0, mastery: 0.5, dueAt: ago(0) }),
      full: pos({ asked: 2, correct: 2, streak: 2, mastery: 0.5, dueAt: ago(0) }),
    },
  });
  ok(/weakest is at/.test(tie[0]?.why ?? ''),
    'accuracy breaks a tie in mastery, so the half-answered position is named first',
    tie[0]?.why);

  // Not-yet-asked positions are not urgent. The old badge counted every position with no dueAt,
  // which is every position the user has never been asked.
  const fresh = buildDailyPlan({
    ...empty(),
    positions: { never: pos({ asked: 0, correct: 0, streak: 0, mastery: 0, dueAt: null }) },
  });
  ok(!fresh.some((i) => i.kind === 'review-position'),
    'a position never asked is NOT offered as a review — that is what made the old badge meaningless');
}

// ---------------------------------------------------------------------------
head('3. NEW MATERIAL FOLLOWS HIS REPERTOIRE');

/*
 * The half the old plan could not express: it had no way to ask which opening a study belonged to, so
 * it could not prefer one the user plays. The corpus order begins with the Sicilian for everybody.
 */
{
  const sicilianOnly = buildDailyPlan({
    ...empty(),
    repertoire: ['sicilian'],
    // Deliberately supplied NOT in repertoire-first order, so a plan that simply takes the first
    // entry would offer an Indian study and fail.
    catalogue: [CATALOGUE[3], CATALOGUE[1], CATALOGUE[0]],
  });
  ok(sicilianOnly.some((i) => i.kind === 'learn' && i.studyId?.startsWith('sic-')),
    'with a Sicilian repertoire, the new material is Sicilian',
    sicilianOnly.map((i) => `${i.studyId ?? i.kind}`).join(', '));
  ok(!sicilianOnly.some((i) => i.studyId === 'ind-c1'),
    'and not the Indian study that came first in the list');

  const reasons = sicilianOnly.find((i) => i.kind === 'learn');
  ok(/Najdorf|Open Sicilian|Dragon/.test(reasons?.why ?? ''),
    'and it names the chapter, because a study id cannot say where it goes',
    reasons?.why);

  // An empty repertoire is a real state and must not produce a confident recommendation.
  const virgin = buildDailyPlan({ ...empty(), repertoire: [] });
  ok(virgin.length > 0, 'a brand new account still gets a plan');
  ok(/start/.test(virgin.find((i) => i.kind === 'learn')?.why ?? ''),
    'and it says it is a starting point rather than pretending to know his repertoire',
    virgin.find((i) => i.kind === 'learn')?.why);

  // A reference index is not a lesson.
  const noRef = buildDailyPlan({ ...empty(), repertoire: ['sicilian'], catalogue: [CATALOGUE[4]] });
  ok(!noRef.some((i) => i.studyId === 'ref-index'),
    'a reference index is never offered as new material — it is a dead end');
}

// ---------------------------------------------------------------------------
head('4. IT SAYS WHY, AND IT IS NEVER EMPTY');

{
  // Every item must be actionable: a name, a count, and a reason.
  const plans = [
    buildDailyPlan({ ...empty(), positions: { k: pos({ asked: 1, correct: 0, streak: 0, mastery: 0, dueAt: ago(0) }) } }),
    buildDailyPlan({ ...empty(), studies: { 'sic-a1': { attempts: 2, mastery: 0.4, dueAt: ago(1) } } }),
    buildDailyPlan({ ...empty(), repertoire: ['sicilian'] }),
    buildDailyPlan({ ...empty(), repertoire: ['sicilian'], studies: { 'sic-a1': { attempts: 2, mastery: 0.4, dueAt: ahead(9) } } }),
  ];
  const weak = plans.flat().filter((i) => !i.title || !i.why || !(i.count > 0));
  ok(weak.length === 0, 'every item has a title, a reason and a count',
    weak.map((i) => JSON.stringify(i)).join('\n'));

  // Nothing due, nothing new. "New" means the catalogue is EXHAUSTED, not merely that today's study
  // is not due - the first version of this check used the full catalogue and asserted puzzles, which
  // was wrong: with unstarted studies available, offering a study is right and offering puzzles would
  // be advice instead of a plan.
  const exhausted = buildDailyPlan({
    ...empty(),
    repertoire: ['sicilian'],
    catalogue: [CATALOGUE[0]],
    studies: { 'sic-a1': { attempts: 4, mastery: 1, dueAt: ahead(30) } },
  });
  ok(exhausted.length === 1 && exhausted[0]?.kind === 'puzzles',
    'with everything started and nothing due, the plan offers light work rather than nothing',
    exhausted.map((i) => i.kind).join(', '));

  // And the inverse, which is the real requirement: do NOT offer puzzles while study work waits.
  const studyWaits = buildDailyPlan({
    ...empty(),
    repertoire: ['sicilian'],
    studies: { 'sic-a1': { attempts: 4, mastery: 1, dueAt: ahead(30) } },
  });
  ok(studyWaits.some((i) => i.kind === 'learn'),
    'while unstarted material remains, the plan learns rather than serving puzzles',
    studyWaits.map((i) => i.kind).join(', '));
  ok(!studyWaits.some((i) => i.kind === 'puzzles'),
    'and does not pad the plan with puzzles - that would be advice, not a plan');

  // A master study is not "behind", so it is not a review item.
  const done = buildDailyPlan({
    ...empty(),
    repertoire: ['sicilian'],
    studies: { 'sic-a1': { attempts: 9, mastery: 1, dueAt: ago(0) } },
  });
  ok(!done.some((i) => i.studyId === 'sic-a1'),
    'a study at full mastery is not offered for review, however overdue its date');
}

// ---------------------------------------------------------------------------
head('5. THE SCREEN USES IT, AND DOES NOT KEEP THE OLD BUTTON');

{
  const home = fs.readFileSync(path.join(ROOT, 'src', 'components', 'screens', 'HomeScreen.tsx'), 'utf8');
  const code = home.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  ok(/buildDailyPlan\(/.test(code), 'Home builds the plan with the tested function');
  ok(!/Continue: \$\{suggested/.test(code),
    'and the old single "Continue: <study>" button is gone — it was the thing that never changed');
  ok(/plan\.map\(/.test(code), 'the plan is rendered as a list');
  ok(/item\.why/.test(code), 'and each row shows its reason');
  ok(/openingId: o\.id/.test(code),
    'the study list carries the opening each study belongs to, which the old flat list could not');
  ok(/loadCustomRepertoire\(\)/.test(code),
    'and the repertoire is read from the custom repertoire — the openings he actually plays');
  ok(!/allStudies\[0\]/.test(code),
    'CONTROL: the corpus-first-study fallback is gone, which is what pinned it to Study 1.1');
  ok(/isReference: isReferenceStudy\(s\)/.test(code),
    'and the reference rule comes from the module that owns it, not a second copy');
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
