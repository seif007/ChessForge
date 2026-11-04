/**
 * Positional feature extraction — the coach's eyes on the board.
 * A TypeScript port of the Kotlin prototype's `coach/analysis/PositionFeatures.kt`
 * (plus `Control.kt`), keeping the same geometry, thresholds and tag vocabulary,
 * because the knowledge base's hooks are keyed on these exact names.
 *
 * Everything here is deterministic: same FEN in, same facts out, no randomness.
 */

import {
  BISHOP, BLACK, boardFromFen, CoachBoard, colorOf,
  EMPTY, fileChar, fileOf, isLightSquare, KING, kingSquareOf, KNIGHT, PAWN, piece, pieceName,
  QUEEN, rankOf, ROOK, sqName, sqOf, typeOf, WHITE,
} from './board';
import { Control } from './control';

export type Phase = 'opening' | 'middlegame' | 'endgame';

export const sideName = (color: number): string => (color === WHITE ? 'white' : 'black');
export const colorName = (sq: number): string => (isLightSquare(sq) ? 'light' : 'dark');

export interface MaterialCount {
  side: number;
  pawns: number;
  knights: number;
  bishops: number;
  rooks: number;
  queens: number;
  bishopPair: boolean;
}

export const nonPawnValue = (m: MaterialCount): number => m.knights * 300 + m.bishops * 300 + m.rooks * 500 + m.queens * 900;
export const totalValue = (m: MaterialCount): number => nonPawnValue(m) + m.pawns * 100;

/** A square in [weakFor]'s camp that no pawn of [weakFor] can ever defend. */
export interface HoleInfo {
  sq: number;
  weakFor: number;
  severity: number; // 1..5 narration priority
  occupiedBy: number; // piece code or EMPTY
  enemyAttackers: string[]; // "knight on c3" style descriptions
  nearOwnKing: boolean;
  central: boolean;
}

export const occupiedByEnemy = (h: HoleInfo): boolean => h.occupiedBy !== EMPTY && colorOf(h.occupiedBy) !== h.weakFor;

/** A square in the defender's camp where the attacker can safely plant a piece. */
export interface OutpostInfo {
  sq: number;
  forSide: number;
  protectedByOwnPawn: boolean;
  occupiedByOwnMinor: boolean;
  knightReach: number[]; // squares of forSide knights that attack sq
}

export interface ColorWeakness {
  side: number;
  weakColor: 'light' | 'dark';
  pawnsOnWeakColor: number;
  pawnsOnStrongColor: number;
  ownBishopOnWeakColor: boolean;
  enemyBishopOnWeakColor: boolean;
  holesOnWeakColor: number[];
  acute: boolean; // missing own bishop of that colour + enemy has one
}

export interface RookNote {
  sq: number;
  onOpenFile: boolean;
  onSemiOpenFile: boolean;
  onSeventh: boolean;
}

export interface BishopNote {
  sq: number;
  mobility: number;
  bad: boolean;
  fianchetto: boolean;
}

export interface KingSafetyFacts {
  side: number;
  kingSq: number;
  castledSide: 'kingside' | 'queenside' | null;
  inCenter: boolean;
  shield: number; // 0..3 own pawns directly in front
  openFilesNearKing: number[];
  zoneAttackerSquares: number[]; // distinct enemy pieces attacking the king zone
  danger: 'LOW' | 'MODERATE' | 'HIGH';
}

export interface DevelopmentFacts {
  side: number;
  homeMinors: number; // minors still on their original squares
  castled: boolean;
  queenOutEarly: boolean;
}

export interface PositionReport {
  fen: string;
  stm: number;
  moveNumber: number;
  phase: Phase;
  material: MaterialCount[]; // indexed by colour
  pawnSquares: number[][];
  doubled: number[][][];
  isolated: number[][];
  backward: number[][];
  passed: number[][];
  protectedPassers: number[][];
  islands: number[];
  holes: HoleInfo[];
  outposts: OutpostInfo[];
  colorWeakness: ColorWeakness[];
  openFiles: number[];
  semiOpenFiles: number[][]; // side -> files without that side's pawns
  rookNotes: RookNote[];
  knightsOnRim: number[];
  knightsOnOutposts: number[];
  bishopNotes: BishopNote[];
  kingSafety: KingSafetyFacts[];
  development: DevelopmentFacts[];
  loosePieces: number[][];
  space: number[];
  structureTags: string[];
  /**
   * The shape of the ending, when this position IS an ending: which technique
   * the coach should teach. Empty in the opening and the middlegame, where
   * the pawn structure is the subject instead.
   */
  endgameTags: string[];
}

/** rank of the most advanced pawn of [side] on file [f], or -1 if none */
function pawnRank(side: number, f: number, pawns: readonly number[]): number {
  const ranks = pawns.filter((sq) => fileOf(sq) === f).map((sq) => rankOf(sq));
  if (ranks.length === 0) return -1;
  return side === WHITE ? Math.max(...ranks) : Math.min(...ranks);
}

export function analyze(b: CoachBoard, fen: string): PositionReport {
  const control = new Control(b);

  // ---------- pawn files / lists ----------
  const pawnFiles = Array.from({ length: 2 }, () => new Array<number>(8).fill(0));
  const pawnsOf = Array.from({ length: 2 }, () => [] as number[]);
  const counts = Array.from({ length: 2 }, () => [0, 0, 0, 0, 0]); // p n b r q
  for (let sq = 0; sq < 64; sq++) {
    const p = b.pieces[sq];
    if (p === EMPTY) continue;
    const c = colorOf(p);
    const t = typeOf(p);
    if (t === KING) continue;
    counts[c][t - 1] += 1;
    if (t === PAWN) {
      pawnFiles[c][fileOf(sq)] += 1;
      pawnsOf[c].push(sq);
    }
  }
  const material: MaterialCount[] = [0, 1].map((c) => ({
    side: c,
    pawns: counts[c][0],
    knights: counts[c][1],
    bishops: counts[c][2],
    rooks: counts[c][3],
    queens: counts[c][4],
    bishopPair: counts[c][2] >= 2,
  }));

  // ---------- pawn structure ----------
  const pawnsOnAdjacentFile = (side: number, f: number, rankPredicate: (r: number) => boolean): boolean => {
    for (const df of [-1, 1]) {
      const nf = f + df;
      if (nf < 0 || nf > 7) continue;
      if (pawnsOf[side].some((sq) => fileOf(sq) === nf && rankPredicate(rankOf(sq)))) return true;
    }
    return false;
  };

  const isolated: number[][] = [[], []];
  const backward: number[][] = [[], []];
  const passed: number[][] = [[], []];
  const protectedPassers: number[][] = [[], []];
  const doubledGroups: number[][][] = [[], []];
  const islandsMap: number[] = [0, 0];

  for (const side of [WHITE, BLACK]) {
    const enemy = side ^ 1;
    const forward = side === WHITE ? 1 : -1;

    // doubled groups
    for (let f = 0; f < 8; f++) {
      const onFile = pawnsOf[side].filter((sq) => fileOf(sq) === f).sort((a, c) => (side === WHITE ? a - c : c - a));
      if (onFile.length >= 2) doubledGroups[side].push(onFile);
    }

    for (const sq of pawnsOf[side]) {
      const f = fileOf(sq);
      const r = rankOf(sq);

      /*
       * ISOLATED = NO FRIENDLY PAWN ON EITHER ADJACENT FILE.
       *
       * The old test asked whether the pawn had NO neighbour at all, which
       * made an a-pawn or h-pawn "isolated" the moment the b- or g-pawn left:
       * the coach said "Black has an isolated pawn on c6 and a7 and h7" for a
       * position whose only isolated pawn is c6.
       *
       * The edge files are excluded because the concept does not apply to
       * them: a rook pawn can never be chased by an enemy pawn, so "isolated"
       * there is a statement about the shape of the board rather than a
       * weakness in it. A pawn on b through g is isolated when NEITHER
       * adjacent file holds a friendly pawn — that is the IQP, and the enemy
       * can come at it with a pawn.
       */
      const hasPawnOn = (file: number): boolean =>
        file >= 0 && file <= 7 && pawnsOf[side].some((p) => fileOf(p) === file);
      if (f > 0 && f < 7 && !hasPawnOn(f - 1) && !hasPawnOn(f + 1)) isolated[side].push(sq);

      // backward: no potential pawn defender behind + advance square enemy-pawn-controlled
      const potentialDefenders = pawnsOnAdjacentFile(side, f, (rr) => (side === WHITE ? rr < r : rr > r));
      const front = sqOf(f, r + forward);
      const frontOnBoard = r + forward >= 0 && r + forward <= 7;
      if (frontOnBoard && !potentialDefenders && b.pieces[front] !== piece(PAWN, side)) {
        if (control.isPawnControlled(front, enemy)) backward[side].push(sq);
      }

      // passed: no enemy pawns ahead on same or adjacent files
      const isPassed = pawnsOf[enemy].every((e) => {
        const ef = fileOf(e);
        const er = rankOf(e);
        return !(ef >= f - 1 && ef <= f + 1 && (side === WHITE ? er > r : er < r));
      });
      if (isPassed) {
        passed[side].push(sq);
        if (control.isPawnControlled(sq, side)) protectedPassers[side].push(sq);
      }
    }

    // islands: groups of adjacent files that contain pawns
    let islands = 0;
    let prev = -10;
    for (let f = 0; f < 8; f++) {
      if (pawnFiles[side][f] > 0) {
        if (f - prev > 1) islands += 1;
        prev = f;
      }
    }
    islandsMap[side] = islands;
  }

  // ---------- holes ----------
  const holes: HoleInfo[] = [];
  const pawnEverControls = (side: number, sq: number): boolean => {
    const f = fileOf(sq);
    const r = rankOf(sq);
    return pawnsOnAdjacentFile(side, f, (rr) => (side === WHITE ? rr <= r - 1 : rr >= r + 1));
  };
  for (const side of [WHITE, BLACK]) {
    const enemy = side ^ 1;
    /*
     * A WEAK SQUARE IS ONLY A WEAKNESS IF SOMEBODY CAN USE IT.
     *
     * The hole is a square the defender's pawns can never cover, so the
     * OPPONENT can settle a piece there. If the opponent has no piece that
     * could go there, the square is not a weakness at all: in a K+P vs K
     * ending the analyzer called f3 and f4 "weak squares for White" on a
     * board where neither side has anything but a king and a pawn. A student
     * who hears "weak square" learns the term, and then applies it to
     * positions where it means nothing.
     *
     * The exploiting side needs a minor piece, a rook or a queen: something
     * that can actually occupy the square. And the defending side needs pawns
     * to fail with: "no pawn of yours can ever defend this square" is
     * vacuously true when you have no pawns, which is how a K+N vs K ending
     * came to have twenty-four "weak squares".
     */
    const enemyM = material[enemy];
    const canExploit = enemyM.knights + enemyM.bishops + enemyM.rooks + enemyM.queens > 0;
    const hasPawnsToDefend = material[side].pawns >= 2;
    if (!canExploit || !hasPawnsToDefend) continue;
    // holes only in the meaningful camp: ranks 3-5 for White, 4-6 for Black.
    // (2nd/7th-rank squares can never be defended by pawns — flagging them is noise.)
    const campLo = side === WHITE ? 2 : 3;
    const campHi = side === WHITE ? 4 : 5;
    for (let sq = 0; sq < 64; sq++) {
      const rank = rankOf(sq);
      if (rank < campLo || rank > campHi) continue;
      const p = b.pieces[sq];
      if (p !== EMPTY && typeOf(p) === PAWN) continue; // pawn-occupied: not an empty hole
      if (pawnEverControls(side, sq)) continue;
      const kingSq = kingSquareOf(b, side);
      const nearKing = kingSq >= 0
        && Math.max(Math.abs(fileOf(sq) - fileOf(kingSq)), Math.abs(rankOf(sq) - rankOf(kingSq))) <= 2;
      const enemyAtk = control.attackersOf(sq, enemy).map(([from, ep]) => `${pieceName(typeOf(ep))} on ${sqName(from)}`);
      const central = fileOf(sq) >= 2 && fileOf(sq) <= 5;
      let severity = 1 + (central ? 1 : 0) + (nearKing ? 1 : 0) + (enemyAtk.length > 0 ? 1 : 0);
      if (p !== EMPTY && colorOf(p) === enemy) severity += 2;
      holes.push({ sq, weakFor: side, severity: Math.min(severity, 5), occupiedBy: p, enemyAttackers: enemyAtk, nearOwnKing: nearKing, central });
    }
  }

  // ---------- outposts ----------
  const outposts: OutpostInfo[] = [];
  for (const attacker of [WHITE, BLACK]) {
    const defender = attacker ^ 1;
    const lo = attacker === WHITE ? 3 : 2;
    const hi = attacker === WHITE ? 5 : 4;
    for (const h of holes.filter((x) => x.weakFor === defender && rankOf(x.sq) >= lo && rankOf(x.sq) <= hi)) {
      const sq = h.sq;
      const protectedByPawn = control.isPawnControlled(sq, attacker);
      if (!protectedByPawn) continue;
      const occupant = b.pieces[sq];
      const ownMinorOnIt = occupant !== EMPTY && colorOf(occupant) === attacker
        && (typeOf(occupant) === KNIGHT || typeOf(occupant) === BISHOP);
      const reach = control.attackersOf(sq, attacker)
        .filter(([, ap]) => typeOf(ap) === KNIGHT)
        .map(([from]) => from);
      if (ownMinorOnIt || reach.length > 0) {
        outposts.push({ sq, forSide: attacker, protectedByOwnPawn: true, occupiedByOwnMinor: ownMinorOnIt, knightReach: reach });
      }
    }
  }

  // ---------- colour complexes ----------
  const colorWeakness: ColorWeakness[] = [];
  for (const side of [WHITE, BLACK]) {
    const enemy = side ^ 1;
    const onLight = pawnsOf[side].filter((sq) => isLightSquare(sq)).length;
    const onDark = pawnsOf[side].length - onLight;
    const weak = Math.min(onLight, onDark);
    const strong = Math.max(onLight, onDark);
    const weakColorIsLight = onLight <= onDark;
    if (strong >= 4 && weak <= 1) {
      const bishopsOfSide = (c: number): number[] => {
        const out: number[] = [];
        for (let sq = 0; sq < 64; sq++) if (b.pieces[sq] === piece(BISHOP, c)) out.push(sq);
        return out;
      };
      const ownB = bishopsOfSide(side).some((sq) => isLightSquare(sq) === weakColorIsLight);
      const enemyB = bishopsOfSide(enemy).some((sq) => isLightSquare(sq) === weakColorIsLight);
      const holesOn = holes.filter((h) => h.weakFor === side && isLightSquare(h.sq) === weakColorIsLight).map((h) => h.sq);
      colorWeakness.push({
        side,
        weakColor: weakColorIsLight ? 'light' : 'dark',
        pawnsOnWeakColor: weak,
        pawnsOnStrongColor: strong,
        ownBishopOnWeakColor: ownB,
        enemyBishopOnWeakColor: enemyB,
        holesOnWeakColor: holesOn,
        acute: !ownB && enemyB && holesOn.length > 0,
      });
    }
  }

  // ---------- files ----------
  const openFiles: number[] = [];
  for (let f = 0; f < 8; f++) if (pawnFiles[WHITE][f] === 0 && pawnFiles[BLACK][f] === 0) openFiles.push(f);
  const semiOpen: number[][] = [0, 1].map((side) =>
    Array.from({ length: 8 }, (_, f) => f).filter((f) => pawnFiles[side][f] === 0 && pawnFiles[side ^ 1][f] > 0));

  // ---------- piece activity ----------
  const rookNotes: RookNote[] = [];
  const knightsOnRim: number[] = [];
  const knightsOnOutposts: number[] = [];
  const bishopNotes: BishopNote[] = [];
  for (let sq = 0; sq < 64; sq++) {
    const p = b.pieces[sq];
    if (p === EMPTY) continue;
    const c = colorOf(p);
    const t = typeOf(p);
    if (t === ROOK) {
      rookNotes.push({
        sq,
        onOpenFile: openFiles.includes(fileOf(sq)),
        onSemiOpenFile: semiOpen[c].includes(fileOf(sq)),
        onSeventh: (c === WHITE && rankOf(sq) === 6) || (c === BLACK && rankOf(sq) === 1),
      });
    } else if (t === KNIGHT) {
      if (fileOf(sq) === 0 || fileOf(sq) === 7) knightsOnRim.push(sq);
      if (outposts.some((o) => o.sq === sq && o.forSide === c)) knightsOnOutposts.push(sq);
    } else if (t === BISHOP) {
      const ownPawnsOnColor = pawnsOf[c].filter((psq) => isLightSquare(psq) === isLightSquare(sq)).length;
      bishopNotes.push({
        sq,
        mobility: control.mobility[sq],
        bad: ownPawnsOnColor >= 3 && control.mobility[sq] <= 5,
        fianchetto: [sqOf(6, 1), sqOf(1, 1), sqOf(6, 6), sqOf(1, 6)].includes(sq),
      });
    }
  }

  // ---------- king safety ----------
  const kingSafety: KingSafetyFacts[] = [WHITE, BLACK].map((side) => {
    const k = kingSquareOf(b, side);
    const kf = fileOf(k);
    const kr = rankOf(k);
    const fwd = side === WHITE ? 1 : -1;
    const shield = [-1, 0, 1].filter((d) => {
      const f = kf + d;
      return f >= 0 && f <= 7 && kr + fwd >= 0 && kr + fwd <= 7 && b.pieces[sqOf(f, kr + fwd)] === piece(PAWN, side);
    }).length;
    const openNear = Array.from({ length: 3 }, (_, i) => kf - 1 + i).filter((f) => f >= 0 && f <= 7 && pawnFiles[side][f] === 0);
    const zoneAttackers = new Set<number>();
    for (let df = -2; df <= 2; df++) {
      for (let dr = -2; dr <= 2; dr++) {
        const f = kf + df;
        const r = kr + dr;
        if (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
          for (const [from] of control.attackersOf(sqOf(f, r), side ^ 1)) zoneAttackers.add(from);
        }
      }
    }
    const castledSide: 'kingside' | 'queenside' | null = side === WHITE
      ? (k === sqOf(6, 0) ? 'kingside' : k === sqOf(2, 0) ? 'queenside' : null)
      : (k === sqOf(6, 7) ? 'kingside' : k === sqOf(2, 7) ? 'queenside' : null);
    const inCenter = [sqOf(4, 0), sqOf(4, 7), sqOf(3, 0), sqOf(3, 7)].includes(k);
    let danger = 0;
    if (zoneAttackers.size >= 2) danger += 1;
    /*
     * AN OPEN FILE IS ONLY DANGEROUS TO A KING IF A ROOK CAN USE IT.
     *
     * In a K+P vs K ending the analyzer reported "the king is in moderate
     * danger: 2 open files nearby" — open files next to a king that no rook
     * can reach, on a board with no rook on it. The same went for a shielded
     * king in a queen endgame: the pawn shield does not exist in an ending,
     * and counting it as a danger is noise.
     */
    const enemyHasRook = material[side ^ 1].rooks > 0;
    if (enemyHasRook && openNear.length > 0) danger += 1;
    if (enemyHasRook && shield === 0) danger += 1;
    if (enemyHasRook && castledSide === null && b.fullmove > 12) danger += 1;
    return {
      side,
      kingSq: k,
      castledSide,
      inCenter,
      shield,
      openFilesNearKing: openNear,
      zoneAttackerSquares: [...zoneAttackers].sort((a, c) => a - c),
      danger: danger >= 3 ? 'HIGH' : danger === 2 ? 'MODERATE' : 'LOW',
    };
  });

  // ---------- development ----------
  const development: DevelopmentFacts[] = [WHITE, BLACK].map((side) => {
    const homeSquares = side === WHITE
      ? [sqOf(1, 0), sqOf(6, 0), sqOf(2, 0), sqOf(5, 0)]
      : [sqOf(1, 7), sqOf(6, 7), sqOf(2, 7), sqOf(5, 7)];
    const homeMinors = homeSquares.filter((sq) => b.pieces[sq] === piece(KNIGHT, side) || b.pieces[sq] === piece(BISHOP, side)).length;
    const castled = kingSafety[side].castledSide !== null;
    const qHome = side === WHITE ? sqOf(3, 0) : sqOf(3, 7);
    const queenOutEarly = counts[side][4] > 0 && b.pieces[qHome] !== piece(QUEEN, side) && homeMinors >= 2;
    return { side, homeMinors, castled, queenOutEarly };
  });

  // ---------- loose pieces ----------
  const loose: number[][] = [[], []];
  for (let sq = 0; sq < 64; sq++) {
    const p = b.pieces[sq];
    if (p === EMPTY) continue;
    const t = typeOf(p);
    if (t === PAWN || t === KING) continue;
    const c = colorOf(p);
    if (control.attackersOf(sq, c ^ 1).length > 0 && control.attackersOf(sq, c).length === 0) loose[c].push(sq);
  }

  // ---------- space ----------
  const space: number[] = [WHITE, BLACK].map((side) => {
    const lo = side === WHITE ? 4 : 1;
    const hi = side === WHITE ? 6 : 3;
    let n = 0;
    for (let sq = 0; sq < 64; sq++) {
      const r = rankOf(sq);
      if (r >= lo && r <= hi && control.isControlled(sq, side) && !control.isPawnControlled(sq, side ^ 1)) n += 1;
    }
    return n;
  });

  // ---------- phase ----------
  const npW = material[WHITE].knights * 300 + material[WHITE].bishops * 300 + material[WHITE].rooks * 500 + material[WHITE].queens * 900;
  const npB = material[BLACK].knights * 300 + material[BLACK].bishops * 300 + material[BLACK].rooks * 500 + material[BLACK].queens * 900;
  const queensOff = material[WHITE].queens === 0 && material[BLACK].queens === 0;
  const phase: Phase = (npW <= 1300 && npB <= 1300) || (queensOff && npW <= 2100 && npB <= 2100)
    ? 'endgame'
    : (b.fullmove <= 10 && development[WHITE].homeMinors + development[BLACK].homeMinors >= 3 && Math.min(npW, npB) >= 2700)
      ? 'opening'
      : 'middlegame';

  // ---------- structure tags ----------
  const tags: string[] = [];
  for (const side of [WHITE, BLACK]) {
    const sn = sideName(side);
    for (const sq of isolated[side]) {
      tags.push(`isolated_pawn_${sn}_${fileChar(sq)}`);
      if (fileOf(sq) === 3) tags.push(`iqp_${sn}`);
    }
    for (const g of doubledGroups[side]) tags.push(`doubled_pawns_${sn}_${fileChar(g[0])}`);
    for (const sq of backward[side]) tags.push(`backward_pawn_${sn}_${fileChar(sq)}`);
    for (const sq of passed[side]) tags.push(`passed_pawn_${sn}_${fileChar(sq)}`);
  }
  // hanging pawn pairs (c+d or d+e style): two connected pawns on open files, no outer neighbors
  for (const side of [WHITE, BLACK]) {
    const sn = sideName(side);
    for (let f = 0; f <= 6; f++) {
      if (pawnFiles[side][f] === 1 && pawnFiles[side][f + 1] === 1) {
        const leftOuter = f - 1 < 0 || pawnFiles[side][f - 1] === 0;
        const rightOuter = f + 2 > 7 || pawnFiles[side][f + 2] === 0;
        const p1 = pawnsOf[side].find((sq) => fileOf(sq) === f)!;
        const p2 = pawnsOf[side].find((sq) => fileOf(sq) === f + 1)!;
        const connected = Math.abs(rankOf(p1) - rankOf(p2)) <= 1;
        const bothFilesOpen = pawnFiles[side ^ 1][f] === 0 && pawnFiles[side ^ 1][f + 1] === 0;
        if (leftOuter && rightOuter && connected && bothFilesOpen) tags.push(`hanging_pawns_${sn}_${fileChar(p1)}${fileChar(p2)}`);
      }
    }
  }
  // named structures by file signature
  const whiteHas = (f: number): boolean => pawnFiles[WHITE][f] > 0;
  const blackHas = (f: number): boolean => pawnFiles[BLACK][f] > 0;
  if (!whiteHas(2) && !blackHas(4) && whiteHas(3) && blackHas(3)) {
    const whiteD = pawnRank(WHITE, 3, pawnsOf[WHITE]);
    const blackD = pawnRank(BLACK, 3, pawnsOf[BLACK]);
    if (whiteD >= 0 && blackD >= 0 && blackD - whiteD === 1) tags.push('carlsbad');
  }
  if (!whiteHas(3) && !blackHas(2) && whiteHas(4) && blackHas(3) && blackHas(4)) tags.push('open_sicilian_center');
  /*
   * A CLOSED CENTRE IS TWO LOCKED PAIRS, NOT "PAWNS ON BOTH FILES".
   *
   * The old test only asked whether each side had a pawn somewhere on the d-
   * and e-files, which is true after 1.e4 e5 (d2/d7 are still at home) and in
   * almost every opening. The coach then told the student "the centre is
   * closed" and prescribed a Ruy Lopez regrouping that did not exist. A real
   * closed centre has both central files directly opposed: d4 vs d5 AND e4 vs
   * e5, with no pawn able to step forward.
   */
  const wD = pawnRank(WHITE, 3, pawnsOf[WHITE]);
  const bD = pawnRank(BLACK, 3, pawnsOf[BLACK]);
  const wE = pawnRank(WHITE, 4, pawnsOf[WHITE]);
  const bE = pawnRank(BLACK, 4, pawnsOf[BLACK]);
  const locked = (w: number, b: number): boolean => w >= 0 && b >= 0 && b === w + 1;

  /*
   * A LOCKED CENTRE IS NOT ONE STRUCTURE, IT IS THREE.
   *
   * The KB holds a page for each of them, with a different plan, and the
   * coach used to hand out the Ruy Lopez one to all of them:
   *   ruy_closed    White d4+e4 against Black d6+e5  (Ruy Lopez, closed)
   *   french_chain  White d4+e5 against Black d5+e6  (French, the chain)
   *   kid_closed    White d5+e4 against Black d6+e5  (King's Indian, closed)
   *
   * The d-pawns are locked in the French and the King's Indian and NOT in
   * the Ruy, and the e-pawns are locked in all three. So "the centre is
   * closed" alone cannot tell them apart, and a King's Indian was answered
   * with "Regroup with Nbd2-f1-g3 and Re1" — a move that does not exist in
   * that opening. Each shape is now named.
   */
  const has = (side: number, file: number, rank: number): boolean =>
    pawnsOf[side].some((sq) => fileOf(sq) === file && rankOf(sq) === rank);
  if (has(WHITE, 3, 3) && has(WHITE, 4, 3) && has(BLACK, 3, 5) && has(BLACK, 4, 4)) {
    tags.push('ruy_closed');
  } else if (has(WHITE, 3, 3) && has(WHITE, 4, 4) && has(BLACK, 3, 4) && has(BLACK, 4, 5)) {
    tags.push('french_chain');
  } else if (has(WHITE, 3, 4) && has(WHITE, 4, 3) && has(BLACK, 3, 5) && has(BLACK, 4, 4)) {
    tags.push('kid_closed');
  }
  if (locked(wD, bD) && locked(wE, bE)) tags.push('closed_center');
  /*
   * "THE CENTRE IS FULLY OPEN" IS A CLAIM ABOUT PAWNS.
   *
   * With no pawns on d or e for either side the test is trivially true, so a
   * K+P ending was told the centre was fully open — a statement about a board
   * with no centre to speak of. The claim needs a pawn skeleton to be about.
   */
  const pawnsOnCentre = pawnFiles[WHITE][3] + pawnFiles[WHITE][4]
    + pawnFiles[BLACK][3] + pawnFiles[BLACK][4];
  if (pawnsOnCentre > 0 && !whiteHas(3) && !whiteHas(4) && !blackHas(3) && !blackHas(4)) {
    tags.push('open_center');
  }
  for (const side of [WHITE, BLACK]) {
    let mineQ = 0;
    let theirsQ = 0;
    let mineK = 0;
    let theirsK = 0;
    for (let f = 0; f <= 2; f++) {
      mineQ += pawnFiles[side][f];
      theirsQ += pawnFiles[side ^ 1][f];
    }
    for (let f = 5; f <= 7; f++) {
      mineK += pawnFiles[side][f];
      theirsK += pawnFiles[side ^ 1][f];
    }
    if (mineQ >= theirsQ + 1) tags.push(`queenside_majority_${sideName(side)}`);
    if (mineK >= theirsK + 1) tags.push(`kingside_majority_${sideName(side)}`);
  }

  // ---------- the shape of the ending ----------
  /*
   * WHICH ENDING IS THIS?
   *
   * The teaching for an ending is chosen by the pieces that are on the board,
   * never by prose similarity. A king-and-pawn ending is not a rook ending
   * however many times the word "endgame" appears in a summary.
   *
   * The order matters: the most specific shape wins, so an ending with a
   * rook AND a pawn is a rook-and-pawn ending, not a rook ending.
   */
  const endgameTags: string[] = [];
  if (phase === 'endgame') {
    const wM = material[WHITE];
    const bM = material[BLACK];
    const wPieces = wM.knights + wM.bishops + wM.rooks + wM.queens;
    const bPieces = bM.knights + bM.bishops + bM.rooks + bM.queens;
    const wOnlyPawns = wPieces === 0 && wM.pawns > 0;
    const bOnlyPawns = bPieces === 0 && bM.pawns > 0;
    const wBareKing = wPieces === 0 && wM.pawns === 0;
    const bBareKing = bPieces === 0 && bM.pawns === 0;
    const wBishopOnly = wM.bishops === 1 && wM.knights === 0 && wM.rooks === 0 && wM.queens === 0;
    const bBishopOnly = bM.bishops === 1 && bM.knights === 0 && bM.rooks === 0 && bM.queens === 0;
    const wKnightOnly = wM.knights === 1 && wM.bishops === 0 && wM.rooks === 0 && wM.queens === 0;
    const bKnightOnly = bM.knights === 1 && bM.bishops === 0 && bM.rooks === 0 && bM.queens === 0;

    /*
     * ONE ENDING, ONE LESSON.
     *
     * The tests ran in sequence and each pushed a tag, so the LAST test to
     * fire decided the lesson: a position with opposite-coloured bishops was
     * pushed as 'endgame_opposite_bishops' and then overwritten by
     * 'endgame_fortress' by the queen test below, and the bishop-versus-knight
     * ending was overwritten too. Every ending must be classified once, by
     * the most specific thing about it.
     */
    const oppositeBishops = (() => {
      if (!wBishopOnly || !bBishopOnly) return false;
      const wSq = b.pieces.findIndex((p, i) => p !== EMPTY && colorOf(p) === WHITE && typeOf(p) === BISHOP);
      const bSq = b.pieces.findIndex((p, i) => p !== EMPTY && colorOf(p) === BLACK && typeOf(p) === BISHOP);
      return wSq >= 0 && bSq >= 0 && isLightSquare(wSq) !== isLightSquare(bSq);
    })();
    const bishopVsKnight = (wBishopOnly && bKnightOnly) || (wKnightOnly && bBishopOnly);
    const deadPosition = (() => {
      // One minor piece and nothing else: no mate is possible, so it is drawn.
      const wSingle = (wM.knights + wM.bishops) === 1 && wM.knights * wM.bishops === 0;
      const bSingle = (bM.knights + bM.bishops) === 1 && bM.knights * bM.bishops === 0;
      return (wSingle && bBareKing) || (bSingle && wBareKing);
    })();
    const hasQueen = wM.queens + bM.queens > 0;
    const wRookOnly = wM.rooks === 1 && wM.knights === 0 && wM.bishops === 0 && wM.queens === 0;
    const bRookOnly = bM.rooks === 1 && bM.knights === 0 && bM.bishops === 0 && bM.queens === 0;
    const rookAndPawn = (wRookOnly && bOnlyPawns) || (bRookOnly && wOnlyPawns)
      || ((wRookOnly || bRookOnly) && wM.pawns > 0 && bM.pawns > 0);

    if (deadPosition) endgameTags.push('endgame_dead');
    else if (oppositeBishops) endgameTags.push('endgame_opposite_bishops');
    else if (bishopVsKnight) endgameTags.push('endgame_bishop_knight');
    else if (wBareKing && bOnlyPawns) endgameTags.push('endgame_kpk');
    else if (bBareKing && wOnlyPawns) endgameTags.push('endgame_kpk');
    else if (wOnlyPawns && bOnlyPawns) endgameTags.push('endgame_pawns');
    else if (hasQueen) {
      /*
       * A QUEEN ON THE BOARD CHANGES WHAT THE ENDING IS ABOUT.
       *
       * A queen against a rook is not a rook ending: the rook side's only
       * hope is a perpetual check or a stalemate trick, and the queen side
       * has to be careful not to hand one over. "Activate the rook first,
       * rooks behind passers" is advice for two rooks, not for a queen.
       */
      const queenVsBareKing = (wM.queens === 1 && bBareKing) || (bM.queens === 1 && wBareKing);
      endgameTags.push(queenVsBareKing ? 'endgame_qk' : 'endgame_fortress');
    } else if (wM.rooks + bM.rooks > 0) {
      if (rookAndPawn) endgameTags.push('endgame_rp_r');
      else endgameTags.push('endgame_rook');
    } else {
      endgameTags.push('endgame_fortress');
    }
  }

  return {
    fen,
    stm: b.stm,
    moveNumber: b.fullmove,
    phase,
    material,
    pawnSquares: [pawnsOf[WHITE].slice(), pawnsOf[BLACK].slice()],
    doubled: [doubledGroups[WHITE].map((g) => g.slice()), doubledGroups[BLACK].map((g) => g.slice())],
    isolated: [isolated[WHITE].slice(), isolated[BLACK].slice()],
    backward: [backward[WHITE].slice(), backward[BLACK].slice()],
    passed: [passed[WHITE].slice(), passed[BLACK].slice()],
    protectedPassers: [protectedPassers[WHITE].slice(), protectedPassers[BLACK].slice()],
    islands: [islandsMap[WHITE], islandsMap[BLACK]],
    holes: holes.slice().sort((a, c) => c.severity - a.severity),
    outposts,
    colorWeakness,
    openFiles,
    semiOpenFiles: [semiOpen[WHITE], semiOpen[BLACK]],
    rookNotes,
    knightsOnRim,
    knightsOnOutposts,
    bishopNotes,
    kingSafety,
    development,
    loosePieces: [loose[WHITE].slice(), loose[BLACK].slice()],
    space,
    structureTags: tags.filter((t, i) => tags.indexOf(t) === i),
    endgameTags,
  };
}

/** Convenience: full pipeline from a FEN. */
export function analyzeFen(fen: string): PositionReport {
  return analyze(boardFromFen(fen), fen);
}
