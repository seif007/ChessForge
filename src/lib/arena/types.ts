/**
 * ChessForge Arena — local tournament data.
 *
 * Everything here is deliberately local and self-contained. A tournament stores
 * a SNAPSHOT of every bot that entered it (profile, weights, engine cap), so a
 * later edit to a bot cannot silently change a tournament already in progress.
 * Ratings are ChessForge ratings; the Lichess account never appears in this
 * model.
 */

import type { BotProfile } from '@/lib/bots/types';

export type ArenaFormat =
  | 'round-robin'
  | 'double-round-robin'
  | 'knockout'
  | 'swiss'
  | 'arena';

export type ArenaMode = 'human' | 'bots';

export type ArenaTimeCategory = 'bullet' | 'blitz' | 'rapid' | 'classical';

export interface ArenaTimeControl {
  id: string;
  label: string;
  category: ArenaTimeCategory;
  initialSeconds: number;
  incrementSeconds: number;
  /** Untimed games are always unrated and have no clocks. */
  untimed?: boolean;
}

export type ArenaResult = '1-0' | '0-1' | '1/2-1/2' | 'bye';

export type ColorPreference = 'white' | 'black' | 'random';

export interface ArenaParticipant {
  /** `you` for the human, otherwise the bot's id. */
  id: string;
  kind: 'human' | 'bot';
  name: string;
  /** Current ChessForge rating in this tournament's category. */
  rating: number;
  startingRating: number;
  seed: number;
  /** Frozen at creation. The tournament never re-reads the bot library. */
  bot?: BotProfile;
}

export interface ArenaMove {
  san: string;
  from: string;
  to: string;
  color: 'white' | 'black';
  /** Present on a promotion; replay must not silently turn it into a queen. */
  promotion?: string;
}

export interface ArenaClockSnapshot {
  white: number;
  black: number;
}

export interface ArenaClockPoint extends ArenaClockSnapshot {
  ply: number;
}

export interface ArenaRatingChange {
  participantId: string;
  name: string;
  before: number;
  after: number;
  delta: number;
}

export interface ArenaGame {
  id: string;
  round: number;
  board: number;
  whiteId: string;
  /** null on a bye. */
  blackId: string | null;
  byeId?: string;
  status: 'pending' | 'playing' | 'done';
  result?: ArenaResult;
  winnerId?: string | null;
  reason?: string;
  moves: ArenaMove[];
  pgn?: string;
  clocks?: ArenaClockSnapshot;
  clockHistory?: ArenaClockPoint[];
  /** 1 or 2 for a knockout match leg; absent outside a knockout. */
  leg?: number;
  /** True for the tie-break game a level knockout match is decided by. */
  armageddon?: boolean;
  /**
   * Per-game starting clocks, when this game does not use the tournament's
   * control for both sides. An Armageddon gives White more time than Black.
   */
  clockStart?: ArenaClockSnapshot;
  startedAt?: number;
  finishedAt?: number;
  ratingChanges?: ArenaRatingChange[];
}

export type ArenaContinuation = 'immediate' | 'later';

export interface ArenaTournament {
  id: string;
  name: string;
  mode: ArenaMode;
  format: ArenaFormat;
  timeControl: ArenaTimeControl;
  rated: boolean;
  /** Requested rounds for Swiss/Arena; derived for the other formats. */
  rounds: number;
  colourPreference: ColorPreference;
  continuation: ArenaContinuation;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  participants: ArenaParticipant[];
  games: ArenaGame[];
  /** 1-based; 0 while a Swiss/Arena next round has not been drawn yet. */
  currentRound: number;
  /**
   * Draft = created with "Save for later". The settings and bot snapshots are
   * stored, but no pairings exist until the user starts it. Drafts may be edited
   * before the first game; active tournaments are frozen.
   */
  status: 'draft' | 'active' | 'completed';
  /**
   * Knockout match length: 1 game, or 2 games with both colours.
   * A level match is decided by an Armageddon game (Black advances on a draw).
   */
  knockoutLegs?: 1 | 2;
  championId?: string;
}

export interface ArenaRatings {
  bullet: number;
  blitz: number;
  rapid: number;
  classical: number;
}

export interface ArenaRatingHistory {
  id: string;
  at: number;
  category: ArenaTimeCategory;
  participantId: string;
  name: string;
  before: number;
  after: number;
  delta: number;
  tournamentId: string;
  gameId: string;
}

export interface ArenaData {
  v: 1;
  tournaments: ArenaTournament[];
  humanRatings: ArenaRatings;
  /** Bot ratings are independent of the bot's estimated source rating. */
  botRatings: Record<string, ArenaRatings>;
  history: ArenaRatingHistory[];
}

export interface ArenaSettings {
  name: string;
  mode: ArenaMode;
  format: ArenaFormat;
  timeControl: ArenaTimeControl;
  rated: boolean;
  rounds: number;
  colourPreference: ColorPreference;
  continuation: ArenaContinuation;
  botIds: string[];
  /** The human's colour preference in human mode. */
  humanColor: ColorPreference;
  /** Knockout only: 1 game, or 2 games with both colours. */
  knockoutLegs?: 1 | 2;
}

export interface ArenaStanding {
  participant: ArenaParticipant;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  byes: number;
  points: number;
  buchholz: number;
  sonneborn: number;
  /**
   * Games played with the black pieces, one of the published tie-breaks.
   *
   * A drawn single game between two players is identical on points, direct
   * encounter, Buchholz, Sonneborn-Berger and wins — the player who had Black is
   * the only honest discriminator, and it is a real rule rather than a hidden
   * rating comparison.
   */
  blackGames: number;
  performance: number | null;
  rank: number;
}

export interface ArenaPairing {
  whiteId: string;
  blackId: string | null;
  byeId?: string;
}
