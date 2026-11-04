/**
 * Pairings and standings — pure tournament arithmetic.
 *
 * The store owns persistence and ids; this module only answers questions about
 * a tournament object it is given. That keeps the formats testable without a
 * database and keeps the screens free of pairing rules.
 *
 * Formats:
 *   round-robin / double — circle method, byes for odd fields, colours balanced
 *   knockout             — seeded bracket; draws are resolved by the store
 *   swiss                — score groups, no repeat pairings where possible,
 *                          colour balancing, one bye for an odd field
 *   arena                — repeated score-group pairings, rematches allowed
 */

import type {
  ArenaGame,
  ArenaPairing,
  ArenaParticipant,
  ArenaStanding,
  ArenaTournament,
} from './types';

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function participantById(
  tournament: ArenaTournament,
  id: string | null,
): ArenaParticipant | undefined {
  if (!id) return undefined;
  return tournament.participants.find((p) => p.id === id);
}

/** The circle method, including a dummy player for an odd field. */
export function roundRobinRounds(ids: readonly string[], double: boolean): ArenaPairing[][] {
  const players: (string | null)[] = [...ids];
  if (players.length < 2) return [];
  if (players.length % 2 === 1) players.push(null);
  const n = players.length;
  const rounds: ArenaPairing[][] = [];
  let order = [...players];

  /*
   * The circle method fixes one player in place, so a naive "alternate every
   * board" colour rule gives that player white in every round. Keep a colour
   * ledger instead: the player with fewer whites gets white, and if the counts
   * are level the player who did not have white last time gets it. This keeps a
   * four-player round robin at 2/1 for everyone rather than 3/0 for the fixed
   * player.
   */
  const whites = new Map<string, number>();
  const last = new Map<string, 'white' | 'black'>();
  const chooseWhite = (a: string, b: string): string => {
    const aw = whites.get(a) ?? 0;
    const bw = whites.get(b) ?? 0;
    if (aw !== bw) return aw < bw ? a : b;
    const al = last.get(a);
    const bl = last.get(b);
    if (al === 'white' && bl !== 'white') return b;
    if (bl === 'white' && al !== 'white') return a;
    if (al === 'white' && bl === 'white') return b;
    return a;
  };

  for (let r = 0; r < n - 1; r++) {
    const round: ArenaPairing[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = order[i];
      const b = order[n - 1 - i];
      if (a && b) {
        const whiteId = chooseWhite(a, b);
        const blackId = whiteId === a ? b : a;
        whites.set(whiteId, (whites.get(whiteId) ?? 0) + 1);
        last.set(whiteId, 'white');
        last.set(blackId, 'black');
        round.push({ whiteId, blackId });
      } else if (a || b) {
        const bye = (a ?? b) as string;
        round.push({ whiteId: bye, blackId: null, byeId: bye });
      }
    }
    rounds.push(round);
    // Keep the first player fixed, rotate the rest one place clockwise.
    order = [order[0], order[n - 1], ...order.slice(1, n - 1)];
  }

  if (!double) return rounds;
  return [
    ...rounds,
    ...rounds.map((round) =>
      round.map((p) =>
        p.blackId
          ? { whiteId: p.blackId, blackId: p.whiteId }
          : p,
      ),
    ),
  ];
}

interface ColorRecord {
  white: number;
  black: number;
  last: 'white' | 'black' | null;
}

function colorRecord(id: string, games: readonly ArenaGame[]): ColorRecord {
  let white = 0;
  let black = 0;
  let last: 'white' | 'black' | null = null;
  for (const g of games) {
    if (g.status !== 'done' || g.result === 'bye') continue;
    if (g.whiteId === id) {
      white += 1;
      last = 'white';
    } else if (g.blackId === id) {
      black += 1;
      last = 'black';
    }
  }
  return { white, black, last };
}

function whiteFor(
  a: ArenaParticipant,
  b: ArenaParticipant,
  games: readonly ArenaGame[],
): string {
  const ca = colorRecord(a.id, games);
  const cb = colorRecord(b.id, games);
  if (ca.white < cb.white) return a.id;
  if (ca.white > cb.white) return b.id;
  if (ca.last === 'white' && cb.last !== 'white') return b.id;
  if (cb.last === 'white' && ca.last !== 'white') return a.id;
  return a.id;
}

function withColours(
  a: ArenaParticipant,
  b: ArenaParticipant,
  games: readonly ArenaGame[],
): ArenaPairing {
  const whiteId = whiteFor(a, b, games);
  return {
    whiteId,
    blackId: whiteId === a.id ? b.id : a.id,
  };
}

/** Score used for Swiss/Arena grouping. Byes count as a win. */
function pointsFor(tournament: ArenaTournament, id: string): number {
  let points = 0;
  for (const g of tournament.games) {
    if (g.status !== 'done') continue;
    if (g.result === 'bye' && g.whiteId === id) {
      points += 1;
      continue;
    }
    if (g.result === '1-0' && g.whiteId === id) points += 1;
    else if (g.result === '0-1' && g.blackId === id) points += 1;
    else if (g.result === '1/2-1/2' && (g.whiteId === id || g.blackId === id)) points += 0.5;
  }
  return points;
}

function hadBye(tournament: ArenaTournament, id: string): boolean {
  return tournament.games.some((g) => g.result === 'bye' && g.whiteId === id);
}

function playedSet(tournament: ArenaTournament): Set<string> {
  const set = new Set<string>();
  for (const g of tournament.games) {
    if (g.blackId) set.add(pairKey(g.whiteId, g.blackId));
  }
  return set;
}

/**
 * Backtracking Swiss pairing. The sorted list is already in score groups; the
 * recursion only has to find a legal perfect matching. When no legal matching
 * exists (a tiny field can run out of fresh opponents) a rematch is allowed
 * rather than refusing to draw the round.
 */
function pairSwissPlayers(
  players: readonly ArenaParticipant[],
  played: ReadonlySet<string>,
  allowRepeats: boolean,
): ArenaParticipant[][] | null {
  if (players.length === 0) return [];
  const first = players[0];
  for (let i = 1; i < players.length; i++) {
    const second = players[i];
    if (!allowRepeats && played.has(pairKey(first.id, second.id))) continue;
    const rest = players.filter((_, idx) => idx !== 0 && idx !== i);
    const sub = pairSwissPlayers(rest, played, allowRepeats);
    if (sub) return [[first, second], ...sub];
  }
  if (!allowRepeats) return pairSwissPlayers(players, played, true);
  return null;
}

function orderedForSwiss(tournament: ArenaTournament): ArenaParticipant[] {
  return [...tournament.participants].sort((a, b) => {
    const pa = pointsFor(tournament, a.id);
    const pb = pointsFor(tournament, b.id);
    if (pa !== pb) return pb - pa;
    if (a.rating !== b.rating) return b.rating - a.rating;
    return a.seed - b.seed;
  });
}

/** Draw one Swiss round. `allowRepeats` is true for Arena. */
export function swissPairings(
  tournament: ArenaTournament,
  allowRepeats: boolean,
): ArenaPairing[] {
  const ordered = orderedForSwiss(tournament);
  let bye: ArenaParticipant | null = null;
  if (ordered.length % 2 === 1) {
    // The lowest-scoring player without a bye gets it; if everyone has had one,
    // the lowest-scoring player gets the second.
    const candidates = [...ordered].reverse();
    bye = candidates.find((p) => !hadBye(tournament, p.id)) ?? candidates[0];
  }
  const field = bye ? ordered.filter((p) => p.id !== bye?.id) : ordered;
  const pairs = pairSwissPlayers(field, playedSet(tournament), allowRepeats) ?? [];
  const doneGames = tournament.games.filter((g) => g.status === 'done');
  const result = pairs.map(([a, b]) => withColours(a, b, doneGames));
  if (bye) result.push({ whiteId: bye.id, blackId: null, byeId: bye.id });
  return result;
}

/**
 * Seeded knockout first round: 1 v last, 2 v second-last, and so on.
 * An odd field gives the bye to the top seed, not to the middle of the bracket.
 */
export function firstKnockoutRound(tournament: ArenaTournament): ArenaPairing[] {
  const sorted = [...tournament.participants].sort((a, b) => a.seed - b.seed);
  const result: ArenaPairing[] = [];
  const field = sorted.length % 2 === 1 ? sorted.slice(1) : sorted;
  if (sorted.length % 2 === 1 && sorted[0]) {
    result.push({ whiteId: sorted[0].id, blackId: null, byeId: sorted[0].id });
  }
  let lo = 0;
  let hi = field.length - 1;
  while (lo < hi) {
    result.push(withColours(field[lo], field[hi], []));
    lo += 1;
    hi -= 1;
  }
  return result;
}

export function roundComplete(tournament: ArenaTournament, round: number): boolean {
  const games = tournament.games.filter((g) => g.round === round);
  return games.length > 0 && games.every((g) => g.status === 'done');
}

export function allRoundsComplete(tournament: ArenaTournament): boolean {
  const maxRound = Math.max(0, ...tournament.games.map((g) => g.round));
  if (maxRound === 0) return false;
  for (let r = 1; r <= maxRound; r++) {
    if (!roundComplete(tournament, r)) return false;
  }
  return true;
}

/**
 * ONE KNOCKOUT MATCH, as opposed to one game.
 *
 * A knockout pairing can be a single game, two legs with both colours, or those
 * plus an Armageddon. The bracket cares about the MATCH winner, so the games are
 * grouped by the pair of players and scored together. This is the shape the
 * bracket, the completion check and the Armageddon rule all read.
 */
export interface KnockoutMatch {
  /** The participants in the match. One id for a bye. */
  playerIds: string[];
  /** The games of this match, board order. */
  games: ArenaGame[];
  byeId?: string;
}

/** The games of a knockout round, grouped into matches, in board order. */
export function knockoutMatches(tournament: ArenaTournament, round: number): KnockoutMatch[] {
  const games = tournament.games
    .filter((g) => g.round === round)
    .sort((a, b) => a.board - b.board);
  const byKey = new Map<string, KnockoutMatch>();
  for (const g of games) {
    const bye = g.blackId === null;
    const key = bye ? `bye:${g.whiteId}` : [g.whiteId, g.blackId].sort().join('|');
    const match = byKey.get(key) ?? {
      playerIds: bye ? [g.whiteId] : [g.whiteId, g.blackId as string],
      games: [],
      byeId: bye ? g.byeId ?? g.whiteId : undefined,
    };
    match.games.push(g);
    byKey.set(key, match);
  }
  return [...byKey.values()];
}

/** Points each player scored across the regulation (non-Armageddon) games. */
export function knockoutScores(match: KnockoutMatch): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const id of match.playerIds) scores[id] = 0;
  for (const g of match.games) {
    if (g.armageddon || !g.result || g.result === 'bye' || !g.blackId) continue;
    const white = g.result === '1-0' ? 1 : g.result === '0-1' ? 0 : 0.5;
    scores[g.whiteId] = (scores[g.whiteId] ?? 0) + white;
    scores[g.blackId] = (scores[g.blackId] ?? 0) + (1 - white);
  }
  return scores;
}

/** The Armageddon game of a match, when one has been scheduled. */
export function knockoutTiebreak(match: KnockoutMatch): ArenaGame | undefined {
  return match.games.find((g) => g.armageddon);
}

/**
 * The match winner, or null when the match is unfinished — INCLUDING when the
 * regulation legs are level and the Armageddon has not decided it yet.
 */
export function knockoutMatchWinner(match: KnockoutMatch): string | null {
  if (match.byeId) return match.byeId;
  const decider = knockoutTiebreak(match);
  if (decider) {
    return decider.status === 'done' ? decider.winnerId ?? null : null;
  }
  const regulation = match.games.filter((g) => !g.armageddon);
  if (regulation.length === 0 || regulation.some((g) => g.status !== 'done')) return null;
  const scores = knockoutScores(match);
  const [a, b] = match.playerIds;
  const sa = scores[a] ?? 0;
  const sb = scores[b] ?? 0;
  if (sa === sb) return null;
  return sa > sb ? a : b;
}

/**
 * True when every regulation leg is done and the match is level, so an
 * Armageddon has to be played.
 */
export function knockoutMatchNeedsTiebreak(match: KnockoutMatch): boolean {
  if (match.byeId || knockoutTiebreak(match)) return false;
  const regulation = match.games.filter((g) => !g.armageddon);
  if (regulation.length === 0 || regulation.some((g) => g.status !== 'done')) return false;
  const scores = knockoutScores(match);
  const [a, b] = match.playerIds;
  return (scores[a] ?? 0) === (scores[b] ?? 0);
}

/**
 * One advancing player per match in the round.
 *
 * The old version mapped every GAME to a winner, which is right for a single
 * game and wrong the moment a match has two legs — it produced two winners for
 * one pairing and the bracket doubled. It returns an entry only for a decided
 * match.
 */
export function knockoutWinnerIds(tournament: ArenaTournament, round: number): string[] {
  return knockoutMatches(tournament, round)
    .map((m) => knockoutMatchWinner(m))
    .filter((id): id is string => !!id);
}

export function knockoutNextPairings(tournament: ArenaTournament, round: number): ArenaPairing[] {
  const winners = knockoutWinnerIds(tournament, round)
    .map((id) => participantById(tournament, id))
    .filter((p): p is ArenaParticipant => !!p);
  if (winners.length <= 1) return [];
  const games = tournament.games.filter((g) => g.status === 'done');
  const result: ArenaPairing[] = [];
  for (let i = 0; i + 1 < winners.length; i += 2) {
    result.push(withColours(winners[i], winners[i + 1], games));
  }
  if (winners.length % 2 === 1) {
    const last = winners[winners.length - 1];
    result.push({ whiteId: last.id, blackId: null, byeId: last.id });
  }
  return result;
}

/** Pairings for a newly drawn round, or [] when the format has no next round. */
export function nextRoundPairings(tournament: ArenaTournament): ArenaPairing[] {
  if (tournament.format === 'knockout') {
    return knockoutNextPairings(tournament, tournament.currentRound);
  }
  if (tournament.format === 'swiss') return swissPairings(tournament, false);
  if (tournament.format === 'arena') return swissPairings(tournament, true);
  return [];
}

export function hasScheduledNextRound(tournament: ArenaTournament): boolean {
  return tournament.games.some((g) => g.round === tournament.currentRound + 1);
}

export function nextPendingGame(tournament: ArenaTournament): ArenaGame | null {
  const current = tournament.games
    .filter((g) => g.round === tournament.currentRound)
    .sort((a, b) => a.board - b.board);
  const pending = current.filter((g) => g.status !== 'done');
  /*
   * In a human tournament the human's game is the one they came to play. A
   * multi-bot field can put a bot-vs-bot game on board one, so "Play now" must
   * not open that game while the human's own pairing is still waiting. Once the
   * human game is done, the remaining bot games are still offered for watching.
   */
  if (tournament.mode === 'human') {
    const human = pending.find((g) => g.whiteId === 'you' || g.blackId === 'you');
    if (human) return human;
  }
  return pending[0] ?? null;
}

/** Points, Buchholz, Sonneborn-Berger and a transparent performance estimate. */
export function computeStandings(tournament: ArenaTournament): ArenaStanding[] {
  const rows = new Map<string, ArenaStanding>();
  for (const p of tournament.participants) {
    rows.set(p.id, {
      participant: p,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      byes: 0,
      points: 0,
      buchholz: 0,
      sonneborn: 0,
      blackGames: 0,
      performance: null,
      rank: 0,
    });
  }

  const ratedOpponents = new Map<string, number[]>();

  for (const g of tournament.games) {
    if (g.status !== 'done' || !g.result) continue;
    if (g.result === 'bye') {
      const row = rows.get(g.whiteId);
      if (row) {
        row.played += 1;
        row.byes += 1;
        row.points += 1;
      }
      continue;
    }
    const white = rows.get(g.whiteId);
    const black = g.blackId ? rows.get(g.blackId) : undefined;
    if (!white || !black) continue;
    white.played += 1;
    black.played += 1;
    black.blackGames += 1;
    if (g.result === '1-0') {
      white.wins += 1;
      black.losses += 1;
      white.points += 1;
    } else if (g.result === '0-1') {
      black.wins += 1;
      white.losses += 1;
      black.points += 1;
    } else {
      white.draws += 1;
      black.draws += 1;
      white.points += 0.5;
      black.points += 0.5;
    }
    /*
     * Performance is a statement about the field the player met, so use the
     * rating each opponent started the tournament with. `participant.rating`
     * is updated after every result; using it here would make a player's
     * performance change merely because an opponent's live rating moved.
     */
    const ratingOf = (p: ArenaParticipant) => p.startingRating ?? p.rating;
    const wr = ratedOpponents.get(white.participant.id) ?? [];
    wr.push(ratingOf(black.participant));
    ratedOpponents.set(white.participant.id, wr);
    const br = ratedOpponents.get(black.participant.id) ?? [];
    br.push(ratingOf(white.participant));
    ratedOpponents.set(black.participant.id, br);
  }

  for (const row of rows.values()) {
    const opponents = tournament.games.filter(
      (g) => g.status === 'done' && g.result !== 'bye' && g.blackId &&
        (g.whiteId === row.participant.id || g.blackId === row.participant.id),
    );
    for (const g of opponents) {
      const oppId = g.whiteId === row.participant.id ? g.blackId : g.whiteId;
      const opp = oppId ? rows.get(oppId) : undefined;
      if (!opp) continue;
      row.buchholz += opp.points;
      if (g.result === '1-0' && g.whiteId === row.participant.id) row.sonneborn += opp.points;
      else if (g.result === '0-1' && g.blackId === row.participant.id) row.sonneborn += opp.points;
      else if (g.result === '1/2-1/2') row.sonneborn += opp.points * 0.5;
    }
    const opponentsRatings = ratedOpponents.get(row.participant.id) ?? [];
    if (opponentsRatings.length > 0) {
      const avg = opponentsRatings.reduce((a, b) => a + b, 0) / opponentsRatings.length;
      // Performance excludes byes: a bye is a free point, not evidence against
      // the field, and counting it here would inflate a small sample.
      const score = opponents.reduce((sum, g) => {
        if (g.result === '1-0') return sum + (g.whiteId === row.participant.id ? 1 : 0);
        if (g.result === '0-1') return sum + (g.blackId === row.participant.id ? 1 : 0);
        if (g.result === '1/2-1/2') return sum + 0.5;
        return sum;
      }, 0);
      row.performance = Math.round(avg + 400 * (score / opponentsRatings.length - 0.5));
    }
  }

  /*
   * THE TIEBREAK LADDER — ONE WINNER, DECIDED BY PUBLISHED RULES.
   *
   * The report was *"we draw the match and the app says the bot won the
   * tournament! no tie break"*. The old sort put `participant.rating` after the
   * chess measures, so two players who drew their only game were separated by
   * a number that had nothing to do with the game — and there was no way to see
   * which rule had chosen. The ladder below is the one tournament tables use,
   * in order, and every step is a number the standings sheet shows or can
   * explain:
   *
   *   1. points
   *   2. direct encounter (score between the tied players themselves)
   *   3. Buchholz (sum of opponents' scores)
   *   4. Sonneborn-Berger
   *   5. more wins
   *   6. more games with Black
   *   7. seed (a disclosed last resort, never a rating)
   *
   * Groups are ranked inside the ladder, so a two-player group is decided by
   * their head-to-head, and a larger tie is decided by the encounter among the
   * tied players — both real rules, not a hidden preference.
   */
  const byPoints = [...rows.values()].sort((a, b) => b.points - a.points);
  const ranked: ArenaStanding[] = [];
  for (let start = 0; start < byPoints.length;) {
    let end = start;
    while (end < byPoints.length && byPoints[end].points === byPoints[start].points) end += 1;
    const group = byPoints.slice(start, end);
    if (group.length > 1) {
      const ids = new Set(group.map((r) => r.participant.id));
      const direct = new Map<string, number>(group.map((r) => [r.participant.id, 0]));
      for (const g of tournament.games) {
        if (g.status !== 'done' || !g.result || g.result === 'bye' || !g.blackId) continue;
        if (!ids.has(g.whiteId) || !ids.has(g.blackId)) continue;
        const whiteScore = g.result === '1-0' ? 1 : g.result === '0-1' ? 0 : 0.5;
        direct.set(g.whiteId, (direct.get(g.whiteId) ?? 0) + whiteScore);
        direct.set(g.blackId, (direct.get(g.blackId) ?? 0) + (1 - whiteScore));
      }
      group.sort((a, b) =>
        direct.get(b.participant.id)! - direct.get(a.participant.id)!
        || b.buchholz - a.buchholz
        || b.sonneborn - a.sonneborn
        || b.wins - a.wins
        || b.blackGames - a.blackGames
        || a.participant.seed - b.participant.seed);
    }
    ranked.push(...group);
    start = end;
  }
  ranked.forEach((row, i) => {
    row.rank = i + 1;
  });
  return ranked;
}

/**
 * Which rule separated the champion from the runner-up, or null when the
 * champion is ahead on points.
 *
 * Shown on the final sheet so the answer to "why did he win?" is on the screen
 * rather than in the code.
 */
export function championTiebreakNote(tournament: ArenaTournament): string | null {
  /*
   * A knockout champion is decided by the bracket, not by the standings ladder,
   * and the final's own reason already says whether an Armageddon was needed.
   * Appending "won on the tiebreak (knockout bracket)" to every knockout title
   * implied a tie that did not happen.
   */
  if (tournament.format === 'knockout') return null;
  const standings = computeStandings(tournament);
  if (standings.length < 2) return null;
  const [a, b] = standings;
  if (a.points !== b.points) return null;

  const group = standings.filter((s) => s.points === a.points).map((s) => s.participant.id);
  const ids = new Set(group);
  let direct = 0;
  for (const g of tournament.games) {
    if (g.status !== 'done' || !g.result || g.result === 'bye' || !g.blackId) continue;
    if (!ids.has(g.whiteId) || !ids.has(g.blackId)) continue;
    const whiteScore = g.result === '1-0' ? 1 : g.result === '0-1' ? 0 : 0.5;
    if (g.whiteId === a.participant.id) direct += whiteScore;
    else if (g.blackId === a.participant.id) direct += 1 - whiteScore;
    if (g.whiteId === b.participant.id) direct -= whiteScore;
    else if (g.blackId === b.participant.id) direct -= 1 - whiteScore;
  }
  if (direct !== 0) return 'head-to-head';
  if (a.buchholz !== b.buchholz) return 'Buchholz';
  if (a.sonneborn !== b.sonneborn) return 'Sonneborn-Berger';
  if (a.wins !== b.wins) return 'more wins';
  if (a.blackGames !== b.blackGames) return 'more games with Black';
  return 'seed';
}

export function championOf(tournament: ArenaTournament): ArenaStanding | null {
  const standings = computeStandings(tournament);
  /*
   * A knockout champion is the last player standing, not necessarily the player
   * with the most points. A final won on the tiebreak after a draw can leave the
   * runner-up ahead on score, so use the bracket winner explicitly.
   */
  if (tournament.format === 'knockout') {
    if (tournament.championId) {
      const champion = standings.find((s) => s.participant.id === tournament.championId);
      if (champion) return champion;
    }
    const maxRound = Math.max(0, ...tournament.games.map((g) => g.round));
    const winners = maxRound > 0 ? knockoutWinnerIds(tournament, maxRound) : [];
    if (winners.length === 1) {
      return standings.find((s) => s.participant.id === winners[0]) ?? standings[0] ?? null;
    }
  }
  // The ladder above always produces a single first place: every tournament has
  // one winner, as the owner required.
  return standings[0] ?? null;
}
