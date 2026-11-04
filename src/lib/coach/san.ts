/**
 * chess.js bridges for the coach: the legal SAN set (grounding guard) and
 * UCI -> SAN conversion (engine PVs). The prototype implemented its own
 * move generator; the app already ships chess.js, so this is the one place
 * the coach leans on it.
 */

import { Chess } from 'chess.js';

/** Legal moves of [fen] in SAN; empty when the FEN cannot be parsed. */
export function legalSan(fen: string): string[] {
  try {
    return new Chess(fen).moves();
  } catch {
    return [];
  }
}

function promoOf(uci: string): string | undefined {
  return uci.length >= 5 ? uci[4].toLowerCase() : undefined;
}

/** SAN of one UCI move in [fen], or null when it is not legal there. */
export function uciToSan(fen: string, uci: string): string | null {
  if (uci.length < 4) return null;
  try {
    const game = new Chess(fen);
    const m = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: promoOf(uci) });
    return m.san;
  } catch {
    return null;
  }
}

/** Convert an engine UCI PV into SAN from [fen], at most [maxPlies] plies. */
export function sanPv(fen: string, pvUci: readonly string[], maxPlies: number): string[] {
  const out: string[] = [];
  let game: Chess;
  try {
    game = new Chess(fen);
  } catch {
    return out;
  }
  for (const uci of pvUci.slice(0, maxPlies)) {
    if (uci.length < 4) break;
    try {
      const m = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: promoOf(uci) });
      out.push(m.san);
    } catch {
      break;
    }
  }
  return out;
}
