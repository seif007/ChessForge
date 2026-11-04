/**
 * ENDGAME TECHNIQUE, CHOSEN BY THE MATERIAL ON THE BOARD.
 *
 * The coach used to pick its endgame teaching by prose score, so a king-and-
 * pawn ending was told "In rook endings activity beats material: active rook,
 * king forward, rooks behind passers" — a sentence about rooks on a board with
 * no rooks, in a position whose whole subject is the opposition. The student
 * who asks "what is the plan here?" in a K+P ending got rook advice.
 *
 * The KB already holds the right answers (the king-and-pawn-vs-king page, the
 * pawn-endgame page, the rook-endgame page), each with a winning method and a
 * holding method. What was missing was the link from the board to the page.
 * That link is here: the analyzer labels the shape of the ending, and this
 * module turns that label into the page, its plan for the side to move, and
 * the one related idea worth reading next.
 *
 * THE PLAN IS PICKED BY WHO IS BETTER OFF, NOT BY COLOUR.
 *
 * The KB's endgame plans are written as "Winning method: ..." and "Holding
 * method: ...", so the white/black split in the data is the winning/holding
 * split, not White/Black. Telling the side that is holding a winning method
 * is exactly backwards, so the side to move is compared on material first and
 * the matching text is used.
 */

import { BLACK, rankOf, sqName, WHITE } from './board';
import type { PositionReport } from './features';
import type { KbIndex } from './kb';

export interface EndgameRelated {
  title: string;
  summary: string;
}

export interface EndgameLesson {
  /** The KB row that teaches this ending. */
  kbName: string;
  title: string;
  summary: string;
  /** The plan for the side to move, in the side to move's own words. */
  plan: string;
  /** The one related page worth reading next. */
  related?: EndgameRelated;
  /** The hook tokens that put this page into the context. */
  tags: string[];
}

interface Material {
  pawns: number;
  knights: number;
  bishops: number;
  rooks: number;
  queens: number;
}

const value = (m: Material): number =>
  m.pawns * 100 + m.knights * 300 + m.bishops * 300 + m.rooks * 500 + m.queens * 900;

/**
 * The lesson for [r], or null when the position is not an ending the KB
 * teaches a technique for.
 */
export function endgameLessonFor(r: PositionReport, kb: KbIndex): EndgameLesson | null {
  const tag = r.endgameTags[0];
  if (!tag) return null;

  const w = r.material[WHITE];
  const b = r.material[BLACK];
  if (!w || !b) return null;
  const stm = r.stm;
  const me = stm === WHITE ? w : b;
  const them = stm === WHITE ? b : w;
  const meValue = value(me);
  const themValue = value(them);
  const behind = meValue < themValue;

  const row = (name: string) => kb.byName(name);

  const build = (
    kbName: string,
    related?: string,
  ): EndgameLesson | null => {
    const e = row(kbName);
    if (!e) return null;
    const relatedRow = related ? row(related) : null;
    return {
      kbName,
      title: e.title,
      summary: e.summary,
      plan: '',
      related: relatedRow
        ? { title: relatedRow.title, summary: relatedRow.summary }
        : undefined,
      tags: [tag],
    };
  };

  switch (tag) {
    case 'endgame_kpk': {
      /*
       * KING AND PAWN AGAINST KING. The side with the pawn is trying; the bare
       * king is holding, and the answer to "what is the plan?" is different for
       * each of them.
       */
      const lesson = build('kpk', 'pawn_endgame_principles');
      if (!lesson) return null;
      const withPawn = w.pawns > 0 ? WHITE : BLACK;
      const iAmTrying = stm === withPawn;
      const e = row('kpk')!;
      lesson.plan = iAmTrying ? e.whitePlan : e.blackPlan;
      return lesson;
    }
    case 'endgame_pawns': {
      const lesson = build('pawn_endgame_principles', 'square_rule');
      if (!lesson) return null;
      const e = row('pawn_endgame_principles')!;
      lesson.plan = behind ? e.blackPlan : e.whitePlan;
      return lesson;
    }
    case 'endgame_rook': {
      const lesson = build('rook_endgame_principles', 'pawn_endgame_principles');
      if (!lesson) return null;
      const e = row('rook_endgame_principles')!;
      lesson.plan = behind ? e.blackPlan : e.whitePlan;
      return lesson;
    }
    case 'endgame_rp_r': {
      /*
       * ROOK AND PAWN AGAINST ROOK. The rook side's task is activity and the
       * passer; the pawn side's task is the square rule and the third-rank
       * fence. The rook-endgame page is the safe, always-true statement, and
       * the square rule is the counting technique worth adding.
       */
      const lesson = build('rook_endgame_principles', 'square_rule');
      if (!lesson) return null;
      const e = row('rook_endgame_principles')!;
      lesson.plan = behind ? e.blackPlan : e.whitePlan;
      return lesson;
    }
    case 'endgame_opposite_bishops': {
      const lesson = build('opposite_bishops', 'fortress_and_draws');
      if (!lesson) return null;
      const e = row('opposite_bishops')!;
      lesson.plan = e.blackPlan;
      return lesson;
    }
    case 'endgame_bishop_knight': {
      const lesson = build('bishop_vs_knight', 'fortress_and_draws');
      if (!lesson) return null;
      const e = row('bishop_vs_knight')!;
      // This page is written by piece, not by side: the bishop side opens the
      // position, the knight side fixes the chains.
      const iHaveTheBishop = me.bishops > 0 && me.knights === 0;
      lesson.plan = iHaveTheBishop ? e.whitePlan : e.blackPlan;
      return lesson;
    }
    case 'endgame_qk': {
      /*
       * A QUEEN AGAINST A BARE KING. It is simply won, and the one thing
       * that can go wrong is stalemating the poor king — so the technique
       * worth naming is the one that ends it, not a fortress.
       */
      return {
        kbName: 'kpk',
        title: 'Queen against a bare king',
        summary: 'A queen beats a bare king easily; the only care needed is not to stalemate the defender.',
        plan: 'A queen beats a bare king: bring the king to the edge, then drive the king to the corner and checkmate on the eighth rank. Watch for stalemate.',
        tags: [tag],
      };
    }
    case 'endgame_dead': {
      /*
       * K+N AGAINST K, OR K+B AGAINST K. There is no mate, so the game is
       * drawn by insufficient material, and the only thing worth telling the
       * student is that. The fortress page is not quoted either: it says
       * "convert by opening a second front", which is advice for a win that
       * cannot happen.
       */
      return {
        kbName: 'kpk',
        title: 'Insufficient material (drawn)',
        summary: 'One minor piece cannot mate a bare king, so this position is drawn by insufficient material and there is nothing to convert.',
        plan: 'This position is drawn: one minor piece cannot mate a bare king, so there is nothing to convert. Offer a draw.',
        tags: [tag],
      };
    }
    case 'endgame_fortress': {
      /*
       * FORTRESES, STALEMATE, PERPETUAL CHECK, INSUFFICIENT MATERIAL. The
       * losing side's plan is the one that matters here: it is the whole game.
       */
      const lesson = build('fortress_and_draws', 'square_rule');
      if (!lesson) return null;
      const e = row('fortress_and_draws')!;
      lesson.plan = behind ? e.blackPlan : e.whitePlan;
      return lesson;
    }
    default:
      return null;
  }
}

/** The KB rows this lesson's related page may name, for the context. */
export function relatedEndgameNames(lesson: EndgameLesson | null): string[] {
  if (!lesson) return [];
  return [lesson.kbName];
}

/** A short description of the ending's shape, for logs and tests. */
export function describeShape(r: PositionReport): string {
  const tag = r.endgameTags[0];
  if (!tag) return 'no ending';
  const w = r.material[WHITE];
  const b = r.material[BLACK];
  if (!w || !b) return tag;
  return `${tag}: white ${w.pawns}p ${w.knights}n ${w.bishops}b ${w.rooks}r ${w.queens}q, `
    + `black ${b.pawns}p ${b.knights}n ${b.bishops}b ${b.rooks}r ${b.queens}q`;
}

/** The squares the ending's pawns stand on, for the gate that checks detection. */
export function pawnSquaresOf(r: PositionReport, side: number): string[] {
  return r.pawnSquares[side].map(sqName);
}

/** True when [sq] is on [side]'s own half of the board. */
export function onOwnHalf(sq: number, side: number): boolean {
  const r = rankOf(sq);
  return side === WHITE ? r <= 3 : r >= 4;
}
