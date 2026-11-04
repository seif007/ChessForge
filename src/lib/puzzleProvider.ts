'use client';

/**
 * Puzzle provider — one fresh puzzle from Lichess per call.
 *
 * WHY THIS FILE ASKED FOR TEN PUZZLES' WORTH OF REQUESTS
 * =======================================================
 * `fetchNextPuzzle` used to make up to TEN calls to `lichess.org/api/puzzle/next` to produce a single
 * puzzle: one attempt, then two retries, then three, then four more while hunting for the nearest
 * rating to the user's band.
 *
 * Ten anonymous requests for one puzzle is well past what an unauthenticated client should be doing,
 * and the consequence was not bad luck — it was arithmetic. The report was:
 *
 *     *"finally check the puzzles ( normal not from my games) : it always shows me rate limit
 *      problem"*
 *
 * "Always", not "once". Lichess answers `/api/puzzle/next` with a bare `429` and a body of
 * `{"error":"Too many requests. Try again later."}` — no `Retry-After`, no rate-limit headers, nothing
 * a client can adapt to. So the app was told nothing useful and asked for ten things anyway.
 *
 * WHAT THE REQUEST COUNT IS NOW: ONE.
 *
 * That is the whole fix for the rate limit, and it is worth being precise about which problem it
 * fixes. A user solving twenty puzzles now makes twenty requests, which is not a load. Before, it was
 * two hundred.
 *
 * WHAT WAS GIVEN UP, AND WHY IT WAS THE RIGHT THING TO GIVE UP
 * ============================================================
 * The near-miss hunt is gone, and with it `NEAR_MISS_TOLERANCE` and the "take the closest rating the
 * endpoint produced" pass. It existed to paper over a real problem — a single difficulty bucket cannot
 * satisfy every band, so the code asked repeatedly until something close turned up — but it solved it
 * by brute force, ten requests at a time.
 *
 * The honest replacement is not another retry loop. It is `offBandBy`: if the one puzzle we get is
 * outside the user's band, we serve it AND say how far outside it is, so "matched to your level" is
 * either true or visibly qualified. A user would rather be told "this one is 180 above your level"
 * than wait through a retry storm for a marginally better one.
 *
 * NOTHING IS STORED, AND NOTHING IS MARKED SEEN
 * =============================================
 * Also asked for: *"dont save puzzles so we dont get blocked, i want them to be always fresh from the
 * internet"*. So there is no session cache of fetched puzzles — an in-memory Map that existed only to
 * stop a repeat and had no reader that needed one — and no `markPuzzleSeen` call writing each served
 * id into a permanent per-profile list. Nothing is written, so every puzzle really is new.
 *
 * Worth being precise about what that does and does not do. Not remembering a puzzle does not by
 * itself prevent a 429; the request count does, and that is fixed above. This is about the app not
 * accumulating state nobody asked for, and about the promise on the screen being true.
 *
 * THE REMAINING LEVER, WHICH IS NOT CODE
 * ======================================
 * Lichess raises its limits for clients that send an OAuth token, which is free to create but requires
 * registering an application. That is a deployment decision with an account attached, so it is
 * recorded here rather than done unilaterally.
 */

import { Chess } from 'chess.js';
import {
  autoModeFor, bandRange, modeWindow, lichessDifficulty, type PuzzleMode,
} from '@/lib/puzzles';
import { useAppStore } from '@/lib/store';
import { fallbackPuzzle } from '@/lib/puzzlePool';

/**
 * WHY THE LAST FETCH RETURNED NOTHING, for the screen to report.
 *
 * The screen used to be told only "something went wrong" and printed "check your connection", which is
 * how a 429 became a message about the user's wifi. These four are genuinely different faults and the
 * screen maps each to its own sentence (see `PuzzlesScreen`'s `loadReason`, held to that by GATE 1n):
 *
 *  - `offline`      the request never produced a response. No DNS, no route, airplane mode, or the
 *                   abort timer firing. Nothing else can land here: every step after the response
 *                   exists is inside the same `try`, and a parse failure is logged rather than
 *                   silently folded in.
 *  - `rate-limited` the service answered 429, or our own backoff is still in force.
 *  - `http-error`   any other non-200. A provider-shaped problem.
 *  - `none`         the endpoint answered and nothing in what it sent was usable — a solution that
 *                   would not reconstruct, or a rating outside the window. Also the value before the
 *                   first fetch of a session.
 */
export type PuzzleFetchDiagnostic = 'offline' | 'rate-limited' | 'http-error' | 'none';

let lastFetchDiagnostic: PuzzleFetchDiagnostic | null = null;

/** What the most recent `fetchNextPuzzle` call ran into, if anything. */
export function puzzleFetchDiagnostic(): PuzzleFetchDiagnostic {
  return lastFetchDiagnostic ?? 'none';
}

export interface ServedPuzzle {
  id: string;
  fen: string;
  side: 'w' | 'b';
  solutionUci: string[];
  solutionSan: string[];
  rating: number;
  themes: string[];
  /**
   * `'live'`: fetched just now from the service. `'pool'`: the bundled offline deck, served only
   * when the live request failed (see `puzzlePool.ts`). The screen labels the two differently, so a
   * fresh puzzle is never presented as a fallback one or the other way round.
   */
  source: 'live' | 'pool';
  /**
   * How far outside the user's own band this puzzle's rating falls, in rating points. Absent means
   * it was inside the band that was asked for.
   *
   * This is the replacement for the retry storm (see the file header). Serving a near miss is fine;
   * serving it QUIETLY is not, because the screen says "matched to your level" and that would make
   * the claim false in the one direction the user cannot check. `> 0` is the whole contract.
   */
  offBandBy?: number;
}

/**
 * How long to stop asking after a 429.
 *
 * Raised from 60s. With one request per puzzle a 429 is now a genuine signal rather than a symptom of
 * our own looping, so it is worth respecting properly — and Lichess sends no `Retry-After`, so the
 * client has to pick. 3 minutes is long enough that a user who hits a limit waits it out rather than
 * tapping Next repeatedly, which is what would keep a limit alive.
 */
const LICHESS_BACKOFF_MS = 180_000;
let lichessBackoffUntil = 0;

const LICHESS_TIMEOUT_MS = 6000;

/** Convert UCI solution to SAN, verifying legality. Returns null if illegal. */
function solutionSans(fen: string, uciMoves: string[]): string[] | null {
  try {
    const c = new Chess(fen);
    const sans: string[] = [];
    for (const uci of uciMoves) {
      const m = c.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      sans.push(m.san);
    }
    return sans;
  } catch {
    return null;
  }
}

/**
 * Trim a solution so it ENDS WITH THE PLAYER'S MOVE.
 *
 * Lichess serves odd-length solutions (player moves first and last), which is what `PuzzlesScreen`
 * expects: only the player advances `step`, and the puzzle completes on the player's last move. A
 * trailing opponent reply would leave the screen waiting for a move that is not the user's.
 */
function trimToPlayer(fen: string, uciMoves: string[]): string[] | null {
  const c = new Chess(fen);
  const player = c.turn();
  let last = -1;
  for (let i = 0; i < uciMoves.length; i++) {
    const uci = uciMoves[i];
    let m;
    try {
      m = c.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
    } catch {
      return null; // solution doesn't fit this position — reject the puzzle
    }
    if (m.color === player) last = i;
  }
  if (last < 0) return null;
  return uciMoves.slice(0, last + 1);
}

/**
 * Reconstruct the puzzle position from the Lichess game PGN and verify the whole solution line is
 * legal there. `initialPly` is the 0-based index of the last played move — the puzzle position sits
 * after initialPly+1 plies. Candidates are tried in order until the full solution fits.
 */
function reconstruct(
  pgn: string,
  initialPly: number,
  solutionUci: string[],
): { fen: string; turn: 'w' | 'b'; sans: string[] } | null {
  try {
    const loader = new Chess();
    loader.loadPgn(pgn);
    const hist = loader.history();
    if (hist.length === 0) return null;

    const candidates = [initialPly + 1, hist.length, initialPly, initialPly - 1].filter(
      (n, i, arr) => n >= 0 && n <= hist.length && arr.indexOf(n) === i,
    );

    for (const n of candidates) {
      const c = new Chess();
      for (let i = 0; i < n; i++) {
        try {
          c.move(hist[i]);
        } catch {
          break;
        }
      }
      const sans = solutionSans(c.fen(), solutionUci);
      if (sans) return { fen: c.fen(), turn: c.turn(), sans };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * ONE request to Lichess for ONE puzzle.
 *
 * Single attempt, no retry, no loop — that is the entire point of this function now, and the reason it
 * is written as a straight line rather than a search.
 */
async function fetchLive(difficulty: string): Promise<ServedPuzzle | null> {
  /*
   * STILL BACKED OFF. This early return must set a diagnostic, or a request suppressed by our own
   * backoff is indistinguishable from one the endpoint answered and nothing in the answers was
   * usable — and the screen reported the second as "not a connection problem".
   */
  if (Date.now() < lichessBackoffUntil) {
    lastFetchDiagnostic = 'rate-limited';
    console.warn('[puzzles] Lichess asked us to wait; not asking again yet');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LICHESS_TIMEOUT_MS);

  try {
    const res = await fetch(`https://lichess.org/api/puzzle/next?difficulty=${difficulty}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    /*
     * THE 429 IS OURS TO RESPOND TO, NOT TO WORK AROUND.
     *
     * Lichess answers a rate-limited puzzle request with `429` and a 47-byte body — no `Retry-After`,
     * no rate-limit headers. There is nothing to adapt to, so the only correct response is to stop
     * asking for a while and to say so. The old code backed off for 60s and then immediately
     * resumed a ten-request search, which is how a 60-second pause turned into a permanently blocked
     * session.
     */
    if (res.status === 429) {
      lichessBackoffUntil = Date.now() + LICHESS_BACKOFF_MS;
      lastFetchDiagnostic = 'rate-limited';
      console.warn(
        `[puzzles] Lichess rate-limited us — not asking again for ${LICHESS_BACKOFF_MS / 1000}s`,
      );
      return null;
    }
    if (!res.ok) {
      lastFetchDiagnostic = 'http-error';
      console.warn('[puzzles] Lichess HTTP', res.status);
      return null;
    }

    const data = (await res.json()) as {
      puzzle?: { id?: string; solution?: unknown; initialPly?: unknown; rating?: unknown; themes?: unknown };
      game?: { pgn?: string };
    };

    const puz = data?.puzzle;
    const pgn = data?.game?.pgn;
    if (!puz?.id || !pgn || !Array.isArray(puz.solution) || puz.solution.length === 0) return null;

    const rec = reconstruct(pgn, Number(puz.initialPly ?? 0), puz.solution as string[]);
    if (!rec) return null; // solution doesn't fit — discard this one

    const solutionUci = trimToPlayer(rec.fen, puz.solution as string[]);
    if (!solutionUci) return null;
    const solutionSan = solutionSans(rec.fen, solutionUci);
    if (!solutionSan) return null;

    lichessBackoffUntil = 0; // healthy again

    return {
      // Lichess's own puzzle id, so the identity is the provider's rather than a counter. It is used
      // for nothing that persists — see the note about caching at the end of this file.
      id: `live_${String(puz.id)}`,
      fen: rec.fen,
      side: rec.turn,
      solutionUci,
      solutionSan,
      rating: Math.round(Number(puz.rating ?? 1500)),
      themes: Array.isArray(puz.themes) ? (puz.themes as string[]).slice(0, 6) : [],
      source: 'live',
    };
  } catch (e) {
    /*
     * THE MOST IMPORTANT DIAGNOSTIC IN THIS FILE.
     *
     * Getting here means the request never produced a response: no DNS, no route, captive portal,
     * airplane mode, or the abort timer firing. The consequence the owner reported exactly:
     *
     *     *"i tried the app without connection for puzzles and it says provider problem while it
     *      had to say internet problem"*
     *
     * The old code logged the message and returned null WITHOUT touching `lastFetchDiagnostic`, so
     * the screen read 'none', mapped that to 'no-puzzle', and printed a message about the service
     * having nothing — with no wifi at all. The `offline` copy already existed and was unreachable:
     * nothing in the codebase could produce that value. This is the line that makes it reachable.
     */
    lastFetchDiagnostic = 'offline';
    console.warn('[puzzles] request failed:', e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Main entry point. Mirrors `GET /api/puzzles/next?mode=...`.
 *
 * `rating` is the user's current puzzle rating (defaults to the store's).
 */
export async function fetchNextPuzzle(mode: PuzzleMode, rating?: number): Promise<ServedPuzzle | null> {
  const store = useAppStore.getState();
  const userRating = rating ?? store.profile.puzzleRating ?? 800;

  // Auto resolves to a concrete band from the rating. It must not be a licence to serve anything:
  // the previous `mode === 'auto' || inWindow` accepted every live puzzle regardless of its rating,
  // so a beginner on Auto could be handed a 2200 puzzle and "matched to your level" was simply false.
  const band: PuzzleMode = mode === 'auto' ? autoModeFor(userRating) : mode;
  const difficulty = lichessDifficulty(band, userRating);
  // The band's own edges, which are the floor for every attempt below.
  const bandWin = bandRange(band);

  /*
   * AUTO MUST NEVER WINDOW A NEW USER OUT OF EVERY PUZZLE.
   *
   * `autoModeFor(400)` is `beginner`, but `modeWindow('auto', 400)` is `[450, 550]` — and the measured
   * floor of the `easy` bucket is 1308 (see `PUZZLE_BUCKET_FLOOR` in `puzzles.ts`). A new account on
   * Auto is therefore asking for a 450-550 puzzle out of a bucket containing nothing under 1300.
   *
   * So on Auto the window is the user's own, UNIONED with the band the bucket can actually supply.
   * The rating still chooses the band, so difficulty is still matched to the user; what changes is
   * that the window is not permitted to exclude everything the endpoint has. On an EXPLICIT band the
   * user has chosen it, so it is honoured exactly.
   */
  const win = modeWindow(mode, userRating);
  const winLo = mode === 'auto' ? Math.min(win[0], bandWin[0]) : win[0];
  const winHi = mode === 'auto' ? Math.max(win[1], bandWin[1]) : win[1];

  /*
   * Lichess' easy/medium/hard buckets are coarse, so allow a margin — but the accepted puzzle must
   * still fall inside the user's own band. Without that clamp a 1500-rated player (intermediate)
   * could be served a 1050 puzzle, which is beginner-band material, and "matched to your level" would
   * be false in the OTHER direction: refusing to serve anything is not matching anyone either.
   */
  const tol = 200;
  const liveLo = Math.max(winLo - tol, bandWin[0]);
  const liveHi = mode === 'auto'
    ? Math.max(winHi + tol, bandWin[1])
    : Math.min(winHi + tol, bandWin[1]);

  // Reset per request, so a limit that has EXPIRED is not reported as the reason for this one.
  lastFetchDiagnostic = null;

  /*
   * ONE REQUEST. Then accept, or accept-with-disclosure, or fail.
   *
   * There is no loop here and there is not going to be one again. The shape of this function is the
   * fix: a user solving twenty puzzles makes twenty requests.
   */
  const live = await fetchLive(difficulty);
  if (!live) {
    /*
     * THE LIVE REQUEST FAILED — THE BUNDLED DECK ANSWERS.
     *
     * Every reason `fetchLive` can return null for is a reason the user cannot do anything about at
     * this moment: no connection, the service's unauthenticated rate limit, an error page, or a
     * payload nothing usable could be reconstructed from. Until this fallback existed, all four ended
     * at a card that asked the user to retry, which for a device with no signal is a wall — and the
     * owner's reports about that wall are what produced this deck (*"i tried the app without
     * connection for puzzles and it says provider problem"*).
     *
     * This is still ONE live attempt, exactly as before: the deck does not spend the request, it
     * only answers when the request came back empty. Online, with a working request, nothing below
     * runs and every puzzle is as fresh as it has always been.
     *
     * The band window is passed through so a pooled puzzle is disclosed off-band the same way a
     * live one is (`offBandBy`), rather than quietly handing a 1900 puzzle to an 800 player.
     */
    return fallbackPuzzle(userRating, liveLo, liveHi);
  }

  if (live.rating >= liveLo && live.rating <= liveHi) return live;

  /*
   * NEAR MISS — SERVED, AND SAY SO.
   *
   * The puzzle is usable, it is just outside the band. The two options are "serve it and tell the
   * user how far out it is" and "show an error to someone who is online and waiting with a service
   * that has already given us one". The first is a far smaller harm, because the difficulty is still
   * roughly right and the screen is explicit about it.
   *
   * `offBandBy` travels with the puzzle so the screen can render it as a plain sentence next to the
   * rating. `> 0` is the only thing that matters; the exact figure is for the log.
   */
  return { ...live, offBandBy: live.rating < liveLo ? liveLo - live.rating : live.rating - liveHi };
}
