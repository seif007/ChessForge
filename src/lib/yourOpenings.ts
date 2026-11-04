'use client';

/**
 * "Your openings" — the opening builder.
 *
 * THE SHAPE OF THIS SCREEN, AND WHAT WAS WRONG HERE
 * -------------------------------------------------
 * An opening trainer should not be a list of cards that drop you into a game. This screen is about an
 * OPENING: where you stand in it, how far you have got, which of its lines you actually meet, and
 * which one to drill next. Three mechanics follow from that, and each one is a defect in the version
 * this replaces:
 *
 *   1. A NODE IS A LINE, and you drill one at a time. There was a single `spine` per opening with
 *      siblings as a secondary "Other lines (8)" control, and tapping the card jumped straight
 *      into playing. That is why a card could be two or three plies long and read as broken: a
 *      spine of whatever move orders the pool rotation happened to reach is not a line anyone
 *      would drill. Here every line is a first-class thing you can see, size and pick.
 *
 *   2. MASTERY, NOT VOLUME. A line is scored on how well you know it, and that score is what grows
 *      as you drill — not the number of positions you have been shown. There were ply counts. A ply
 *      count is volume, and volume goes up whether or not you improved.
 *
 *   3. PRIORITISED BY LIKELIHOOD. Lines are ordered by how likely you are to meet them, not by the
 *      order an internal rotation happened to emit them in, which is arbitrary. The number that
 *      actually predicts what he will meet is how many of HIS OWN GAMES reached the line.
 *
 * And on the openings list itself, each opening carries the win rate he has actually achieved in it,
 * so the list is ordered by weakness — and that weakness is measurable from games already on the
 * device rather than estimated.
 *
 * The content sources are deliberate: OUR books and the engine, as the user required. What these
 * mechanics changed is which line is offered, in what order, and what is shown about it.
 */

import type { BuilderStep, FamilyLine } from './openingBuilder';
import type { LichessGame } from './lichess';
import type { Repertoire, RepStudy } from './repertoire';
import { collectStudyLines } from './repertoire';

/** Which line of a family: the spine, or one of its siblings. */
export type LineRef = { kind: 'main' } | { kind: 'alt'; index: number };

/** Per-position progress, as `store.ts` holds it. Only the fields used here. */
export interface PositionProgress {
  asked: number;
  correct: number;
  mastery: number;   // 0..1
}

/** One drillable line, with everything the card needs to draw itself. */
export interface DrillLine {
  ref: LineRef;
  /** The whole line in SAN, from move one. */
  sans: string[];
  /** The first few plies, so the line is recognisable without a board. */
  preview: string;
  plies: number;
  /** Positions where the user has something to decide. */
  decisions: number;
  /** Of those, how many the engine has judged to be a mistake or a blunder. */
  mistakes: number;
  /**
   * MASTERY OUT OF TEN, the number their rings show.
   *
   * Derived from `PositionStat.mastery` (already stored per position, already moved by
   * `recordPositionResult`), averaged over the line's decision positions. A position never asked
   * counts as zero, so an untrained line honestly reads 0/10 rather than being invisible.
   */
  mastery: number;
  /** How many times a position on this line has been asked at all. */
  asked: number;
  /**
   * How many of the user's OWN GAMES reached this line, measured at its deepest position.
   *
   * This is the likelihood number, and it is the ordering key. It is a real measurement from his
   * games rather than a guess about which line is "main". See `describeLine` for why it is read
   * where it is read.
   */
  weight: number;
  /**
   * False for a line too short to be a line. See `MIN_DRILL_PLIES`.
   *
   * A short line is still DESCRIBED - it is in the family, and hiding it would be a different kind
   * of lie - but it is not offered as something to drill, because drilling it is exactly the
   * "two moves and it says done" experience.
   */
  drillable: boolean;
}

/** The steps a `LineRef` names, falling back to the spine so a stale ref is never empty. */
export function stepsForRef(family: FamilyLine, ref: LineRef): BuilderStep[] {
  if (ref.kind === 'main') return family.steps;
  return family.alternates[ref.index] ?? family.steps;
}

/** Every line of a family: the spine and all its siblings, in that order. */
export function allLineRefs(family: FamilyLine): LineRef[] {
  return [
    { kind: 'main' },
    ...family.alternates.map((_, index) => ({ kind: 'alt', index }) as LineRef),
  ];
}

/** How many plies of a line are shown before it is truncated with an ellipsis. */
const PREVIEW_PLIES = 10;

/**
 * THE SHORTEST THING THAT MAY EVER BE CALLED A LINE.
 *
 * The report this exists to make impossible: *"i play only one or two moves and the app says the
 * line is done"*, and *"i only played one move and thats it"* before it. It is the same defect
 * every time and it has survived more fixes than any other bug in this project, because each fix
 * attacked whatever produced the short line THAT TIME - a lookup that returned nothing, a tail
 * that stopped at the first illegal move, an index that could not see a transposition - rather
 * than the thing every one of them shared: nothing stopped a short list from being presented as
 * a complete one.
 *
 * Eight plies is four moves a side. It is not a claim about chess; it is the point below which
 * the screen's own promise ("drill this line") is not true, because there is nothing to drill
 * past the opening moves. Below it a line is either extended from the book or not offered.
 *
 * Enforced in `describeLine` by refusing to describe a short one as drillable, and checked by
 * GATE 1i over both sources - the user's games and the shipped studies - because the two fail for
 * different reasons and a floor that only guards one of them is half a fix.
 */
export const MIN_DRILL_PLIES = 8;

/** One line, described. */
export function describeLine(
  family: FamilyLine,
  ref: LineRef,
  progress: Record<string, PositionProgress>,
): DrillLine {
  const steps = stepsForRef(family, ref);
  const sans = steps.map((s) => s.moveSan);

  const decisions = steps.filter((s) => s.choice != null);
  const mistakes = decisions.filter(
    (s) => s.choice?.verdict === 'mistake' || s.choice?.verdict === 'blunder',
  ).length;

  /*
   * MASTERY — AVERAGED OVER HIS OWN MOVES, NOT ONLY OVER THE POSITIONS THE ENGINE JUDGED.
   *
   * The basis used to be `decisions` (steps carrying a `choice`), and that pinned the ring at
   * 0% for a line whose family the engine had not published verdicts for: no verdict means no
   * choice means no decision means no mastery, however much of the line the user actually played.
   * That is the report — *"the circle ... advanced, but in a new one it didnt advance while i
   * complete it"* — because the families whose analysis had not merged yet could never move.
   *
   * The positions the app records are the USER'S moves (see `recordStepProgress` in the screen),
   * so the average is taken over exactly those steps. The two exclusions that mattered before
   * still hold: the opponent's moves carry no position, so they cannot dilute the ring, and
   * unplayed positions count as zero, so a fresh line reads 0/10 rather than an average of
   * nothing. `decisions` remains the right basis for the DECISION COUNT and the mistake count —
   * those are about what the engine judged; the ring is about what he played.
   */
  const mine = steps.filter((s) => s.position != null);
  let masterySum = 0;
  let asked = 0;
  for (const step of mine) {
    const p = step.position ? progress[step.position.key] : undefined;
    masterySum += p?.mastery ?? 0;
    asked += p?.asked ?? 0;
  }
  const mastery = mine.length === 0 ? 0 : Math.round((masterySum / mine.length) * 10);

  /*
   * WEIGHT - how many of his own games reached this line.
   *
   * `GamePosition.timesSeen`, NOT a count of distinct `gameId`s, and getting this right took two
   * attempts that the gate caught.
   *
   * FIRST WRONG: counting `gameId`s. Four games sharing a move order produce four identical
   * positions, the pool collapses them (`gameOpenings.ts` increments `timesSeen` on a repeat
   * rather than storing the position twice), and the survivor keeps ONE `gameId`. The four-game
   * line weighed 1 and tied with a line one game had reached, so the ordering degraded straight
   * back to arbitrary.
   *
   * SECOND WRONG: the MAXIMUM `timesSeen` along the line. Every opening shares its first plies -
   * `d4 d5` belongs to the Queen's Gambit and to every reply to it - so a maximum is measured at
   * the shared PREFIX and every line scores the same. Measured: five games split 4/1 across two
   * lines of the same opening, and both weighed 5.
   *
   * RIGHT: the DEEPEST position on the line. `timesSeen` there is the number of games that
   * actually followed this line that far, which is the thing being asked. Not the sum either,
   * which would multiply by the ply count and let a long line outrank a frequently-played short
   * one.
   */
  let weight = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const seen = steps[i].position?.timesSeen;
    if (seen != null) { weight = seen; break; }
  }

  return {
    ref,
    sans,
    preview: sans.slice(0, PREVIEW_PLIES).join(' ') + (sans.length > PREVIEW_PLIES ? ' …' : ''),
    plies: sans.length,
    decisions: decisions.length,
    mistakes,
    mastery,
    asked,
    weight,
    /**
     * False for a line too short to honestly be called one.
     *
     * The play view must not offer a line that would report itself finished after two moves, which
     * is the defect this flag exists to make impossible rather than merely less likely.
     */
    drillable: sans.length >= MIN_DRILL_PLIES,
  };
}

/**
 * The lines to show, in the order to show them.
 *
 * ORDER IS THE PRODUCT. Sorted by how many of his own games reached the line, most likely first,
 * because "prioritizes what you're most likely to encounter" is the stated behaviour and the
 * weight is measured rather than assumed. Ties break toward the line with more to decide, and
 * then toward the spine, so the same opening always produces the same order - an unstable order
 * would make the list reshuffle under his thumb between openings.
 *
 * Nothing is truncated. The "Top 150 positions" banner is a property of their corpus, not
 * something to copy when ours is 1,204 studies; inventing a cut-off here would hide lines he
 * actually plays.
 */
export function drillableLines(
  family: FamilyLine,
  progress: Record<string, PositionProgress>,
): DrillLine[] {
  return allLineRefs(family)
    .map((ref) => describeLine(family, ref, progress))
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      if (b.decisions !== a.decisions) return b.decisions - a.decisions;
      if (a.ref.kind !== b.ref.kind) return a.ref.kind === 'main' ? -1 : 1;
      return 0;
    });
}

/** The line worth suggesting, used when the user has not chosen one. */
export function suggestedLine(lines: DrillLine[]): DrillLine | null {
  if (lines.length === 0) return null;
  // Most likely, and among equally likely the one he knows LEAST - "pinpoint weaknesses" is the
  // point of the screen, so a fully-mastered line should not be what he is pushed at.
  return lines.slice().sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.mastery - b.mastery;
  })[0];
}

/**
 * Find the line the user actually chose, after the family has been re-derived.
 *
 * THE BUG, REPORTED THREE TIMES
 * -----------------------------
 * *"it keep playin automatically 3 times and then i get a new different position to play"* —
 * and, earlier in the same session, *"it keep repeating the moves 3 times before i could choose
 * between my move and the suggested move"*.
 *
 * A line was identified by `{kind:'alt', index: n}`, a POSITION in `family.alternates`. The
 * engine pass re-derives the family with `buildFamilyLines` once the verdicts land, and the pool
 * rotation prefers positions that carry decisions - so `alternates` comes back as a DIFFERENT
 * list, published twice (head of the sample, then tail). An index into a list that is being
 * rebuilt twice while the user watches it is not an identity.
 *
 * So the index silently selects somebody else's move order, the sync effect notices the new SANs
 * disagree with the board, and `startLine()` walks from move one again. Publish, disagree,
 * replay - twice over. The automatic playing IS the replay, and the "new different position" is
 * the line the user never chose.
 *
 * THE FIX: the moves are recorded at the moment of the tap and the line is located by them. The
 * index is a hint for the first render only, before any moves are known.
 *
 * Returns null when no line in the family matches, which is the honest answer: the moves are
 * genuinely gone, and substituting a different line silently is the bug rather than the fix.
 * Comparing a PREFIX is deliberate - a re-derivation can attach more moves to the end of a line
 * (a book tail, an engine continuation) without changing the opening, and that is the same line
 * with more data, not a different one.
 *
 * AND THE PREFIX GOES ONE WAY ONLY: THE RECORDED MOVES MUST FIT INSIDE THE CANDIDATE.
 *
 * THE REPORT: *"the line finishes after 2 moves"*, and *"it jumps to a completely different
 * position"* - two symptoms, one comparison.
 *
 * This test used to be `Math.min(recordedSans.length, cand.length)` moves, and `family.steps` -
 * the MAIN line - is searched first. The engine pass publishes a family more than once while the
 * user plays (the head of the sample, then the tail), so the family he is standing in can be
 * rebuilt against FEWER positions: the rotation stops early and what comes back is a PREFIX of the
 * line on his board. A two-ply main line then matched a seven-ply session on its first two moves
 * and was returned as "the line the user chose". The board snapped back to move two and the finish
 * view appeared over it - and because the main line is searched first, tapping any alternate and
 * letting the engine publish handed the user the main line: different and shorter at once.
 *
 * The rule is the one this docblock already states. More data at the END is the same line; a
 * candidate that RUNS OUT before the recording does is a different one, and null is the honest
 * answer - the caller then keeps the session on the line already on the board (see the
 * `sessionLiveRef` fallback in `GameOpeningsScreen`).
 */
export function resolveLine(
  family: FamilyLine,
  ref: LineRef,
  recordedSans: string[] | null,
): BuilderStep[] | null {
  const byIndex = ref.kind === 'main'
    ? family.steps
    : (family.alternates[ref.index] ?? family.steps);

  if (!recordedSans || recordedSans.length === 0) return byIndex;

  const all: BuilderStep[][] = [family.steps, ...family.alternates];
  for (const cand of all) {
    // A candidate that ends before the recording does cannot be the line that was recorded.
    if (cand.length < recordedSans.length) continue;
    let same = true;
    for (let i = 0; i < recordedSans.length; i++) {
      if (cand[i].moveSan !== recordedSans[i]) { same = false; break; }
    }
    if (same) return cand;
  }
  return null;
}

/**
 * THE NAMED STUDIES OF AN OPENING — the correction that matters most.
 *
 * THE USER, CORRECTING THE BUILD: *"there isn't only beginner to novice, these are only
 * the beginning and they keep giving me different studies and lines (for example for the sicilian:
 * dragon, smith moora, classic,…) and keep adding every time i advance not just one line study
 * and keep repeating"*.
 *
 * What this had built treated the RANK as a depth control - it decided how far into ONE line you
 * were taken. It is not a depth control. It decides how much of the opening EXISTS:
 *
 *   Spark      a couple of studies
 *   Ember      more studies appear
 *   Flame      more again
 *   …
 *   Crucible   the whole opening
 *
 * and what appears is not more depth in the current line but DIFFERENT STUDIES. For the Sicilian
 * that means the Najdorf, the Dragon, the Classical, the Sveshnikov, Taimanov, the Accelerated
 * Dragon, the Rossolimo — which is the user's own example.
 *
 * THE DATA FOR THIS ALREADY EXISTS, one level above the line, and it is the corpus's own
 * structure rather than anything invented: every shipped repertoire is `chapters[].studies[]`, and
 * the chapter titles ARE the variation names. `repertoire.json` is 12 chapters for the Sicilian -
 * Najdorf, Dragon, Classical Sicilian, Sveshnikov, Taimanov and Kan, Accelerated Dragon, Rossolimo
 * and Moscow, Wing Gambit. `indian-defense.json` is 10 - Nimzo, Queen's Indian, Bogo, King's
 * Indian, Grünfeld, Benoni, Budapest, Benko. A chapter is a named study; a study holds lines; a
 * line is what gets drilled; the mastery ring is per line.
 *
 * The user's games keep a job - they decide WHICH opening this is, and they are what the win rate
 * and the mistake list are measured from. They are not the curriculum.
 */

export interface OpeningStudy {
  /** Stable key: the chapter's title, which is unique inside a repertoire. */
  key: string;
  /**
   * The name to show, with the chapter number stripped.
   *
   * "Chapter 4: The Najdorf" reads as a name; "The Najdorf" reads as a name and a heading. The
   * stripping is deliberately narrow - only a leading "Chapter <n>:" - so a chapter called
   * "Chapter 3: The Bogoljubow Variation" and one called "The Accelerated Dragon" both come out
   * right, and nothing else is touched.
   */
  title: string;
  studies: number;
  /** Lines across the chapter, which is what the group card can honestly promise. */
  lines: number;
  /** The chapter's order in the book: "the Najdorf" before "traps and tactics". */
  order: number;
}

/** One drillable line, tagged with the study and chapter it came from. */
export interface StudyLine {
  key: string;
  sans: string[];
  /** The variation this line belongs to, e.g. "The Najdorf". */
  chapter: string;
  chapterOrder: number;
  /** The study's own title. */
  study: string;
}

/* --------------------------------------------------------------------------
 * LINES PER RANK - and the interleaving, which is the part that was wrong twice
 * ------------------------------------------------------------------------ */

interface RepertoireLike {
  chapters: { title: string; studies: { title: string; id: string }[] }[];
}

/**
 * Every drillable line of an opening, drawn from its studies, ordered so that ANY PREFIX OF THE
 * LIST SPANS THE WHOLE OPENING.
 *
 * THE USER, CORRECTING THIS TWICE
 * -------------------------------
 * First: *"they keep giving me different studies and lines (for example for the sicilian: dragon,
 * smith moora, classic,…)"* - so the material is the named studies, not the games.
 *
 * Then: *"no, we get some lines of these tudies and chaprters at every level ( not each study in a
 * level)"* - so a level is not handed out a whole study at a time. Each level is a set of LINES,
 * taken from across the chapters.
 *
 * WHICH IS THE WHOLE POINT, and the round-robin is what delivers it. Order the corpus by chapter
 * and take the first N, and a Spark gets the Najdorf and nothing else - the Dragon, the
 * Classical and the rest are three ranks away. Interleaved, the first handful already spans
 * Najdorf, Dragon, Classical and Sveshnikov, which is what "dragon, smith moora, classic" describes
 * and what makes an early rank feel like an opening rather than one line with a rank on it.
 *
 * So the list is built round-robin over chapters, then over studies within a chapter. A prefix of
 * it is a balanced sample of the whole opening, and `LINES_PER_RANK` decides how much of it a rank
 * sees. Advancing a rank is then literally "show more of this list" - which is the user's words:
 * keep adding, not keep deepening.
 */
export function allLinesOf(repertoire: Repertoire | null): StudyLine[] {
  if (!repertoire || !repertoire.chapters) return [];
  const full = repertoire as unknown as RepertoireLike;

  // One queue per chapter, so the merge below can round-robin between them.
  const queues: StudyLine[][] = full.chapters.map((ch) => {
    const out: StudyLine[] = [];
    for (const st of ch.studies ?? []) {
      const study = findStudy(repertoire, st.id);
      if (!study) continue;
      for (const line of collectStudyLines(study)) {
        out.push({
          key: `${ch.title}::${st.id}::${line.index}`,
          sans: line.sans,
          chapter: ch.title.replace(/^\s*Chapter\s+\d+\s*:\s*/i, '').trim() || ch.title,
          chapterOrder: full.chapters.indexOf(ch),
          study: st.title,
        });
      }
    }
    return out;
  });

  // Round-robin the chapters: one line from each, then a second from each, and so on.
  const merged: StudyLine[] = [];
  const longest = queues.reduce((a, q) => Math.max(a, q.length), 0);
  for (let i = 0; i < longest; i++) {
    for (const q of queues) if (i < q.length) merged.push(q[i]);
  }
  return merged;
}

function findStudy(repertoire: Repertoire | null, id: string): RepStudy | null {
  if (!repertoire) return null;
  for (const ch of repertoire.chapters) {
    for (const st of ch.studies) if (st.id === id) return st;
  }
  return null;
}

/**
 * HOW MANY LINES A RANK UNLOCKS.
 *
 * A design decision, not a measurement, and the one number here most likely to want changing. The
 * user asked for lines to be added at each level and did not say how many, so they are in one
 * array. The top rank is the whole opening, which for the Sicilian is every line its 114 studies
 * contain.
 *
 * The names are this app's own heat ladder - Spark to Crucible - and match `LEVELS` in
 * `repertoire.ts` and `RANKS` below. Nothing enforces that, and the failure is silent: `linesForRank`
 * falls back to 8 lines for a name it does not recognise, so a typo here quietly shows the user the
 * first rank's worth of lines under the name of the sixth.
 */
const LINES_PER_RANK: Record<string, number> = {
  Spark: 8,
  Ember: 16,
  Flame: 30,
  Blaze: 50,
  Forge: 80,
  Crucible: 99999,
};

export const RANK_ORDER = ['Spark', 'Ember', 'Flame', 'Blaze', 'Forge', 'Crucible'];

/** The first N lines of the opening's list — a balanced sample, not one chapter's worth. */
export function linesForRank(all: StudyLine[], rankName: string): StudyLine[] {
  return all.slice(0, LINES_PER_RANK[rankName] ?? 8);
}

/** How many more lines the NEXT rank would add. */
export function nextRankLineCount(all: StudyLine[], rankName: string): number {
  const i = RANK_ORDER.indexOf(rankName);
  if (i < 0 || i >= RANK_ORDER.length - 1) return 0;
  return linesForRank(all, RANK_ORDER[i + 1]).length - linesForRank(all, rankName).length;
}

/** How many distinct chapters a set of lines covers — the "is this one track or the opening" test. */
export function chaptersCovered(lines: StudyLine[]): number {
  return new Set(lines.map((l) => l.chapter)).size;
}

/** A family's record in the user's own games, which is the weakness signal. */
export interface FamilyRecord {
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** 0..1. Null when there are no games, so the UI can say "no games yet" rather than 0%. */
  winRate: number | null;
  meanAccuracy: number | null;
}

/**
 * Win rate and accuracy for one family, from his games.
 *
 * MATCHES ANY LABEL THE FAMILY ABSOLBER, NOT THE DISPLAY STRING - the same reason the engine pass
 * tests membership rather than `===`. A family that absorbed "Queen's Gambit" and "Queen's Pawn"
 * has a display name of "Queen's Gambit + Queen's Pawn", which no single game equals, and an
 * equality test would report a 0% win rate on the opening he has played most.
 *
 * Draws count as half a win, which is the standard convention and the one that stops a family of
 * draws from looking like a family of losses.
 */
export function familyRecord(family: FamilyLine, games: LichessGame[]): FamilyRecord {
  const labels = new Set(family.sourceNames ?? [family.sourceName]);
  const mine = games.filter((g) => labels.has(g.opening));

  let wins = 0, draws = 0, losses = 0, accSum = 0, accN = 0;
  for (const g of mine) {
    if (g.outcome === 'win') wins++;
    else if (g.outcome === 'draw') draws++;
    else losses++;
    if (typeof g.accuracy === 'number') { accSum += g.accuracy; accN++; }
  }
  const total = mine.length;
  return {
    games: total,
    wins, draws, losses,
    winRate: total === 0 ? null : (wins + draws * 0.5) / total,
    meanAccuracy: accN === 0 ? null : accSum / accN,
  };
}

/**
 * Rank for a family, from the mastery of its lines.
 *
 * A rank here is the same six-tier heat ladder as `LEVELS`: Spark at the bottom, Crucible at the
 * top. The rank is what decides how deep into a line the user is taken, so it has to be derived from
 * something that grows, which is why it reads mastery.
 *
 * The thresholds are deliberately coarse. Mastery is a 0..1 average over a handful of positions, and
 * a ladder with fine gradations would put a family on a different rank after a single drill.
 */
const RANKS: { key: string; name: string; at: number }[] = [
  { key: 'spark', name: 'Spark', at: 0 },
  { key: 'ember', name: 'Ember', at: 0.2 },
  { key: 'flame', name: 'Flame', at: 0.4 },
  { key: 'blaze', name: 'Blaze', at: 0.6 },
  { key: 'forge', name: 'Forge', at: 0.8 },
  { key: 'crucible', name: 'Crucible', at: 1 },
];

/** The rank a family has reached, and the one it is working toward. */
export function rankFor(masteryOutOf10: number): { current: string; next: string | null } {
  const m = Math.max(0, Math.min(10, masteryOutOf10)) / 10;
  let current = RANKS[0];
  for (const r of RANKS) if (m >= r.at) current = r;
  const next = RANKS.find((r) => r.at > current.at) ?? null;
  return { current: current.name, next: next ? next.name : null };
}

/**
 * How many plies of a line the user's rank allows them to be taken into.
 *
 * The floor is set so the shallowest rank still covers five moves a side. That is a choice about what
 * counts as a lesson rather than a preview: below about five moves there is nothing to remember and
 * nothing to have got wrong, so the shallowest rung would be a tap-through rather than a drill. Every
 * value above it is in PLIES, which is twice the moves the number suggests.
 *
 * WATCH THE `default`. It returns the whole line, so a name that is not one of the six is not
 * rejected — it is treated as the top rank, and the user is handed a complete line under a label the
 * ladder does not contain. The six cases below are therefore the complete set, and
 * `.bench/youropenings.test.mjs` asserts the names here, `RANK_ORDER`, `LINES_PER_RANK`, `RANKS` and
 * `LEVELS` are all the same six.
 */
export function depthForRank(rankName: string): number {
  switch (rankName) {
    case 'Spark': return 10;       // 5 moves
    case 'Ember': return 12;
    case 'Flame': return 18;       // 9 moves
    case 'Blaze': return 26;       // 13 moves
    case 'Forge': return 32;
    default: return 999;           // Crucible: the whole line
  }
}

/**
 * WHICH OPENINGS A TRAINING SESSION MAY DRAW FROM.
 *
 * The user asked for the trainer to give him *"positions from what we learned"* when he starts it
 * from Your openings. That needs a SCOPE - the opening he was looking at - and the scope arrives as
 * a plain optional id, which is a hazard worth containing rather than trusting.
 *
 * THE HAZARD, concretely. A React Native `Pressable` given `onPress={onTrain}` calls the handler
 * with the gesture event. If `onTrain` takes an opening id, that event arrives AS the id. It is a
 * truthy object, so a naive `id ? filter(id) : all` builds a session from an opening that does not
 * exist: the pool is empty, the screen says "Nothing to train yet", and nothing anywhere reports a
 * miswired button. A silent failure, so it is made impossible here rather than left to a code
 * review that has to remember it.
 *
 * The rule: an id that is not a real opening is treated as NO scope. A stale or mistyped id degrades
 * to the full review - what the user would have got before - rather than to an empty screen.
 * Returning nothing is never correct here, and it is the one outcome a caller cannot recover from.
 */
export function scopedOpenings<T extends { id: string }>(
  openings: readonly T[],
  openingId?: string | null,
): readonly T[] {
  if (typeof openingId !== 'string') return openings;      // absent, or a gesture event
  const hit = openings.filter((o) => o.id === openingId);
  return hit.length > 0 ? hit : openings;
}

/**
 * THE PLACES A TEST CAN ASK A QUESTION.
 *
 * A place is askable when it is a move the USER has to make: his own move, or a decision we had an
 * opinion about. That is the whole condition, and the three versions of it are worth recording because
 * each was wrong in a direction the user had to find on the device.
 *
 * VERSION 1 required `choice != null`.
 *   *"i completed a line where it asked me and i made a choice but there is no test. also there
 *   should be tests even if i didnt choose since i have lines completed."*
 *   `choice` is not a property of a position. It is a property of a position we could offer an
 *   alternative for. A line the engine had no opinion about has no `choice` anywhere, so it produced
 *   nothing askable — even though the user had just played it move by move.
 *
 * VERSION 2 required a real `position.key` as well.
 *   *"again i completed a line where i played a suggested move and it says no test! the test should
 *   be there whether i played my move or a suggested move and even if there is no askable position"*
 *   This is the one that is genuinely wrong, and it is wrong in principle rather than in a threshold.
 *   A position key exists to record PROGRESS against a position. It is bookkeeping, not content. The
 *   moment the user takes our recommendation the line is re-derived by `continueLine`, and the steps
 *   the engine or a book supplies carry `position: null` — they are not positions the user was asked
 *   about, so there is nothing to record, which is correct. But the MOVE is still there, still his to
 *   play, and asking him to play it is the entire point of a test. Requiring the key made the test
 *   contingent on the bookkeeping, so playing our own recommendation — the good outcome, the one the
 *   app is steering him towards — was the surest way to get no test at all.
 *
 * So the key is no longer part of the condition. It is carried when it exists, and `null` when it does
 * not, and the only thing that then changes is that progress is not recorded for that question. A test
 * that cannot be scored is a worse test; a test that cannot be asked is not a test.
 */
export interface AskablePlace<T = unknown> {
  /**
   * The position key to record progress against, or `null` when the step has no position.
   *
   * `null` is a normal answer, not a failure. It is what a book or engine move looks like.
   */
  key: string | null;
  /**
   * A stable identity for this place, used to avoid asking the same one twice running.
   *
   * Never the bare ply, because two lines can both have their third move at index 5.
   */
  id: string;
  /** Index of the question within its line. */
  ply: number;
  /**
   * The line the question belongs to.
   *
   * Carried rather than looked up afterwards, because the ply alone does not identify a line, and
   * walking the wrong line's moves to that ply would put a different position on the board. An earlier
   * version guessed the owner and had a `void owner` in it, which is the shape a wrong guess takes
   * when nothing checks it.
   */
  line: T;
}

export function askablePositions<T extends { id?: string }>(
  lines: readonly {
    id?: string;
    steps: readonly {
      choice?: unknown;
      isUserMove?: boolean;
      position?: { key?: string | null } | null;
    }[];
  }[],
): AskablePlace<T>[] {
  const out: AskablePlace<T>[] = [];
  for (const entry of lines as readonly {
    id?: string;
    steps: readonly {
      choice?: unknown;
      isUserMove?: boolean;
      position?: { key?: string | null } | null;
    }[];
  }[]) {
    const lineId = entry.id ?? '';
    for (let i = 0; i < entry.steps.length; i += 1) {
      const s = entry.steps[i];
      // His move, or a decision we had an opinion about. Either way there is a question to ask.
      if (s.choice == null && s.isUserMove !== true) continue;
      const key = s.position?.key ?? null;
      out.push({ key, id: key ?? `${lineId}#${i}`, ply: i, line: entry as unknown as T });
    }
  }
  return out;
}
/* --------------------------------------------------------------------------
 * THE USER'S OWN DECISIONS, BY POSITION
 * ------------------------------------------------------------------------ */

export interface YourDecision {
  /** The position, with move counters stripped, so it joins to a course prefix. */
  fenKey: string;
  /** The move the user played in their own game. */
  playedSan: string;
  playedUci: string;
  /** What we recommend at this position, when the position was analysed. */
  recommendSan: string | null;
  recommendUci: string | null;
  /** Engine verdict on the played move, or null when it was never analysed. */
  verdict: 'mistake' | 'blunder' | null;
  /** Centipawns the played move gave away, or 0 when never analysed. */
  lossCp: number;
  /** Which opening Lichess labelled, for filtering the index to one opening. */
  opening: string;
  /** How many of the user's games reached this position. */
  timesSeen: number;
  /** The game the decision came from, so the note can be traced back to it. */
  gameId: string;
  gameUrl: string;
  /** The move number this happened at, for the note. */
  ply: number;
}

/**
 * The user's own moves, keyed by POSITION, so any view of an opening can ask
 * "what did I play here, and what should I have played".
 *
 * WHY A POSITION KEY AND NOT A LINE INDEX
 * ---------------------------------------
 * A decision belongs to a POSITION, not to a line. The same position is reached by several games,
 * by several lines of one opening, and by the course line the user is reading right now - none of
 * which share a move order. Keying on the line could not answer "what did I do here", because the
 * line the user is reading was never one of his.
 *
 * WHY THE WORST ENTRY WINS
 * ------------------------
 * Four games reached the position and one of them lost a piece. Indexing by FEN means four entries
 * collide, and keeping the last one written made the note depend on fetch order. A position the user
 * blundered in should read as a blunder regardless of which game happened to be analysed last, so
 * the entry with the largest loss wins, and ties prefer the one seen most often.
 */
export function buildDecisionIndex(
  positions: readonly {
    fen: string; playedSan: string | null; playedUci: string | null;
    recommendSan?: string | null; recommendUci?: string | null;
    verdict?: 'mistake' | 'blunder' | null; lossCp?: number;
    opening?: string; timesSeen?: number; gameId?: string; gameUrl?: string; ply?: number;
  }[],
  fenKeyOf: (fen: string) => string,
): Map<string, YourDecision> {
  const byFen = new Map<string, YourDecision>();
  for (const p of positions) {
    // No played move means the game ended on this position. There is no decision to record and no
    // arrow to draw, so it is skipped rather than stored as a blank entry that would shadow a real
    // one from another game.
    if (!p.playedSan || !p.playedUci) continue;
    const k = fenKeyOf(p.fen);
    const loss = typeof p.lossCp === 'number' && Number.isFinite(p.lossCp) ? p.lossCp : 0;
    const cand: YourDecision = {
      fenKey: k,
      playedSan: p.playedSan,
      playedUci: p.playedUci,
      recommendSan: p.recommendSan ?? null,
      recommendUci: p.recommendUci ?? null,
      verdict: p.verdict ?? null,
      lossCp: loss,
      opening: p.opening ?? '',
      timesSeen: typeof p.timesSeen === 'number' ? p.timesSeen : 1,
      gameId: p.gameId ?? '',
      gameUrl: p.gameUrl ?? '',
      ply: typeof p.ply === 'number' ? p.ply : 0,
    };
    const held = byFen.get(k);
    if (!held || loss > held.lossCp || (loss === held.lossCp && cand.timesSeen > held.timesSeen)) {
      byFen.set(k, cand);
    }
  }
  return byFen;
}

/**
 * The decision to SHOW at a position, or null.
 *
 * A decision is only shown where it is the user's move. A position the opponent reached - every
 * second ply - has a stored entry from the opponent's move in some game, and drawing "you played
 * this" over the opponent's reply would be reporting the opponent's move as the user's.
 */
export function decisionAt(
  byFen: Map<string, YourDecision> | null | undefined,
  fen: string | null | undefined,
  fenKeyOf: (fen: string) => string,
  sideToMove: 'w' | 'b' | null | undefined,
  userSide: 'w' | 'b' | null | undefined,
): YourDecision | null {
  if (!byFen || !fen || !sideToMove || !userSide) return null;
  if (sideToMove !== userSide) return null;
  return byFen.get(fenKeyOf(fen)) ?? null;
}

/* --------------------------------------------------------------------------
 * THE LOOP: TODO, MISTAKE, UNCLEAR, SOLVED
 * ------------------------------------------------------------------------ */

/**
 * Where a position sits in the loop that takes a move from "not looked at" to "known".
 *
 * These four names, and this order, are the ones the user asked for: to-do, mistake, unclear,
 * correct. They were written out inline in the trainer's screen and nowhere else, so the openings
 * drill could not use them - it had progress counts (`asked`, `correct`) and no state to show, which
 * is why "does the loop work here too" had no answer beyond "there is nothing to loop".
 *
 * `solved` rather than `correct`, because a position can be answered correctly once and still not be
 * known - that is what `unclear` exists for, and calling it "correct" would collapse the two states
 * the loop is built to keep apart.
 */
export type OpeningLoopState = 'todo' | 'mistake' | 'unclear' | 'solved';

/**
 * Where a position goes after one attempt.
 *
 *   - a clean pass over a fresh position SOLVES it. Nothing has to go wrong twice to be called known.
 *   - a clean pass over one that was MISTAKEN marks it UNCLEAR, not solved. It has now been answered
 *     right once after being answered wrong, and one right answer does not undo a wrong one - it is
 *     the state that means "come back and confirm".
 *   - a clean pass over UNCLEAR solves it. That is the confirmation, and it is the only way in.
 *   - any mistake marks it MISTAKE, whatever it was before. A position you have solved can be solved
 *     badly again, and the honest state is the one that says it will come back.
 *
 * Extracted from the trainer verbatim rather than redesigned: the trainer's loop is the loop the user
 * described, and a second version of it would drift from the one they already know.
 */
export function nextLoopState(prev: OpeningLoopState, clean: boolean): OpeningLoopState {
  if (!clean) return 'mistake';
  if (prev === 'todo') return 'solved';
  if (prev === 'mistake') return 'unclear';
  return 'solved';
}

/**
 * The sentence under the flash, in the trainer's words.
 *
 * Every branch names the state it moved to, because a transition that reports only "wrong" or "ok"
 * cannot be told apart from a wrong answer to a different question. `unclear` in particular reads as
 * a failure if it is not explained: it is neither solved nor mistaken, and that is the point of it.
 */
export function loopMessage(prev: OpeningLoopState, next: OpeningLoopState): string {
  if (next === 'mistake') return 'Mistake noted � this one will come back later in the session.';
  if (prev === 'todo' && next === 'solved') return 'Solved with zero mistakes � memorized!';
  if (prev === 'mistake' && next === 'unclear') {
    return 'Clean repeat � marked unclear. One more clean pass to confirm it.';
  }
  if (prev === 'unclear' && next === 'solved') return 'Confirmed � fully memorized!';
  if (next === 'solved') return 'Solved.';
  return 'Marked unclear.';
}

/**
 * Order a test queue so the positions still outstanding come first.
 *
 * A queue that kept its original order asked about position 1, then position 2, and a mistake on the
 * first one could sit untouched until the end - which is the opposite of drilling. `mistake` and
 * `unclear` are the positions the user has not finished learning, so they are asked again before
 * anything new is introduced, and within each group the user's own order is preserved.
 *
 * `solved` positions are kept rather than dropped: a position that has been solved and then solved
 * badly is `mistake` again, and a queue that could not hold a solved position could not show that.
 */
export function orderLoopQueue<T extends { state: OpeningLoopState }>(
  items: readonly T[],
): T[] {
  const rank: Record<OpeningLoopState, number> = { mistake: 0, unclear: 1, todo: 2, solved: 3 };
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (rank[a.it.state] - rank[b.it.state]) || (a.i - b.i))
    .map((x) => x.it);
}

/** The counts the drill header shows: how much of the opening is left, and in what state. */
export function loopCounts(items: readonly { state: OpeningLoopState }[]): Record<OpeningLoopState, number> {
  const out: Record<OpeningLoopState, number> = { todo: 0, mistake: 0, unclear: 0, solved: 0 };
  for (const it of items) out[it.state] += 1;
  return out;
}

/**
 * The state a position should START in, given what has already been recorded for it.
 *
 * Progress is persisted per position (`asked`, `correct`) while the loop state lives in the session,
 * so a position answered in an earlier session comes back as `todo` and is asked from the beginning.
 * That is deliberate: `asked` and `correct` are counters for statistics, and reading a state out of
 * them would claim knowledge the loop never confirmed.
 */
export function loopStateForNewSession(): OpeningLoopState {
  return 'todo';
}
