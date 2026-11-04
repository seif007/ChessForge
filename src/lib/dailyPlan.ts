'use client';

/**
 * TODAY'S PLAN - what the user should do, decided by need rather than by position in a list.
 *
 * WHAT IT WAS
 * -----------
 * The card picked ONE study: the lowest-mastery study the user had started, and if they had started
 * none, `allStudies[0]`. Both halves are close to arbitrary:
 *
 *   - `Array.sort` is stable, so studies with equal mastery stay in corpus order, and on a new
 *     account every study is at mastery 0. That made the button read `Continue: Study 1.1` forever.
 *   - It never looked at the user's repertoire. The user plays the Sicilian; the plan could offer a
 *     Reti, and there was nothing in the code that could tell the difference.
 *   - "Nothing due" produced the same button anyway, so the plan did not change from day to day even
 *     though the sentence above it said all reviews were done.
 *
 * THE USER: *"if you can make real todays plan changing everyday as how i need (not just random
 * stuff)"*. The requirement is not variety — a random pick changes daily too, and is exactly what he
 * is asking us to stop doing. It is that the plan should follow from his own state.
 *
 * WHY A PURE FUNCTION, AND WHY IT IS GATEABLE
 * -------------------------------------------
 * The logic is a ranking, and a ranking is the kind of thing that is easy to write and easy to get
 * subtly wrong: a tie broken by array order is invisible in review and produces the same plan
 * forever. So the whole decision is here, with no clock, no randomness and no React, and
 * `.bench/dailyplan.test.mjs` checks it against the shapes that broke the old version — an untouched
 * account, an account with one thing due, an account whose weakest study is not in his repertoire.
 */

export type PlanKind = 'review-position' | 'review-study' | 'learn' | 'puzzles';

export interface PlanItem {
  kind: PlanKind;
  /** Short, human, and naming the thing rather than the category. */
  title: string;
  /** One clause on why this, today. Empty is allowed but strongly discouraged. */
  why: string;
  /** How many units of work this is, so the plan can be read at a glance. */
  count: number;
  /** The study to open, for the two study kinds. */
  studyId?: string;
  /** The level to open it at. */
  level?: number;
}

export interface PlanInput {
  now: number;
  /** Position progress, keyed by position. */
  positions: Record<string, {
    asked: number; correct: number; streak: number; mastery: number; dueAt: string | null;
  }>;
  /** Study progress, keyed by study id. */
  studies: Record<string, { attempts: number; mastery: number; dueAt: string | null; level?: number }>;
  /**
   * Opening ids the user actually plays, most important first.
   *
   * Read from the custom repertoire, which is written by drilling in "Your openings" — so it is his
   * real repertoire and not our opinion of it. An empty list means he has not drilled anything, and
   * the plan says so rather than pretending to know.
   */
  repertoire: string[];
  /**
   * Every shipped study, as `{ id, title, openingId, chapter, isReference }`.
   *
   * `isReference` is passed in rather than detected here, because the rule for what counts as a
   * reference index already exists in `@/lib/repertoire` and a second copy of it would be free to
   * disagree with the first. The original version of this module guessed with a regex on the study
   * id, did not match the real ids, and offered a reference index as "new material" — which is a
   * contents page, not a lesson.
   */
  catalogue: {
    id: string; title: string; openingId: string; chapter: string; isReference?: boolean;
  }[];
  /** How many puzzles the plan may suggest. Zero disables the item. */
  puzzlesAvailable: boolean;
}

const due = (at: string | null | undefined, now: number) => !at || new Date(at).getTime() <= now;

/** Strip the corpus' own numbering so a title reads as prose: "Study 6.2 — The Sveshnikov" -> "The Sveshnikov". */
export function plainTitle(title: string): string {
  return title.replace(/^Study [\d.]+ [—–-] /, '').trim();
}

/**
 * HOW WELL A POSITION IS KNOWN. LOWER IS WORSE, and the list is sorted ascending, so the first
 * entry is the one the user is worst at.
 *
 * Mastery leads because it already encodes the last answer: a wrong answer multiplies it by 0.4, so a
 * blunder sorts below a position answered correctly every time. Accuracy breaks ties, because two
 * positions can share a mastery exactly while one has been missed three times out of three.
 *
 * THE DIRECTION WAS BACKWARDS IN THE FIRST VERSION, and it is worth writing down because the code
 * read as though it were right. It sorted DESCENDING, which put the position the user knows best at
 * the top, and then reported that position as "the weakest" — so a card with one blunder and one
 * solved position said "2 positions ready for review" and named neither. The gate caught it against
 * a case with both shapes in it, which is the only reason it was caught at all: a test with only
 * weak positions cannot tell a descending sort from an ascending one.
 */
function weaknessOf(p: { asked: number; correct: number; mastery: number }): number {
  const accuracy = p.asked > 0 ? p.correct / p.asked : 0;
  return p.mastery * 2 + accuracy;
}

export function buildDailyPlan(input: PlanInput): PlanItem[] {
  const { now, positions, studies, repertoire, catalogue, puzzlesAvailable } = input;
  const items: PlanItem[] = [];

  /*
   * 1. OVERDUE POSITIONS, worst first.
   *
   * The most urgent thing the user has, and the one thing the old plan never mentioned: a position is
   * overdue the moment it is asked and missed, because a wrong answer schedules it for NOW. So this
   * is where a blunder surfaces, and it is the item most likely to differ from yesterday's.
   */
  const duePositions = Object.values(positions)
    .filter((p) => p.asked > 0 && due(p.dueAt, now))
    .sort((a, b) => weaknessOf(a) - weaknessOf(b));      // worst first — see `weaknessOf`

  if (duePositions.length > 0) {
    const worst = duePositions[0];
    const missed = duePositions.filter((p) => p.correct < p.asked).length;
    const why = worst.correct < worst.asked
      // Named after the failure, not the category, because "review 4 positions" is not actionable
      // and "you missed this" is.
      ? `you missed ${missed} of these, and the weakest is at ${Math.round(worst.mastery * 100)}%`
      : `${duePositions.length} position${duePositions.length === 1 ? '' : 's'} ready for review`;
    items.push({
      kind: 'review-position',
      title: `${duePositions.length} opening position${duePositions.length === 1 ? '' : 's'} to review`,
      why,
      count: Math.min(duePositions.length, 12),
    });
  }

  /*
   * 2. STUDIES HE HAS STARTED AND IS BEHIND ON, weakest first.
   *
   * `attempts > 0` is the filter, and it is the honest one: a study he has never opened is not a
   * review, and calling it one produces the old plan's behaviour of pointing at the corpus's first
   * study. Ties are broken by the catalogue order the caller supplies, which is corpus order — so the
   * caller is told to pass a repertoire-first order, and item 3 depends on that.
   */
  const behind = catalogue
    .filter((s) => {
      const st = studies[s.id];
      return st != null && st.attempts > 0 && st.mastery < 1 && due(st.dueAt, now);
    })
    .sort((a, b) => (studies[a.id]?.mastery ?? 0) - (studies[b.id]?.mastery ?? 0));

  if (behind.length > 0) {
    const s = behind[0];
    const st = studies[s.id];
    items.push({
      kind: 'review-study',
      title: plainTitle(s.title),
      why: `you are ${Math.round((st?.mastery ?? 0) * 100)}% through this one`,
      count: 1,
      studyId: s.id,
      level: st?.level ?? 1,
    });
  }

  /*
   * 3. NEW MATERIAL, FROM HIS OWN REPERTOIRE.
   *
   * This is the half the old plan could not express at all, and the reason the plan now changes day
   * to day rather than only at mastery boundaries: as he drills openings, the repertoire list grows,
   * and the next unstarted study in it changes. The repertoire comes first because a Sicilian he
   * plays is worth more to him than a Réti nobody suggested.
   *
   * When the repertoire is empty it falls back to the whole catalogue, which is the honest state for
   * a new account rather than a silent "you have nothing".
   */
  if (repertoire.length > 0 || items.length === 0) {
    const inRepertoire = new Set(repertoire);
    const fresh = catalogue.filter(
      (s) => (studies[s.id]?.attempts ?? 0) === 0
        // A reference index is a contents page. Offering one as "new material" is a dead end, and
        // the rule for what counts as one belongs to the repertoire module, so it is passed in.
        && s.isReference !== true
        && (inRepertoire.size === 0 || inRepertoire.has(s.openingId)),
    );
    if (fresh.length > 0) {
      const s = fresh[0];
      items.push({
        kind: 'learn',
        title: plainTitle(s.title),
        why: inRepertoire.has(s.openingId)
          ? `new, in a ${s.chapter || 'line'} you play`
          : 'a good place to start',
        count: 1,
        studyId: s.id,
        level: 1,
      });
    }
  }

  /*
   * 4. A LIGHT TASK, so the plan is never empty and never nothing but reading.
   *
   * Only when there is genuinely no review outstanding. Its absence is meaningful: telling someone to
   * solve puzzles when they have a position they have got wrong three times is advice, not a plan.
   */
  if (items.length === 0 && puzzlesAvailable) {
    items.push({
      kind: 'puzzles',
      title: 'A few tactics at your level',
      why: 'nothing is due, so keep the sharpness',
      count: 5,
    });
  }

  return items;
}
