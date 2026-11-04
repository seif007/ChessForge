/**
 * BOT SOURCES — Lichess.
 *
 * A bot built from an account is built from that account's own public games,
 * fetched on the device. This file is the seam between the app's Lichess client
 * and the bot builder: the client already looks up an account and replays its
 * games, so what is added here is only what a BOT needs on top — the recent
 * games rather than the whole history, the current ratings, and one conversion
 * into the RawBotGame shape that every source shares.
 */

import {
  LichessError, fetchAllGames, fetchProfile, lichessAccountError, sanitizeLichessUser,
} from '@/lib/lichess';
import type { LichessGame, LichessProfile, LichessRatings } from '@/lib/lichess';
import type { BotBuildProgress, BotMeta, RawBotGame } from './types';

/** How many games a bot wants when the user has not asked for a specific number. */
export const BOT_GAMES_TARGET = 60;

/** Below this there is no personality to find in the games, only an average. */
export const MIN_GAMES_FOR_BOT = 6;

/** The most this app will ever ask any source for on one bot's behalf. */
export const MAX_BOT_GAMES = 200;

/**
 * The time classes a bot may be built from.
 *
 * BULLET IS NOT ONE OF THEM. Bullet is a different game — premoves and flagging
 * rather than choices — and a bot wearing a name learned from it plays like a
 * different player. The walk below never keeps a bullet game whatever was asked
 * for, and this type makes "bullet" a compile error rather than an option that
 * exists and should not.
 *
 * `daily` is the app's label for Lichess's slow formats: classical and
 * correspondence. The bots UI offers that choice as "Classical" and the
 * profile prints the same word everywhere.
 */
export type LichessTimeClass = 'all' | 'blitz' | 'rapid' | 'daily';

/** The server-side Lichess perf filter for a bot's chosen class. */
function perfTypeFor(timeClass: LichessTimeClass): string {
  if (timeClass === 'blitz') return 'blitz';
  if (timeClass === 'rapid') return 'rapid';
  if (timeClass === 'daily') return 'classical,correspondence';
  return 'blitz,rapid,classical,correspondence';
}

export { sanitizeLichessUser };

/**
 * One game in the shape the builder reads.
 *
 * The account client returns games that have already been replayed into SAN;
 * the builder reads PGN. Rebuilding a PGN from that SAN mainline loses nothing
 * the builder looks at — players, result, ratings, date, moves — and it means
 * there is ONE Lichess game reader in the app. A second reader would be a
 * second opinion about what a Lichess game is.
 */
export function lichessRawGame(game: LichessGame, username: string): RawBotGame {
  const opponent = game.opponent;
  const white = game.color === 'w' ? username : opponent;
  const black = game.color === 'w' ? opponent : username;
  const whiteRating =
    game.color === 'w' ? game.playerRating ?? undefined : game.opponentRating ?? undefined;
  const blackRating =
    game.color === 'b' ? game.playerRating ?? undefined : game.opponentRating ?? undefined;

  let result: string;
  if (game.outcome === 'draw') result = '1/2-1/2';
  else if (game.outcome === 'win') result = game.color === 'w' ? '1-0' : '0-1';
  else result = game.color === 'w' ? '0-1' : '1-0';

  const date = game.endTime > 0
    ? new Date(game.endTime * 1000).toISOString().slice(0, 10)
    : '';
  const moves = game.movesSan
    .map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san))
    .join(' ');

  const tag = (name: string, value: string | number | undefined) =>
    value === undefined || value === '' ? null : `[${name} "${value}"]`;

  const pgn = [
    tag('Event', 'Lichess'),
    tag('Date', date.replace(/-/g, '.')),
    tag('White', white),
    tag('Black', black),
    tag('Result', result),
    tag('WhiteElo', whiteRating),
    tag('BlackElo', blackRating),
    tag('TimeControl', game.timeClass),
    '',
    moves ? `${moves} ${result}` : result,
  ]
    .filter((line) => line !== null)
    .join('\n');

  return {
    pgn,
    white,
    black,
    whiteRating,
    blackRating,
    timeControl: game.timeClass,
    date,
    source: 'lichess',
  };
}

/**
 * One silent retry for a network-level failure.
 *
 * Phones hop between networks and resolvers hiccup: a request fails while the
 * host is up, and the very next attempt succeeds. One retry turns most of
 * those into a build that merely took a second longer instead of an error the
 * user has to act on. Anything that is NOT a network failure — a missing
 * account, a cancelled build — passes straight through, untouched.
 */
async function withNetRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof LichessError) || err.kind !== 'network') throw err;
    await new Promise((resolve) => setTimeout(resolve, 600));
    return await fn();
  }
}

/**
 * The account's recent games, ready to fold into a profile.
 *
 * Lichess filters by `perfType` on the server, so one request returns the
 * recent non-bullet games the bot needs rather than a full history.
 */
export async function fetchLichessBotGames(
  query: string,
  onProgress: (p: BotBuildProgress) => void,
  opts: { maxGames?: number; timeClass?: LichessTimeClass; signal?: AbortSignal } = {},
): Promise<{ games: RawBotGame[]; meta: BotMeta }> {
  const user = sanitizeLichessUser(query);
  if (!user) throw new Error('Enter a Lichess username.');

  const maxGames = Math.max(
    MIN_GAMES_FOR_BOT,
    Math.min(MAX_BOT_GAMES, Math.floor(opts.maxGames ?? BOT_GAMES_TARGET)),
  );
  const timeClass = opts.timeClass ?? 'all';

  onProgress({ stage: 'fetch', label: 'Looking up the account…', done: 0, total: 0, pct: 4 });

  let profile: LichessProfile;
  try {
    profile = await withNetRetry(() => fetchProfile(user, opts.signal));
  } catch (err) {
    if (err instanceof LichessError && (err.kind === 'not-found' || err.kind === 'disabled')) {
      throw new Error(lichessAccountError(user, err));
    }
    throw err;
  }
  /*
   * A CLOSED ACCOUNT CANNOT BE A BOT. Its games endpoint 404s even though the
   * profile exists, so the build would otherwise fail with a message about a
   * username that is not missing. Say what is actually true.
   */
  if (profile.disabled) {
    throw new Error(lichessAccountError(profile.username, new LichessError('closed', 'disabled')));
  }

  /*
   * A missing rating must not sink an otherwise good build: the games are the
   * bot, the rating is the label on the card, and the builder can fall back to
   * the Elo in the game headers.
   */
  const ratings: LichessRatings = profile.ratings;

  const meta: BotMeta = {
    /*
     * THE HANDLE IS THE IDENTITY. A Lichess bot is an unofficial style model
     * of a public account, so the real name, title, avatar and country are not
     * part of what the app keeps. The handle is enough to label it honestly and
     * to find the player in the PGN headers.
     */
    name: profile.username,
    key: profile.username,
    source: 'lichess',
    timeClass,
    ratings: {
      // No bullet entry: the rating for a format the bot can never be built
      // from would sit in the sheet as a number for a game nobody can play.
      blitz: ratings.blitz,
      rapid: ratings.rapid,
      daily: ratings.daily,
      fide: ratings.fide,
    },
  };

  onProgress({ stage: 'fetch', label: 'Fetching their games…', done: 0, total: 0, pct: 10 });

  const raw = await withNetRetry(() =>
    fetchAllGames(profile.username, {
      signal: opts.signal,
      maxGames,
      perfType: perfTypeFor(timeClass),
      rated: true,
      disabledHint: profile.disabled,
      onProgress: (p) =>
        onProgress({
          stage: 'fetch',
          label: p.phase,
          done: p.gamesSoFar,
          total: 0,
          pct: p.fraction === null ? 12 : 10 + Math.round(p.fraction * 28),
        }),
    }),
  );

  /*
   * BULLET IS NEVER KEPT — in any mode, including "all". The server filter
   * excludes it, and the clause below makes that true even if a future caller
   * asks for a different perf set.
   */
  const kept = raw.filter(
    (g) => g.timeClass !== 'bullet' && (timeClass === 'all' || g.timeClass === timeClass),
  );
  if (kept.length < MIN_GAMES_FOR_BOT) {
    throw new Error(
      timeClass === 'all'
        ? `That account has fewer than ${MIN_GAMES_FOR_BOT} public non-bullet games to learn from.`
        : `That account has fewer than ${MIN_GAMES_FOR_BOT} public ${timeClass === 'daily' ? 'classical' : timeClass} games to learn from.`,
    );
  }

  const games = kept.slice(0, maxGames).map((g) => lichessRawGame(g, profile.username));
  return { games, meta };
}
