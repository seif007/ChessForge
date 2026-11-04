/**
 * Square-control map: which pieces attack which squares.
 * Used by the positional feature extractor — NOT by move generation.
 *
 * Semantics (identical to the Kotlin prototype): a sliding piece "controls"
 * every square along its rays up to and including the first blocker. Pawns
 * control their two attack diagonals.
 */

import {
  BISHOP, colorOf, CoachBoard, EMPTY, fileOf, KING, KNIGHT, PAWN, rankOf, ROOK, sqOf, typeOf,
} from './board';
import { ALL_DIRS, BISHOP_DIRS, KING_TARGETS, KNIGHT_TARGETS, PAWN_ATTACKS, ROOK_DIRS } from './tables';

/** [fromSquare, piece] of an attacking piece. */
export type Attacker = readonly [number, number];

export class Control {
  readonly b: CoachBoard;

  /** attackers[color][sq] = list of (fromSquare, piece) of that color attacking sq */
  readonly attackers: Attacker[][][];
  /** pawnControls[color][sq] = true if a pawn of color controls sq */
  readonly pawnControls: boolean[][];
  /** mobility[fromSq] = number of EMPTY squares this piece attacks */
  readonly mobility: number[];

  constructor(b: CoachBoard) {
    this.b = b;
    this.attackers = Array.from({ length: 2 }, () => Array.from({ length: 64 }, () => [] as Attacker[]));
    this.pawnControls = Array.from({ length: 2 }, () => new Array<boolean>(64).fill(false));
    this.mobility = new Array<number>(64).fill(0);

    for (let sq = 0; sq < 64; sq++) {
      const p = b.pieces[sq];
      if (p === EMPTY) continue;
      const c = colorOf(p);
      const t = typeOf(p);
      if (t === PAWN) {
        for (const target of PAWN_ATTACKS[c][sq]) {
          this.attackers[c][target].push([sq, p]);
          this.pawnControls[c][target] = true;
          if (b.pieces[target] === EMPTY) this.mobility[sq] += 1;
        }
      } else if (t === KNIGHT) {
        for (const target of KNIGHT_TARGETS[sq]) {
          this.attackers[c][target].push([sq, p]);
          if (b.pieces[target] === EMPTY) this.mobility[sq] += 1;
        }
      } else if (t === KING) {
        for (const target of KING_TARGETS[sq]) {
          this.attackers[c][target].push([sq, p]);
          if (b.pieces[target] === EMPTY) this.mobility[sq] += 1;
        }
      } else {
        const dirs = t === ROOK ? ROOK_DIRS : t === BISHOP ? BISHOP_DIRS : ALL_DIRS;
        for (const [df, dr] of dirs) {
          let f = fileOf(sq) + df;
          let r = rankOf(sq) + dr;
          while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
            const target = sqOf(f, r);
            this.attackers[c][target].push([sq, p]);
            if (b.pieces[target] === EMPTY) this.mobility[sq] += 1;
            if (b.pieces[target] !== EMPTY) break;
            f += df;
            r += dr;
          }
        }
      }
    }
  }

  attackersOf(sq: number, color: number): Attacker[] {
    return this.attackers[color][sq];
  }

  count(sq: number, color: number): number {
    return this.attackers[color][sq].length;
  }

  isControlled(sq: number, color: number): boolean {
    return this.attackers[color][sq].length > 0;
  }

  isPawnControlled(sq: number, color: number): boolean {
    return this.pawnControls[color][sq];
  }

  squaresControlled(color: number): number {
    let n = 0;
    for (let sq = 0; sq < 64; sq++) if (this.attackers[color][sq].length > 0) n += 1;
    return n;
  }
}
