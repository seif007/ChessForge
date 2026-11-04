/**
 * Bots — the shapes shared by everything a bot is made of.
 *
 * A bot is built from a player's real games and then plays as that player: the
 * fetchers (sources.ts / otb.ts) hand back `RawBotGame`s, `profile.ts` boils
 * them down to a `BotProfile`, `mimic.ts` turns the profile plus a MultiPV
 * engine search into one move, and `store.ts` persists the profiles under a
 * list the Bots screen shows.
 *
 * The three parts of a bot that make its moves recognisable:
 *   book      — this exact position → the moves the player actually chose there
 *   typeRates — how often they capture / check / castle / develop, per phase
 *   style     — the four dials the profile card shows, for humans to read
 */

/** Where a bot's games came from. */
export type BotSource = 'lichess' | 'otb' | 'coach' | 'preset';

/** A single game, normalised across sources. `pgn` is always a full game. */
export interface RawBotGame {
  pgn: string;
  white: string;
  black: string;
  whiteRating?: number;
  blackRating?: number;
  /** The source's class for the game ("blitz"…), or undefined for OTB. */
  timeControl?: string;
  /** ISO-ish `YYYY.MM.DD` or `YYYY-MM-DD`. */
  date?: string;
  eco?: string;
  source: BotSource;
  /** Non-standard start (problem positions, odds games). Skips the game. */
  initialFen?: string;
}

/** Who the bot is and where the games were found. */
export interface BotMeta {
  /** Display name. */
  name: string;
  /** The string used to find this player inside game headers. */
  key: string;
  source: BotSource;
  title?: string;
  avatar?: string;
  country?: string;
  fideId?: string;
  /** Online time-class filter the games were fetched with. */
  timeClass?: string;
  ratings?: { bullet?: number; blitz?: number; rapid?: number; daily?: number; fide?: number };
}

/** One opening as this player met it, with their record in it. */
export interface OpeningStat {
  name: string;
  eco?: string;
  asColor: 'white' | 'black' | 'both';
  count: number;
  wins: number;
  draws: number;
  losses: number;
}

/** Rates of move-type features, as fractions of the player's own moves. */
export interface MoveTypeStats {
  total: number;
  capture: number;
  check: number;
  castle: number;
  centralPawn: number;
  develop: number;
  /** rate of genuine material offers (see `lib/sacrifice`), per own move */
  sac: number;
  byPiece: Record<'p' | 'n' | 'b' | 'r' | 'q' | 'k', number>;
}

export interface PhaseRates {
  opening: MoveTypeStats;
  middle: MoveTypeStats;
  end: MoveTypeStats;
}

/** Position → move → count, opening phase only (the player's actual choices). */
export type BookMemory = Record<string, Record<string, number>>;

/** The four dials the profile card draws, 0-100. */
export interface BotStyle {
  aggression: number;
  kingSafety: number;
  pieceActivity: number;
  endgame: number;
  /** average ply of first castling; null when they never castled in the set */
  castlePly: number | null;
  avgGameLength: number;
}

/** The recipe a bot was built from, so the profile can say what it is. */
export interface BotRecipe {
  kind: BotSource;
  /** what the user typed */
  query: string;
  /** games asked for */
  games: number;
  /** Online time-class filter, when that is the source */
  timeClass?: string;
}

/**
 * The five style dials that sit ON TOP of the existing player fingerprint.
 *
 * They are deliberately not a second move engine: `mimic.ts` already has one
 * formula, and these numbers only change the weight of the personality term
 * inside it. A preset bot starts with no imported book; a custom bot keeps its
 * book and historical rates and uses these dials to colour them.
 */
export type PersonalityId =
  | 'aggressive'
  | 'positional'
  | 'defensive'
  | 'gambit'
  | 'endgame'
  | 'custom';

export interface PersonalityWeights {
  /** attacking potential: checks, king pressure, initiative */
  attack: number;
  /** structure, outposts, piece activity */
  position: number;
  /** king safety, solidity, simplification */
  defence: number;
  /** sacrifices, development, open lines */
  gambit: number;
  /** trading into and playing technical endgames */
  endgame: number;
  /** how far the bot will stray from the engine's top move for style */
  risk: number;
}

export interface BotPersonality {
  preset: PersonalityId;
  weights: PersonalityWeights;
  /**
   * Centipawns below the engine's best move before the style term is damped.
   * Style chooses among reasonable moves; it never throws a winning position.
   */
  safetyCp: number;
}

export interface BotProfile {
  /** Stable id, also the storage key suffix. */
  id: string;
  /** Display name (may differ from meta.name for a hand-named bot). */
  name: string;
  source: BotSource;
  meta: BotMeta;
  recipe: BotRecipe;
  gamesAnalyzed: number;
  rating: number;
  /** e.g. "Lichess blitz" or "FIDE standard". */
  ratingLabel: string;
  wins: number;
  draws: number;
  losses: number;
  openings: OpeningStat[];
  style: BotStyle;
  book: BookMemory;
  typeRates: PhaseRates;
  /** Most frequent first moves as White. */
  firstMoves: { san: string; count: number }[];
  /** Most frequent replies to 1.e4 / 1.d4 as Black. */
  repliesToE4: { san: string; count: number }[];
  repliesToD4: { san: string; count: number }[];
  timeControlMix: { label: string; count: number }[];
  dateRange: { from?: string; to?: string };
  fetchedAt: string;
  createdAt: number;
  /**
   * The personality layer. Missing on old profiles and on imported bots that
   * have never been edited; the mimic then uses the original book/tendency
   * formula exactly as before.
   */
  personality?: BotPersonality;
  /**
   * Optional Stockfish UCI_Elo cap. Preset bots use this so "aggressive at
   * 1200" and "aggressive at 2200" differ in strength, not in character.
   */
  playElo?: number;
}

/** What the Bots list renders without loading every profile off the disk. */
export interface BotSummary {
  id: string;
  name: string;
  /** The source account handle, used for neutral Lichess bot labels. */
  key?: string;
  source: BotSource;
  rating: number;
  ratingLabel: string;
  gamesAnalyzed: number;
  createdAt: number;
  style: BotStyle;
  title?: string;
  country?: string;
  avatar?: string;
  /** The preset badge shown on the list card, when the bot has one. */
  personalityPreset?: PersonalityId;
}

/** Progress of a bot build, in the shape every screen already shows. */
export interface BotBuildProgress {
  stage: 'fetch' | 'analyze' | 'done';
  label: string;
  detail?: string;
  done: number;
  total: number;
  pct: number;
}

// ─── Engine / mimic ──────────────────────────────────────────────────────────

/** One MultiPV line, in this app's engine's own field names. */
export interface EvalLine {
  multipv: number;
  /** centipawns from the perspective of the side to move */
  scoreCp: number | null;
  /** mate in N moves (positive: the side to move delivers mate) */
  mate: number | null;
  /** principal variation as UCI moves */
  pv: string[];
  depth: number;
}

export interface MimicWeights {
  /** engine quality */
  alpha: number;
  /** human plausibility (player-agnostic) */
  beta: number;
  /** this player's personality */
  gamma: number;
}

/** One chosen move, with the sentence the play screen shows as "why". */
export interface MoveDecision {
  uci: string;
  san: string;
  reason: string;
  /** the three signals and the combined score, for the advanced view */
  scores: { e: number; h: number; p: number; s: number };
  engineRank: number;
}
