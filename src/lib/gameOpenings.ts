'use client';

/**
 * Build a personal repertoire out of the openings the user ACTUALLY plays.
 *
 * THE REQUEST
 * -----------
 * "I also want the user to be able to train from positions in the openings he
 * had in his games so the app shows him the position + an arrow what he played +
 * an arrow what we recommend (+ a msg indicating to user what he played and what
 * we recommend + alternative choices + engine differences). The user could
 * choose what we recommend or from alternatives and like that he could create
 * his own repertoires by keep choosing sometimes the moves or the app sometimes
 * just shows him the moves without alternatives. And finally he could train
 * anytime he wants on his own repertoires created with the (to do, mistake,
 * unclear...) like we have already in the train."
 *
 * ...plus the follow-up: the app will keep gaining new repertoires, so the user
 * may well have played openings we do NOT ship yet. That case must still produce
 * something useful rather than a dead end.
 *
 * THE THREE CASES, AND HOW EACH IS HANDLED
 * ----------------------------------------
 * 1. **We ship this opening** — the played move is compared against our shipped
 *    study. If the user's move is in the book we say so and move on. If it is
 *    not, we show what we recommend (the book move) plus engine alternatives,
 *    with centipawn deltas so "slightly worse" and "blunder" are distinguishable.
 *
 * 2. **We do not ship it yet** — no book exists, so there is nothing to deviate
 *    from. We ask the ENGINE for the best move and the top alternatives and
 *    present the position as "new to us". If the user adopts a move, it is
 *    written into a **custom repertoire** they own. When a future app version
 *    ships a real book for that opening, the custom line stays (see `upgrade`
 *    below): we never silently delete the user's own choices.
 *
 * 3. **The user adopts a move we did not recommend** — that is the point of the
 *    feature. The adopted move becomes the "expected" move for that position in
 *    their personal repertoire, so training reinforces *their* choice, not ours.
 *
 * WHY ADOPTION IS STORED PER POSITION, NOT PER LINE
 * -------------------------------------------------
 * Chess lines transpose. Storing "the user wants Nf3 here" keyed by the position
 * (FEN + the move that led to it) rather than by a line index means the same
 * choice is honoured whether the user arrived at it via 1.e4 e5 or via a
 * transposition. It is also what makes the repertoire survive a rescan of the
 * games, and what lets an unknown opening be *later* merged into a shipped one.
 *
 * ENGINE COST
 * -----------
 * One `multipv` search per position, not per alternative. The engine host
 * already returns the PV lines for the requested MultiPV, so asking for 3 costs
 * roughly one search. Positions are de-duplicated by FEN across all games, so a
 * user who plays the Italian 40 times analyses the opening once.
 */

import { Chess } from 'chess.js';
import { getEngine } from '@/lib/engine';
import type { LichessGame } from '@/lib/lichess';
import { bestCoverageAcrossOpenings, bestOpeningForLine, bookHere } from '@/lib/openings';
import { fenKey, type TrainExercise, type TrainLine } from '@/lib/repertoire';

/** One candidate move for a position, with its engine assessment. */
export interface MoveOption {
  uci: string;
  san: string;
  /** Centipawns from the MOVER's perspective. */
  cp: number;
  /** Pawns lost versus the best option. 0 for the best move. */
  lossCp: number;
  /** True when this is the move the user actually played in their game. */
  played: boolean;
  /** True when this move is the shipped book's recommendation. */
  book: boolean;
  /** One-line human note: "your move", "our book move", "engine's pick". */
  note: string;
}

/** A position the user reached in their own games, ready to train. */
export interface GamePosition {
  /** Stable key — this is what adoption and SRS are stored against. */
  key: string;
  fen: string;
  /** Plies from the start of the game, for display ("move 7"). */
  ply: number;
  /** The side that has to move here = the side the user played. */
  side: 'w' | 'b';
  gameId: string;
  gameUrl: string;
  /** Opening family as Lichess labelled it. */
  opening: string;
  /** The move the user played, in SAN, or null if the game ended here. */
  playedSan: string | null;
  playedUci: string | null;
  /**
   * The opponent's move that created this position (SAN), or null at ply 0.
   *
   * Kept for the UI note; the reconstructable form is `prefixSan`.
   */
  prevSan: string | null;
  /**
   * Every move before this position, from the start of the game, in SAN.
   *
   * Needed to drill the position on the Train screen, which auto-plays a prefix
   * and derives the turn from the ply index rather than the FEN. See
   * `buildCustomExercises`.
   */
  prefixSan: string[];
  /** True when a book that trains the side to move has a move at this position. */
  inBook: boolean;
  /** The shipped book's move here, if any. */
  bookSan: string | null;
  /**
   * EVERY move a book for the side to move offers at this position, in registry
   * order. Empty means honestly out of book.
   *
   * WHY THIS IS ON THE POSITION AND NOT COMPUTED BY THE UI
   * ---------------------------------------------------
   * The screen used to label the move the user played with a hardcoded string
   * derived from `inBook` — which is a property of the POSITION, not of the MOVE.
   * So the app told a user who played `1...Nf6` "not our book move" while claiming
   * "We have this", and no amount of fixing the label could have made it true: the
   * label had no idea which moves the book actually contains.
   *
   * `bookReplies` is that missing fact, carried on the record so every consumer
   * (the play view, the Train drill, the family summary) can answer the same
   * question the same way. See `bookHere` for how it is derived — the short
   * version is that it is read from the library index and filtered by the side to
   * move, so a White book can never be credited with supplying Black's move.
   */
  bookReplies: string[];
  /** What we suggest the user trains — book move, or the engine's pick. */
  recommendUci: string | null;
  recommendSan: string | null;
  /** Engine alternatives, best first. Always includes the played move. */
  options: MoveOption[];
  /** How many times the user reached this exact position across their games. */
  timesSeen: number;
}

/** The user's own repertoire: positions with an adopted move. */
/**
 * How to continue one of the user's own lines from OUR book.
 *
 * LAZY, AND NOT BY IMPORT. `openingBuilder` imports this module, so importing
 * `continueFromBook` back from here would close a cycle - the same reason this file reaches
 * `openings.ts` through a registered matcher rather than a direct call. `openingBuilder` wires
 * the real implementation in at module load; until then the continuation is honestly "no
 * continuation" and a drill is simply the user's own moves.
 */
type DrillContinuation = (sans: string[], openingId?: string | null) => string[] | null;
let drillContinuationFn: DrillContinuation | null = null;

/** Wire the book continuation. Called once by `openingBuilder` at module load. */
export function registerDrillContinuation(fn: DrillContinuation): void {
  drillContinuationFn = fn;
}

/** Our book's continuation of this line, scoped to one opening, or null. */
export function drillContinuation(sans: string[], openingId?: string | null): string[] | null {
  if (!drillContinuationFn) return null;
  return drillContinuationFn(sans, openingId);
}

export interface CustomLine {
  /** GamePosition.key this decision was made at. */
  key: string;
  fen: string;
  /** The move the user adopted (UCI). */
  adoptedUci: string;
  adoptedSan: string;
  /**
   * The opponent's move that CREATED this position, in SAN — i.e. the move
   * played at ply `position.ply - 1`.
   *
   * Kept for display and for the "you diverged after ..." note; it is NOT
   * sufficient to reconstruct the position, because a move at ply 7 cannot be
   * replayed from the initial board. Use `prefixSan` for that.
   */
  prevSan: string | null;
  /**
   * Every move BEFORE this position, from the start of the game, in SAN.
   *
   * This is what makes a deep position drillable. The Train screen derives whose
   * turn it is from the ply INDEX (not the FEN) and auto-plays `sans[0..
   * startPly-1]` before handing over — so the drilled line must be
   * `prefixSan + [adoptedSan]` with `startPly = prefixSan.length`, and the
   * prefix has to be the real game moves, not just the immediately preceding
   * one. (An earlier version stored only `prevSan`; it worked for Black's first
   * move and produced an illegal first move for every deeper position — the
   * harness caught 8 of 22 failing.)
   *
   * See `buildCustomExercises`.
   */
  prefixSan: string[];
  /** The engine's preference at the time, for the "you diverged" note. */
  engineBestSan: string | null;
  opening: string;
  decidedAt: number;
  /** True when this came from an opening we do not ship (case 2). */
  selfDiscovered: boolean;
  /**
   * Which shipped opening this decision belongs to, e.g. `sicilian`.
   *
   * The REGISTRY ID, not the display name. `opening` above is Lichess's own name
   * for the position, and joining that to a registry id is a string comparison that
   * fails silently the first time either side is reworded — which shows up as a
   * per-opening rank that never moves, with no error anywhere.
   *
   * Null when nothing matched, and consumers must treat null as "not attributable"
   * rather than defaulting it to some opening.
   */
  openingId?: string | null;
}

export interface GameOpeningReport {
  positions: GamePosition[];
  /** Openings the user played that we DO ship. */
  knownOpenings: string[];
  /** Openings the user played that we do NOT ship yet. */
  unknownOpenings: string[];
}

/**
 * The book's move for THIS position — the library's answer AND the real board.
 *
 * ONE FUNCTION, ONE BOOK LOOKUP
 * -----------------------------
 * This used to be two functions and TWO lookups of the SAME question. `bookMoveAt`
 * asked `bestCoverageAcrossOpenings(sans[0..ply))` to decide whether the book
 * followed the game far enough and what it recommends; `bookMoveAtBoard` then
 * asked the identical question again to decide whether the match was EXACT. Both
 * answers come out of one call — `matchedPly` answers "far enough" and "exactly"
 * at once — so the second walk of the entire library was pure duplicated cost on
 * the hottest path in the app.
 *
 * WHY THE BOARD CHECK IS NOT OPTIONAL
 * -----------------------------------
 * Reasoning in SAN answers "did the book follow this game as far as this ply",
 * which is NOT the same question as "does the book have a move in the position
 * the app is about to put on screen". Two documented ways it diverges, both found
 * by measurement:
 *
 *  1. **Transpositions.** `deriveCandidates` dedupes by FEN + side to move, and
 *     openings transpose constantly — `Nf3 g6 c4` and `c4 g6 Nf3` reach the SAME
 *     position — so one game's `bookSan` gets attached to a position reached by
 *     another game's move order.
 *
 *  2. **Studies are written from one side.** Our books are authored from the
 *     trained side's point of view, while the matcher takes a game against every
 *     book regardless of colour. A Black position that opens `Nf3` matches the
 *     English Opening (a WHITE book) at ply 1, and its `expectedNext` is then read
 *     as though it were Black's move.
 *
 * The measured consequence is the user's own report. In the Modern Defence the
 * app "recommended" `d5` at a position whose real book move is `Bg7`. `d5` is
 * legal there, so a legality check ALONE does not catch it — but it is not this
 * position's book move, and following it walks out of both his games and our
 * book after a single move: "i got an illegal move after i chose the app
 * recommendation ... it doesn't complete the line, i just played one move and
 * that's it".
 *
 * So a book move counts ONLY when the book followed the position EXACTLY (not
 * merely "at least as far as") AND the move is playable on the real board. When
 * it is not, the position is honestly out of book and the user's own move
 * becomes the recommendation — which is always legal and always continues the
 * line.
 *
 * WHY A FEN AND NOT A BOARD
 * -------------------------
 * The caller is `deriveCandidates`, which has just advanced its own board PAST
 * this move (the position is the one the move was played FROM). Handing that
 * board in and then re-serialising its FEN to probe it is two wasted operations
 * per candidate, and there are ~1,300 candidates per derivation. The probe board
 * is now built from the FEN string, and only when there is actually a book move
 * to verify — which is a small minority of positions.
 */
function bookMoveAt(
  fen: string,
  sans: string[],
  ply: number,
  playedSan: string | null,
  openingId?: string | null,
): { inBook: boolean; san: string | null; replies: string[] } {
  if (ply <= 0) return { inBook: false, san: null, replies: [] };
  // `bookHere` derives the side to move from the ply itself, so the caller cannot
  // ask about the wrong side and be handed the opponent's moves. `openingId` is the
  // opening THIS game is, so the answer comes from that opening's book and not from
  // whichever book happened to be registered first at a shared position.
  const here = bookHere(sans.slice(0, ply), openingId);
  if (!here) return { inBook: false, san: null, replies: [] };

  /*
   * "IN BOOK" NOW MEANS SOMETHING CHECKABLE
   * ---------------------------------------
   * It used to be `matchedPly >= ply`, which is true whenever ANY book in the
   * library shares the first move — so `1.e4` was "in book" for a Black user
   * because thirteen books begin with a White move or a Black reply to it, and
   * the app then claimed "We have this" and attributed a recommendation to "our
   * book" for a position where the Black books we ship offer `c5`, `c6` and `e6`
   * and the user played `Nf6`.
   *
   * Now it means: a book that trains THIS side has a move at THIS position. If
   * that set is empty the position is out of book, and every consumer says so —
   * which is the honest reading, and the one that makes the "New to us" chip and
   * the engine's suggestion mean what they say.
   */
  const replies = here.replies;
  if (replies.length === 0) return { inBook: false, san: null, replies };

  /*
   * The library has to have followed the game to exactly this position, not merely
   * to some shallower point — a match at depth N proves the library contains N
   * plies, not that its position after N is the position on the board.
   */
  const exact = here.depth === ply;
  let san: string | null = null;
  if (exact) {
    // Prefer the move the user actually played when the book contains it:
    // recommending what they already played would be a fake deviation.
    san = (playedSan && replies.includes(playedSan)) ? playedSan : replies[0];
  }
  if (!san) return { inBook: false, san: null, replies };

  let legal = false;
  try {
    legal = new Chess(fen).move(san) != null;
  } catch {
    legal = false;
  }
  if (legal) return { inBook: true, san, replies };
  return { inBook: false, san: playedSan, replies };
}

/**
 * A position the user reached, BEFORE the engine has looked at it.
 *
 * Splitting this out matters for two reasons:
 *
 *  1. **The opening-name list must be instant.** Deriving these costs a chess.js
 *     replay per game and no engine time at all, so "Your openings" can show
 *     *Sicilian Defence, Italian Game, ...* immediately, and only the family the
 *     user opens pays for a search.
 *  2. **It makes the engine pass targetable.** `analyseGameOpenings` accepts a
 *     prepared `Cand[]`, so the builder can hand it one family's positions
 *     instead of the whole library.
 *
 * `playedSan`/`playedUci` are nullable because the game can end mid-opening,
 * and `prefixSan` is a full move list from the start of the game (see the note
 * on `CustomLine.prefixSan` — a partial prefix cannot replay a deep position).
 */
export interface Cand {
  key: string;
  fen: string;
  ply: number;
  side: 'w' | 'b';
  game: LichessGame;
  playedSan: string | null;
  playedUci: string | null;
  inBook: boolean;
  bookSan: string | null;
  /**
   * Every move a book for `side` offers at this position. See
   * `GamePosition.bookReplies` — the same fact, carried on the candidate.
   */
  bookReplies: string[];
  /** The opponent's move that created this position (see CustomLine.prevSan). */
  prevSan: string | null;
  /** Every move before this position, from the game start (see CustomLine.prefixSan). */
  prefixSan: string[];
  /** How many of the user's games reached this exact position (set by the dedupe). */
  timesSeen?: number;
}

/**
 * Derive the training positions from games — no engine involved.
 *
 * A position is created at each of the USER's moves only. Parity decides whose
 * move it is: White moves on even plies, so `(ply % 2 === 0) === (game.color
 * === 'w')` is true exactly on the tracked player's turns. Getting this
 * backwards is the classic failure of this kind of code and it is invisible
 * until the user is asked to "recall" a move their opponent played, which is
 * why the harness pins it.
 *
 * Positions are de-duplicated by FEN + side-to-move, so a transposition is one
 * decision seen twice (`timesSeen` increments) rather than two identical cards.
 */
export function deriveCandidates(
  games: LichessGame[],
  opts: { limit?: number; maxPly?: number } = {},
): Cand[] {
  const limit = opts.limit ?? 120;
  const maxPly = opts.maxPly ?? 20;
  const cands: Cand[] = [];
  const byKey = new Map<string, Cand>();

  for (const game of games) {
    if (cands.length >= limit) break;
    if (deriveFromGame(game, maxPly, cands, byKey, limit)) break;
  }

  return cands;
}

/**
 * One game's worth of `deriveCandidates`, into a shared accumulator.
 *
 * Split out so the same work can be driven two ways: synchronously
 * (`deriveCandidates`, used by the benches and by every caller that already has
 * a warm cache) and in slices (`deriveCandidatesAsync`, used by the first build,
 * which must not block the JS thread).
 *
 * Returns true when the limit has been reached and the caller should stop.
 */
function deriveFromGame(
  game: LichessGame,
  maxPly: number,
  cands: Cand[],
  byKey: Map<string, Cand>,
  limit: number,
): boolean {
  const sans = game.movesSan;
  /*
   * WHICH OPENING IS THIS GAME, RESOLVED ONCE.
   *
   * `bookMoveAt` used to ask "what does ANY of our books offer here", and at a shared position
   * that is answered by registry order: `1.d4 d5` belongs to the London System and the Queen's
   * Gambit Declined equally at two plies, so the Queen's Gambit's move was recommended inside a
   * London System card, and inside the Queen's Gambit card too. Resolving the game's opening
   * from the whole line first — by how far each book FOLLOWS it, not by list position — and
   * scoping every position in the game to it makes the recommendation belong to the opening the
   * user is actually playing.
   *
   * Once per game, not once per position: the whole point is to use the DEEPEST evidence, and
   * a prefix three plies long has very little of it.
   */
  const gameOpeningId = bestOpeningForLine([sans])?.id ?? null;
  const board = new Chess();
  // The SAN of the last move played, tracked as the board advances, so a
  // position can record what created it without replaying the game again.
  let previousSan: string | null = null;
  // The full movelist so far. This grows as the loop advances; it is COPIED
  // into each candidate because the same array must not be mutated after a
  // candidate captured it.
  const prefix: string[] = [];

  for (let ply = 0; ply < Math.min(sans.length, maxPly); ply++) {
    const isUserMove = (ply % 2 === 0) === (game.color === 'w');
    // The FEN is read only when a position is actually created. It used to be
    // read on every ply — including the opponent's, which the loop then
    // `continue`s past — so half the serialisations of the hottest loop in the
    // app were thrown away.
    let fen = '';

    let san: string | null = null;
    let uci: string | null = null;
    try {
      if (isUserMove) fen = board.fen();
      const m = board.move(sans[ply]);
      san = m?.san ?? null;
      uci = m ? m.from + m.to + (m.promotion ?? '') : null;
    } catch {
      break;
    }
    if (!san) break;

    // Only the user's OWN moves are training positions.
    if (!isUserMove) {
      previousSan = san;
      prefix.push(san);
      continue;
    }

    const key = `${fenKey(fen)}|${ply % 2 === 0 ? 'w' : 'b'}`;

    // `fen` was captured before the move, so it IS the board this decision is
    // made from — which is what the book move has to be legal in. Passed as a
    // string so the book check does not have to re-serialise the caller's own
    // board, and does not build one until there is a move worth verifying.
    const side = (ply % 2 === 0 ? 'w' : 'b') as 'w' | 'b';
    const bm = bookMoveAt(fen, sans, ply, san, gameOpeningId);

    const existing = byKey.get(key);
    if (existing) {
      existing.timesSeen = (existing.timesSeen ?? 1) + 1;
      previousSan = san;
      prefix.push(san);
      continue;
    }

    const cand: Cand = {
      key, fen, ply, side,
      game, playedSan: san, playedUci: uci,
      inBook: bm.inBook, bookSan: bm.san, bookReplies: bm.replies,
      prevSan: previousSan,
      // A snapshot: `prefix` keeps growing for later plies of this game.
      prefixSan: prefix.slice(),
    };
    cands.push(cand);
    byKey.set(key, cand);
    previousSan = san;
    prefix.push(san);
    if (cands.length >= limit) return true;
  }
  return false;
}

/**
 * The same derivation, in slices, so the JS thread is never held.
 *
 * WHY THE FIRST BUILD CANNOT BE SYNCHRONOUS
 * -----------------------------------------
 * The derivation is ~4,100 chess.js moves at ~0.2 ms each: about a second of
 * blocked main thread on a desktop and several seconds on the phone. That is
 * tolerable behind a progress card ONLY if the screen can actually paint and
 * respond while it happens — and it cannot, because one synchronous call owns
 * the thread until it returns. The "Stop" button on that card is dead for the
 * duration, which is the same class of bug as the freeze the user reported on
 * the play screen: work that looks like a hang because nothing can be drawn or
 * touched.
 *
 * So the games are derived in slices with a real yield between them, and the
 * progress the card shows is the honest count. `shouldStop` is honoured at every
 * slice boundary, which is what makes the button work.
 */
export async function deriveCandidatesAsync(
  games: LichessGame[],
  opts: {
    limit?: number;
    maxPly?: number;
    /** Games per slice. Bigger = fewer yields, more time blocked per yield. */
    slice?: number;
    shouldStop?: () => boolean;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<Cand[]> {
  const limit = opts.limit ?? 120;
  const maxPly = opts.maxPly ?? 20;
  const slice = opts.slice ?? 8;
  const cands: Cand[] = [];
  const byKey = new Map<string, Cand>();
  const total = games.length;

  for (let i = 0; i < total; i++) {
    if (opts.shouldStop?.() === true) break;
    if (deriveFromGame(games[i], maxPly, cands, byKey, limit)) break;
    // Yield every slice, and after the last one only if there is more to do.
    if ((i + 1) % slice === 0 && i + 1 < total) {
      opts.onProgress?.(i + 1, total);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  // One final tick, so the bar lands on 100% even when the loop finished on a
  // slice boundary (or stopped early — in which case the caller is leaving).
  if (opts.shouldStop?.() !== true) opts.onProgress?.(total, total);
  return cands;
}

/**
 * Derive candidates and attach an ENGINE-FREE `GamePosition` to each.
 *
 * This is the "list the opening names without waiting" path: `options` is empty
 * and `recommendUci` falls back to the book move when we have one and to the
 * played move otherwise. Nothing here is a lie — an empty option list honestly
 * means "not analysed yet", and the UI shows the book move as the
 * recommendation. `analyseFamily` fills in the engine verdict afterwards for
 * whichever family the user opens.
 */
export function analysedPositionsFromGames(
  games: LichessGame[],
  opts: { maxGames?: number; maxPly?: number } = {},
): GamePosition[] {
  const maxGames = opts.maxGames ?? 160;
  const cands = deriveCandidates(games.slice(0, maxGames), {
    limit: Number.MAX_SAFE_INTEGER,
    maxPly: opts.maxPly ?? 20,
  });
  return analysedPositionsFromCandidates(cands);
}

/**
 * The engine-free `GamePosition` for each candidate — the half of
 * `analysedPositionsFromGames` that is not a chess.js replay.
 *
 * Split out because the two halves have very different costs and the screen
 * needs BOTH products of one derivation: the list from the positions, the engine
 * pass from the candidates. Deriving twice cost a full replay of every game; this
 * makes the replay happen once, in `deriveCandidates`, and turns the mapping into
 * the array pass it always should have been.
 */
export function analysedPositionsFromCandidates(cands: Cand[]): GamePosition[] {
  const out: GamePosition[] = [];
  for (const c of cands) {
    out.push({
      key: c.key,
      fen: c.fen,
      ply: c.ply,
      side: c.side,
      gameId: c.game.id,
      gameUrl: c.game.url,
      opening: c.game.opening || 'Unknown opening',
      playedSan: c.playedSan,
      playedUci: c.playedUci,
      prevSan: c.prevSan,
      prefixSan: c.prefixSan,
      inBook: c.inBook,
      bookSan: c.bookSan,
      bookReplies: c.bookReplies ?? [],
      /*
       * The recommendation, before the engine has spoken.
       *
       * `recommendSan` is our book move when we ship one, else the user's own
       * move (there is nothing better to say yet). `recommendUci` is left null
       * here and filled in below, because turning SAN into UCI needs a board.
       *
       * Careful with the intent: when the user PLAYED the book move, the two
       * sides of this ternary agree and the result is a recommendation equal to
       * their own move -- which is exactly what makes the step silent, since
       * `stepFor` only builds a `choice` when the moves differ. When they
       * diverged, `recommendSan` is the book's move and the divergence becomes a
       * real prompt. That is the whole "your move vs ours" mechanism and it does
       * NOT need the engine: on the reference corpus all 285 line decisions come
       * from the book, and only 48 positions genuinely need a search.
       */
      recommendUci: c.inBook && c.bookSan ? null : c.playedUci,
      recommendSan: c.inBook && c.bookSan ? c.bookSan : c.playedSan,
      options: [],
      timesSeen: 1,
    });
  }

  // The book recommendation needs a UCI too, and turning SAN into UCI needs the
  // board — do it once here rather than in every consumer.
  for (const p of out) {
    if (p.recommendUci == null && p.recommendSan) {
      try {
        const c = new Chess(p.fen);
        const m = c.move(p.recommendSan);
        if (m) p.recommendUci = m.from + m.to + (m.promotion ?? '');
      } catch { /* leave null: the UI shows the SAN it has */ }
    }
  }

  return out;
}

/**
 * The candidate list for ONE opening family — derived WITHOUT replaying a game
 * the family does not contain.
 *
 * THE SCOPE FIX
 * -------------
 * `analyseFamily` is called when the user OPENS one family, and it wants that
 * family's positions. The way to get them used to be `deriveCandidates(all of
 * the user's games)`, which replays every game with chess.js — and chess.js
 * costs ~0.2 ms a move, so 160 games x 24 plies is ~4,100 moves and roughly a
 * second of blocked main thread on a desktop, several seconds on the phone that
 * runs the app. All of it spent to answer a question about one opening.
 *
 * The filter is exact rather than approximate: `buildFamilyLines` groups
 * positions by `position.opening`, and `position.opening` is the game's own
 * `opening` string. So selecting the games whose `opening` matches the family
 * selects a SUPERSET of the family's positions — every position of that family
 * comes from one of those games — and nothing else is touched.
 *
 * The colour filter is exact too, for the same reason: `deriveCandidates` only
 * creates a position when the move belongs to the tracked player, so the
 * side-to-move of every such position is that player's colour. A family is
 * already split by colour (`FamilyLine.side`), so this cannot lose a position.
 *
 * The filter runs over the game's OWN metadata, so it costs nothing — no board
 * is built for a game that is then thrown away.
 */
export function deriveFamilyCandidates(
  games: LichessGame[],
  sourceName: string | readonly string[],
  side: 'w' | 'b',
  opts: { maxPly?: number } = {},
): Cand[] {
  /*
   * A FAMILY CAN BE MORE THAN ONE Lichess LABEL.
   *
   * This took one name and compared it with `===`. Families are now built by grouping
   * several Lichess labels into one card - "Queen's Gambit" and "Queen's Pawn" are one
   * opening to the app and two labels to Lichess - so for a merged family the single
   * string matched nothing. The engine pass then received an empty list, which is why the
   * user saw no evaluation for the move he played or the one we recommend.
   *
   * So the argument is a string OR a set of labels, and membership is what is tested.
   * `'Unknown opening'` is always accepted because it is this module's own fallback for an
   * unlabelled game, and a family built from such games would otherwise be unable to find
   * them. A single string still works, so existing callers are unaffected.
   */
  const labels = new Set<string>(
    typeof sourceName === 'string'
      ? [sourceName, 'Unknown opening']
      : [...sourceName, 'Unknown opening'],
  );
  const mine = games.filter(
    (g) => labels.has(g.opening || 'Unknown opening') && g.color === side,
  );
  if (mine.length === 0) return [];
  return deriveCandidates(mine, {
    limit: Number.MAX_SAFE_INTEGER,
    maxPly: opts.maxPly ?? 20,
  });
}

/**
 * Rebuild the candidate list from positions that are ALREADY derived.
 *
 * THE OTHER HALF OF THE SAME FIX
 * ------------------------------
 * The engine pass needs `Cand[]`, and re-deriving them was a second full replay
 * of the library even when the family filter above had already narrowed it. A
 * `GamePosition` carries everything a `Cand` carries except the `game` object,
 * and that object is only ever read for `id`, `url` and `opening` — all three of
 * which are already on the position. So a screen that has the positions (which
 * it always does: the list is built from them, and the on-disk cache stores them
 * on each family) can produce candidates with no chess work at all.
 */
export function candidatesFromPositions(positions: GamePosition[]): Cand[] {
  const out: Cand[] = [];
  for (const p of positions) {
    out.push({
      key: p.key,
      fen: p.fen,
      ply: p.ply,
      side: p.side,
      // The three fields `analyseGameOpenings` reads off the game. The cast is
      // honest about what this is: a stand-in carrying the position's own
      // provenance, not a replacement for a game record.
      game: {
        id: p.gameId,
        url: p.gameUrl,
        opening: p.opening,
      } as unknown as LichessGame,
      playedSan: p.playedSan,
      playedUci: p.playedUci,
      inBook: p.inBook,
      bookSan: p.bookSan,
      bookReplies: p.bookReplies ?? [],
      prevSan: p.prevSan,
      prefixSan: p.prefixSan,
      timesSeen: p.timesSeen,
    });
  }
  return out;
}

/**
 * HOW MANY SILENT SEARCHES IN A ROW END THE PASS.
 *
 * A host that has answered NOTHING three times running is not going to answer:
 * `engine.analyse` only returns null when its safety timer fired because the
 * WebView never replied, and that is the state that made the device report read
 * as a freeze — "it took too much in 'checking our ideas here' then i get stuck
 * there". Each silent request already costs `movetime + 8s`, so three bounds the
 * dead-host case to about half a minute and lets the screen say honestly that
 * the engine did not answer, instead of holding the spinner for the length of
 * the whole sample.
 */
const MAX_SILENT_SEARCHES = 3;

/**
 * Analyse up to `limit` positions the user reached in their games.
 *
 * Positions are de-duplicated by FEN across games, and each is analysed ONCE
 * with MultiPV so one search yields the best move plus its alternatives. The
 * played move is always included in `options` even when the engine did not
 * suggest it — otherwise the whole "here is what you played vs what we
 * recommend" comparison would be missing its other half.
 */
export async function analyseGameOpenings(
  games: LichessGame[],
  opts: {
    limit?: number;
    /** Stop analysing after this ply — openings, not whole games. */
    maxPly?: number;
    /** MultiPV width. 3 is enough for "best + two alternatives". */
    multipv?: number;
    depth?: number;
    /**
     * Hard time cap per search, in milliseconds. Without it a depth search runs
     * unbounded (`go depth N`, which on a phone took minutes), so any caller
     * that pays for MANY searches must pass one: the host turns it into
     * `go depth N movetime M`, and the search stops at whichever lands first.
     */
    movetime?: number;
    /**
     * Hard time cap for the played-move probe, when one is needed.
     *
     * THE PROBE IS NOT THE MAIN SEARCH AND MUST NOT PAY THE MAIN SEARCH'S PRICE.
     *
     * When the move the user played falls outside the MultiPV window, a second
     * search scores the position after it so the comparison has a number instead
     * of a dash. That search is single-line — it has no alternatives to rank and
     * no recommendation to make — so it can be given a smaller budget than the
     * MultiPV search without changing what the screen recommends. This used to
     * inherit `movetime`, which made every unranked move cost a second full
     * search and was half of the "Checking our ideas here…" wait.
     *
     * Defaults to `movetime`, so a caller that does not opt in keeps the old
     * behaviour exactly.
     */
    probeMovetime?: number;
    shouldStop?: () => boolean;
    onProgress?: (done: number, total: number) => void;
    /**
     * Positions to analyse, instead of deriving them from `games`.
     *
     * This is what lets the opening builder analyse ONE family's positions
     * without re-deriving (and without paying for) every other family's. The
     * caller passes the output of `analysedPositionsFromGames` filtered down to
     * the family it is showing.
     */
    positions?: Cand[];
  } = {},
): Promise<GameOpeningReport> {
  const limit = opts.limit ?? 120;
  const maxPly = opts.maxPly ?? 20;
  const multipv = Math.max(2, Math.min(4, opts.multipv ?? 3));
  const depth = opts.depth ?? 12;
  const movetime = opts.movetime;
  const probeMovetime = opts.probeMovetime ?? movetime;
  const isCancelled = () => opts.shouldStop?.() === true;
  const engine = getEngine();

  const positions: GamePosition[] = [];
  const byKey = new Map<string, GamePosition>();
  const known = new Set<string>();
  const unknown = new Set<string>();

  // Candidates are derived WITHOUT the engine so the caller can decide what to
  // analyse — and so the list of opening names can paint before any search runs.
  const cands: Cand[] = opts.positions ?? deriveCandidates(games, { limit, maxPly });
  for (const c of cands) {
    const fam = c.game.opening || 'Unknown';
    if (c.inBook) known.add(fam); else unknown.add(fam);
  }

  // ---- the engine pass -------------------------------------------------------
  let done = 0;
  let silent = 0;
  for (const cand of cands) {
    if (isCancelled()) break;

    let info;
    try {
      // ONE search yields the best move AND its alternatives, because `multipv`
      // makes Stockfish report the top N lines together. Asking for each
      // alternative separately would be N searches per position.
      info = await engine.analyse(cand.fen, { depth, multipv, movetime });
    } catch {
      continue;
    }
    done++;
    opts.onProgress?.(done, cands.length);
    if (!info) {
      // Nothing came back, so nothing was learned. A few of these in a row is
      // the WebView failing, not the position being hard — stop asking rather
      // than spend `MAX_SILENT_SEARCHES × (movetime + 8s)` more on dead air.
      silent++;
      if (silent >= MAX_SILENT_SEARCHES) break;
      continue;
    }
    silent = 0;

    // `engine.analyse` returns `lines` (best first) when multipv > 1, and falls
    // back to the single best line otherwise — so this handles both shapes.
    const rawLines = normaliseMultipv(info);
    if (rawLines.length === 0) continue;

    const bestCp = rawLines[0].cp;

    const options: MoveOption[] = [];
    const seenUci = new Set<string>();

    for (const line of rawLines) {
      if (seenUci.has(line.uci)) continue;
      seenUci.add(line.uci);
      const san = uciToSan(cand.fen, line.uci);
      if (!san) continue;
      const isPlayed = line.uci === cand.playedUci;
      // "Is this our book move" is a question about the MOVE, and the answer now
      // comes from the reply set rather than from comparing against one study's
      // single `bookSan`. Before, a move the books DO contain could be reported as
      // "not our book move" purely because the winning study happened to name a
      // different one.
      const isBook = (cand.bookReplies ?? []).includes(san);
      options.push({
        uci: line.uci,
        san,
        cp: line.cp,
        lossCp: Math.max(0, bestCp - line.cp),
        played: isPlayed,
        book: isBook,
        note: isPlayed && isBook
          ? 'Your move — and our book move'
          : isBook
            ? 'Our book move'
            : isPlayed
              ? 'What you played'
              : 'Engine alternative',
      });
    }

    // The played move must always be present, even if the engine ranked it
    // outside the MultiPV window — it is half the lesson.
    if (cand.playedUci && cand.playedSan && !seenUci.has(cand.playedUci)) {
      /*
       * MEASURE THE MOVE HE ACTUALLY PLAYED, INSTEAD OF PRINTING A DASH.
       *
       * The previous version left `cp: NaN` here, with the reasoning that a number we did
       * not measure should not be claimed. That reasoning is right and the outcome is wrong:
       * the user saw "You played  —  /  Engine suggests  +0.24" and had no way to judge his
       * own move, which is the entire point of a comparison. His report: *"there is no
       * engine eval on the move i played so i can compare it to the suggested move"*.
       *
       * So it is measured. ONE extra search, on the position AFTER his move, and the score
       * is negated to put it on the same scale as the shortlist.
       *
       * The negation is the part that has to be right. A UCI score is from the point of view
       * of the side to move. Every line in the shortlist comes from ONE search, so they all
       * share the mover's perspective and are directly comparable - which is what makes
       * `lossCp = bestCp - line.cp` meaningful. Searching the position after his move means
       * the side to move is now his OPPONENT, so that score is the mirror image and has to
       * be negated. Mate scores are handled by the same negation, because `normaliseMultipv`
       * already encodes a mate as a signed magnitude.
       *
       * If the search fails, it stays NaN and the UI shows the dash - so a missing engine
       * degrades to the old behaviour rather than to a wrong number.
       */
      let playedCp = NaN;
      let playedAfter: string | null = null;
      try {
        const b = new Chess(cand.fen);
        const mv = b.move({
          from: cand.playedUci.slice(0, 2),
          to: cand.playedUci.slice(2, 4),
          promotion: cand.playedUci[4],
        });
        if (mv) playedAfter = b.fen();
      } catch {
        playedAfter = null;
      }
      if (playedAfter) {
        try {
          const probe = await engine.analyse(playedAfter, { depth, multipv: 1, movetime: probeMovetime });
          const cp = normaliseMultipv(probe)[0]?.cp;
          if (Number.isFinite(cp)) playedCp = -cp;
        } catch {
          playedCp = NaN;
        }
      }
      options.push({
        uci: cand.playedUci,
        san: cand.playedSan,
        cp: playedCp,
        lossCp: Number.isFinite(playedCp) ? Math.max(0, bestCp - playedCp) : NaN,
        played: true,
        book: cand.playedSan != null && (cand.bookReplies ?? []).includes(cand.playedSan),
        note: Number.isFinite(playedCp)
          ? 'What you played'
          : 'What you played (the engine could not score it)',
      });
    }

    if (options.length === 0) continue;

    // What we suggest training: the book move when one exists, else the engine's
    // top choice. This is the "recommend" arrow.
    const bookOpt = options.find((o) => o.book);
    const best = bookOpt ?? options[0];

    const gp: GamePosition = {
      key: cand.key,
      fen: cand.fen,
      ply: cand.ply,
      side: cand.side,
      gameId: cand.game.id,
      gameUrl: cand.game.url,
      opening: cand.game.opening || 'Unknown opening',
      playedSan: cand.playedSan,
      playedUci: cand.playedUci,
      prevSan: cand.prevSan,
      prefixSan: cand.prefixSan,
      inBook: cand.inBook,
      bookSan: cand.bookSan,
      bookReplies: cand.bookReplies ?? [],
      recommendUci: best.uci,
      recommendSan: best.san,
      options,
      timesSeen: cand.timesSeen ?? 1,
    };
    positions.push(gp);
    byKey.set(gp.key, gp);
  }

  // Most-played positions first: a position the user reaches constantly is the
  // one most worth getting right, and it makes the list feel personal.
  positions.sort((a, b) => b.timesSeen - a.timesSeen || a.ply - b.ply);

  return {
    positions,
    knownOpenings: [...known].sort(),
    unknownOpenings: [...unknown].sort(),
  };
}

/**
 * Analyse ONE opening family's positions, with the engine.
 *
 * The builder calls this when the user taps a family, so the engine cost is
 * proportional to the one opening they are actually looking at rather than to
 * their entire game history. `onProgress` reports done/total for the family, so
 * the screen can show an honest bar for a wait that is now seconds rather than
 * minutes.
 *
 * Returns the same `GamePosition` shape `analyseGameOpenings` produces, which is
 * what lets `buildFamilyLines` and the drill path be identical either way.
 */
export async function analyseFamily(
  cands: Cand[],
  opts: {
    multipv?: number;
    depth?: number;
    /**
     * Hard time cap per search, in milliseconds — see `analyseGameOpenings`.
     * Passed through so the family check cannot run an unbounded search.
     */
    movetime?: number;
    /**
     * Cheaper time cap for the played-move probe — see `analyseGameOpenings`.
     * The probe ranks no alternatives, so the family check budgets it separately.
     */
    probeMovetime?: number;
    shouldStop?: () => boolean;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<GamePosition[]> {
  if (cands.length === 0) return [];
  const report = await analyseGameOpenings([], {
    positions: cands,
    limit: Number.MAX_SAFE_INTEGER,
    multipv: opts.multipv,
    depth: opts.depth,
    movetime: opts.movetime,
    probeMovetime: opts.probeMovetime,
    shouldStop: opts.shouldStop,
    onProgress: opts.onProgress,
  });
  return report.positions;
}

/**
 * Pull the MultiPV lines out of the engine reply, best first.
 *
 * `engine.analyse` populates `lines` when `multipv > 1` and leaves it undefined
 * for an ordinary single-line search, so both cases land here and are normalised
 * to the same list. A mate is folded onto the centipawn scale the same way the
 * game scan does it, so `lossCp` between a mate line and a non-mate line is
 * a real number rather than `null - 42`.
 */
function normaliseMultipv(info: unknown): { uci: string; cp: number }[] {
  const out: { uci: string; cp: number }[] = [];
  const anyInfo = info as {
    bestMoveUci?: string | null;
    scoreCp?: number | null;
    mateIn?: number | null;
    pvUci?: string[];
    lines?: { uci?: string; pvUci?: string[]; scoreCp?: number | null; mateIn?: number | null }[];
  };

  const cpFrom = (cp: number | null | undefined, mate: number | null | undefined): number => {
    if (mate != null) {
      const mag = 10000 - Math.min(Math.abs(mate), 60) * 100;
      return mate > 0 ? mag : -mag;
    }
    return cp ?? 0;
  };

  if (Array.isArray(anyInfo.lines) && anyInfo.lines.length) {
    for (const l of anyInfo.lines) {
      const uci = l.uci ?? l.pvUci?.[0];
      if (uci) out.push({ uci, cp: cpFrom(l.scoreCp, l.mateIn) });
    }
    if (out.length) return out;
  }

  const first = anyInfo.pvUci?.[0] ?? anyInfo.bestMoveUci ?? null;
  if (first) out.push({ uci: first, cp: cpFrom(anyInfo.scoreCp, anyInfo.mateIn) });
  return out;
}

/** SAN for a UCI move in a position, or null when it does not apply. */
function uciToSan(fen: string, uci: string): string | null {
  try {
    const c = new Chess(fen);
    const m = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return m?.san ?? null;
  } catch {
    return null;
  }
}

/**
 * An engine score as a player reads it: `+0.34`, `-0.60`, `#3`.
 *
 * The request: *"if the user could see the engine eval (for example +0.3) for his
 * move and for the suggested move … that would be great"*.
 *
 * A comparison that says "your move costs you 0.6" is abstract; one that shows
 * `-0.60` beside `+0.21` is the actual difference, and it is the same number the
 * verdict was decided from, so the headline and the score cannot disagree.
 *
 * Mate is folded into the centipawn scale by `normaliseMultipv` (mate in N becomes
 * `10000 - N*100`), so it is detected and rendered as `#N` rather than as a
 * hundred-pawn score, which would be absurd on screen.
 *
 * `null` when the engine never judged the move. The UI must then show a dash and
 * not `0.00`: "we did not measure this" and "this is equal" are different facts,
 * and conflating them is how a trainer ends up accusing the user of a mistake it
 * has no evidence for.
 */
export function formatEvalCp(cp: number | null | undefined): string | null {
  if (cp == null || !Number.isFinite(cp)) return null;
  if (Math.abs(cp) >= 9000) {
    const n = Math.max(1, Math.round((10000 - Math.abs(cp)) / 100));
    return cp > 0 ? `#${n}` : `-#${n}`;
  }
  const pawns = (Math.abs(cp) / 100).toFixed(2);
  return cp >= 0 ? `+${pawns}` : `-${pawns}`;
}

/**
 * Render a centipawn delta the way a player reads it.
 *
 * "+0.31" is a number; "slightly worse" is an opinion a player can act on. We
 * give both, because the user explicitly asked for "engine differences" and a
 * bare number would not tell them whether -0.4 matters.
 */
export function describeDelta(lossCp: number): string {
  if (!Number.isFinite(lossCp)) return '';
  if (lossCp <= 10) return 'equal to the best move';
  const pawns = (lossCp / 100).toFixed(2).replace(/0$/, '');
  if (lossCp < 50) return `slightly worse (−${pawns})`;
  if (lossCp < 110) return `inaccuracy (−${pawns})`;
  if (lossCp < 250) return `mistake (−${pawns})`;
  return `blunder (−${pawns})`;
}

/**
 * Merge freshly-analysed positions with the user's earlier adoptions.
 *
 * This is the function that makes the "we will keep adding repertoires" promise
 * safe. An adopted move is never thrown away: if a later app version ships a
 * book for an opening the user had already self-discovered, the adoption is
 * still applied, because the user's choice is theirs and we have no business
 * overwriting it silently. What DOES change is `selfDiscovered`, which flips to
 * false once we ship the opening — so the UI can say "we now have a book for
 * this" without discarding the user's line.
 */
export function applyAdoptions(
  positions: GamePosition[],
  adopted: Record<string, CustomLine>,
): GamePosition[] {
  return positions.map((p) => {
    const a = adopted[p.key];
    if (!a) return p;
    // The user's adopted move wins over our recommendation.
    const match = p.options.find((o) => o.uci === a.adoptedUci);
    return {
      ...p,
      recommendUci: a.adoptedUci,
      recommendSan: a.adoptedSan,
      options: match
        ? p.options.map((o) => ({ ...o, note: o.uci === a.adoptedUci ? 'Your repertoire move' : o.note }))
        : p.options,
    };
  });
}

/** Count how many positions the user has decided on, for the UI summary. */
export function countAdopted(adopted: Record<string, CustomLine>): number {
  return Object.keys(adopted).length;
}

// ---------------------------------------------------------------------------
// Bridge: custom repertoire -> the Train screen's drill pool
// ---------------------------------------------------------------------------

/**
 * Synthetic study id for the user's own repertoire.
 *
 * The Train screen keys SRS state by `${studyId}|${fenKey(fen)}` (see
 * `positionKeyAtPly`), so a custom exercise needs a study id that can never
 * collide with a shipped one. Shipped ids are real slug-ish strings (`s1.2`,
 * `qg4`, `kia9`), so a reserved prefix with a `/` in it is unambiguous — and
 * deliberately NOT an id any `openings.ts` entry could ever take, because if it
 * collided the user's drill history would be shared with a book study's.
 */
export const CUSTOM_STUDY_ID = 'custom/your-openings';

/** The title shown in the Train screen's header for a custom exercise. */
export const CUSTOM_STUDY_TITLE = 'Your openings';

/**
 * Turn the user's adopted decisions into trainable exercises.
 *
 * WHY THIS IS NOT `buildTrainExercises`
 * -------------------------------------
 * A shipped study is a tree of 30-ply lines; an adopted position is a single
 * move with no continuation. So each adoption becomes a one-move line: the
 * position from the game, and the move the user chose for it. Deliberately NOT
 * engine-completed — the thing being drilled is the user's OWN decision, and
 * appending our engine's continuation would silently drill moves they never
 * agreed to and never saw.
 *
 * THE PREFIX, AND WHY IT IS NOT OPTIONAL
 * --------------------------------------
 * The Train screen decides whose turn it is purely from the ply INDEX, not from
 * the FEN: `userTurn = ply % 2 === userMod`, with `userMod = 0` for White and 1
 * for Black (see TrainScreen `handleMove`). Because `ply` counts moves *from the
 * start of the line*, a single-move line only ever has ply 0 — which is White's
 * turn by that rule. So a Black adoption stored as a bare one-element line is
 * NEVER playable: `0 % 2 === 1` is false, `handleMove` returns false immediately,
 * and the exercise deadlocks on screen with no way to advance.
 *
 * The fix is to make every line start from the beginning of the game and end at
 * the user's move, so the user's move lands on an index whose parity really
 * matches their colour:
 *
 *     sans     = [...prefixSan, adoptedSan]
 *     startPly = prefixSan.length
 *
 * The screen auto-plays `sans[0..startPly-1]` and then hands over. Because the
 * prefix is the ACTUAL game moves, that hand-over position IS the game position
 * the user faced — which is also what makes the SRS key stable, since the screen
 * keys it as `${studyId}|${fenKey(board before the user's move)}`.
 *
 * Note that a partial prefix is NOT enough: an earlier version carried only the
 * immediately preceding move, which replayed correctly for Black's first move
 * and was illegal for every deeper position (a `Bg2` at ply 7 cannot be played
 * from the initial board). The full prefix is required.
 *
 * A position with no prefix at all is a White move on move 1, which needs none.
 */
/**
 * Is `sans[i]` just taking back the piece `sans[i-1]` brought into the square?
 *
 * THE DEFINITION, AND IT IS NOT THE OBVIOUS ONE
 * ----------------------------------------------
 * A recapture is a capture landing on the square the OPPONENT'S LAST MOVE LANDED ON:
 * `1.e4 d5 2.exd5` — the pawn on d5 has just arrived there, and taking it is taking it back.
 * That is what a recapture is, and it is exactly one comparison to make.
 *
 * The first version of this compared the capture's destination to the previous move's
 * ORIGIN instead, which reads plausibly and identifies almost nothing: in `1.e4 d5 2.exd5`
 * Black moved d7->d5, so the origins differ and the real recapture was missed, while the
 * comparison only ever fires in the rare case where a player captures a piece by moving onto
 * the square the opponent retreated from.
 *
 * WHY IT MATTERS - THE USER REPORTED IT
 * -------------------------------------
 * *"in the training it always give me simple position whre i have to just recapture.
 * I want positions to play a move according to the opening not just a recapture!"*
 *
 * Taking a piece back is not chess knowledge. It is the one position in the opening where
 * almost every player finds the move, so drilling it teaches nothing and, because these were
 * scored like any other decision, it crowded out the moves that actually need work. It was
 * happening constantly: an adopted position is one where the user chose between a book move
 * and their own, and "their own" is very often the recapture the engine also rated first.
 */
function isRecapture(sans: string[], i: number): boolean {
  if (i <= 0 || i >= sans.length) return false;
  const c = new Chess();
  for (let k = 0; k < i; k++) {
    try { c.move(sans[k]); } catch { return false; }
  }
  // Where the opponent's move just put a piece.
  let landedOn: string;
  try { landedOn = c.move(sans[i - 1]).to; } catch { return false; }
  try {
    const m = c.move(sans[i]);
    // `isCapture()` rather than testing `captured`: in chess.js 1.4 `captured` is the piece
    // TYPE (a string like 'p'), not a count, so `captured > 0` does not mean what it looks
    // like. The repo's `tsc` never caught that because this import resolves untyped there.
    // `isCapture()` is true for en passant too, which is what we want.
    return m.isCapture() && m.to === landedOn;
  } catch {
    return false;   // an unplayable move is not a recapture; it is not this function's problem
  }
}

export function buildCustomExercises(
  adopted: Record<string, CustomLine>,
  max = 12,
): TrainExercise[] {
  const out: TrainExercise[] = [];
  const now = Date.now();

  for (const line of Object.values(adopted)) {
    // The side to move is encoded in the FEN, and it must equal the side the
    // user played — that is what makes the adopted move *their* move.
    const side = line.fen.split(' ')[1];
    if (side !== 'w' && side !== 'b') continue;
    if (!line.adoptedSan) continue;

    // `prefixSan` may be absent on lines saved by an older build; fall back to
    // the single predecessor when it is, which is still correct for ply 1.
    const prefix = line.prefixSan
      ?? (side === 'b' && line.prevSan ? [line.prevSan] : []);

    // The prefix must have the right parity to hand over on the user's turn. If
    // it does not (a corrupt or hand-edited record), skip rather than ship a card
    // that cannot be played. `prefix.length` is where the user moves, so it must
    // be even for White and odd for Black.
    const expectedParity = side === 'w' ? 0 : 1;
    if (prefix.length % 2 !== expectedParity) continue;

    /*
     * THE DRILL IS SEVERAL MOVES, NOT ONE.
     *
     * The line used to stop at the adopted move, so `totalLen = startPly + 1`: the user played
     * exactly one move and the screen flashed and moved on. Both halves of "the training
     * always gives me simple positions" follow from that plus the move itself being a
     * recapture.
     *
     * It now continues with OUR book for the same opening, which is what "positions to play a
     * move according to the opening" asks for: after his move the opponent's reply is
     * auto-played and he is asked again, several times, on moves that come from the opening
     * rather than from a piece that has just been taken.
     *
     * Scoped to the opening the decision was attributed to, so the Queen's Gambit's book
     * cannot finish a London System drill - the same tie that put `c4` in the London card.
     */
    const stem = [...prefix, line.adoptedSan];
    const startPly = prefix.length;
    const tail = drillContinuation(stem, line.openingId);
    const sans = tail && tail.length > 0 ? [...stem, ...tail] : stem;

    const trainLine: TrainLine = {
      id: `${CUSTOM_STUDY_ID}#${line.key}`,
      studyId: CUSTOM_STUDY_ID,
      index: 0,
      sans,
      isVariation: line.selfDiscovered,
      plyCount: sans.length,
    };

    out.push({
      id: `${trainLine.id}|${startPly}`,
      studyId: CUSTOM_STUDY_ID,
      studyTitle: CUSTOM_STUDY_TITLE,
      line: trainLine,
      startPly,
      userColor: side,
      // Rank by RECENCY of the decision.
      //
      // A shipped study scores by SRS urgency and level, neither of which exists
      // here, so recency is the whole signal: the move the user chose a moment
      // ago is the one they most want to confirm stuck, and an old decision has
      // presumably already been drilled.
      //
      // The first version of this was `3 + decidedAt / now`, which looks like a
      // recency term but is not: `decidedAt / now` is ~1.0 for ANY recent
      // timestamp (a day-old one differs in the fifth decimal), so every item
      // scored identically and the random tiebreak decided the order — the
      // harness caught it selecting none of the five newest decisions. The decay
      // must be measured in real elapsed time, so it is hours over a fortnight:
      // brand new -> ~5, two weeks old -> ~3, older -> 3. Kept inside the same
      // 1..5 band the shipped scores use so the two sources are comparable.
      score: 5 - Math.min(2, (now - (line.decidedAt || 0)) / (14 * 24 * 3600 * 1000) * 2)
        + Math.random() * 0.05,
    });
  }

  /*
   * RECAPTURES ARE REMOVED, NOT MERELY RANKED LOWER.
   *
   * "Train me openings" means openings. If the user has four real decisions and twelve
   * recaptures, showing him the four is right; burying the recaptures at the bottom would
   * still put one in front of him every fourth exercise, which is the complaint. They are
   * offered only when there is nothing else, because an empty trainer is worse than an easy one.
   */
  const real = out.filter((ex) => !isRecapture(ex.line.sans, ex.startPly));
  const chosen = real.length > 0 ? real : out;
  chosen.sort((a, b) => b.score - a.score);
  return chosen.slice(0, max);
}

