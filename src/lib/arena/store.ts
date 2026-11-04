/**
 * ChessForge Arena storage and tournament lifecycle.
 *
 * The lifecycle is deliberately split in two:
 *
 *   buildTournament()       pure, testable, no storage
 *   recordGameResult()      pure, applies a result and its rating changes
 *   advanceTournament()     pure, draws the next round or crowns a champion
 *
 * The exported async functions are thin read/modify/write wrappers around one
 * key. A tournament stores bot snapshots, so deleting or editing a bot later
 * does not rewrite history.
 */

import Storage from 'expo-sqlite/kv-store';

import type { BotProfile } from '@/lib/bots/types';
import { botDisplayName } from '@/lib/bots/display';
import {
  championOf,
  championTiebreakNote,
  computeStandings,
  firstKnockoutRound,
  knockoutMatchNeedsTiebreak,
  knockoutMatches,
  knockoutNextPairings,
  knockoutWinnerIds,
  nextRoundPairings,
  roundComplete,
  roundRobinRounds,
  swissPairings,
} from './pairing';
import {
  DEFAULT_RATINGS,
  applyElo,
  eloDelta,
  initialBotRating,
  normalizeRatings,
  ratingFrom,
  withRating,
} from './ratings';
import type {
  ArenaData,
  ArenaGame,
  ArenaMode,
  ArenaParticipant,
  ArenaPairing,
  ArenaRatingHistory,
  ArenaResult,
  ArenaSettings,
  ArenaTimeCategory,
  ArenaTimeControl,
  ArenaTournament,
} from './types';

const ARENA_KEY = 'chessforge.arena.v1';
const ARENA_V = 1;

/**
 * Arena writes are load-modify-save operations. Without a queue, a slow
 * intermediate move save could load the pre-result tournament, finish after the
 * result save, and overwrite the result with "playing". Every write goes through
 * this promise chain so the order the screen asked for is the order disk sees.
 */
let arenaWriteQueue: Promise<unknown> = Promise.resolve();

function serializeArenaWrite<T>(work: () => Promise<T>): Promise<T> {
  const next = arenaWriteQueue.then(work, work);
  arenaWriteQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function writeArenaData(data: ArenaData): Promise<void> {
  await Storage.setItem(ARENA_KEY, JSON.stringify(data));
}

export function newArenaId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}_${r}`;
}

export function emptyArenaData(): ArenaData {
  return {
    v: ARENA_V,
    tournaments: [],
    humanRatings: { ...DEFAULT_RATINGS },
    botRatings: {},
    history: [],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function botRatingSeed(profile: BotProfile, category: keyof typeof DEFAULT_RATINGS): number {
  const fromSource = category === 'classical'
    ? profile.meta.ratings?.daily
    : profile.meta.ratings?.[category];
  if (typeof fromSource === 'number' && Number.isFinite(fromSource)) return fromSource;
  return initialBotRating(profile);
}

function ratingsForBot(profile: BotProfile): ArenaData['humanRatings'] {
  const fallback = initialBotRating(profile);
  return {
    bullet: profile.meta.ratings?.bullet ?? fallback,
    blitz: profile.meta.ratings?.blitz ?? fallback,
    rapid: profile.meta.ratings?.rapid ?? fallback,
    classical: profile.meta.ratings?.daily ?? fallback,
  };
}

function normaliseGame(raw: Partial<ArenaGame>): ArenaGame | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.whiteId !== 'string') return null;
  return {
    id: raw.id,
    round: Number(raw.round ?? 1),
    board: Number(raw.board ?? 1),
    whiteId: raw.whiteId,
    blackId: typeof raw.blackId === 'string' ? raw.blackId : null,
    byeId: raw.byeId,
    status: raw.status === 'done' || raw.status === 'playing' ? raw.status : 'pending',
    result: raw.result,
    winnerId: raw.winnerId,
    reason: raw.reason,
    moves: Array.isArray(raw.moves) ? raw.moves : [],
    pgn: raw.pgn,
    clocks: raw.clocks,
    clockHistory: Array.isArray(raw.clockHistory) ? raw.clockHistory : [],
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    ratingChanges: raw.ratingChanges,
    /*
     * THE MATCH SHAPE MUST SURVIVE A ROUND TRIP.
     *
     * These three fields were dropped here, and it broke knockouts completely:
     * the Armageddon was scheduled with `armageddon: true`, the write stored it,
     * and the NEXT read rebuilt the game without the flag. So the tie-break
     * played as an ordinary game, its draw did not send Black through, the match
     * stayed level, and the store appended ANOTHER Armageddon — the owner's
     * report of *"each time we draw there is a next game! and it is normal
     * game!"*. `leg` and `clockStart` are part of the same shape.
     */
    leg: typeof raw.leg === 'number' ? raw.leg : undefined,
    armageddon: raw.armageddon === true ? true : undefined,
    clockStart: raw.clockStart && typeof raw.clockStart.white === 'number'
      && typeof raw.clockStart.black === 'number'
      ? { white: raw.clockStart.white, black: raw.clockStart.black }
      : undefined,
  };
}

export function normaliseArenaData(raw: unknown): ArenaData {
  const data = emptyArenaData();
  if (!raw || typeof raw !== 'object') return data;
  const obj = raw as Partial<ArenaData>;
  if (Array.isArray(obj.tournaments)) {
    data.tournaments = obj.tournaments
      .map((t) => {
        if (!t || typeof t.id !== 'string' || !Array.isArray(t.participants)) return null;
        return {
          ...t,
          participants: t.participants.filter((p) => p && typeof p.id === 'string'),
          games: Array.isArray(t.games)
            ? t.games.map(normaliseGame).filter((g): g is ArenaGame => !!g)
            : [],
          currentRound: Number(t.currentRound ?? 1) || 1,
          status: t.status === 'completed' ? 'completed' : t.status === 'draft' ? 'draft' : 'active',
          rounds: Number(t.rounds ?? 1) || 1,
        } as ArenaTournament;
      })
      .filter((t): t is ArenaTournament => !!t);
  }
  data.humanRatings = normalizeRatings(obj.humanRatings);
  if (obj.botRatings && typeof obj.botRatings === 'object') {
    for (const [id, ratings] of Object.entries(obj.botRatings)) {
      data.botRatings[id] = normalizeRatings(ratings);
    }
  }
  if (Array.isArray(obj.history)) data.history = obj.history.filter((h) => !!h && typeof h.id === 'string');
  return data;
}

async function readArenaData(): Promise<ArenaData> {
  try {
    const raw = await Storage.getItem(ARENA_KEY);
    if (!raw) return emptyArenaData();
    return normaliseArenaData(JSON.parse(raw));
  } catch {
    return emptyArenaData();
  }
}

/**
 * Readers wait for queued writes. Without this, leaving a game immediately
 * after its move save would reopen the tournament before the write landed and
 * show the previous position.
 */
export async function loadArenaData(): Promise<ArenaData> {
  await arenaWriteQueue;
  return readArenaData();
}

export function saveArenaData(data: ArenaData): Promise<void> {
  return serializeArenaWrite(() => writeArenaData(data));
}

export function clearArenaData(): Promise<void> {
  return serializeArenaWrite(async () => {
    await Storage.removeItem(ARENA_KEY);
  });
}

export function tournamentById(data: ArenaData, id: string): ArenaTournament | undefined {
  return data.tournaments.find((t) => t.id === id);
}

function initialPairings(tournament: ArenaTournament): ArenaPairing[] {
  const ids = tournament.participants.map((p) => p.id);
  switch (tournament.format) {
    case 'round-robin':
    case 'double-round-robin':
      return roundRobinRounds(ids, tournament.format === 'double-round-robin')[0] ?? [];
    case 'knockout':
      return firstKnockoutRound(tournament);
    case 'swiss':
      return swissPairings(tournament, false);
    case 'arena':
      return swissPairings(tournament, true);
    default:
      return [];
  }
}

function gameFromPairing(
  tournamentId: string,
  pairing: ArenaPairing,
  round: number,
  board: number,
  now: number,
  leg = 1,
): ArenaGame {
  const bye = pairing.blackId === null;
  return {
    id: `g_${tournamentId}_${round}_${board}`,
    round,
    board,
    whiteId: pairing.whiteId,
    blackId: pairing.blackId,
    byeId: pairing.byeId,
    status: bye ? 'done' : 'pending',
    result: bye ? 'bye' : undefined,
    winnerId: bye ? pairing.byeId ?? pairing.whiteId : undefined,
    reason: bye ? 'bye' : undefined,
    moves: [],
    leg: leg > 1 ? leg : undefined,
    finishedAt: bye ? now : undefined,
  };
}

function gamesForRound(
  tournamentId: string,
  pairings: readonly ArenaPairing[],
  round: number,
  now: number,
  boardOffset = 0,
  leg = 1,
): ArenaGame[] {
  return pairings.map((p, i) => gameFromPairing(tournamentId, p, round, boardOffset + i + 1, now, leg));
}

/**
 * The games of one knockout round: one leg, or two with the colours swapped.
 *
 * A bye is not duplicated — there is no second game to play against nobody.
 */
function knockoutRoundGames(
  tournament: ArenaTournament,
  pairings: readonly ArenaPairing[],
  round: number,
  now: number,
): ArenaGame[] {
  const first = gamesForRound(tournament.id, pairings, round, now, 0, 1);
  if ((tournament.knockoutLegs ?? 1) !== 2) return first;
  const swapped: ArenaPairing[] = pairings
    .filter((p) => p.blackId !== null)
    .map((p) => ({ whiteId: p.blackId as string, blackId: p.whiteId }));
  return [...first, ...gamesForRound(tournament.id, swapped, round, now, first.length, 2)];
}

/**
 * The Armageddon clocks: White gets the event's base time, Black 80% of it.
 *
 * Draw odds are the real tiebreak — Black advances on a draw — and the extra
 * time for White is the compensation that makes the game fair. Untimed events
 * have no clocks, so the game is decided by the same draw odds alone.
 */
function armageddonClock(tc: ArenaTimeControl): { white: number; black: number } | undefined {
  if (tc.untimed || tc.initialSeconds <= 0) return undefined;
  return {
    white: tc.initialSeconds,
    black: Math.max(45, Math.round(tc.initialSeconds * 0.8)),
  };
}

function humanColourAdjustment(tournament: ArenaTournament): void {
  if (tournament.mode !== 'human' || tournament.colourPreference === 'random') return;
  const human = tournament.participants.find((p) => p.kind === 'human');
  if (!human) return;
  const first = tournament.games
    .filter((g) => g.round === 1 && g.blackId)
    .find((g) => g.whiteId === human.id || g.blackId === human.id);
  if (!first) return;
  const wantsWhite = tournament.colourPreference === 'white';
  const isWhite = first.whiteId === human.id;
  if (wantsWhite === isWhite) return;
  /*
   * FLIP THE WHOLE MATCH, NOT ONE LEG. In a two-leg knockout the legs must stay
   * opposite colours; flipping only the first would hand the human the same
   * colour twice and break the format's promise.
   */
  const pairKey = [first.whiteId, first.blackId].sort().join('|');
  for (const g of tournament.games) {
    if (g.round !== first.round || !g.blackId) continue;
    if ([g.whiteId, g.blackId].sort().join('|') !== pairKey) continue;
    const white = g.whiteId;
    g.whiteId = g.blackId as string;
    g.blackId = white;
  }
}

function roundsFor(format: ArenaTournament['format'], count: number, requested: number): number {
  /*
   * An odd round robin needs `count` rounds because one player has a bye in
   * each round. Using count - 1 made the header promise four rounds for five
   * players while the circle method correctly scheduled five.
   */
  const single = count % 2 === 0 ? Math.max(1, count - 1) : Math.max(1, count);
  if (format === 'round-robin') return single;
  if (format === 'double-round-robin') return single * 2;
  if (format === 'knockout') return Math.max(1, Math.ceil(Math.log2(Math.max(2, count))));
  return Math.max(1, Math.min(12, requested || 5));
}

/** Build the first round (or the full round-robin schedule) for an active tournament. */
function scheduleTournament(tournament: ArenaTournament, now: number): void {
  tournament.games = [];
  tournament.currentRound = 1;
  if (tournament.format === 'round-robin' || tournament.format === 'double-round-robin') {
    const roundsOfPairings = roundRobinRounds(
      tournament.participants.map((p) => p.id),
      tournament.format === 'double-round-robin',
    );
    tournament.games = roundsOfPairings.flatMap((pairings, i) =>
      gamesForRound(tournament.id, pairings, i + 1, now),
    );
  } else if (tournament.format === 'knockout') {
    tournament.games = knockoutRoundGames(tournament, initialPairings(tournament), 1, now);
  } else {
    tournament.games = gamesForRound(tournament.id, initialPairings(tournament), 1, now);
  }
  humanColourAdjustment(tournament);
}

export function buildTournament(
  data: ArenaData,
  settings: ArenaSettings,
  bots: readonly BotProfile[],
  now = Date.now(),
): { data: ArenaData; tournament: ArenaTournament } {
  const uniqueBots = bots.filter((b, i) => bots.findIndex((x) => x.id === b.id) === i);
  if (uniqueBots.length === 0) throw new Error('Choose at least one bot.');
  if (settings.mode === 'bots' && uniqueBots.length < 2) {
    throw new Error('A bot championship needs at least two bots.');
  }
  const mode: ArenaMode = settings.mode;
  const timeControl = settings.timeControl;
  const rated = settings.rated;
  const category = timeControl.category;
  const humanRatings = normalizeRatings(data.humanRatings);
  const botRatings = { ...data.botRatings };

  const participants: ArenaParticipant[] = [];
  if (mode === 'human') {
    const rating = ratingFrom(humanRatings, category, 1500);
    participants.push({
      id: 'you',
      kind: 'human',
      name: 'You',
      rating,
      startingRating: rating,
      seed: 1,
    });
  }
  for (const bot of uniqueBots) {
    if (!botRatings[bot.id]) botRatings[bot.id] = ratingsForBot(bot);
    const rating = ratingFrom(botRatings[bot.id], category, botRatingSeed(bot, category));
    participants.push({
      id: bot.id,
      kind: 'bot',
      name: botDisplayName(bot),
      rating,
      startingRating: rating,
      seed: 1,
      bot: clone(bot),
    });
  }

  // Seed by current rating, strongest first. The human is not privileged.
  const seeded = [...participants].sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    if (a.kind !== b.kind) return a.kind === 'human' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  seeded.forEach((p, i) => {
    p.seed = i + 1;
  });

  const id = newArenaId('arena');
  const draft = settings.continuation === 'later';
  const rounds = roundsFor(settings.format, seeded.length, settings.rounds);

  const tournament: ArenaTournament = {
    id,
    name: settings.name.trim() || 'ChessForge Arena',
    mode,
    format: settings.format,
    timeControl,
    rated,
    rounds,
    colourPreference: settings.mode === 'human' ? settings.humanColor : settings.colourPreference,
    continuation: settings.continuation,
    knockoutLegs: settings.format === 'knockout' && settings.knockoutLegs === 2 ? 2 : 1,
    createdAt: now,
    startedAt: draft ? undefined : now,
    participants: seeded,
    games: [],
    currentRound: 1,
    status: draft ? 'draft' : 'active',
  };
  if (!draft) scheduleTournament(tournament, now);

  const nextData: ArenaData = {
    ...data,
    tournaments: [tournament, ...data.tournaments],
    humanRatings,
    botRatings,
  };
  return { data: nextData, tournament };
}

export function createTournament(
  settings: ArenaSettings,
  bots: readonly BotProfile[],
): Promise<{ data: ArenaData; tournament: ArenaTournament }> {
  return serializeArenaWrite(async () => {
    const data = await readArenaData();
    const built = buildTournament(data, settings, bots);
    await writeArenaData(built.data);
    return built;
  });
}

export async function loadTournament(id: string): Promise<ArenaTournament | null> {
  const data = await loadArenaData();
  return tournamentById(data, id) ?? null;
}

/**
 * Edit a saved draft before the first game. Bot snapshots are NOT re-read from
 * the library: the participants stay the same, only the tournament settings and
 * the rating pool for the chosen time control move. That is the line between
 * "settings" and "a different tournament".
 */
export function updateDraftSettingsData(
  data: ArenaData,
  tournamentId: string,
  patch: {
    name: string;
    format: ArenaTournament['format'];
    timeControl: ArenaTournament['timeControl'];
    rated: boolean;
    rounds: number;
    knockoutLegs?: 1 | 2;
  },
): ArenaData {
  const tournament = tournamentById(data, tournamentId);
  if (!tournament || tournament.status !== 'draft') return data;
  const next = cloneTournament(tournament);
  const category = patch.timeControl.category;
  const humanRatings = normalizeRatings(data.humanRatings);
  const botRatings = { ...data.botRatings };
  next.name = patch.name.trim() || 'ChessForge Arena';
  next.format = patch.format;
  next.timeControl = patch.timeControl;
  next.rated = patch.rated;
  if (patch.format === 'knockout') next.knockoutLegs = patch.knockoutLegs === 2 ? 2 : 1;
  next.rounds = roundsFor(patch.format, next.participants.length, patch.rounds);
  next.games = [];
  next.currentRound = 1;
  next.startedAt = undefined;
  for (const p of next.participants) {
    const rating = p.kind === 'human'
      ? ratingFrom(humanRatings, category, p.rating)
      : ratingFrom(botRatings[p.id], category, p.rating);
    p.rating = rating;
    p.startingRating = rating;
  }
  return {
    ...data,
    tournaments: data.tournaments.map((t) => (t.id === tournamentId ? next : t)),
    humanRatings,
    botRatings,
  };
}

/** Move a saved draft to active and generate its first pairings. */
export function startTournamentData(data: ArenaData, tournamentId: string): ArenaData {
  const tournament = tournamentById(data, tournamentId);
  if (!tournament || tournament.status !== 'draft') return data;
  const next = cloneTournament(tournament);
  next.status = 'active';
  next.startedAt = Date.now();
  scheduleTournament(next, Date.now());
  return {
    ...data,
    tournaments: data.tournaments.map((t) => (t.id === tournamentId ? next : t)),
  };
}

export function updateDraftSettings(
  tournamentId: string,
  patch: Parameters<typeof updateDraftSettingsData>[2],
): Promise<ArenaData> {
  return serializeArenaWrite(async () => {
    const data = await readArenaData();
    const next = updateDraftSettingsData(data, tournamentId, patch);
    await writeArenaData(next);
    return next;
  });
}

export function startTournament(tournamentId: string): Promise<ArenaData> {
  return serializeArenaWrite(async () => {
    const data = await readArenaData();
    const next = startTournamentData(data, tournamentId);
    await writeArenaData(next);
    return next;
  });
}

/** The two Elo movements of one casual rated game, for the result card. */
export interface CasualRatingChange {
  category: ArenaTimeCategory;
  humanBefore: number;
  humanAfter: number;
  humanDelta: number;
  botBefore: number;
  botAfter: number;
  botDelta: number;
}

/**
 * A RATED GAME OUTSIDE A TOURNAMENT.
 *
 * The owner wanted the same rated/unrated choice for a plain game against a bot
 * as Arena offers, with the result moving their real ChessForge rating. This is
 * the same Elo and the same per-category pools as `recordGameResult`, minus the
 * tournament: the human side moves the human pool, the bot side moves that
 * bot's pool, and two history rows are written so the profile's "last played
 * category" is right.
 */
export function recordCasualGame(opts: {
  botId: string;
  botProfile: { playElo?: number; rating: number };
  category: ArenaTimeCategory;
  /** From the human's point of view. */
  humanScore: 0 | 0.5 | 1;
}): Promise<CasualRatingChange | null> {
  return serializeArenaWrite(async () => {
    const data = await readArenaData();
    const category = opts.category;
    const humanRatings = normalizeRatings(data.humanRatings);
    const botRatings = { ...data.botRatings };
    const humanBefore = ratingFrom(humanRatings, category, 1500);
    const botBefore = ratingFrom(
      botRatings[opts.botId], category, initialBotRating(opts.botProfile),
    );
    const humanAfter = applyElo(humanBefore, botBefore, opts.humanScore);
    const botAfter = applyElo(botBefore, humanBefore, 1 - opts.humanScore);
    const now = Date.now();
    const history: ArenaRatingHistory[] = [
      ...data.history,
      {
        id: newArenaId('rating'),
        at: now,
        category,
        participantId: 'you',
        name: 'You',
        before: humanBefore,
        after: humanAfter,
        delta: humanAfter - humanBefore,
        tournamentId: 'casual',
        gameId: `casual_${now}`,
      },
      {
        id: newArenaId('rating'),
        at: now,
        category,
        participantId: opts.botId,
        name: opts.botId,
        before: botBefore,
        after: botAfter,
        delta: botAfter - botBefore,
        tournamentId: 'casual',
        gameId: `casual_${now}`,
      },
    ];
    const next: ArenaData = {
      ...data,
      humanRatings: withRating(humanRatings, category, humanAfter),
      botRatings: { ...botRatings, [opts.botId]: withRating(botRatings[opts.botId], category, botAfter) },
      history,
    };
    await writeArenaData(next);
    return {
      category,
      humanBefore,
      humanAfter,
      humanDelta: humanAfter - humanBefore,
      botBefore,
      botAfter,
      botDelta: botAfter - botBefore,
    };
  });
}

function cloneTournament(t: ArenaTournament): ArenaTournament {
  return clone(t);
}

/**
 * Apply a finished game. Pure: the input tournament and data are not mutated.
 *
 * A knockout draw never picks a winner here: a level match has an Armageddon
 * game appended (Black prevails on a draw), and the bracket advances whoever
 * that game decides.
 */
export function recordGameResult(
  data: ArenaData,
  tournamentId: string,
  gameId: string,
  result: ArenaResult,
  opts: {
    pgn?: string;
    moves?: ArenaGame['moves'];
    clocks?: ArenaGame['clocks'];
    clockHistory?: ArenaGame['clockHistory'];
    reason?: string;
    winnerId?: string | null;
  } = {},
): ArenaData {
  const tournament = tournamentById(data, tournamentId);
  if (!tournament || tournament.status !== 'active') return data;
  const nextTournament = cloneTournament(tournament);
  const game = nextTournament.games.find((g) => g.id === gameId);
  if (!game || game.status === 'done') return data;

  game.status = 'done';
  game.result = result;
  game.pgn = opts.pgn;
  game.moves = opts.moves ?? game.moves;
  game.clocks = opts.clocks;
  game.clockHistory = opts.clockHistory;
  game.reason = opts.reason;
  game.finishedAt = Date.now();

  const white = nextTournament.participants.find((p) => p.id === game.whiteId);
  const black = game.blackId ? nextTournament.participants.find((p) => p.id === game.blackId) : undefined;

  if (result === 'bye') {
    game.winnerId = game.whiteId;
    game.reason = 'bye';
  } else if (result === '1-0') {
    game.winnerId = game.whiteId;
  } else if (result === '0-1') {
    game.winnerId = game.blackId;
  } else {
    game.winnerId = null;
    /*
     * A KNOCKOUT DRAW IS NOT DECIDED BY A RATING. It is decided on the board:
     * the regulation legs are played out, and a level match gets an Armageddon
     * game (Black advances on a draw). That game is appended below, once every
     * leg of this match is in.
     */
    if (nextTournament.format === 'knockout' && game.armageddon && white && black) {
      game.winnerId = black.id;
      game.reason = 'Armageddon drawn — Black advances';
    }
  }

  /*
   * SCHEDULE THE ARMAGEDDON FOR A LEVEL MATCH — once, and only when every
   * regulation leg is already done. It is appended to the SAME round, so the
   * round is not complete while the tie-break is pending: `nextPendingGame`
   * offers it, the bracket waits, and `knockoutMatchWinner` reads its result.
   */
  if (nextTournament.format === 'knockout') {
    for (const match of knockoutMatches(nextTournament, game.round)) {
      if (!knockoutMatchNeedsTiebreak(match)) continue;
      const regulation = match.games
        .filter((g) => !g.armageddon)
        .sort((a, b) => b.board - a.board);
      const last = regulation[0];
      if (!last || last.blackId === null) continue;
      // The player who had Black in the last leg gets White in the Armageddon;
      // the other, with the draw odds, gets Black.
      const nextBoard = Math.max(0, ...nextTournament.games.map((g) => g.board)) + 1;
      nextTournament.games.push({
        id: newArenaId('arm'),
        round: game.round,
        board: nextBoard,
        whiteId: last.blackId,
        blackId: last.whiteId,
        status: 'pending',
        moves: [],
        armageddon: true,
        clockStart: armageddonClock(nextTournament.timeControl),
      });
    }
  }

  let humanRatings = normalizeRatings(data.humanRatings);
  const botRatings = { ...data.botRatings };
  const history = [...data.history];
  const category = nextTournament.timeControl.category;

  if (nextTournament.rated && result !== 'bye' && white && black) {
    const whiteScore = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
    const blackScore = 1 - whiteScore;
    const changes: ArenaData['history'] = [];
    /*
     * Both Elo calculations use the pre-game ratings. Applying white first and
     * then reading white.rating for black would make the second player's change
     * depend on the first player's update.
     */
    const whiteRating = white.kind === 'human'
      ? ratingFrom(humanRatings, category, white.rating)
      : ratingFrom(botRatings[white.id], category, white.rating);
    const blackRating = black.kind === 'human'
      ? ratingFrom(humanRatings, category, black.rating)
      : ratingFrom(botRatings[black.id], category, black.rating);
    const apply = (p: ArenaParticipant, current: number, opponentRating: number, score: number) => {
      const delta = eloDelta(current, opponentRating, score);
      const after = applyElo(current, opponentRating, score);
      if (p.kind === 'human') humanRatings = withRating(humanRatings, category, after);
      else botRatings[p.id] = withRating(botRatings[p.id], category, after);
      p.rating = after;
      changes.push({
        id: newArenaId('rating'),
        at: Date.now(),
        category,
        participantId: p.id,
        name: p.name,
        before: current,
        after,
        delta,
        tournamentId,
        gameId,
      });
    };
    apply(white, whiteRating, blackRating, whiteScore);
    apply(black, blackRating, whiteRating, blackScore);
    game.ratingChanges = changes.map((h) => ({
      participantId: h.participantId,
      name: h.name,
      before: h.before,
      after: h.after,
      delta: h.delta,
    }));
    history.push(...changes);
  }

  // A completed round in a format whose next round is drawn on demand stays
  // active until advanceTournament() is called. Knockout finals and the last
  // scheduled round are completed immediately.
  const maxRound = Math.max(0, ...nextTournament.games.map((g) => g.round));
  const allScheduledDone =
    nextTournament.games.length > 0 && nextTournament.games.every((g) => g.status === 'done');
  const finalRoundDone = roundComplete(nextTournament, nextTournament.currentRound);
  if (finalRoundDone) {
    if (nextTournament.format === 'knockout') {
      const winners = knockoutWinnerIds(nextTournament, nextTournament.currentRound);
      if (winners.length <= 1) {
        nextTournament.status = 'completed';
        nextTournament.completedAt = Date.now();
        nextTournament.championId = winners[0];
      }
    } else if (
      (nextTournament.format === 'round-robin' || nextTournament.format === 'double-round-robin') &&
      (nextTournament.currentRound >= maxRound || allScheduledDone)
    ) {
      nextTournament.status = 'completed';
      nextTournament.completedAt = Date.now();
      nextTournament.championId = championOf(nextTournament)?.participant.id;
    } else if (
      (nextTournament.format === 'swiss' || nextTournament.format === 'arena') &&
      nextTournament.currentRound >= nextTournament.rounds
    ) {
      nextTournament.status = 'completed';
      nextTournament.completedAt = Date.now();
      nextTournament.championId = championOf(nextTournament)?.participant.id;
    }
  }

  return {
    ...data,
    tournaments: data.tournaments.map((t) => (t.id === tournamentId ? nextTournament : t)),
    humanRatings,
    botRatings,
    history,
  };
}

/** Draw the next round, or crown the champion when the schedule is exhausted. */
export function advanceTournament(data: ArenaData, tournamentId: string): ArenaData {
  const tournament = tournamentById(data, tournamentId);
  if (!tournament || tournament.status !== 'active') return data;
  if (!roundComplete(tournament, tournament.currentRound)) return data;

  const next = cloneTournament(tournament);
  const now = Date.now();

  if (next.format === 'round-robin' || next.format === 'double-round-robin') {
    const maxRound = Math.max(0, ...next.games.map((g) => g.round));
    const allScheduledDone = next.games.length > 0 && next.games.every((g) => g.status === 'done');
    if (next.currentRound < maxRound && !allScheduledDone) {
      next.currentRound += 1;
    } else {
      next.status = 'completed';
      next.completedAt = now;
      next.championId = championOf(next)?.participant.id;
    }
  } else if (next.format === 'knockout') {
    const pairings = knockoutNextPairings(next, next.currentRound);
    if (pairings.length === 0) {
      const winners = knockoutWinnerIds(next, next.currentRound);
      next.status = 'completed';
      next.completedAt = now;
      next.championId = winners[0];
    } else {
      const round = next.currentRound + 1;
      next.games.push(...knockoutRoundGames(next, pairings, round, now));
      next.currentRound = round;
    }
  } else {
    if (next.currentRound >= next.rounds) {
      next.status = 'completed';
      next.completedAt = now;
      next.championId = championOf(next)?.participant.id;
    } else {
      const pairings = nextRoundPairings(next);
      if (pairings.length === 0) {
        next.status = 'completed';
        next.completedAt = now;
        next.championId = championOf(next)?.participant.id;
      } else {
        const round = next.currentRound + 1;
        next.games.push(...gamesForRound(next.id, pairings, round, now));
        next.currentRound = round;
      }
    }
  }

  return {
    ...data,
    tournaments: data.tournaments.map((t) => (t.id === tournamentId ? next : t)),
  };
}

export function saveTournamentGameResult(
  tournamentId: string,
  gameId: string,
  result: ArenaResult,
  opts: Parameters<typeof recordGameResult>[4] = {},
): Promise<ArenaData> {
  return serializeArenaWrite(async () => {
    const data = await readArenaData();
    const next = recordGameResult(data, tournamentId, gameId, result, opts);
    await writeArenaData(next);
    return next;
  });
}

export function saveTournamentGameState(
  tournamentId: string,
  gameId: string,
  patch: {
    moves: ArenaGame['moves'];
    clocks?: ArenaGame['clocks'];
    clockHistory?: ArenaGame['clockHistory'];
    pgn?: string;
  },
): Promise<void> {
  return serializeArenaWrite(async () => {
    const data = await readArenaData();
    const tournament = tournamentById(data, tournamentId);
    const game = tournament?.games.find((g) => g.id === gameId);
    if (!tournament || tournament.status !== 'active' || !game || game.status === 'done') return;
    game.status = 'playing';
    game.startedAt = game.startedAt ?? Date.now();
    game.moves = patch.moves;
    game.clocks = patch.clocks;
    game.clockHistory = patch.clockHistory;
    game.pgn = patch.pgn;
    await writeArenaData(data);
  });
}

export function advanceTournamentAndSave(tournamentId: string): Promise<ArenaData> {
  return serializeArenaWrite(async () => {
    const data = await readArenaData();
    const next = advanceTournament(data, tournamentId);
    await writeArenaData(next);
    return next;
  });
}

export function deleteTournament(tournamentId: string): Promise<ArenaData> {
  return serializeArenaWrite(async () => {
    const data = await readArenaData();
    const next = { ...data, tournaments: data.tournaments.filter((t) => t.id !== tournamentId) };
    await writeArenaData(next);
    return next;
  });
}

export function setHumanRatings(ratings: Partial<ArenaData['humanRatings']>): Promise<ArenaData> {
  return serializeArenaWrite(async () => {
    const data = await readArenaData();
    const next = { ...data, humanRatings: normalizeRatings({ ...data.humanRatings, ...ratings }) };
    await writeArenaData(next);
    return next;
  });
}

export { computeStandings, championOf, championTiebreakNote };
export type { ArenaRatingHistory };
