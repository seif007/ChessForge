/**
 * Personality presets — a layer on top of the existing bot formula.
 *
 * The imported-game bot is unchanged: its book and tendency rates still come
 * from `profile.ts`, and `mimic.ts` still combines engine quality, human
 * plausibility and the player's personality. What this file adds is a small,
 * inspectable set of weights for the personality term, plus factory functions
 * that turn one preset into a complete `BotProfile`.
 *
 * Two consequences worth stating because they are the reason the module exists:
 *
 *   - A preset bot has no fake imported history. Its sample count is zero and
 *     the card says "preset" rather than pretending the style was measured from
 *     games. Its book is a CURATED REPERTOIRE (`repertoire.ts`), and every move
 *     played from it is explained as repertoire rather than as a game the user
 *     imported.
 *   - Strength is separate. `playElo` caps Stockfish; the weights decide which
 *     reasonable move the bot likes. An aggressive 1200 and an aggressive 2200
 *     have the same character and different accuracy.
 */

import { presetBook } from './repertoire';
import type {
  BotPersonality,
  BotProfile,
  BotStyle,
  MoveTypeStats,
  PersonalityId,
  PersonalityWeights,
  PhaseRates,
} from './types';

export interface PersonalityPreset {
  id: Exclude<PersonalityId, 'custom'>;
  name: string;
  short: string;
  tagline: string;
  description: string;
  weights: PersonalityWeights;
  style: BotStyle;
}

/** The five presets. The illustrative weights from the design note, normalised. */
export const PERSONALITY_PRESETS: readonly PersonalityPreset[] = [
  {
    id: 'aggressive',
    name: 'Aggressive Attacker',
    short: 'Attacker',
    tagline: 'Initiative first',
    description: 'Checks, king pressure, sacrifices for the attack and complicated positions.',
    weights: { attack: 0.85, position: 0.3, defence: 0.25, gambit: 0.8, endgame: 0.2, risk: 0.75 },
    style: { aggression: 90, kingSafety: 36, pieceActivity: 82, endgame: 30, castlePly: 18, avgGameLength: 64 },
  },
  {
    id: 'positional',
    name: 'Positional Player',
    short: 'Strategist',
    tagline: 'Long-term pressure',
    description: 'Strong squares, pawn structure, piece activity and restricting counterplay.',
    weights: { attack: 0.3, position: 0.9, defence: 0.65, gambit: 0.2, endgame: 0.65, risk: 0.35 },
    style: { aggression: 44, kingSafety: 72, pieceActivity: 84, endgame: 68, castlePly: 22, avgGameLength: 82 },
  },
  {
    id: 'defensive',
    name: 'Defensive Player',
    short: 'The Wall',
    tagline: 'Safety and solidity',
    description: 'King safety, defensive resources, solid pawns and simplification when useful.',
    weights: { attack: 0.2, position: 0.65, defence: 0.95, gambit: 0.1, endgame: 0.7, risk: 0.2 },
    style: { aggression: 28, kingSafety: 90, pieceActivity: 48, endgame: 72, castlePly: 16, avgGameLength: 92 },
  },
  {
    id: 'gambit',
    name: 'Gambit Enthusiast',
    short: 'Gambit',
    tagline: 'Material for time',
    description: 'Gambit openings, rapid development, open lines and unbalanced positions.',
    weights: { attack: 0.8, position: 0.25, defence: 0.2, gambit: 0.95, endgame: 0.15, risk: 0.9 },
    style: { aggression: 86, kingSafety: 40, pieceActivity: 80, endgame: 28, castlePly: 30, avgGameLength: 58 },
  },
  {
    id: 'endgame',
    name: 'Endgame Specialist',
    short: 'Endgame',
    tagline: 'Technical and patient',
    description: 'Favourable exchanges, an active king and accurate rook-and-minor endgames.',
    weights: { attack: 0.25, position: 0.75, defence: 0.75, gambit: 0.15, endgame: 0.95, risk: 0.25 },
    style: { aggression: 36, kingSafety: 76, pieceActivity: 70, endgame: 96, castlePly: 20, avgGameLength: 104 },
  },
] as const;

/** Strength choices offered when a preset bot is created or edited. */
export const PRESET_STRENGTHS = [1400, 1800, 2200, 2600] as const;

const PRESET_BY_ID = new Map(PERSONALITY_PRESETS.map((p) => [p.id, p]));

export function presetById(id: PersonalityId): PersonalityPreset | null {
  return id === 'custom' ? null : PRESET_BY_ID.get(id) ?? null;
}

export function personalityLabel(id: PersonalityId): string {
  return presetById(id)?.name ?? 'Custom Player';
}

export function personalityTagline(id: PersonalityId): string {
  return presetById(id)?.tagline ?? 'Your imported fingerprint';
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Keep every dial in [0,1] and make the five style dials sum to one. */
export function normalizePersonality(weights: PersonalityWeights): PersonalityWeights {
  const attack = clamp01(weights.attack);
  const position = clamp01(weights.position);
  const defence = clamp01(weights.defence);
  const gambit = clamp01(weights.gambit);
  const endgame = clamp01(weights.endgame);
  const sum = attack + position + defence + gambit + endgame;
  const risk = clamp01(weights.risk);
  if (sum <= 0.0001) {
    return { attack: 0.2, position: 0.2, defence: 0.2, gambit: 0.2, endgame: 0.2, risk };
  }
  return {
    attack: attack / sum,
    position: position / sum,
    defence: defence / sum,
    gambit: gambit / sum,
    endgame: endgame / sum,
    risk,
  };
}

/**
 * A custom bot's starting personality is read from what its games measured.
 * It is a starting point, not a claim: the user can move every dial afterwards.
 */
export function customPersonalityFromStyle(style: BotStyle): PersonalityWeights {
  const aggression = style.aggression / 100;
  const activity = style.pieceActivity / 100;
  const safety = style.kingSafety / 100;
  const endgame = style.endgame / 100;
  return normalizePersonality({
    attack: 0.25 + aggression * 0.6,
    position: 0.25 + activity * 0.55 + (1 - aggression) * 0.15,
    defence: 0.2 + safety * 0.7,
    gambit: 0.15 + Math.max(0, aggression - 0.45) * 0.9,
    endgame: 0.2 + endgame * 0.75,
    risk: 0.2 + aggression * 0.65,
  });
}

export function personalityFor(
  id: PersonalityId,
  style?: BotStyle,
  overrides?: Partial<PersonalityWeights>,
): BotPersonality {
  const preset = presetById(id);
  const base = preset
    ? preset.weights
    : customPersonalityFromStyle(
        style ?? { aggression: 50, kingSafety: 50, pieceActivity: 50, endgame: 50, castlePly: null, avgGameLength: 0 },
      );
  const weights = normalizePersonality({ ...base, ...overrides });
  return {
    preset: id,
    weights,
    // A gambit or attacker may stray a little further; a defensive bot should
    // not abandon a winning position to look solid.
    safetyCp: id === 'gambit' || id === 'aggressive' ? 220 : id === 'defensive' ? 160 : 190,
  };
}

function emptyStats(): MoveTypeStats {
  return {
    total: 0,
    capture: 0,
    check: 0,
    castle: 0,
    centralPawn: 0,
    develop: 0,
    sac: 0,
    byPiece: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
  };
}

function emptyRates(): PhaseRates {
  return { opening: emptyStats(), middle: emptyStats(), end: emptyStats() };
}

/**
 * Build the complete profile the play screen and tournament manager consume.
 * `id` is supplied by the caller so the store stays the only thing that mints
 * ids; `rating` is both the displayed estimate and the default Stockfish cap.
 */
export function createPresetProfile(opts: {
  id: string;
  preset: Exclude<PersonalityId, 'custom'>;
  name?: string;
  rating?: number;
  createdAt?: number;
}): BotProfile {
  const preset = presetById(opts.preset);
  if (!preset) throw new Error(`Unknown personality preset: ${opts.preset}`);
  const rating = opts.rating ?? 1600;
  const now = opts.createdAt ?? Date.now();
  const name = (opts.name ?? preset.name).trim() || preset.name;
  return {
    id: opts.id,
    name,
    source: 'preset',
    meta: { name, key: opts.id, source: 'preset' },
    recipe: { kind: 'preset', query: opts.preset, games: 0 },
    gamesAnalyzed: 0,
    rating,
    ratingLabel: 'ChessForge preset',
    wins: 0,
    draws: 0,
    losses: 0,
    openings: [],
    style: { ...preset.style },
    book: presetBook(opts.preset),
    typeRates: emptyRates(),
    firstMoves: [],
    repliesToE4: [],
    repliesToD4: [],
    timeControlMix: [],
    dateRange: {},
    fetchedAt: new Date(now).toISOString(),
    createdAt: now,
    personality: personalityFor(preset.id, preset.style),
    playElo: rating,
  };
}

/** Apply a preset (or custom weights) to an existing imported profile. */
export function withPersonality(
  profile: BotProfile,
  id: PersonalityId,
  overrides?: Partial<PersonalityWeights>,
): BotProfile {
  return {
    ...profile,
    personality: personalityFor(id, profile.style, overrides),
  };
}

/** The sentence under a bot's name. It never claims measured evidence. */
export function personalitySummary(profile: BotProfile): string {
  const p = profile.personality;
  if (!p) return 'Imported fingerprint, with the original book and tendency model.';
  if (p.preset === 'custom') {
    return profile.source === 'preset'
      ? 'Custom blend on top of the preset character.'
      : 'Custom blend on top of the imported fingerprint.';
  }
  return presetById(p.preset)?.description ?? 'Personality blend.';
}
