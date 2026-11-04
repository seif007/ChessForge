/**
 * Static position evals for the repertoires, precomputed by
 * scripts/build_evals.mjs (Stockfish-18, 300ms+ per position, merged with the
 * extension pipeline's cache). Covers every position along every trainable
 * line of BOTH repertoires, so Course/Practice eval bars are instant and
 * engine-free at runtime.
 *
 * Key: FEN first 4 fields (placement + turn + castling + en-passant).
 * Value: eval in centipawns from WHITE's perspective; mate scores are folded
 * to +/- (10000 - 10*mateInN) so labels can reconstruct "#N".
 */
import evalData from '@/data/evals.json';

const BY_KEY = evalData as Record<string, number>;

export function fenEvalKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

/** White-POV centipawn eval for a FEN (0 when unknown). */
export function evalCpWhite(fen: string): number {
  return BY_KEY[fenEvalKey(fen)] ?? 0;
}

/** True when the position has a precomputed eval (0 is a legitimate value, so presence matters). */
export function hasCachedEval(fen: string): boolean {
  return Object.prototype.hasOwnProperty.call(BY_KEY, fenEvalKey(fen));
}
