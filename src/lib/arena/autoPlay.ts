/**
 * THE OTHER BOARDS PLAY THEMSELVES.
 *
 * A human tournament used to require the user to open (and watch) every
 * bot-versus-bot board before a round could finish. The owner's rule: *"the user
 * shouldnt stop and watch games between bots. he plays his games and gets the
 * results of other bots in the page, and if he wants to watch a game of bots in
 * that tournament, he can click on that game and watch it"*.
 *
 * So the tournament sheet plays the bot-only boards out in the background, using
 * the same engine and the same move chooser as the board screen, and stores a
 * complete game (moves + PGN). They appear as finished results, and any of them
 * can still be opened and replayed on demand.
 *
 * The simulation is deliberately quick (a short movetime per move) because nobody
 * is watching it live; the strength comes from `playElo` and the personality, not
 * from the search budget.
 */

import { Chess } from 'chess.js';

import { getEngine } from '@/lib/engine';
import { weightsFromMimicry } from '@/lib/bots/mimic';
import { botMoveFor, botShouldResign } from '@/lib/bots/play';
import { arenaPgn, outcomeFromChess, replayArenaGame } from './game';
import type { ArenaOutcome } from './game';
import { saveTournamentGameResult } from './store';
import type { ArenaGame, ArenaMove, ArenaTournament } from './types';

/** Thinking time per simulated move. Short on purpose — this is a background pass. */
export const SIM_MOVETIME_MS = 320;

/** Hard stop so a degenerate position cannot spin forever. */
export const SIM_MAX_PLIES = 300;

/** True when both sides of a game are bots (a bye is not a bot game). */
export function isBotOnlyGame(tournament: ArenaTournament, game: ArenaGame): boolean {
  if (!game.blackId) return false;
  const white = tournament.participants.find((p) => p.id === game.whiteId);
  const black = tournament.participants.find((p) => p.id === game.blackId);
  return !!white?.bot && !!black?.bot;
}

function nameOf(tournament: ArenaTournament, id: string | null): string {
  if (!id) return 'Bot';
  return tournament.participants.find((p) => p.id === id)?.name ?? 'Bot';
}

/**
 * Play one bot-only game to the end and store it.
 *
 * Returns true when the game is now finished (including an Armageddon draw,
 * which the store resolves for Black). A false return means the engine could not
 * play it; the caller should not keep retrying.
 */
export async function simulateBotGame(
  tournament: ArenaTournament,
  game: ArenaGame,
  opts: { movetime?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (!isBotOnlyGame(tournament, game) || game.status === 'done') return true;
  const blackId = game.blackId;
  if (!blackId) return true;
  const movetime = opts.movetime ?? SIM_MOVETIME_MS;

  const chess = replayArenaGame(game.moves);
  const moves: ArenaMove[] = [...game.moves];
  let outcome: ArenaOutcome | null = outcomeFromChess(chess, game.whiteId, blackId);

  while (!outcome && moves.length < SIM_MAX_PLIES) {
    if (opts.signal?.aborted) return false;
    const side = chess.turn();
    const participantId = side === 'w' ? game.whiteId : blackId;
    const profile = tournament.participants.find((p) => p.id === participantId)?.bot;
    if (!profile) return false;

    let res;
    try {
      res = await botMoveFor(
        (f, o) => getEngine().analyse(f, o),
        chess.fen(),
        profile,
        weightsFromMimicry(0.78),
        { movetime, elo: profile.playElo ?? null },
      );
    } catch {
      return false;
    }
    if (!res) return false;

    if (botShouldResign(res.evalTop)) {
      outcome = {
        result: side === 'w' ? '0-1' : '1-0',
        winnerId: side === 'w' ? game.blackId : game.whiteId,
        reason: `${nameOf(tournament, participantId)} resigned`,
      };
      break;
    }

    const uci = res.decision.uci;
    let mv;
    try {
      mv = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
    } catch {
      return false;
    }
    moves.push({
      san: mv.san,
      from: mv.from,
      to: mv.to,
      color: mv.color === 'w' ? 'white' : 'black',
      promotion: mv.promotion || undefined,
    });
    outcome = outcomeFromChess(chess, game.whiteId, blackId);
  }

  if (!outcome) {
    outcome = { result: '1/2-1/2', winnerId: null, reason: 'Draw' };
  }

  const pgn = arenaPgn(tournament, { ...game, moves }, outcome.result);
  await saveTournamentGameResult(tournament.id, game.id, outcome.result, {
    pgn,
    moves,
    reason: outcome.reason,
    winnerId: outcome.winnerId,
  });
  return true;
}