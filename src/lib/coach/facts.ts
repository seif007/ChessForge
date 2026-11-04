/**
 * The fact factory: every machine-verified statement the coach may narrate.
 * A TypeScript port of the Kotlin prototype's `coach/coach/GroundedFacts.kt`.
 *
 * All verbalization happens here, once, deterministically — narrators (template
 * or LLM) never invent chess content; they only arrange these sentences.
 */

import {
  BLACK, colorOf, EMPTY, fileOf, PAWN, pieceName, rankOf, sqName, WHITE,
} from './board';
import {
  analyzeFen, ColorWeakness, DevelopmentFacts, HoleInfo, KingSafetyFacts, MaterialCount,
  OutpostInfo, Phase, PositionReport, sideName,
} from './features';
import { KbEntry, KbIndex } from './kb';
import { legalSan, sanPv } from './san';
import { CoachMoveReview, moverCpAfter, moverCpBefore, MoveGrade } from './review';
import { endgameLessonFor, type EndgameLesson } from './endgame';

/** One machine-verified statement about a position or move. */
export interface GroundedFact {
  /** move | eval | best | phase | material | structure | holes | outposts | colour | king | loose | rooks | development | passed | kb */
  kind: string;
  text: string;
  /**
   * Whose this fact is about, when it is about one side: a hole in Black's
   * camp is a TARGET for White, and a hole in White's camp is a weakness
   * White has to watch. Without this, a plan answer cannot tell the two
   * apart and ends up listing them as one undifferentiated pile.
   */
  side?: number;
  /**
   * What the fact IS, which decides whether it is something to attack, a
   * weakness to watch, or simply a description of the board:
   *   'weakness'  a real liability of `side` — a hole, an isolated or
   *                backward pawn, a bad colour, an exposed king
   *   'asset'     something `side` can use — an outpost, a passed pawn
   *   'feature'   a description: a majority, a named structure
   *
   * Without this, "Black has a queenside majority" was listed as a TARGET
   * for White, which is not a weakness of Black at all.
   */
  role?: 'weakness' | 'asset' | 'feature';
}

/**
 * Everything a narrator is allowed to know about the current context:
 * facts, retrieved KB entries, the legal-move SAN set (for the guard) and phase.
 */
export interface GroundedContext {
  fen: string;
  phase: Phase;
  stm: number;
  facts: GroundedFact[];
  kbHits: KbEntry[];
  legalSan: Set<string>;
  /**
   * The ending's technique, when this position IS an ending. Null in the
   * opening and the middlegame, where the pawn structure is the subject.
   */
  endgameLesson?: EndgameLesson | null;
  /**
   * Who has the bishop pair on this board:
   *   'white' | 'black'  exactly one side owns it (the advantage)
   *   'both'             each side has two bishops (no advantage either way)
   *   'neither'          nobody has two bishops
   *
   * The answer to "what is the bishop pair?" has to say which of these it is,
   * or the student cannot tell whether the concept applies to the board in
   * front of them.
   */
  bishopPairState?: 'white' | 'black' | 'both' | 'neither';
  /**
   * The structure the analyzer detected, by name, when it detected one.
   * "closed_center" is a family (Ruy Lopez, French chain, King's Indian) and
   * each member has its own plan, so the page is chosen by the SPECIFIC
   * structure rather than by the family's first row.
   */
  structureName?: string | null;
  /**
   * The side ATTACKING the structure's weakness, for the pages whose two
   * plans are role-keyed rather than colour-keyed: the isolated queen's pawn
   * and the hanging pawns. White's plan there is the ATTACKER's plan when
   * Black holds the weakness, and the DEFENDER's plan when White holds it,
   * so the side to move is not enough to pick the text.
   */
  structureAttacker?: number | null;
}

export class FactFactory {
  /** Analyzer tokens the KB hooks on: structure tags + phase + feature flags. */
  static hookTokens(r: PositionReport): string[] {
    const t: string[] = [];
    t.push(...r.structureTags);
    if (r.phase === 'opening') t.push('opening');
    if (r.phase === 'endgame') t.push('endgame');
    if (r.holes.length > 0) t.push('holes');
    if (r.outposts.length > 0) t.push('outposts');
    if (r.colorWeakness.some((c) => c.acute)) t.push('color_weakness');
    if (r.kingSafety.some((k) => k.danger !== 'LOW')) t.push('king_danger');
    if (r.loosePieces.some((l) => l.length > 0)) t.push('loose_pieces');
    /*
     * THE PAIR IS AN ADVANTAGE, NOT A STARTING POSITION.
     * `bishopPair` is true for BOTH sides at move 1 (two bishops each), so the
     * old `some()` hook taught the bishop-pair concept in the opening, where it
     * explains nothing. It is only a feature when exactly one side owns it.
     */
    if (r.material[WHITE].bishopPair !== r.material[BLACK].bishopPair) t.push('bishop_pair');
    if (r.openFiles.length > 0 || r.semiOpenFiles.some((s) => s.length > 0)) t.push('open_files');
    return [...new Set(t)];
  }

  // -------------------------------------------------------------- positions

  static forPosition(report: PositionReport, kb: KbIndex): GroundedContext {
    const facts: GroundedFact[] = [];
    facts.push({ kind: 'phase', text: `${capitalize(sideName(report.stm))} to move; ${FactFactory.phaseWord(report.phase)}.` });
    facts.push({ kind: 'material', text: FactFactory.materialPhrase(report) });
    facts.push(...structureFacts(report));
    facts.push(...featureFacts(report));

    const hooks = FactFactory.hookTokens(report);
    /*
     * THE ENDING IS TAUGHT BY ITS MATERIAL.
     *
     * The old search put the ending's own page in by prose score, so a
     * king-and-pawn ending was taught rook technique. The analyzer now names
     * the shape of the ending, and that page leads the context.
     */
    const lesson = report.phase === 'endgame' ? endgameLessonFor(report, kb) : null;
    /*
     * A STRUCTURE IS A SPECIFIC STRUCTURE.
     *
     * "closed_center" covers three different openings with three different
     * plans, and the first row in the list won, so a King's Indian was
     * answered with the Ruy Lopez regrouping. The analyzer now names the
     * member of the family, and that page leads.
     */
    const structureName = FactFactory.detectedStructure(report);
    const structurePage = structureName ? kb.byName(structureName) : null;
    const hits = report.phase === 'endgame'
      ? distinctByName([
        ...(lesson ? [kb.byName(lesson.kbName)].filter((e): e is KbEntry => e !== null) : []),
        ...kb.byHook(hooks, undefined, 8),
      ])
      : distinctByName([
        ...(structurePage ? [structurePage] : []),
        ...kb.byHook(hooks, undefined, 8),
      ]);

    return {
      fen: report.fen,
      phase: report.phase,
      stm: report.stm,
      facts,
      kbHits: hits,
      legalSan: new Set(legalSan(report.fen)),
      endgameLesson: lesson,
      structureName,
      structureAttacker: FactFactory.structureAttacker(report),
      bishopPairState: FactFactory.bishopPairState(report),
    };
  }

  /** Who owns the bishop pair on this board, if anyone. */
  static bishopPairState(r: PositionReport): 'white' | 'black' | 'both' | 'neither' {
    const w = r.material[WHITE].bishopPair;
    const b = r.material[BLACK].bishopPair;
    if (w && b) return 'both';
    if (w) return 'white';
    if (b) return 'black';
    return 'neither';
  }

  /**
   * The side attacking the structure's weakness, for the role-keyed pages.
   *
   * The isolated queen's pawn and the hanging pawns are weaknesses ONE side
   * has and the OTHER attacks, so the two plans in those pages are the
   * attacker's and the defender's, not White's and Black's. The side holding
   * the weakness is the defender; the other side attacks.
   */
  static structureAttacker(r: PositionReport): number | null {
    const tags = r.structureTags;
    if (tags.includes('iqp_white')) return BLACK;
    if (tags.includes('iqp_black')) return WHITE;
    if (tags.includes('hanging_pawns_white')) return BLACK;
    if (tags.includes('hanging_pawns_black')) return WHITE;
    return null;
  }

  /**
   * The KB row for the structure this position actually has, or null.
   *
   * The analyzer tags the family ("closed_center"); the pages are the members
   * of it, and only the member that matches the pawns on the board is right.
   */
  static detectedStructure(r: PositionReport): string | null {
    const tags = r.structureTags;
    /*
     * THE ISOLATED QUEEN'S PAWN WINS OVER THE CARLSBAD.
     *
     * Both tags can be true at once: the Panov has White's d4 AND Black's d5
     * isolated, and the Carlsbad tag fires on it too. The IQP page is the one
     * that describes those pawns, and its plan is the one for the side with
     * the weakness, so it has to be the page the plan is taken from.
     */
    if (tags.includes('iqp_white') || tags.includes('iqp_black')) return 'iqp';
    if (tags.includes('carlsbad')) return 'carlsbad';
    if (tags.includes('kid_closed')) return 'kid_closed';
    if (tags.includes('french_chain')) return 'french_chain';
    if (tags.includes('ruy_closed')) return 'closed_center';
    if (tags.includes('open_sicilian_center')) return 'open_sicilian_center';
    if (tags.includes('hanging_pawns_white') || tags.includes('hanging_pawns_black')) return 'hanging_pawns';
    if (tags.includes('closed_center')) return 'closed_center';
    return null;
  }

  static forPositionFen(fen: string, kb: KbIndex): GroundedContext {
    return FactFactory.forPosition(analyzeFen(fen), kb);
  }

  // ------------------------------------------------------------------ moves

  static forMove(mr: CoachMoveReview, kb: KbIndex): GroundedContext {
    const report = analyzeFen(mr.fenAfter);
    const num = mr.moveNumber;
    const label = mr.moverIsWhite ? `${num}.${mr.san}` : `${num}...${mr.san}`;

    const moveFacts: GroundedFact[] = [
      {
        kind: 'move',
        text: `Move played: ${label}${mr.isCheck ? ', giving check' : ''}${mr.isCapture ? ' (a capture)' : ''}.`,
      },
      {
        kind: 'eval',
        text: `Engine grade: ${FactFactory.gradeWord(mr.grade)} - it cost ${mr.wpLoss.toFixed(2)} winning-chance points `
          + `(evaluation went from ${FactFactory.evalPhrase(moverCpBefore(mr))} to ${FactFactory.evalPhrase(moverCpAfter(mr))}).`,
      },
    ];
    if (mr.bestSan != null) {
      const pv = sanPv(mr.fenBefore, mr.pvUci, 6);
      moveFacts.push({
        kind: 'best',
        text: `Engine preferred ${num}${mr.moverIsWhite ? '.' : '...'}${mr.bestSan}`
          + (pv.length > 1 ? ` with the line ${pv.join(' ')}.` : '.'),
      });
    }

    const posFacts: GroundedFact[] = [
      { kind: 'phase', text: `After the move: ${capitalize(sideName(report.stm))} to move; ${FactFactory.phaseWord(report.phase)}.` },
      { kind: 'material', text: FactFactory.materialPhrase(report) },
      ...structureFacts(report),
      ...featureFacts(report),
    ];

    const hooks = FactFactory.hookTokens(report);
    if (mr.grade === 'mistake' || mr.grade === 'blunder') hooks.push('mistake', 'blunder');

    return {
      fen: mr.fenAfter,
      phase: report.phase,
      stm: report.stm,
      facts: [...moveFacts, ...posFacts],
      kbHits: kb.byHook(hooks, undefined, 8),
      legalSan: new Set(legalSan(mr.fenBefore)),
    };
  }

  // ---------------------------------------------------------- verbalization

  /** A retrieval query describing the position's material signature. */
  static positionQuery(r: PositionReport): string {
    const w = r.material[WHITE];
    const b = r.material[BLACK];
    if (!w || !b) return FactFactory.phaseWord(r.phase);
    let q = FactFactory.phaseWord(r.phase);
    if (w.queens === 0 && b.queens === 0) {
      if (w.rooks > 0 && b.rooks > 0) q += ' rook';
      if (w.knights === 0 && b.knights === 0 && w.bishops > 0 && b.bishops > 0) q += ' bishop';
    }
    if (w.pawns !== b.pawns) q += ' pawn';
    // a far-advanced pawn in a rook ending points at promotion technique;
    // a strong king on the 8th in front of a 7th-rank pawn is the Lucena signature
    if (w.queens === 0 && w.rooks > 0 && b.rooks > 0) {
      const advW = r.pawnSquares[WHITE].some((sq) => rankOf(sq) >= 6);
      const advB = r.pawnSquares[BLACK].some((sq) => rankOf(sq) <= 1);
      if (advW || advB) q += ' bridge promote';
      const kingOnEighthInFront = (advW && rankOf(r.kingSafety[WHITE].kingSq) === 7)
        || (advB && rankOf(r.kingSafety[BLACK].kingSq) === 0);
      if (kingOnEighthInFront) q += ' lucena';
    }
    return q;
  }

  static gradeWord(g: MoveGrade): string {
    switch (g) {
      case 'book': return 'a book move';
      case 'best': return "the engine's top choice";
      case 'excellent': return 'an excellent move';
      case 'good': return 'a good move';
      case 'inaccuracy': return 'an inaccuracy';
      case 'mistake': return 'a mistake';
      case 'blunder': return 'a blunder';
    }
  }

  static phaseWord(p: Phase): string {
    return p === 'opening' ? 'opening phase' : p === 'middlegame' ? 'middlegame' : 'endgame';
  }

  /** cp from the given side's POV -> plain-English assessment. */
  static evalPhrase(cpMoverPov: number): string {
    const cp = Math.max(-10000, Math.min(10000, cpMoverPov));
    if (cp >= 9000) return 'a forced win for them';
    if (cp >= 900) return 'completely winning for them';
    if (cp >= 400) return 'winning for them';
    if (cp >= 150) return 'clearly better for them';
    if (cp >= 50) return 'slightly better for them';
    if (cp > -50) return 'roughly balanced';
    if (cp > -150) return 'slightly worse for them';
    if (cp > -400) return 'clearly worse for them';
    if (cp > -900) return 'losing for them';
    if (cp > -9000) return 'much worse for them';
    return 'a forced loss for them';
  }

  static materialPhrase(r: PositionReport): string {
    const w = r.material[WHITE];
    const b = r.material[BLACK];
    if (!w || !b) return 'material unknown';
    return FactFactory.materialDiffPhrase(w, b);
  }

  /** "White is up a knight for two pawns." / "Material is level." */
  static materialDiffPhrase(w: MaterialCount, b: MaterialCount): string {
    const dP = w.pawns - b.pawns;
    const dN = w.knights - b.knights;
    const dB = w.bishops - b.bishops;
    const dR = w.rooks - b.rooks;
    const dQ = w.queens - b.queens;
    if (dP === 0 && dN === 0 && dB === 0 && dR === 0 && dQ === 0) {
      if (w.bishopPair && !b.bishopPair) return 'Material is level, but White has the bishop pair.';
      if (b.bishopPair && !w.bishopPair) return 'Material is level, but Black has the bishop pair.';
      return 'Material is level.';
    }
    const whiteAhead = dP * 100 + dN * 300 + dB * 300 + dR * 500 + dQ * 900 >= 0;
    const name = whiteAhead ? 'White' : 'Black';
    const s = whiteAhead ? 1 : -1;
    const p = s * dP;
    const n = s * dN;
    const bb = s * dB;
    const r = s * dR;
    const q = s * dQ;

    const exchange = r > 0 && (n < 0 || bb < 0);
    const gains: string[] = [];
    if (q > 0) gains.push(countNoun(q, 'queen'));
    if (r > 0) gains.push(exchange ? 'the exchange' : countNoun(r, 'rook'));
    if ((!exchange || n > 0) && n > 0) gains.push(countNoun(n, 'knight'));
    if ((!exchange || bb > 0) && bb > 0) gains.push(countNoun(bb, 'bishop'));
    if (p > 0) gains.push(countNoun(p, 'pawn'));
    const losses: string[] = [];
    if (q < 0) losses.push(countNoun(-q, 'queen'));
    if (r < 0) losses.push(countNoun(-r, 'rook'));
    if (!exchange) {
      if (n < 0) losses.push(countNoun(-n, 'knight'));
      if (bb < 0) losses.push(countNoun(-bb, 'bishop'));
    }
    if (p < 0) losses.push(countNoun(-p, 'pawn'));
    const gainsText = gains.join(' and ');
    return losses.length === 0
      ? `${name} is up ${gainsText}.`
      : `${name} is up ${gainsText} for ${losses.join(' and ')}.`;
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * "c6", "c6 and e5", "c6, e5 and g4".
 *
 * The old code joined every list with " and ", so three squares came out as
 * "c6 and a7 and h7" and the coach read like a machine listing files.
 */
function joinSquares(sqs: readonly string[]): string {
  if (sqs.length === 0) return '';
  if (sqs.length === 1) return sqs[0];
  if (sqs.length === 2) return `${sqs[0]} and ${sqs[1]}`;
  return `${sqs.slice(0, -1).join(', ')} and ${sqs[sqs.length - 1]}`;
}

function countNoun(n: number, noun: string): string {
  switch (n) {
    case 1: return `a ${noun}`;
    case 2: return `two ${noun}s`;
    case 3: return `three ${noun}s`;
    case 4: return `four ${noun}s`;
    default: return `${n} ${noun}s`;
  }
}

function distinctByName(entries: KbEntry[]): KbEntry[] {
  const seen = new Set<string>();
  const out: KbEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  return out;
}

/**
 * Which side a structure tag is about, when it is about one. The plan
 * answer needs this: a hole in the opponent's camp is a target, a hole in
 * your own camp is a weakness, and the two must not be listed as one pile.
 */
function tagSide(tag: string): number | null {
  if (tag.startsWith('iqp_')) return tag.slice(4) === 'white' ? WHITE : BLACK;
  if (tag.startsWith('hanging_pawns_')) {
    const who = tag.slice('hanging_pawns_'.length).slice(0, tag.slice('hanging_pawns_'.length).lastIndexOf('_'));
    return who === 'white' ? WHITE : BLACK;
  }
  if (tag.endsWith('_majority_white')) return WHITE;
  if (tag.endsWith('_majority_black')) return BLACK;
  return null;
}

export function structureFacts(r: PositionReport): GroundedFact[] {
  const out: GroundedFact[] = [];
  for (const tag of r.structureTags) {
    let sentence: string | null = null;
    if (tag === 'carlsbad') {
      sentence = "The position has the Carlsbad structure: White d4 vs Black c6+d5, White's kingside majority vs Black's queenside majority.";
    } else if (tag.startsWith('iqp_')) {
      sentence = `The ${tag.slice(4)} side has an isolated queen's pawn.`;
    } else if (tag.startsWith('hanging_pawns_')) {
      sentence = `The ${tag.slice('hanging_pawns_'.length).slice(0, tag.slice('hanging_pawns_'.length).lastIndexOf('_'))} side has hanging pawns.`;
    } else if (tag === 'open_sicilian_center') {
      sentence = 'Open Sicilian centre: White e4 vs Black d6+e5, with the d5 hole as the key square.';
    } else if (tag === 'closed_center') {
      sentence = 'The centre is closed; play goes to the wings.';
    } else if (tag === 'open_center') {
      sentence = 'The centre is fully open.';
    } else if (tag.endsWith('_majority_white')) {
      sentence = `White has a ${tag.slice(0, -'_majority_white'.length)} majority.`;
    } else if (tag.endsWith('_majority_black')) {
      sentence = `Black has a ${tag.slice(0, -'_majority_black'.length)} majority.`;
    }
    if (sentence !== null) {
      const side = tagSide(tag);
      /*
       * A NAMED STRUCTURE IS A DESCRIPTION, NOT A WEAKNESS.
       *
       * "Black has a queenside majority" is a fact about the board. It is
       * not something White attacks and not something White watches for, and
       * listing it as a "target" taught that a majority is a weakness.
       */
      const role = tag === 'iqp_white' || tag === 'iqp_black' || tag.startsWith('hanging_pawns_')
        ? 'weakness'
        : 'feature';
      out.push({ kind: 'structure', text: sentence, role, ...(side !== null ? { side } : {}) });
    }
  }
  for (const side of [WHITE, BLACK]) {
    const iso = r.isolated[side];
    if (iso.length > 0 && iso.some((sq) => fileOf(sq) !== 3)) {
      out.push({
        kind: 'structure',
        side,
        role: 'weakness',
        text: `${capitalize(sideName(side))} has an isolated pawn on ${joinSquares(iso.filter((sq) => fileOf(sq) !== 3).map(sqName))}.`,
      });
    }
    const back = r.backward[side];
    if (back.length > 0) {
      out.push({ kind: 'structure', side, role: 'weakness', text: `${capitalize(sideName(side))}'s pawn on ${joinSquares(back.map(sqName))} is backward on a semi-open file.` });
    }
    const dbl = r.doubled[side];
    if (dbl.length > 0) {
      out.push({ kind: 'structure', side, role: 'weakness', text: `${capitalize(sideName(side))} has doubled pawns on the ${String.fromCharCode(97 + fileOf(dbl[0][0]))}-file.` });
    }
  }
  for (const side of [WHITE, BLACK]) {
    const pass = r.passed[side];
    if (pass.length > 0) {
      const protectedSqs = r.protectedPassers[side];
      out.push({
        kind: 'passed',
        side,
        role: 'asset',
        text: `${capitalize(sideName(side))} has a passed pawn on ${joinSquares(pass.map(sqName))}`
          + (protectedSqs.length > 0 ? ` (the ${joinSquares(protectedSqs.map(sqName))} one is protected).` : '.'),
      });
    }
  }
  return out;
}

export function featureFacts(r: PositionReport): GroundedFact[] {
  const out: GroundedFact[] = [];
  for (const h of r.holes.slice(0, 3)) {
    const occ = h.occupiedBy !== EMPTY && colorOf(h.occupiedBy) !== h.weakFor
      ? ` It is already occupied by an enemy ${pieceName(h.occupiedBy & 7)}.`
      : '';
    out.push({
      kind: 'holes',
      side: h.weakFor,
      role: 'weakness',
      text: `${sqName(h.sq)} is a weak square for ${sideName(h.weakFor)}${h.central ? ', in the centre' : ''}`
        + ` (severity ${h.severity} of 5).${occ}`,
    });
  }
  for (const op of r.outposts.slice(0, 2)) {
    const reach = op.knightReach;
    out.push({
      kind: 'outposts',
      side: op.forSide,
      role: 'asset',
      text: `${sqName(op.sq)} is an outpost square for ${sideName(op.forSide)}`
        + (op.protectedByOwnPawn ? ', protected by a pawn' : '')
        + (op.occupiedByOwnMinor ? ', already occupied by a minor piece' : '')
        + (reach.length > 0 ? `; reachable by the knight on ${sqName(reach[0])}` : '') + '.',
    });
  }
  for (const cw of r.colorWeakness.filter((c) => c.acute).slice(0, 1)) {
    out.push({
      kind: 'colour',
      side: cw.side,
      role: 'weakness',
      text: `${capitalize(sideName(cw.side))} is weak on the ${cw.weakColor} squares: ${cw.pawnsOnStrongColor} pawns are fixed on the other colour`
        + (cw.enemyBishopOnWeakColor ? ' and the enemy bishop of that colour is still on the board' : '') + '.',
    });
  }
  for (const side of [WHITE, BLACK]) {
    const k = r.kingSafety[side];
    if (k.danger !== 'LOW') {
      out.push({
        kind: 'king',
        side,
        role: 'weakness',
        text: `${capitalize(sideName(side))}'s king is in ${k.danger.toLowerCase()} danger: ${k.openFilesNearKing.length} open files nearby, ${k.zoneAttackerSquares.length} enemy piece squares hitting the zone.`,
      });
    }
    if (k.inCenter) {
      out.push({ kind: 'king', side, role: 'feature', text: `${capitalize(sideName(side))}'s king is still in the centre.` });
    }
  }
  for (const side of [WHITE, BLACK]) {
    const loose = r.loosePieces[side];
    if (loose.length > 0) {
      out.push({
        kind: 'loose',
        side,
        role: 'weakness',
        text: `${capitalize(sideName(side))}'s loose pieces: ${loose.slice(0, 3).map(sqName).join(', ')} (undefended and targetable).`,
      });
    }
  }
  for (const rn of r.rookNotes.filter((x) => x.onSeventh).slice(0, 2)) {
    out.push({ kind: 'rooks', text: `A rook on ${sqName(rn.sq)} is on the seventh rank.` });
  }
  for (const side of [WHITE, BLACK]) {
    const dev = r.development[side];
    if (dev.homeMinors >= 2 && r.phase !== 'endgame') {
      out.push({
        kind: 'development',
        text: `${capitalize(sideName(side))} still has ${dev.homeMinors} minor pieces on their starting squares.`,
      });
    }
  }
  return out;
}
