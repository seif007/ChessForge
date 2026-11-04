/** Pure helpers for one Arena game: result, PGN and clock arithmetic. */

import { Chess } from 'chess.js';
import { buildBotPgn, pgnDate } from '@/lib/bots/postgame';
import type { ArenaGame, ArenaResult, ArenaTournament } from './types';

export interface ArenaOutcome {
  result: ArenaResult;
  winnerId: string | null;
  reason: string;
}

export function outcomeFromChess(
  chess: Chess,
  whiteId: string,
  blackId: string,
): ArenaOutcome | null {
  if (chess.isCheckmate()) {
    const whiteWins = chess.turn() === 'b';
    return {
      result: whiteWins ? '1-0' : '0-1',
      winnerId: whiteWins ? whiteId : blackId,
      reason: 'checkmate',
    };
  }
  if (chess.isStalemate()) {
    return { result: '1/2-1/2', winnerId: null, reason: 'stalemate' };
  }
  if (chess.isInsufficientMaterial()) {
    return { result: '1/2-1/2', winnerId: null, reason: 'insufficient material' };
  }
  if (chess.isThreefoldRepetition()) {
    return { result: '1/2-1/2', winnerId: null, reason: 'threefold repetition' };
  }
  if (chess.isDraw()) {
    return { result: '1/2-1/2', winnerId: null, reason: 'draw' };
  }
  return null;
}

export function timeoutOutcome(
  loser: 'white' | 'black',
  chess: Chess,
  whiteId: string,
  blackId: string,
): ArenaOutcome {
  if (chess.isInsufficientMaterial()) {
    return { result: '1/2-1/2', winnerId: null, reason: 'timeout — insufficient material' };
  }
  return {
    result: loser === 'white' ? '0-1' : '1-0',
    winnerId: loser === 'white' ? blackId : whiteId,
    reason: `${loser === 'white' ? 'White' : 'Black'} ran out of time`,
  };
}

export function arenaPgn(
  tournament: ArenaTournament,
  game: ArenaGame,
  result: ArenaResult,
): string {
  const white = tournament.participants.find((p) => p.id === game.whiteId)?.name ?? 'White';
  const black = game.blackId
    ? tournament.participants.find((p) => p.id === game.blackId)?.name ?? 'Black'
    : 'Bye';
  return buildBotPgn({
    moves: game.moves.map((m) => ({ san: m.san, color: m.color === 'white' ? 'w' : 'b' })),
    white,
    black,
    result: result === 'bye' ? '1-0' : result,
    date: pgnDate(),
    event: `${tournament.name} — round ${game.round}`,
  });
}

export function replayArenaGame(moves: readonly ArenaGame['moves'][number][]): Chess {
  const chess = new Chess();
  for (const m of moves) {
    try {
      chess.move({ from: m.from, to: m.to, promotion: m.promotion ?? 'q' });
    } catch {
      // A corrupted saved game should not crash the review screen.
      break;
    }
  }
  return chess;
}

export function addIncrement(
  clocks: { white: number; black: number } | undefined,
  color: 'white' | 'black',
  incrementSeconds: number,
  initialSeconds: number,
): { white: number; black: number } {
  const base = clocks ?? { white: initialSeconds, black: initialSeconds };
  return {
    ...base,
    [color]: base[color] + incrementSeconds,
  };
}

export function startingClocks(initialSeconds: number): { white: number; black: number } {
  return { white: initialSeconds, black: initialSeconds };
}
