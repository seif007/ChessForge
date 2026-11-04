/**
 * The bot profile builder — a player's games, reduced to a fingerprint.
 *
 * Everything a bot does at the board comes from what this file measures:
 *
 *   book       every position the player met in the first ten moves, and the
 *              moves they actually chose there, with counts
 *   typeRates  how often their moves capture, check, castle, develop or give
 *              material, split into opening / middle / end
 *   style      four 0-100 dials derived from those rates, for humans
 *
 * The games arrive as PGN — one game per string — because that is the one shape
 * Lichess games and over-the-board archives share. The move tokens come from
 * `pgnMainlineMoves`, the same reader the game analysis uses, so a game the app
 * can analyse is a game a bot can be built from.
 */

import { Chess, type Move } from 'chess.js';
import { OPENINGS, bestOpeningForLine } from '@/lib/openings';
import { pgnMainlineMoves } from '@/lib/lichess';
import { sacrificeValue } from '@/lib/sacrifice';
import type {
  BotBuildProgress,
  BotMeta,
  BookMemory,
  MoveTypeStats,
  OpeningStat,
  PhaseRates,
  BotProfile,
  RawBotGame,
} from './types';

/** Moves 1-6 each side count as the opening phase. */
export const OPENING_PLIES = 12;
/** Book positions are stored up to move 10; nothing after that repeats often enough. */
export const BOOK_PLIES = 20;

const CENTRAL = new Set(['e4', 'd4', 'e5', 'd5', 'c4', 'c5', 'e3', 'd3', 'e6', 'd6']);

/** A game shorter than this is not evidence about anything. */
const MIN_PLIES = 4;

/**
 * How deep a registry match must go before it names an opening.
 *
 * Two plies, i.e. a move and its reply. `bestOpeningForLine` reports how far the
 * winning book followed the line, and a one-ply "match" says nothing a first-move
 * fallback does not say better.
 */
const MIN_OPENING_PLIES = 2;

type Feats = {
  capture?: number;
  check?: number;
  castle?: number;
  centralPawn?: number;
  develop?: number;
  sac?: number;
  byPiece?: Partial<Record<'p' | 'n' | 'b' | 'r' | 'q' | 'k', number>>;
};

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

function phaseOf(ply: number): keyof PhaseRates {
  if (ply <= OPENING_PLIES) return 'opening';
  if (ply <= 60) return 'middle';
  return 'end';
}

/** board+turn+castling+en-passant — the part of the FEN that defines the position */
function posKey(fen: string): string {
  const parts = fen.split(' ');
  return parts.slice(0, 4).join(' ');
}

/** The registry's name for a move sequence, or a first-move fallback. */
export function botOpeningFromMoves(sans: readonly string[]): { name: string; eco?: string } {
  const best = bestOpeningForLine([sans.slice(0, OPENING_PLIES) as string[]]);
  if (best && best.depth >= MIN_OPENING_PLIES) {
    const name = OPENINGS.find((o) => o.id === best.id)?.name?.trim();
    if (name) return { name };
  }
  if (sans[0] === 'e4') return { name: "King's Pawn Opening" };
  if (sans[0] === 'd4') return { name: "Queen's Pawn Opening" };
  return { name: 'Irregular Opening' };
}

/* ---------------------------------------------------------------- name match */

const normName = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/**
 * Extract surname + given initial, format-aware:
 *   "Nakamura,Hi" / "Nakamura, Hikaru" → surname first (PGN header style)
 *   "Hikaru Nakamura"                   → surname last (Western style)
 */
const surInit = (s: string) => {
  const cleaned = s.toLowerCase().replace(/[^a-z, ]/g, ' ').trim();
  if (cleaned.includes(',')) {
    const [sur, ...rest] = cleaned.split(',');
    const given = rest.join(' ').split(/\s+/).filter(Boolean)[0] ?? '';
    return { sur: sur.trim(), init: given[0] ?? '' };
  }
  const words = cleaned.split(/\s+/).filter(Boolean);
  return { sur: words[words.length - 1] ?? '', init: words[0]?.[0] ?? '' };
};

/**
 * WHICH SIDE OF THIS GAME IS THE BOT?
 *
 * PGN headers spell names inconsistently across archives: TWIC writes
 * "Nakamura, Hikaru", Lichess writes "Hikaru", PGN Mentor mixes both. An exact
 * string compare finds the player in some files and not others, so the match is
 * deliberately tolerant: exact first, then a surname-plus-initial comparison,
 * which is how a "Hikaru" query still recognises "Nakamura,Hi".
 */
export function playerInGame(white: string, black: string, key: string): 'w' | 'b' | null {
  const a = normName(white);
  const b = normName(black);
  const k = normName(key);
  // also try the word-reversed key ("Hikaru Nakamura" ≡ "Nakamura,Hikaru")
  const kWords = key.toLowerCase().replace(/[^a-z, ]/g, ' ').split(/[,\s]+/).filter(Boolean);
  const kRev = normName([...kWords].reverse().join(''));
  if (a === k || a === kRev) return 'w';
  if (b === k || b === kRev) return 'b';
  const kk = surInit(key);
  if (!kk.sur) return null;
  const w = surInit(white);
  const bl = surInit(black);
  if (w.sur === kk.sur && (!kk.init || !w.init || kk.init === w.init)) return 'w';
  if (bl.sur === kk.sur && (!kk.init || !bl.init || kk.init === bl.init)) return 'b';
  return null;
}

/* ------------------------------------------------------------------ features */

function classifyMove(mv: Move, fenBefore: string): Feats {
  const feats: Feats = {};
  if (mv.captured) feats.capture = 1;
  if (mv.san.includes('+') || mv.san.includes('#')) feats.check = 1;
  if (mv.flags.includes('k') || mv.flags.includes('q')) feats.castle = 1;
  if (mv.piece === 'p' && CENTRAL.has(mv.to)) feats.centralPawn = 1;
  if ((mv.piece === 'n' || mv.piece === 'b') && mv.from[1] === (mv.color === 'w' ? '1' : '8'))
    feats.develop = 1;
  /*
   * A genuine offer, not an unfavourable capture. This is the same signal the
   * live move chooser and the brilliant classifier use, so an imported profile
   * cannot describe a player as never sacrificing while a Gambit preset built
   * from the same idea does. Pawn offers count: a gambit is usually a pawn.
   */
  const uci = mv.from + mv.to + (mv.promotion ?? '');
  if (sacrificeValue(fenBefore, uci) >= 1) feats.sac = 1;
  feats.byPiece = { [mv.piece]: 1 };
  return feats;
}

function addFeats(bucket: MoveTypeStats, feats: Feats) {
  bucket.total++;
  if (feats.capture) bucket.capture++;
  if (feats.check) bucket.check++;
  if (feats.castle) bucket.castle++;
  if (feats.centralPawn) bucket.centralPawn++;
  if (feats.develop) bucket.develop++;
  if (feats.sac) bucket.sac++;
  if (feats.byPiece) {
    for (const [p, n] of Object.entries(feats.byPiece)) {
      (bucket.byPiece as Record<string, number>)[p] += n ?? 0;
    }
  }
}

function normalizeStats(bucket: MoveTypeStats): MoveTypeStats {
  const t = Math.max(1, bucket.total);
  const by = bucket.byPiece;
  return {
    total: bucket.total,
    capture: bucket.capture / t,
    check: bucket.check / t,
    castle: bucket.castle / t,
    centralPawn: bucket.centralPawn / t,
    develop: bucket.develop / t,
    sac: bucket.sac / t,
    byPiece: {
      p: by.p / t,
      n: by.n / t,
      b: by.b / t,
      r: by.r / t,
      q: by.q / t,
      k: by.k / t,
    },
  };
}

/* -------------------------------------------------------------------- PGN bits */

/** The tag section as a plain object. Missing tags are simply absent. */
export function pgnHeaders(pgn: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\[([A-Za-z0-9_]+)\s+"([^"]*)"\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn)) !== null) out[m[1]] = m[2];
  return out;
}

/** One game out of a multi-game PGN file… see the splitter note in the body. */
export function splitPgnGames(text: string): string[] {
  /*
   * A new game starts at a tag line that FOLLOWS movetext.
   *
   * Splitting on every `[Event` would fail on files that open games with a
   * different first tag, and splitting on blank lines fails because PGNs are
   * not required to have any. What is true everywhere: within one game the tags
   * come first, and after them comes at least one line that is not a tag. So the
   * first tag line seen after movetext begins the next game.
   */
  const games: string[] = [];
  const lines = text.split(/\r?\n/);
  let current: string[] = [];
  let seenMovetext = false;

  const flush = () => {
    const joined = current.join('\n').trim();
    if (joined) games.push(joined);
    current = [];
    seenMovetext = false;
  };

  for (const line of lines) {
    const isTag = /^\[[A-Za-z0-9_]+\s/.test(line);
    if (isTag && seenMovetext) flush();
    if (!isTag && line.trim() && !line.trim().startsWith('{')) seenMovetext = true;
    current.push(line);
  }
  flush();
  return games;
}

/* -------------------------------------------------------------------- builder */

const PROGRESS_EVERY = 6;

const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Fold a set of games into the profile fields a bot plays from.
 *
 * The result is everything about the bot EXCEPT the storage bits (`id`, `name`,
 * `recipe`, `createdAt`), which belong to the store — that keeps this function
 * pure enough to run over a fixture in a gate.
 */
export async function buildBotProfile(
  games: readonly RawBotGame[],
  meta: BotMeta,
  opts: {
    onProgress?: (p: BotBuildProgress) => void;
    /** Yield to the UI every N games; tests pass a no-op. */
    yieldEvery?: number;
    yieldToUI?: () => Promise<void>;
  } = {},
): Promise<Omit<BotProfile, 'id' | 'createdAt' | 'recipe' | 'name'>> {
  const { onProgress, yieldEvery = PROGRESS_EVERY, yieldToUI: yieldFn = yieldToUI } = opts;

  /*
   * A BAR THAT ONLY APPEARS AFTER SIX GAMES LOOKS LIKE A DEAD BUTTON.
   *
   * The first report used to fire at the first yield interval, so a small import
   * showed nothing at all while it worked and a large one showed nothing until
   * six games had been folded. Emitting at zero makes the bar appear with the
   * job, before the first game.
   */
  onProgress?.({
    stage: 'analyze',
    label: 'Analyzing games',
    detail: `0 of ${games.length} games`,
    done: 0,
    total: games.length,
    pct: 0,
  });

  const book: BookMemory = {};
  const rates: PhaseRates = { opening: emptyStats(), middle: emptyStats(), end: emptyStats() };
  const openingMap = new Map<string, OpeningStat>();
  const tcMap = new Map<string, number>();
  let dateMin = '';
  let dateMax = '';
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let analyzed = 0;
  let totalPlies = 0;
  let castlePlySum = 0;
  let castleCount = 0;
  const firstMoves = new Map<string, number>();
  const repliesE4 = new Map<string, number>();
  const repliesD4 = new Map<string, number>();
  let lastElo = 0;

  for (let gi = 0; gi < games.length; gi++) {
    /*
     * THE TICK IS ON THE LIST, NOT ON THE SURVIVORS.
     *
     * Progress fires on the game index, before the per-game filters, so the bar
     * advances at a fixed cadence no matter how many games are skipped. Ticking
     * only after a game passed every check made the bar stall for exactly the
     * input where feedback matters most: an archive that is mostly other
     * people's games. The counts in `detail` are as of the previous game; that
     * is what "progress so far" means, and they never go backwards.
     */
    if ((gi + 1) % yieldEvery === 0) {
      onProgress?.({
        stage: 'analyze',
        label: 'Analyzing games',
        detail: `${analyzed} games · ${openingMap.size} openings`,
        done: gi + 1,
        total: games.length,
        pct: Math.round(((gi + 1) / games.length) * 100),
      });
      await yieldFn();
    }

    const g = games[gi];
    const side = playerInGame(g.white, g.black, meta.key);
    if (!side) continue;

    // time-control mix + date span (count every matched game, replayable or not)
    /*
     * Lichess calls its slow online formats classical and correspondence; the
     * app groups both under "Classical" (and OTB games are classical by
     * nature), so every label this profile prints says Classical — one word
     * for one choice, or the same bot would wear two names.
     */
    const tcLabel =
      g.source === 'otb' || g.timeControl === 'daily'
        ? 'Classical'
        : g.timeControl
          ? g.timeControl.charAt(0).toUpperCase() + g.timeControl.slice(1)
          : 'Other';
    tcMap.set(tcLabel, (tcMap.get(tcLabel) ?? 0) + 1);
    if (g.date) {
      const iso = g.date.replace(/\./g, '-');
      if (!dateMin || iso < dateMin) dateMin = iso;
      if (!dateMax || iso > dateMax) dateMax = iso;
    }

    /*
     * A game starting from a problem position teaches a bot nothing about how
     * the player opens, and its book positions would never be reached from a
     * standard start anyway.
     */
    if (g.initialFen) continue;

    const sans = pgnMainlineMoves(g.pgn);
    if (sans.length < MIN_PLIES) continue;

    const headers = pgnHeaders(g.pgn);
    const result = headers.Result ?? '*';

    const replay = new Chess();
    let plies = 0;
    /*
     * A GAME'S MOVES ARE HELD UNTIL THE GAME EARNS ITS PLACE.
     *
     * The replay can stop early - a token chess.js cannot read means every
     * later move depends on a position the app cannot vouch for - and a game
     * that ends up too short is discarded. Counting features while replaying
     * meant a discarded game still left its first moves in the book and the
     * rates: a fixture with a garbled second move moved the player's e4 count
     * and the opening-phase totals, invisibly, because the game itself was
     * never reported as analysed. Collecting first and folding in after the
     * length check makes "this game counted" and "these moves counted" the
     * same statement.
     */
    const mine: { ply: number; key: string; mv: Move; fen: string }[] = [];
    for (let ply = 0; ply < sans.length; ply++) {
      const stateFen = replay.fen();
      let mv: Move;
      try {
        mv = replay.move(sans[ply]);
      } catch {
        break;
      }
      plies++;
      const isPlayerMove = (ply % 2 === 0) === (side === 'w');
      if (!isPlayerMove) continue;
      mine.push({ ply: ply + 1, key: posKey(stateFen), mv, fen: stateFen });
    }

    if (plies < MIN_PLIES) continue;

    analyzed++;
    totalPlies += plies;

    const won = (side === 'w' && result === '1-0') || (side === 'b' && result === '0-1');
    if (won) wins++;
    else if (result.includes('1/2')) draws++;
    else if (result !== '*') losses++;

    const elo = side === 'w' ? g.whiteRating : g.blackRating;
    if (elo) lastElo = elo;

    // Opening: the file's own tag when it has one, our book when it does not.
    const openingName = headers.Opening?.trim() || botOpeningFromMoves(sans).name;
    const eco = headers.ECO || g.eco;
    const asColor = side === 'w' ? ('white' as const) : ('black' as const);
    const stat = openingMap.get(openingName) ?? {
      name: openingName,
      eco,
      asColor,
      count: 0,
      wins: 0,
      draws: 0,
      losses: 0,
    };
    stat.count++;
    if (won) stat.wins++;
    else if (result.includes('1/2')) stat.draws++;
    else if (result !== '*') stat.losses++;
    openingMap.set(openingName, stat);

    let castled = false;
    for (const { ply, key, mv, fen } of mine) {
      addFeats(rates[phaseOf(ply)], classifyMove(mv, fen));

      if ((mv.flags.includes('k') || mv.flags.includes('q')) && !castled) {
        castled = true;
        castlePlySum += ply;
        castleCount++;
      }

      if (ply <= BOOK_PLIES) {
        const slot = (book[key] ??= {});
        slot[mv.san] = (slot[mv.san] ?? 0) + 1;
      }

      if (ply === 1 && side === 'w') firstMoves.set(mv.san, (firstMoves.get(mv.san) ?? 0) + 1);
      if (ply === 2 && side === 'b') {
        if (sans[0] === 'e4') repliesE4.set(mv.san, (repliesE4.get(mv.san) ?? 0) + 1);
        else if (sans[0] === 'd4') repliesD4.set(mv.san, (repliesD4.get(mv.san) ?? 0) + 1);
      }
    }
  }

  if (analyzed === 0) {
    throw new Error('No playable games found for this player.');
  }

  const typeRates: PhaseRates = {
    opening: normalizeStats(rates.opening),
    middle: normalizeStats(rates.middle),
    end: normalizeStats(rates.end),
  };

  const totalMoves = Math.max(1, rates.opening.total + rates.middle.total + rates.end.total);
  const capRate = (rates.opening.capture + rates.middle.capture + rates.end.capture) / totalMoves;
  const chkRate = (rates.opening.check + rates.middle.check + rates.end.check) / totalMoves;
  const sacRate = (rates.opening.sac + rates.middle.sac + rates.end.sac) / totalMoves;

  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const aggression = clamp(50 + 140 * (capRate - 0.32) + 90 * (chkRate - 0.065) + 60 * (sacRate - 0.004));
  const castleRate = castleCount / analyzed;
  const castlePlyAvg = castleCount ? castlePlySum / castleCount : 20;
  const kingSafety = clamp(
    50 + (castleRate - 0.75) * 60 + (castlePlyAvg <= 12 ? 10 : castlePlyAvg >= 18 ? -10 : 0),
  );
  const pieceActivity = clamp(
    50 + 120 * (typeRates.opening.develop - 0.55) + 80 * (typeRates.opening.centralPawn - 0.18),
  );
  const endShare = rates.end.total / totalMoves;
  const endgame = clamp(50 + 90 * (endShare - 0.28) + 60 * (typeRates.end.byPiece.r - 0.16));

  let rating = 0;
  let ratingLabel = '';
  if (meta.source === 'lichess') {
    const r = meta.ratings ?? {};
    /*
     * WHICH RATING SPEAKS FOR THE BOT. A time-class filter, when one was
     * asked for, is the answer. With "all" the label follows the games: the
     * class the player actually played most in this set, read off the same
     * `tcMap` the mix chips on the profile are built from. It used to fall
     * through to blitz-first — a bot built entirely from bullet games called
     * itself a "Lichess blitz" bot at a blitz rating it never played at.
     */
    const tc = meta.timeClass && meta.timeClass !== 'all' ? meta.timeClass : undefined;
    const dominant = tc
      ? undefined
      : [...tcMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]?.toLowerCase();
    const rated = tc ?? dominant;
    /*
     * THE RATINGS INDEX SPELLS IT `daily`, EVERY LABEL SPELLS IT `classical`.
     * The client maps Lichess's classical/correspondence ratings into the
     * app's existing `daily` slot; the bots UI and this profile call the same
     * choice Classical (see the tcLabel note above), so the lookup translates
     * and the label stays one word.
     */
    const ratingKey = rated === 'classical' ? 'daily' : rated;
    const tcRating = ratingKey ? (r as Record<string, number | undefined>)[ratingKey] : undefined;
    if (tcRating) {
      rating = tcRating;
      ratingLabel = `Lichess ${ratingKey === 'daily' ? 'classical' : ratingKey}`;
    } else if (r.blitz) {
      rating = r.blitz;
      ratingLabel = 'Lichess blitz';
    } else if (r.rapid) {
      rating = r.rapid;
      ratingLabel = 'Lichess rapid';
    } else if (r.daily) {
      /*
       * NO BULLET FALLBACK. A bullet rating describes a format the bot is
       * never built from — quoting it as the bot's rating would be the
       * blitz-first mistake again, one class over.
       */
      rating = r.daily;
      ratingLabel = 'Lichess classical';
    } else {
      rating = lastElo || 1200;
      ratingLabel = 'Lichess';
    }
  } else {
    if (meta.ratings?.fide) {
      rating = meta.ratings.fide;
      ratingLabel = 'FIDE standard';
    } else if (lastElo) {
      rating = lastElo;
      ratingLabel = 'FIDE (from games)';
    } else {
      rating = 2200;
      ratingLabel = 'estimated';
    }
  }

  const topN = (map: Map<string, number>, n: number) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([san, count]) => ({ san, count }));

  return {
    source: meta.source,
    meta,
    gamesAnalyzed: analyzed,
    rating,
    ratingLabel,
    wins,
    draws,
    losses,
    openings: [...openingMap.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    style: {
      aggression: Math.round(aggression),
      kingSafety: Math.round(kingSafety),
      pieceActivity: Math.round(pieceActivity),
      endgame: Math.round(endgame),
      castlePly: castleCount ? Math.round(castlePlySum / castleCount) : null,
      avgGameLength: Math.round((totalPlies / analyzed) * 10) / 10,
    },
    book,
    typeRates,
    firstMoves: topN(firstMoves, 4),
    repliesToE4: topN(repliesE4, 4),
    repliesToD4: topN(repliesD4, 4),
    timeControlMix: [...tcMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count })),
    dateRange: { from: dateMin || undefined, to: dateMax || undefined },
    fetchedAt: new Date().toISOString(),
    /*
     * THE SOURCE RATING IS THE PLAYING STRENGTH.
     *
     * `rating` was measured and displayed, but nothing capped the engine with
     * it, so a bot built from an 1800 account still played Stockfish's
     * uncapped best move — the exact report: *"the bots should have the rating
     * that matches the players ... not playing like 3000"*. `playElo` is the
     * field the play screen and Arena already pass to the engine, so setting
     * it here is what makes the card's number true on the board. The user can
     * still raise or lower it in the bot editor.
     */
    playElo: rating,
  };
}
