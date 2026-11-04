/**
 * Precomputed attack tables shared by the coach's control map and analyzer.
 * Port of the Kotlin prototype's `Tables` object — same geometry, same output.
 */

import { fileOf, rankOf, sqOf } from './board';

export type Delta = readonly [number, number];

export const ROOK_DIRS: readonly Delta[] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
export const BISHOP_DIRS: readonly Delta[] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
export const ALL_DIRS: readonly Delta[] = [...ROOK_DIRS, ...BISHOP_DIRS];

const KNIGHT_DIRS: readonly Delta[] = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

function targets(sq: number, deltas: readonly Delta[]): number[] {
  const f = fileOf(sq);
  const r = rankOf(sq);
  const out: number[] = [];
  for (const [df, dr] of deltas) {
    const nf = f + df;
    const nr = r + dr;
    if (nf >= 0 && nf <= 7 && nr >= 0 && nr <= 7) out.push(sqOf(nf, nr));
  }
  return out;
}

/** [sq] -> squares a knight on sq can jump to */
export const KNIGHT_TARGETS: number[][] = Array.from({ length: 64 }, (_, sq) => targets(sq, KNIGHT_DIRS));

/** [sq] -> adjacent squares a king on sq can step to */
export const KING_TARGETS: number[][] = Array.from({ length: 64 }, (_, sq) => targets(sq, ALL_DIRS));

/** [color][sq] -> squares a pawn of [color] standing on [sq] attacks */
export const PAWN_ATTACKS: number[][][] = Array.from({ length: 2 }, (_, c) =>
  Array.from({ length: 64 }, (_, sq) => targets(sq, c === 0
    ? ([[1, 1], [-1, 1]] as const)
    : ([[1, -1], [-1, -1]] as const))),
);

/** [color][sq] -> squares from which a pawn of [color] attacks [sq] */
export const PAWN_ATTACKERS: number[][][] = Array.from({ length: 2 }, (_, c) =>
  Array.from({ length: 64 }, (_, sq) => targets(sq, c === 0
    ? ([[1, -1], [-1, -1]] as const)
    : ([[1, 1], [-1, 1]] as const))),
);
