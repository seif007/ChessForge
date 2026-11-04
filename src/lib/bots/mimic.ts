/**
 * Move selection: S(m) = α·E(m) + β·H(m) + γ·P(m)
 *
 *   E(m) — engine quality: MultiPV scores normalized against the best line
 *   H(m) — human plausibility: would a human consider this move at all?
 *          (engine rank + how natural the move type is, player-agnostic)
 *   P(m) — player personality: this specific player's fingerprints
 *          (their book in this exact position + feature preferences vs. a
 *           generic-human baseline)
 *
 * The three sliders decide the character of the opponent:
 *   α→1, β→γ→0   a chess engine wearing the player's name: strongest move
 *   γ dominance  the player's own habits win even when the engine disagrees
 *   the middle   "strong, but recognisably this player"
 *
 * Everything here is a pure function of (lines, position, profile, weights):
 * given the same engine lines it returns the same move, so an opponent can be
 * reproduced move for move. The one exception is deliberate — the small score
 * noise applied to lower-rated players, which makes a 1200 bot blunder at a
 * human rate instead of always finding the engine's best.
 */

import { Chess } from 'chess.js';
import { sacrificeValue } from '@/lib/sacrifice';
import type {
  BotProfile,
  EvalLine,
  MimicWeights,
  MoveDecision,
  PersonalityId,
  PersonalityWeights,
} from './types';

// ─── generic human baselines ──────────────────────────────────────────────────

const BASE = {
  opening: { capture: 0.2, check: 0.025, sac: 0.003, centralPawn: 0.24, develop: 0.55, byPiece: { p: 0.34, n: 0.2, b: 0.18, r: 0.06, q: 0.08, k: 0.14 } },
  middle: { capture: 0.33, check: 0.07, sac: 0.005, centralPawn: 0.14, develop: 0.08, byPiece: { p: 0.36, n: 0.14, b: 0.12, r: 0.16, q: 0.13, k: 0.09 } },
  end: { capture: 0.3, check: 0.06, sac: 0.004, centralPawn: 0.1, develop: 0.04, byPiece: { p: 0.34, n: 0.13, b: 0.11, r: 0.24, q: 0.06, k: 0.12 } },
};

/** How plausible each engine rank is to a human, falling off fast. */
const RANK_SCORE = [1.0, 0.76, 0.62, 0.52, 0.46];

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function phaseOfPly(ply: number): 'opening' | 'middle' | 'end' {
  if (ply <= 12) return 'opening';
  if (ply <= 60) return 'middle';
  return 'end';
}

function posKey(fen: string): string {
  const parts = fen.split(' ');
  return parts.slice(0, 4).join(' ');
}

/** A move object chess.js returned — what `uciToSan` hands back on a legal UCI. */
type LegalMove = NonNullable<ReturnType<Chess['move']>>;

/** Convert "e7e8q" to SAN by playing it on a clone of the position. */
function uciToSan(fen: string, uci: string): { san: string; move: ReturnType<Chess['move']> | null } {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : undefined;
  try {
    const clone = new Chess(fen);
    const mv = clone.move({ from, to, promotion });
    return { san: mv.san, move: mv };
  } catch {
    return { san: uci, move: null };
  }
}

/**
 * Find the legal move a book SAN names, so the book can nominate moves the
 * engine's MultiPV window never listed. Returns null for a SAN that is not
 * legal here (a corrupted profile): the caller drops that candidate rather
 * than guessing.
 */
function sanToMove(fen: string, san: string): LegalMove | null {
  try {
    const clone = new Chess(fen);
    return clone.moves({ verbose: true }).find((m) => m.san === san) ?? null;
  } catch {
    return null;
  }
}

interface Feats {
  capture: boolean;
  check: boolean;
  castle: boolean;
  centralPawn: boolean;
  develop: boolean;
  sac: boolean;
  /** how many pawns the move offers, 0 when it offers nothing */
  sacPawns: number;
  piece: string;
  earlyQueen: boolean;
}

function featsOf(
  fen: string,
  uci: string,
  san: string,
  piece: string,
  captured: string | undefined,
  flags: string,
  to: string,
  from: string,
  ply: number,
): Feats {
  const isCheck = san.includes('+') || san.includes('#');
  /*
   * A sacrifice is an OFFER after the move, not an unfavourable capture.
   * The old test (`piece value - captured value > 150`) called Qxd8 Rxd8 a
   * sacrifice and missed 2.f4 entirely — precisely backwards for a gambit
   * personality. `sacrificeValue` sees pawn offers, recaptures and material
   * the move itself won. The SIZE is kept as well as the flag: a one-pawn
   * gambit is a normal human opening move, while hanging a piece is not, and
   * the plausibility term has to be able to tell them apart.
   */
  const sacPawns = sacrificeValue(fen, uci);
  return {
    capture: !!captured,
    check: isCheck,
    castle: flags.includes('k') || flags.includes('q'),
    centralPawn: piece === 'p' && ['e4', 'd4', 'e5', 'd5', 'c4', 'c5'].includes(to),
    develop: (piece === 'n' || piece === 'b') && (from[1] === '1' || from[1] === '8'),
    sac: sacPawns >= 1,
    sacPawns,
    piece,
    earlyQueen: piece === 'q' && ply <= 10 && from[1] !== '8' && from[1] !== '1',
  };
}

/**
 * The raw style signals a move expresses. They are deliberately coarse and
 * bounded: a check is 1, a quiet developing move is 1 on the positional dial,
 * and every number is already in [0,1] before the personality weights touch it.
 * That is what stops a feature with a large raw value from dominating.
 */
export interface PersonalityFeatures {
  attack: number;
  position: number;
  defence: number;
  gambit: number;
  endgame: number;
}

function kingSquareOf(fen: string, color: 'w' | 'b'): string | null {
  const rows = fen.split(' ')[0]?.split('/') ?? [];
  if (rows.length !== 8) return null;
  const target = color === 'w' ? 'K' : 'k';
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') {
        file += ch.charCodeAt(0) - 48;
        continue;
      }
      if (ch === target) return `${String.fromCharCode(97 + file)}${8 - r}`;
      file += 1;
    }
  }
  return null;
}

function squareDistance(a: string, b: string): number {
  const df = Math.abs(a.charCodeAt(0) - b.charCodeAt(0));
  const dr = Math.abs(Number(a[1]) - Number(b[1]));
  return Math.max(df, dr);
}

/** Extract the five dials from a legal move. Exported for the personality gate. */
export function personalityFeatures(
  fen: string,
  move: LegalMove,
  feats: Pick<Feats, 'capture' | 'check' | 'castle' | 'centralPawn' | 'develop' | 'sac'>,
  phase: 'opening' | 'middle' | 'end',
): PersonalityFeatures {
  const enemy: 'w' | 'b' = move.color === 'w' ? 'b' : 'w';
  const enemyKing = kingSquareOf(fen, enemy);
  const kingPressure = enemyKing ? clamp01(1 - squareDistance(move.to, enemyKing) / 7) : 0;
  const rank = Number(move.to[1] ?? '0');
  const ownHalf = move.color === 'w' ? rank <= 4 : rank >= 5;
  const openLine = feats.capture || feats.check || (move.piece === 'p' && ['c', 'd', 'e', 'f'].includes(move.to[0]));
  const quiet = !feats.capture && !feats.check && !feats.sac;

  const attack = clamp01(
    0.38 * (feats.check ? 1 : 0) +
    0.2 * (feats.sac ? 1 : 0) +
    0.16 * (feats.capture ? 1 : 0) +
    0.16 * kingPressure +
    0.1 * (move.piece === 'p' && kingPressure > 0.55 ? 1 : 0),
  );
  const position = clamp01(
    0.3 * (feats.centralPawn ? 1 : 0) +
    0.25 * (feats.develop ? 1 : 0) +
    0.2 * (feats.castle ? 1 : 0) +
    0.25 * (quiet ? 1 : 0),
  );
  const defence = clamp01(
    0.45 * (feats.castle ? 1 : 0) +
    0.25 * (!feats.sac ? 1 : 0) +
    0.15 * (ownHalf ? 1 : 0) +
    0.15 * (feats.capture ? 1 : 0),
  );
  const gambit = clamp01(
    0.45 * (feats.sac ? 1 : 0) +
    0.2 * (feats.develop ? 1 : 0) +
    0.2 * (feats.centralPawn ? 1 : 0) +
    0.15 * (openLine ? 1 : 0),
  );
  const endgame = phase === 'end'
    ? clamp01(0.4 * (feats.capture ? 1 : 0) + 0.3 * (move.piece === 'k' ? 1 : 0) + 0.3 * (move.piece === 'p' ? 1 : 0))
    : 0.08;

  return { attack, position, defence, gambit, endgame };
}

/** Weighted personality compatibility, normalized so the dials cannot inflate it. */
export function personalityFit(features: PersonalityFeatures, weights: PersonalityWeights): number {
  const sum =
    weights.attack + weights.position + weights.defence + weights.gambit + weights.endgame;
  if (sum <= 0.0001) return 0.5;
  return clamp01(
    (weights.attack * features.attack +
      weights.position * features.position +
      weights.defence * features.defence +
      weights.gambit * features.gambit +
      weights.endgame * features.endgame) / sum,
  );
}

/**
 * slider t∈[0,1] → weights (α engine, β human, γ personality), normalized.
 *
 * THE TOP OF THE SLIDER IS A PROMISE, AND IT HAS TO BE KEPT.
 *
 * "Player personality to maximum" says the bot plays THE PLAYER'S moves. The
 * curve this replaced topped out at γ = 0.35 against β = 0.55, so a position the
 * player had been in twenty times still went to Stockfish's favourite whenever
 * the two disagreed — a device report said exactly that: *"i puted player
 * personality to maximum but still it doesnt play the moves that players
 * normally play"*. Quality was doing the talking on a setting where the player
 * was supposed to be.
 *
 * The curves are linear and chosen to sum to exactly 1 for every t, so the
 * normalization cannot quietly re-scale the stated proportions:
 *
 *   t = 0     {1.00, 0.00, 0.00}   pure engine
 *   t = 0.5   {0.525, 0.075, 0.40}
 *   t = 1     {0.05, 0.15, 0.80}   the player first, the engine as a tiebreak
 */
export function weightsFromMimicry(t: number): MimicWeights {
  const alpha = 1 - 0.95 * t;
  const beta = 0.15 * t;
  const gamma = 0.8 * t;
  const sum = alpha + beta + gamma || 1;
  return { alpha: alpha / sum, beta: beta / sum, gamma: gamma / sum };
}

/** raw α/β/γ sliders → normalized weights (never divide by zero) */
export function normalizeWeights(w: MimicWeights): MimicWeights {
  const sum = w.alpha + w.beta + w.gamma;
  if (sum <= 0.0001) return { alpha: 1, beta: 0, gamma: 0 };
  return { alpha: w.alpha / sum, beta: w.beta / sum, gamma: w.gamma / sum };
}

/** A one-line explanation in the voice of the chosen preset. */
function styleReason(preset: PersonalityId, f: Feats, san: string): string {
  switch (preset) {
    case 'aggressive':
      return f.check ? `checks the king — ${san} keeps the initiative` : `presses forward — ${san} is the attacker's choice`;
    case 'positional':
      return f.centralPawn || f.develop ? `builds the position — ${san} improves a piece` : `keeps the structure — ${san} is the strategist's move`;
    case 'defensive':
      return f.castle ? `king safety first — ${san} is the solid choice` : `takes no unnecessary risk — ${san} keeps the position sound`;
    case 'gambit':
      return f.sac ? `offers material for time — ${san} is the gambiteer's move` : `opens the game — ${san} creates unbalanced play`;
    case 'endgame':
      return `steers for a technical ending — ${san} is the specialist's choice`;
    default:
      return `fits the custom style — ${san}`;
  }
}

// ─── main entry ───────────────────────────────────────────────────────────────

/**
 * A candidate move to score: the engine's own lines, plus (at high mimicry)
 * book moves the engine's window never listed.
 */
interface Cand {
  uci: string;
  san: string;
  move: LegalMove;
  cp: number;
  mate: number | null;
  /** rank in the engine's lines — `lines.length` for a book-only candidate */
  idx: number;
}

export function selectMove(
  lines: readonly EvalLine[],
  fen: string,
  profile: BotProfile,
  weights: MimicWeights,
): MoveDecision | null {
  if (!lines.length) return null;

  const parts = fen.split(' ');
  const ply = Number(parts[5] ?? '1') * 2 - (parts[1] === 'w' ? 1 : 0);
  const phase = phaseOfPly(ply);
  const baseline = BASE[phase];
  const playerRates = profile.typeRates[phase];
  const bookKey = posKey(fen);
  const bookSlot = profile.book[bookKey];
  const bookTotal = bookSlot ? Object.values(bookSlot).reduce((a, b) => a + b, 0) : 0;

  /*
   * A preset's book is a curated repertoire, not observed history. It may
   * nominate a move the engine's five-line window missed at ordinary mimicry,
   * because otherwise the signature line exists in the data but never reaches
   * the board. Imported books keep their stricter evidence rules: two recorded
   * games and a high personality weight.
   */
  const curatedBook = profile.source === 'preset' && !!profile.personality;
  const bookCountOf = (san: string) => bookSlot?.[san] ?? 0;

  // effective centipawns per line (mate → ±10000)
  const cpOf = (l: EvalLine) =>
    l.mate !== null ? (l.mate > 0 ? 10000 : -10000) : (l.scoreCp ?? 0);
  const bestCp = Math.max(...lines.map(cpOf));

  /*
   * LOWER-RATED PLAYERS GET WORSE MOVES, NOT JUST A WEAKER SEARCH.
   *
   * The engine's own rating limit bottoms out at 1320 (the Stockfish host
   * clamps UCI_Elo), so a bot built from an 800-rated account would otherwise
   * play at 1320 and lie about its strength. The part of the shortfall below
   * that floor is carried here as extra score noise, so the bot still picks
   * plausible-but-worse moves at the rate its rating implies.
   */
  const noise =
    Math.max(0, (2200 - profile.rating) / 2200) * 0.12
    + Math.max(0, Math.min(1320, 2200) - profile.rating) / 2200 * 0.18;

  const emitMove = (uci: string, cp: number, mate: number | null, idx: number): Cand | null => {
    const { san, move } = uciToSan(fen, uci);
    if (!move) return null;
    return { uci, san, move, cp, mate, idx };
  };

  /**
   * Score one candidate move on the three signals. Shared by the engine's own
   * lines and the book's extra candidates below, so both sides of the choice
   * are weighed by exactly the same rule.
   */
  const score = (san: string, move: LegalMove, cp: number, idx: number) => {
    const uci = move.from + move.to + (move.promotion ?? '');
    const f = featsOf(fen, uci, san, move.piece, move.captured, move.flags, move.to, move.from, ply);

    // ── E: engine quality ──
    let e = sigmoid((cp - bestCp) / 130);
    if (noise > 0) e = clamp01(e + (Math.random() * 2 - 1) * noise);

    // ── H: human plausibility (player-agnostic) ──
    const rankScore = RANK_SCORE[Math.min(idx, RANK_SCORE.length - 1)];
    let adj = 0;
    if (phase === 'opening') {
      if (f.castle) adj += 0.18;
      if (f.develop) adj += 0.1;
      if (f.centralPawn) adj += 0.08;
      if (f.earlyQueen) adj -= 0.28;
    }
    /*
     * A PAWN OFFER IS ORDINARY OPENING THEORY; HANGING A PIECE IS NOT.
     *
     * This used to subtract a flat 0.1 from every sacrifice in the opening,
     * which pushed 2.f4 down the plausibility curve for being exactly the move
     * the Gambit personality exists to play. The penalty is now proportional to
     * how much is offered past the first pawn, so a one-pawn gambit carries no
     * plausibility cost while a piece hung on move six still does.
     */
    if (f.sac && phase === 'opening') adj -= 0.1 * Math.max(0, f.sacPawns - 1);
    const naturalness = clamp01(0.5 + adj);
    const h = clamp01(0.62 * rankScore + 0.38 * naturalness);

    // ── P: player personality ──
    // book signal: what this player actually played here, or the curated line
    // a preset was created with.
    let bookSignal = 0.5;
    if (bookSlot && bookTotal > 0) {
      const cnt = bookCountOf(san);
      if (curatedBook) {
        /*
         * A CURATED LINE'S WEIGHT IS EDITORIAL, NOT A SAMPLE COUNT.
         *
         * Imported counts are evidence and a square root keeps a 23-vs-17
         * habit from becoming a landslide. A preset's weights were written by
         * hand to say "this is the signature line", so the top weight at a
         * position is the whole scale: the King's Gambit's 2.f4 (weight 8 here)
         * must outrank a weight-2 sideline in the same position, and the square
         * root compressed those two into a distinction too small to survive
         * the engine and plausibility terms.
         */
        const top = Math.max(...Object.values(bookSlot));
        bookSignal = cnt > 0 ? 0.55 + 0.45 * (cnt / Math.max(1, top)) : 0.28;
      } else {
        bookSignal = cnt > 0 ? 0.5 + 0.5 * Math.sqrt(cnt / bookTotal) : 0.42;
      }
    }
    /*
     * PREFERENCE IS MEASURED OR NEUTRAL — NEVER INVENTED.
     *
     * A preset bot has no imported games, so its rates are all zero. Dividing
     * those zeroes by the generic-human baseline produced a strongly negative
     * preference for every move (a preset "never" developed a piece, "never"
     * captured), which dragged the personality term toward zero and let the
     * engine decide every choice. With no sample there is no evidence, and the
     * honest value for an evidence term with no evidence is neutral.
     */
    let prefScore = 0.5;
    /*
     * "MEASURED" MEANS ANY EVIDENCE AT ALL, not `total > 0`. A profile built by
     * the builder always sets `total`, but the harness (and any hand-made
     * profile) may set a single rate without it; treating that as "no data"
     * would silently discard the only measurement the profile has.
     */
    const hasEvidence = playerRates.total > 0
      || playerRates.capture + playerRates.check + playerRates.castle
        + playerRates.centralPawn + playerRates.develop + playerRates.sac > 0;
    if (hasEvidence) {
      let pref = 0;
      pref += Math.log((playerRates.capture + 0.02) / (baseline.capture + 0.02)) * (f.capture ? 1 : 0);
      pref += Math.log((playerRates.check + 0.02) / (baseline.check + 0.02)) * (f.check ? 1 : 0);
      pref += Math.log((playerRates.sac + 0.01) / (baseline.sac + 0.01)) * (f.sac ? 1 : 0);
      pref += Math.log((playerRates.centralPawn + 0.05) / (baseline.centralPawn + 0.05)) * (f.centralPawn ? 0.6 : 0);
      pref += Math.log((playerRates.develop + 0.05) / (baseline.develop + 0.05)) * (f.develop ? 0.6 : 0);
      pref += Math.log((playerRates.castle + 0.05) / 0.06) * (f.castle ? 0.6 : 0);
      const bp = playerRates.byPiece[f.piece as 'p'] ?? 0.1;
      const baseP = (baseline.byPiece as Record<string, number>)[f.piece] ?? 0.1;
      pref += Math.log((bp + 0.03) / (baseP + 0.03)) * 0.5;
      prefScore = sigmoid(pref * 1.4);
    }
    /*
     * BOOK BEFORE STYLE.
     *
     * The personality score is two different signals wearing one name: the
     * book is EVIDENCE (this player has played this move in this position),
     * the preferences are a TENDENCY. At 50/50 the tendency diluted the
     * evidence enough that a rare engine-favoured book move could still
     * out-score the player's own most played move here. 70/30 keeps the
     * fingerprint real while letting what they actually played decide a
     * position they have actually been in.
     *
     * A profile with a personality preset keeps the same book evidence but
     * splits the remaining weight between the measured tendency and the five
     * style dials. Old profiles take the original branch untouched.
     */
    let fit = 0.5;
    let p: number;
    if (profile.personality) {
      const styleFeatures = personalityFeatures(fen, move, f, phase);
      fit = personalityFit(styleFeatures, profile.personality.weights);
      /*
       * CONTRAST, THEN EVIDENCE.
       *
       * A weighted average of five dials sits in a narrow band: an attacking
       * move and a quiet one both score around 0.5, so the style term barely
       * disagrees with the engine. Expanding around the neutral midpoint makes
       * the difference between "this is my kind of move" and "this is not"
       * visible, and `risk` is finally doing something: a gambiteer amplifies
       * the contrast more than a defensive player. The book still speaks first
       * because it is evidence, not taste.
       */
      const amplification = 1.15 + profile.personality.weights.risk * 0.7;
      const styleSignal = clamp01(0.5 + (fit - 0.5) * amplification);
      const blended = clamp01(0.48 * bookSignal + 0.12 * prefScore + 0.4 * styleSignal);

      /*
       * THE SAFETY RAIL. Style is allowed to choose among competitive moves,
       * not to throw the game. The further a candidate is below the engine's
       * best, the more the style score is pulled back to neutral. This is why
       * a Gambit Enthusiast will offer a pawn for initiative but will not
       * give away a queen in a won position just to look like itself.
       *
       * A curated book move gets a little more room because it is theory
       * rather than an invention: 2.f4 can be objectively 50cp worse and still
       * be the move the bot exists to play. That allowance is opening theory,
       * not a licence to throw material later.
       */
      const gap = Math.max(0, bestCp - cp);
      const allowance = curatedBook && bookCountOf(san) > 0 ? 120 : 0;
      const safety = gap <= profile.personality.safetyCp + allowance
        ? 1
        : clamp01(1 - (gap - profile.personality.safetyCp - allowance) / 500);
      p = clamp01(0.5 + (blended - 0.5) * (0.15 + 0.85 * safety));
    } else {
      p = clamp01(0.7 * bookSignal + 0.3 * prefScore);
    }

    // ── combine ──
    const s = weights.alpha * e + weights.beta * h + weights.gamma * p;
    return { e, h, p, s, f, prefScore, fit };
  };

  const cands: Cand[] = [];
  lines.forEach((line, idx) => {
    const cand = emitMove(line.pv[0] ?? '', cpOf(line), line.mate, idx);
    if (cand) cands.push(cand);
  });

  /*
   * THE PLAYER'S OWN MOVES CAN OUTRANK THE ENGINE'S WINDOW.
   *
   * MultiPV caps the engine's answer at five candidate moves, and a move this
   * player made here twice can still fall outside those five — the engine
   * simply did not consider it worth listing. At maximum mimicry that is the
   * wrong answer to "what would this player play", so once the personality
   * weight is dominant the book may nominate candidates of its own.
   *
   * An unsearched move cannot be given an honest engine score, so it is scored
   * as the engine's LEAST favourite line that was shown — the weakest claim we
   * can make without a search of its own — and ranked at the tail of the
   * plausibility curve. It still has to win the same weighted comparison as
   * everything else. Only a move this player chose more than once qualifies:
   * one recorded game is a sample, two is a habit.
   */
  const canNominate = bookSlot && bookTotal > 0 && (curatedBook || weights.gamma >= 0.6);
  if (canNominate) {
    const seenSan = new Set(cands.map((c) => c.san));
    const worstCp = Math.min(...lines.map(cpOf));
    /*
     * index `lines.length` sits one past the last shown line: the rank curve
     * reads its tail value, and `engineRank` records honestly that this move
     * was not among the engine's suggestions at all.
     */
    const outside = lines.length;
    const minCount = curatedBook ? 1 : 2;
    for (const [san, cnt] of Object.entries(bookSlot)) {
      if (cnt < minCount || seenSan.has(san)) continue;
      const move = sanToMove(fen, san);
      if (!move) continue;
      cands.push({
        uci: move.from + move.to + (move.promotion ?? ''),
        san,
        move,
        cp: worstCp,
        mate: null,
        idx: outside,
      });
    }
  }

  /*
   * SCORE EVERY CANDIDATE, THEN LET THE OPENING BOOK SPEAK.
   *
   * The scoring loop used to pick its winner inline, which made a second,
   * stronger rule — the preset's repertoire — impossible to add without
   * duplicating the reason text. Everything is scored first, the winner is the
   * best score, and the commitment below may replace it with a repertoire move.
   */
  const scored = cands.map((cand) => ({
    cand,
    ...score(cand.san, cand.move, cand.cp, cand.idx),
  }));

  let bestScored = scored[0];
  for (const entry of scored) {
    if (entry.s > bestScored.s) bestScored = entry;
  }

  /*
   * A PRESET PLAYS THE OPENING IT WAS BUILT AROUND.
   *
   * THE REPORT: *"i tried playing against a gambit personality bot and he never
   * played any gambits"*. The curated repertoire existed, but it competed as an
   * ordinary candidate: 2.f4 sits outside Stockfish's five-line window, is
   * scored at the window's worst evaluation, ranked at the tail of the
   * plausibility curve, and — before the fixes in this file — dragged down by an
   * "opening sacrifices are implausible" penalty. The weighted sum then came
   * out roughly level with Nf3, so the engine's normal development usually won
   * and the bot looked like every other bot.
   *
   * Opening theory is not a suggestion for a preset: it IS the preset. So in the
   * opening, a preset with a curated book commits to the highest-weighted
   * repertoire move in the position, subject to two honest limits:
   *
   *   - mimicry must be at least half (γ ≥ 0.4). At the pure-engine end of the
   *     dial the user has asked for Stockfish and gets Stockfish.
   *   - the move may not be materially lost. The bot's own safety cap plus an
   *     allowance for theory is the ceiling; a repertoire line that walks into a
   *     refutation is not played.
   *
   * This is a deliberate design decision, not an engine claim: the repertoire is
   * the bot's opening, and `playElo` governs the tactics inside it.
   */
  let committed: (typeof scored)[number] | null = null;
  if (
    curatedBook
    && phase === 'opening'
    && profile.personality
    && weights.gamma >= CURATED_COMMIT_GAMMA
    && bestCp >= CURATED_COMMIT_MIN_CP
  ) {
    const cap = profile.personality.safetyCp + CURATED_COMMIT_ALLOWANCE_CP;
    let committedWeight = -1;
    for (const entry of scored) {
      const weight = bookCountOf(entry.cand.san);
      if (weight <= 0) continue;
      const gap = Math.max(0, bestCp - entry.cand.cp);
      if (gap > cap) continue;
      const better = !committed
        || weight > committedWeight
        || (weight === committedWeight && entry.cand.cp > committed.cand.cp);
      if (better) {
        committed = entry;
        committedWeight = weight;
      }
    }
  }

  const chosen = committed ?? bestScored;
  if (!chosen) return null;

  const name = (profile.name || profile.meta.name).split(',')[0].split(' ')[0];
  const bookCount = bookCountOf(chosen.cand.san);
  let reason: string;
  if (bookCount > 0 && curatedBook) {
    reason = `opening repertoire — ${chosen.cand.san} is the ${profile.personality?.preset ?? 'preset'} line`;
  } else if (bookCount >= 2) {
    reason = `${name} played ${chosen.cand.san} ${bookCount}× in this exact position`;
  } else if (bookCount === 1) {
    reason = `in ${name}'s opening book — played here before`;
  } else if (chosen.cand.idx === 0 && weights.alpha > weights.gamma * 2) {
    reason = `strongest move (engine ${chosen.cand.mate !== null ? `mate in ${chosen.cand.mate}` : chosen.cand.cp > 0 ? '+' + (chosen.cand.cp / 100).toFixed(1) : (chosen.cand.cp / 100).toFixed(1)})`;
  } else if (profile.personality && chosen.fit >= 0.6 && weights.gamma >= 0.25) {
    reason = styleReason(profile.personality.preset, chosen.f, chosen.cand.san);
  } else if (chosen.f.sac) {
    reason = `sacrifice — matches ${name}'s aggressive style`;
  } else if (chosen.f.capture && chosen.prefScore > 0.55) {
    reason = `captures — ${name} trades at a higher rate than most`;
  } else if (chosen.f.castle) {
    reason = `king safety first, like ${name}`;
  } else if (chosen.f.develop && chosen.prefScore > 0.5) {
    reason = `develops a piece — ${name} values activity`;
  } else if (chosen.prefScore >= 0.55) {
    reason = `fits ${name}'s piece preferences`;
  } else {
    reason = `natural move for ${name}'s level`;
  }

  return {
    uci: chosen.cand.uci,
    san: chosen.cand.san,
    reason,
    scores: { e: chosen.e, h: chosen.h, p: chosen.p, s: chosen.s },
    engineRank: chosen.cand.idx,
  };
}

/**
 * How much personality a preset needs before it plays its own opening book.
 *
 * `weightsFromMimicry(t).gamma` reaches 0.4 at about t = 0.5, which is the
 * midpoint of the dial: below it the user has asked for more engine than player,
 * and the repertoire steps aside.
 */
export const CURATED_COMMIT_GAMMA = 0.4;

/**
 * Extra centipawns of theory allowance on top of the bot's safety cap.
 *
 * A repertoire line is known-good opening theory, so it may be a little worse
 * than the engine's first choice — the King's Gambit concedes a fraction of a
 * pawn for the initiative — but it still may not be lost.
 */
export const CURATED_COMMIT_ALLOWANCE_CP = 150;

/**
 * The bot will not gambit from a position it is already losing badly.
 *
 * `bestCp` is from the bot's own point of view, so -250 is "roughly a piece
 * down": at that point the repertoire is not an opening choice, it is a way to
 * lose faster.
 */
export const CURATED_COMMIT_MIN_CP = -250;

/**
 * How many MultiPV lines a bot move is chosen from.
 *
 * Five is what the personality signal needs: the engine's own top move plus
 * enough runners-up that "the move this player actually plays" is among them
 * rather than filtered out before scoring. It is also the engine host's cap.
 */
export const BOT_MULTIPV = 5;
