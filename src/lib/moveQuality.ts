'use client';

/**
 * Move classification for engine review.
 *
 * Every analyzed move receives exactly one QualityKind. The kinds the app SHOWS are:
 *
 *  - book        within your repertoire, and it cost nothing (brown B)
 *  - brilliant   a sacrifice that is also the engine's best move (teal !!)
 *  - best        matches the engine's top move (green star)
 *  - good        solid - under 12% of the mover's expected score
 *  - mistake     12% to just under 22% of the mover's expected score
 *  - blunder     22% or more of the mover's expected score
 *
 * THE BANDS ARE WIN-PROBABILITY BANDS, NOT CENTIPAWN BANDS.
 *
 * The old table called a move a mistake from 50cp of loss. That is only about
 * 4.6% of a win in an equal position, and it is smaller than the noise in a
 * single shallow search: a perfectly reasonable game came back looking full of
 * mistakes. Lichess classifies by how much winning chance a
 * move actually gave up, because the same 100cp is trivial at +9.00 and serious
 * at equality. The exact 12%/22% split is the `inaccuracy`/`mistake`
 * boundary folded into the two labels this app shows: with no `inaccuracy`
 * grade, everything below a real mistake is `good`.
 *
 * FOUR LABELS WERE RETIRED, at the user's request: "there is brillant, best move good move,
 * mistake and blunder and book but there is others i dont know what so remove them", plus
 * "i forget about the critical move to keep it". So `great` (the only-move/critical-move
 * label), `excellent`, `inaccuracy` and `miss` are no longer produced - see the folding note in
 * `classifyMove` for the exact thresholds that changed.
 *
 * THEY STILL EXIST IN THE TYPE, in `QUALITY_META` and in the database columns, on purpose. A
 * report saved before this change has those labels in it, and a review that could not name its
 * own stored verdicts would render an old game as blank. Nothing produces them; nothing shows
 * them; `ACTIVE_KINDS` is what the UI iterates.
 */

import { Chess } from 'chess.js';
import { pointLoss } from './accuracy';
import { sacrificeValue } from './sacrifice';

export type QualityKind =
  | 'brilliant'
  | 'great'
  | 'best'
  | 'excellent'
  | 'good'
  | 'book'
  | 'inaccuracy'
  | 'miss'
  | 'mistake'
  | 'blunder';

export interface QualityMeta {
  name: string;
  short: string;       // annotation used after SAN
  color: string;       // circle fill
  glyph: string;       // text inside the circle
}

/**
 * Move-quality colours — THEME-INDEPENDENT by design.
 *
 * These ten tones are a shared vocabulary, not UI chrome: they follow the
 * conventions chess players already know, so a "blunder" reads as red and a
 * "brilliant" as teal in any theme. They are always painted on a
 * filled circle with a white glyph, so they carry their own contrast and never
 * sit directly on the page background. They therefore do NOT come from
 * `theme/tokens` — a light theme must not restyle them.
 */
export const QUALITY_META: Record<QualityKind, QualityMeta> = {
  brilliant: { name: 'Brilliant', short: '!!', color: '#26c2a3', glyph: '!!' },
  great: { name: 'Great Move', short: '!', color: '#749bbf', glyph: '!' },
  best: { name: 'Best Move', short: '', color: '#81b64c', glyph: '★' },
  excellent: { name: 'Excellent', short: '', color: '#96bc4b', glyph: '✓' },
  // The reference draws `good` as a full tick, so it is the same shape here; the
  // retired `excellent` keeps its slightly different green on purpose, for old
  // saved games.
  good: { name: 'Good', short: '', color: '#9caf88', glyph: '✓' },
  book: { name: 'Book', short: '', color: '#a88865', glyph: '📖' },
  inaccuracy: { name: 'Inaccuracy', short: '?!', color: '#f7c631', glyph: '?!' },
  miss: { name: 'Missed win', short: '?', color: '#ff7769', glyph: '✗' },
  mistake: { name: 'Mistake', short: '?', color: '#ffa459', glyph: '?' },
  blunder: { name: 'Blunder', short: '??', color: '#d95c5c', glyph: '??' },
};

/**
 * Heuristic sacrifice detector: after the move, can the opponent win at least
 * two pawns of material by any capture (not only by taking the piece that just
 * moved), counting the material the move itself won and the best immediate
 * recapture?
 *
 * The two-pawn floor belongs to `brilliant`, not to the idea of a sacrifice:
 * the personality layer asks `sacrificeValue` for offers of one pawn, because a
 * pawn gambit is a real gambit. This wrapper keeps the stricter classification
 * claim separate from the style signal.
 */
export function isSacrifice(fenBefore: string, uci: string): boolean {
  return sacrificeValue(fenBefore, uci) >= 2;
}

export interface ClassifyInput {
  ply: number;              // 0-based index of the move in the game
  playedUci: string | null; // the played move (uci)
  bestUci: string | null;   // engine best move in the position before
  fenBefore: string;
  fenAfter: string;
  cpBefore: number;         // White-perspective cp BEFORE the move
  cpAfter: number;          // White-perspective cp AFTER the move
  mover: 'w' | 'b';
  bookPlies: number;        // how many plies of this game are repertoire book
  /**
   * Centipawn gap between the best move and the second-best, as a magnitude.
   * Only a MultiPV caller can supply this; without it the classifier returns
   * `best` rather than guessing `brilliant`.
   */
  bestGap?: number | null;
}

const MOVER = (cp: number, mover: 'w' | 'b') => (mover === 'w' ? cp : -cp);

/**
 * How far the second-best line must be behind for a sacrifice to count as the ONLY move.
 *
 * This is the "forced" test. `bestGap` is the centipawn gap between the best move and the runner-up,
 * so a large gap means nothing else came close — which is the property that makes a sacrifice
 * brilliant rather than merely good.
 *
 * 150 is a little over a pawn. Below that the two lines are close enough that calling the better one
 * "the only move" would be asserting something the search did not actually show; above it, the
 * alternative is losing real material. Mate scores fold into the same scale and dwarf it, so a
 * forced mate-with-sacrifice satisfies this without special-casing.
 *
 * It is a threshold, so it is a judgement — but it is a judgement about a NUMBER the engine reports,
 * which is testable, rather than about a shape someone eyeballed.
 */
export const BRILLIANT_MIN_GAP = 150;

/**
 * How much evaluation a sacrifice is allowed to cost and still be an OFFER rather than a mistake.
 *
 * This is a check on the move, and it replaces the old `after >= -50`, which was a statement about
 * the absolute score and so was satisfied by "I am still roughly level" — including by a sacrifice
 * that quietly gave up half a pawn. A move that measurably lost ground cannot be an offer, whatever
 * the engine's ranking says about it.
 *
 * 30cp is a twentieth of a pawn: below the noise of a single search, and far below both the 110cp
 * book ceiling and the 0.12 expected-score mistake boundary in this file, so `brilliant`, `book`
 * and the bad-move bands can never disagree about whether something was lost. Expressed as a DROP
 * from the move's own starting score rather than as a final score, because "did this move cost me
 * anything" is the question — the starting position may be winning, level or losing and none of
 * that is the move's doing.
 */
export const SACRIFICE_COST_CP = 30;

/**
 * How much expected score a move must give up before it stops being `good`.
 *
 * The `mistake` boundary sits at 0.12 expected points. This app does
 * not show `inaccuracy`, so the 0.08-0.12 `inaccuracy` band is deliberately
 * folded into `good` rather than promoted to a scarier word. 0.12 is therefore
 * the first real mistake, and 0.22 is the first blunder (the next
 * boundary).
 *
 * These are fractions of a win, not centipawns. In an equal position 0.12 is
 * roughly 140cp and 0.22 is roughly 260cp; at +5.00 the same fractions cost far
 * more centipawns, and that is the point.
 */
export const MISTAKE_POINT_LOSS = 0.12;
export const BLUNDER_POINT_LOSS = 0.22;

/**
 * A move that leaves the mover this far ahead is still winning, and a loss that
 * merely reduces a winning position is not a mistake.
 *
 * This exists for the mate-to-score transition. A forced mate is folded onto the
 * centipawn scale as roughly +10000, so when a winning combination simplifies
 * into a position that is "only" +4.00, the arithmetic sees a 0.20 expected-point
 * drop and calls the move a mistake — in a game the player is still winning. It is
 * the same artefact that turns a delivered mate into a blunder, which the
 * `mateDelivered` branch already handles; this is its sibling.
 *
 * Lichess does not have this problem because its win-probability curve is much
 * flatter in that range: 100% to about 81% is below its 20% mistake boundary. 400
 * is where that boundary falls on this app's expected-points curve, so the guard
 * reproduces Lichess's behaviour with the curve the bands are stated in.
 */
export const CLEAR_WIN_CP = 400;

/**
 * A book move may still be called `book` on a small loss, but not on a real
 * one. The raw centipawn guard is kept alongside the expected-score guard:
 * 110cp is the old book ceiling, and it prevents a move that hangs material in
 * a still-winning position from being excused as theory merely because the win
 * probability barely moved.
 */
export const BOOK_MAX_POINT_LOSS = MISTAKE_POINT_LOSS;
export const BOOK_MAX_CP_LOSS = 110;

export function classifyMove(inp: ClassifyInput): QualityKind {
  const { ply, playedUci, bestUci, fenBefore, fenAfter, cpBefore, cpAfter, mover, bookPlies, bestGap } = inp;

  const before = MOVER(cpBefore, mover);
  const after = MOVER(cpAfter, mover);
  const drop = Math.max(0, before - after);
  // The actual cost of the move, in expected score (0..1). This is the number
  // the three bands below are stated in; `drop` is retained for the raw
  // centipawn checks that are about material/theory.
  const loss = pointLoss(before, after);

  const matchesBest = playedUci != null && bestUci != null && playedUci === bestUci;
  const mateDelivered = new Chess(fenAfter).isCheckmate();
  const sacrifice = playedUci ? isSacrifice(fenBefore, playedUci) : false;

  /*
   * A CHECKMATE IS ALWAYS THE BEST MOVE, EVEN IF THE ENGINE'S REPORTED bestmove
   * FIELD DISAGREES.
   *
   * The engine can return no best move for a terminal position, and a PGN can
   * contain a mating move that was not the engine's first choice in an earlier,
   * shallower search. Falling through to the eval ladder used to make a mating
   * move "good" — or, worse, a blunder when the final position's mate score was
   * read with the wrong sign. The board already knows the move ended the game;
   * that fact does not need the engine's permission.
   *
   * A checkmate is `best`, not `brilliant`, even when the mating move offers
   * material: Checkmate is short-circuited to BEST before it considers
   * brilliant/critical, and a star is the honest badge for "this ended the game".
   */
  if (mateDelivered) return 'best';

  /*
   * THEORY STANDS — BUT NOT AGAINST A REAL LOSS.
   *
   * This used to be an unconditional `if (ply < bookPlies) return 'book';` on the
   * first line of the function, before the eval was even read. Being inside a book
   * line says the MOVE is one the user's repertoire contains; it says nothing about
   * whether it was the right one in this game. So a user who misplayed a known line
   * — hanging a queen in a book sequence, dropping a piece to a fork — was badged
   * "Book" and hidden from the key moments.
   *
   * Theory now claims a move only when BOTH measures agree it was harmless: the
   * raw loss is under the old 110cp book ceiling, and the expected-score loss is
   * below the mistake boundary. The raw guard matters in a winning position,
   * where a 110cp+ material loss can barely move the win probability and must not
   * be excused as theory.
   */
  if (ply < bookPlies && drop < BOOK_MAX_CP_LOSS && loss < BOOK_MAX_POINT_LOSS) {
    return 'book';
  }

  if (matchesBest) {
    /*
     * "BRILLIANT" IS "THE ONLY MOVE THAT WINS", AND THAT IS A CLAIM ABOUT THE ALTERNATIVES.
     *
     * This used to be:
     *
     *     if (sacrifice && after >= -50) return 'brilliant';
     *
     * which reads as "the engine's top choice gives up material and the position still looks fine".
     * That is not a brilliant move, it is the weakest possible statement, and it is TRUE OF ALMOST
     * EVERY BEST MOVE THAT WALKS INTO A CAPTURE — including a knight simply stepped onto a square a
     * pawn attacks. The user's words after seeing one: *"it gave me a brillant move and it is not a
     * brillant move"*, which is the gate working and the rule being wrong.
     *
     * Two things were missing, and both are about evidence rather than taste:
     *
     *   1. THE ALTERNATIVES WERE NEVER COMPARED. A brilliant sacrifice is only brilliant because
     *      everything else loses — the whole point is that a human would not find it. `bestGap` is the
     *      gap between the best line and the second-best, and it is the only number that says the
     *      alternatives were worse. It comes from a MultiPV search, and until now NO caller supplied
     *      it: the analyse screen ran single-PV, so the classifier fell back to the eval-only test
     *      above and could not tell "the only move" from "the best of twenty".
     *
     *      So without a gap we return `best`. Claiming `brilliant` without the evidence that
     *      distinguishes it is worse than under-claiming, because `best` is still a good move and a
     *      wrong `brilliant` is a lie the user has to learn not to trust.
     *
     *   2. `after >= -50` IS "THE ENGINE CANNOT SEE WHY I GAVE UP MATERIAL". At depth 8-10 a
     *      combination is invisible, so this is satisfied by a sacrifice the engine simply failed to
     *      refute. What replaced it asks the move's own question — did it cost anything? — rather than
     *      asking about the absolute score, so a sacrifice from a losing position can still qualify.
     *
     * The remaining guards are the "critical move" conditions: a sacrifice in a
     * completely winning position is not brilliant, nor is one in a losing position, nor a
     * forced reply to check, nor a promotion. They are conservative on purpose — a missing
     * brilliant is a smaller error than a false one.
     */
    const secondBest = bestGap == null ? null : before - bestGap;
    const inCheckBefore = new Chess(fenBefore).isCheck();
    const isPromotion = playedUci != null && playedUci.length > 4;
    const critical = after >= 0
      && secondBest != null
      && secondBest < 700
      && !inCheckBefore
      && !isPromotion;

    if (sacrifice
      && critical
      && before - after <= SACRIFICE_COST_CP
      && bestGap != null
      && bestGap >= BRILLIANT_MIN_GAP) {
      return 'brilliant';
    }
    return 'best';
  }

  /*
   * THE SIX MOVES, AND WHY THERE ARE NO OTHERS.
   *
   * The request: *"there is brillant, best move good move, mistake and blunder and book but
   * there is others i dont know what so remove them"*, and then *"i forget about the critical
   * move to keep it"*.
   *
   * So `great` ("the best move and the only one that keeps the game" - the critical-move label
   * he named explicitly), `excellent`, `inaccuracy` and `miss` are no longer produced. Four
   * labels the user cannot act on are worse than two they can: a review that says "Inaccuracy"
   * against "Mistake" is drawing a distinction the player has not asked to be taught.
   *
   * The bands are stated in expected score, not centipawns:
   *
   *     good      loss <  0.12   (excellent, okay and inaccuracy collapsed here)
   *     mistake   0.12 <= loss < 0.22
   *     blunder   loss >= 0.22
   *
   * This is the classification ladder with its `inaccuracy` band folded
   * into `good`. The old 50cp/250cp ladder called a 4.6% swing a mistake and made
   * ordinary games look like disaster zones; 0.12 starts at roughly 140cp in an
   * equal position and does not punish a move for losing centipawns that were
   * never worth anything.
   *
   * WHAT IS DELIBERATELY NOT REMOVED: the `great`, `excellent`, `inaccuracy` and `miss` cases
   * still exist in the type, the `QUALITY_META` table and the database columns. Games analysed
   * before this change already have those labels stored, and a report that could no longer name
   * them would render a saved game as blank. Nothing produces them any more, and nothing
   * displays them - see `ACTIVE_KINDS`.
   */
  if (loss < MISTAKE_POINT_LOSS) return 'good';
  /*
   * A MOVE THAT KEEPS A WON GAME WON IS NOT A MISTAKE.
   *
   * Lichess's win probability is already ~81% at +4.00, so dropping from a
   * forced mate (100%) to +4.00 is a small accuracy cost there, not a defect.
   * On this app's expected-points curve the same transition is 0.20 and would
   * be badged a mistake, so the guard states the equivalence explicitly rather
   * than pretending the two curves agree at the top of the scale.
   */
  if (after >= CLEAR_WIN_CP) return 'good';
  if (loss < BLUNDER_POINT_LOSS) return 'mistake';
  return 'blunder';
}

/**
 * The labels the app shows, in the order a player reads them.
 *
 * The display vocabulary, as opposed to `QUALITY_ORDER`, which is every kind the type and the
 * database can still hold so that previously-saved games keep rendering.
 */
export const ACTIVE_KINDS: QualityKind[] = ['brilliant', 'best', 'good', 'book', 'mistake', 'blunder'];

/** All kinds shown in the "key moments" list. */
export const KEY_KINDS: QualityKind[] = ['brilliant', 'miss', 'blunder', 'mistake', 'inaccuracy'];

export const QUALITY_ORDER: QualityKind[] = [
  'brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'miss', 'mistake', 'blunder',
];
