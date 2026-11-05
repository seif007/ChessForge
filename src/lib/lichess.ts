'use client';

/**
 * Lichess public API client — no login, no OAuth, no account required.
 *
 * The user types a Lichess username and we read their PUBLIC game archive.
 * There is no authentication because none is needed: the endpoint below is
 * open, and we never write anything back to Lichess.
 *
 * Endpoints used
 * --------------
 *   GET /api/user/{user}          -> profile and current ratings
 *   GET /api/games/user/{user}    -> public games as NDJSON
 *
 * API manners
 * -----------
 * Lichess asks clients to send one request at a time and to wait a full minute
 * after a 429 before resuming. This client therefore never parallelises account
 * requests, never retries a 429 automatically, and sends an identifiable
 * User-Agent. Public data only; no login, no scraping of private data, no
 * redistribution.
 *
 * Volume
 * ------
 * A busy account can have thousands of games. The game endpoint streams NDJSON
 * and accepts a `max` cap, so one import is one request with a hard game cap,
 * cancellable through an AbortSignal. The response is parsed line by line and
 * progress reports the games kept so far.
 */

import { Chess } from 'chess.js';
import { OPENINGS, bestOpeningForLine } from '@/lib/openings';

const API = 'https://lichess.org/api';

/**
 * Keep this descriptive: Lichess asks clients to identify themselves. The
 * header names the app, version and platform; it deliberately carries no
 * personal contact address. A public project URL can be added at release.
 */
export const USER_AGENT = 'ChessForge/1.0 (Android)';

const PROFILE_TIMEOUT_MS = 20_000;
const GAMES_TIMEOUT_MS = 180_000;

/** A skip-the-queue cap so one enormous account cannot hang the device forever. */
export const MAX_GAMES = 4000;

// ---------------------------------------------------------------------------
// Username input
// ---------------------------------------------------------------------------

/**
 * What the user actually pasted, reduced to a Lichess username.
 *
 * People copy the address bar, so a full profile URL is the common case, and
 * trailing slashes and casing are both things the API accepts — but the PGN
 * headers quote the canonical spelling the API returns, and normalising in one
 * place keeps every later comparison exact.
 *
 * A copied profile address usually carries more than the handle: a query string
 * (`?sort=...`), a fragment (`#games`), or a sub-page (`/perf/blitz`). Those used
 * to survive as part of the "username", so the request went to a handle that
 * does not exist and the user saw "no account for this name" for a name that is
 * perfectly real. Everything after the handle is dropped first, before the URL
 * prefixes are stripped.
 */
export function sanitizeLichessUser(query: string): string {
  return query
    .trim()
    // Query strings and fragments are never part of a handle.
    .replace(/[?#].*$/, '')
    // Profile URL prefixes, with or without a scheme.
    .replace(/^(?:https?:\/\/)?(?:www\.)?lichess\.org\/@\//i, '')
    .replace(/^(?:https?:\/\/)?(?:www\.)?lichess\.org\/user\//i, '')
    .replace(/^(?:https?:\/\/)?(?:www\.)?lichess\.org\//i, '')
    // A pasted API path, or a sub-page under the profile.
    .replace(/^api\/user\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^@+/, '')
    .replace(/[.!?,;:'"`]+$/, '')
    .replace(/[/\s]+$/, '')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface LichessProfile {
  username: string;
  ratings: LichessRatings;
  joined: number | null;
  /**
   * True when Lichess reports the account as closed (`"disabled": true`).
   *
   * A disabled account still answers `GET /api/user/{user}` with 200 — it is a
   * real handle — but its games endpoint returns 404, so an import that only
   * looked at the game request would tell the user the account "does not exist"
   * for a name that plainly does. Carrying the flag out of the profile lets the
   * caller say what is actually true: the account is closed.
   */
  disabled: boolean;
  /**
   * How many rated games the account has, from the profile's `count`.
   *
   * Used as the progress denominator for the games download: the bar used to be
   * measured against the read CAP (4000), so an account with 400 games filled a
   * tenth of it and then jumped to full. `null` when Lichess did not say.
   */
  gameCount: number | null;
}

export interface LichessRatings {
  bullet?: number;
  blitz?: number;
  rapid?: number;
  daily?: number;
  fide?: number;
}

/** One parsed game, already reduced to what the app needs. */
export interface LichessGame {
  /** Stable Lichess game id. */
  id: string;
  url: string;
  /** Top-level opening family - what stats and repertoire matching group by. */
  opening: string;
  /** The full opening name from Lichess, or our book's name when it corrected one. */
  openingVariation: string;
  /** ECO code, kept so the label can be re-derived and for richer labels later. */
  ecoSlug: string;
  /** Which colour the tracked player had. */
  color: 'w' | 'b';
  /** Result from the TRACKED player's point of view. */
  outcome: 'win' | 'loss' | 'draw';
  playerRating: number | null;
  opponentRating: number | null;
  opponent: string;
  /** Lichess does not publish a per-game accuracy; null means unavailable. */
  accuracy: number | null;
  opponentAccuracy: number | null;
  /** Full mainline in UCI, from the initial position. */
  movesUci: string[];
  /** Full mainline in SAN. */
  movesSan: string[];
  /** Time class: bullet / blitz / rapid / daily. */
  timeClass: string;
  timeControl: string;
  rated: boolean;
  /** Unix seconds. */
  endTime: number;
}

export interface FetchProgress {
  /** Human-readable phase, safe to show directly in the UI. */
  phase: string;
  /** 0..1 when the total is known, otherwise null (indeterminate). */
  fraction: number | null;
  gamesSoFar: number;
  /** Kept for the existing progress UI; a Lichess import is one request. */
  monthsDone: number;
  monthsTotal: number;
}

export class LichessError extends Error {
  constructor(
    message: string,
    readonly kind: 'not-found' | 'disabled' | 'network' | 'rate-limit' | 'parse' | 'aborted',
  ) {
    super(message);
    this.name = 'LichessError';
  }
}

/**
 * ONE SENTENCE PER FAILURE, SHARED BY EVERY DOOR.
 *
 * Stats, the inline import card and the bot builder each used to invent their
 * own wording for the same Lichess failure, and they disagreed: a closed
 * account was told it "does not exist", and a mistyped handle got no hint about
 * what to check. The messages live here so every surface says the same true
 * thing, and a test can assert the wording once.
 */
export function lichessAccountError(name: string, err: unknown): string {
  if (err instanceof LichessError) {
    if (err.kind === 'disabled') {
      return `The Lichess account "${name}" is closed on Lichess, so its games cannot be read. `
        + 'Check the handle — if it is a different account, use that one instead.';
    }
    if (err.kind === 'not-found') {
      return `No Lichess account called "${name}". Check the spelling — the handle is the part `
        + `after lichess.org/@/ in a profile address (lichess.org/@/${name}).`;
    }
    if (err.kind === 'rate-limit' || err.kind === 'network') return err.message;
  }
  const raw = (err as Error)?.message ?? '';
  if (/unknownhost|fetch failed|network request failed|failed to fetch|econn|enotfound/i.test(raw)) {
    return 'Could not reach Lichess — check your internet connection and try again.';
  }
  return raw || 'Could not reach Lichess. Try again.';
}

// ---------------------------------------------------------------------------
// Low-level request
// ---------------------------------------------------------------------------

function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onOuterAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onOuterAbort);
  }
  return {
    signal: ctrl.signal,
    dispose() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    },
  };
}

async function fetchText(
  url: string,
  signal: AbortSignal | undefined,
  accept: string,
  timeoutMs: number,
  attempt = 1,
): Promise<string> {
  const t = withTimeout(signal, timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        signal: t.signal,
      });
    } catch {
      if (signal?.aborted) throw new LichessError('Fetch cancelled.', 'aborted');
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        return fetchText(url, signal, accept, timeoutMs, attempt + 1);
      }
      throw new LichessError(
        'Could not reach Lichess. Check your connection and try again.',
        'network',
      );
    }

    if (res.status === 404) {
      throw new LichessError('That Lichess username does not exist.', 'not-found');
    }
    if (res.status === 429) {
      /*
       * Lichess asks for a full minute of quiet after a 429. Waiting inside a
       * mobile import would look like a freeze, so stop and tell the user. The
       * next attempt is theirs to start.
       */
      const retry = res.headers.get('Retry-After');
      const wait = retry ? ` Try again in ${retry} seconds.` : ' Wait a minute and try again.';
      throw new LichessError(`Lichess is rate-limiting requests.${wait}`, 'rate-limit');
    }
    if (!res.ok) {
      if (attempt < 3 && res.status >= 500) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        return fetchText(url, signal, accept, timeoutMs, attempt + 1);
      }
      throw new LichessError(`Lichess returned an error (${res.status}).`, 'network');
    }

    return await res.text();
  } finally {
    t.dispose();
  }
}

/** A response body that can be read as it arrives, when the runtime has one. */
interface StreamingBody {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(r?: unknown): void };
}

/**
 * Download an NDJSON document and hand over each complete line AS IT ARRIVES.
 *
 * THE FREEZE THIS FIXES. `fetchText` above resolves only once the WHOLE body is
 * buffered, so the entire game archive was read into memory reporting nothing:
 * the refresh bar moved to its first phase and then sat still until the download
 * ended and it jumped straight to the end. Lichess already streams NDJSON, and
 * the `fetch` in this runtime (expo/fetch) exposes `Response.body` as a real
 * stream, so the same bytes can be parsed line by line while they arrive.
 *
 * The request/status/retry handling below mirrors `fetchText` deliberately:
 * same one-request discipline, same 404/429/5xx meanings. A runtime without a
 * streaming body falls back to reading the whole response and splitting it —
 * the download still works, only the progress is coarser.
 */
async function readNdjsonLines(
  url: string,
  signal: AbortSignal | undefined,
  accept: string,
  timeoutMs: number,
  onLine: (line: string) => void,
): Promise<void> {
  const t = withTimeout(signal, timeoutMs);
  try {
    let res: Response | null = null;
    for (let attempt = 1; res == null; attempt++) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: accept },
          signal: t.signal,
        });
        if (r.status === 404) {
          throw new LichessError('That Lichess username does not exist.', 'not-found');
        }
        if (r.status === 429) {
          // Lichess asks for a full minute of quiet after a 429. Waiting inside a
          // mobile import would look like a freeze, so stop and tell the user.
          const retry = r.headers.get('Retry-After');
          const wait = retry ? ` Try again in ${retry} seconds.` : ' Wait a minute and try again.';
          throw new LichessError(`Lichess is rate-limiting requests.${wait}`, 'rate-limit');
        }
        if (!r.ok) {
          if (attempt < 3 && r.status >= 500) {
            await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
            continue;
          }
          throw new LichessError(`Lichess returned an error (${r.status}).`, 'network');
        }
        res = r;
      } catch (err) {
        if (err instanceof LichessError) throw err;
        if (signal?.aborted) throw new LichessError('Fetch cancelled.', 'aborted');
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
          continue;
        }
        throw new LichessError(
          'Could not reach Lichess. Check your connection and try again.',
          'network',
        );
      }
    }

    const body = (res as unknown as { body?: StreamingBody | null }).body;
    if (
      body != null
      && typeof body.getReader === 'function'
      // `TextDecoder` comes from the Expo runtime; without it streaming would
      // throw, which the catch below would report as a dropped connection. Fall
      // back to the buffered read instead, which needs no decoder.
      && typeof TextDecoder === 'function'
    ) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          if (signal?.aborted) throw new LichessError('Fetch cancelled.', 'aborted');
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value ?? new Uint8Array(0), { stream: true });
          let nl = buffer.indexOf('\n');
          while (nl >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.trim().length > 0) onLine(line);
            nl = buffer.indexOf('\n');
          }
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) onLine(buffer);
        return;
      } catch (err) {
        if (err instanceof LichessError) throw err;
        if (signal?.aborted) throw new LichessError('Fetch cancelled.', 'aborted');
        throw new LichessError(
          'The connection to Lichess dropped while reading your games.',
          'network',
        );
      }
    }

    // No streaming body: read it whole, then run the same line loop. Coarser
    // progress, identical result.
    const text = await res.text();
    for (const line of text.split(/\r?\n/)) {
      if (signal?.aborted) throw new LichessError('Fetch cancelled.', 'aborted');
      if (line.trim().length > 0) onLine(line);
    }
  } finally {
    t.dispose();
  }
}

// ---------------------------------------------------------------------------
// Opening labels
// ---------------------------------------------------------------------------

/**
 * Words that begin a sub-variation rather than the opening itself.
 * Ordered longest-first so "Knights Variation" wins over "Variation".
 */
const VARIATION_MARKERS = [
  'Variation', 'Variations', 'Defense', 'Defence', 'Attack', 'System',
  'Gambit', 'Opening', 'Line', 'Line,', 'with', 'Accepted', 'Declined',
  'Classical', 'Modern', 'Standard', 'Main', 'Advance', 'Exchange', 'Closed',
  'Open', 'Two', 'Three', 'Four', 'Accelerated', 'Delayed', 'Reversed',
  'Improved', 'Nimzo', 'Berlin', 'Morphy', 'Chigorin', 'Alapin', 'Breyer',
  'Zaitsev', 'Kholmov', 'Schliemann', 'Marshall', 'Sveshnikov', 'Najdorf',
  'Dragon', 'Scheveningen', 'Kan', 'Taimanov', 'Fianchetto', 'Winawer',
  'Rubinstein', 'Tarrasch', 'Steinitz', 'Pirc', 'Caro',
];

/** Openings whose first words are genuinely part of the family. */
const TWO_WORD_FAMILIES = new Set([
  "King's Indian", "Queen's Indian", "Queen's Gambit", "King's Gambit",
  'Nimzowitsch Larsen', "King's Fianchetto", 'Bishop\u2019s Opening',
  'Bishops Opening', 'Modern Defense', 'Indian Game', 'Petrov Defense',
  'Ruy Lopez', 'Two Knights', 'Four Knights', 'Three Knights',
  'Pirc Defense', 'Dutch Defense', 'French Defense', 'English Opening',
  'Scotch Game', 'Vienna Game', 'Berlin Defense', 'London System',
  'Colle System', 'Caro Kann', 'Old Benoni', 'Benoni Defense',
  'Bird Opening', 'Reti Opening', 'Catalan Opening', 'Grob Opening',
  'Trompowsky Attack', 'Richter Veresov', 'Alekhine Defense',
  'Sicilian Defense', 'Italian Game', 'Russian Game', 'Philidor Defense',
]);

export interface OpeningRef {
  /** Top-level opening family used for grouping. */
  family: string;
  /** Full variation name. */
  name: string;
  /** ECO code, when the source supplied one. */
  slug: string;
}

function restoreApostrophes(s: string): string {
  return s
    .replace(/\bKings\b/g, "King's")
    .replace(/\bQueens\b/g, "Queen's")
    .replace(/\bBishops\b/g, "Bishop's")
    .replace(/\bKnights\b/g, "Knight's")
    .replace(/\bRooks\b/g, "Rook's")
    .replace(/\bPawns\b/g, "Pawn's")
    .replace(/\bFisher\b/g, 'Fischer')
    .replace(/\bReti\b/g, 'Réti');
}

function familyFromName(name: string): string {
  const base = name.split(':')[0].trim();
  if (!base) return 'Unknown Opening';
  const words = base.split(/\s+/);
  let family = base;

  for (const tf of TWO_WORD_FAMILIES) {
    if (base === tf || base.startsWith(tf + ' ')) {
      family = tf;
      break;
    }
  }

  if (family === base && words.length > 1) {
    let cutAt = words.length;
    for (let i = 1; i < words.length; i++) {
      if (VARIATION_MARKERS.includes(words[i])) {
        cutAt = i;
        break;
      }
    }
    if (cutAt > 1) family = words.slice(0, cutAt).join(' ');
    else if (cutAt === 1) family = words.slice(0, Math.min(2, words.length)).join(' ');
  }

  return restoreApostrophes(family);
}

/** Parse a Lichess opening name and ECO code into the app's two-level label. */
export function openingFromName(
  name: string | undefined | null,
  eco?: string | null,
): OpeningRef {
  const unknown: OpeningRef = { family: 'Unknown Opening', name: 'Unknown Opening', slug: eco?.trim() ?? '' };
  const full = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!full) return unknown;
  return { family: familyFromName(full), name: full, slug: (eco ?? '').trim() };
}

/**
 * Legacy URL parser retained for old tests and imported text. The app itself
 * reads Lichess opening names directly; a value without `/openings/` is unknown.
 */
export function openingFromEcoUrl(ecoUrl: string | undefined | null): OpeningRef {
  const unknown: OpeningRef = { family: 'Unknown Opening', name: 'Unknown Opening', slug: '' };
  const marker = '/openings/';
  const at = ecoUrl ? ecoUrl.indexOf(marker) : -1;
  if (!ecoUrl || at < 0) return unknown;
  const slug = ecoUrl.slice(at + marker.length).split(/[/?#]/)[0];
  if (!slug) return unknown;
  const cut = slug.search(/\.\.\.|\d+\./);
  const head = cut > 0 ? slug.slice(0, cut) : slug;
  const name = decodeURIComponent(head)
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return unknown;
  return { ...openingFromName(name), slug };
}

const MIN_LABEL_PLIES = 8;
const MAX_LABEL_PLIES = 30;

/** The registry's name for a game's moves, or null when the moves are not enough. */
export function openingNameFromMoves(sans: readonly string[]): string | null {
  const best = bestOpeningForLine([sans.slice(0, MAX_LABEL_PLIES) as string[]]);
  if (!best || best.depth < MIN_LABEL_PLIES) return null;
  const name = OPENINGS.find((o) => o.id === best.id)?.name?.trim();
  return name ? name : null;
}

/** The source's reference, corrected by our books when the moves disagree. */
export function correctedOpeningRef(source: OpeningRef, sans: readonly string[]): OpeningRef {
  const ours = openingNameFromMoves(sans);
  if (!ours || ours.toLowerCase() === source.family.toLowerCase()) return source;
  return { family: ours, name: ours, slug: source.slug };
}

/** The opening reference for a fetched game: source label, corrected by our books. */
export function openingRefForGame(
  nameOrUrl: string | null | undefined,
  eco: string | null | undefined,
  sans: readonly string[],
): OpeningRef {
  const source = nameOrUrl && nameOrUrl.includes('/openings/')
    ? openingFromEcoUrl(nameOrUrl)
    : openingFromName(nameOrUrl, eco);
  return correctedOpeningRef(source, sans);
}

/** Re-derive a stored game's opening label. Idempotent. */
export function relabelGameOpening(game: LichessGame): LichessGame {
  const fixed = openingRefForGame(game.openingVariation, game.ecoSlug, game.movesSan ?? []);
  if (fixed.family === game.opening && fixed.name === game.openingVariation) return game;
  return { ...game, opening: fixed.family, openingVariation: fixed.name };
}

// ---------------------------------------------------------------------------
// PGN / SAN helpers
// ---------------------------------------------------------------------------

/**
 * Extract the mainline moves from a PGN body.
 *
 * Header lines, clock comments and nested variations are removed. Move numbers
 * may be glued to the move (`12.e4`), so the prefix is stripped before
 * chess.js sees it. Exported because the bot profile builder feeds OTB archives
 * through the same reader.
 */
export function pgnMainlineMoves(pgn: string): string[] {
  const body = pgn
    .replace(/^\s*\[[^\]]*\]\s*$/gm, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\s+/g, ' ');

  let flat = '';
  let depth = 0;
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) flat += ch;
  }

  const tokens = flat.split(/\s+/).filter(Boolean);
  const moves: string[] = [];
  for (const tok of tokens) {
    if (tok === '1-0' || tok === '0-1' || tok === '1/2-1/2' || tok === '*') continue;
    const numbered = tok.replace(/^\d+\.+/, '');
    if (!numbered) continue;
    if (/^\$\d+$/.test(numbered)) continue;
    const bare = numbered.replace(/[!?]+$/, '');
    if (!bare) continue;
    moves.push(bare);
  }
  return moves;
}

/** Replay SAN moves onto a game, returning UCI and SAN that both verify legal. */
export function replaySanMoves(
  sans: readonly string[],
  initialFen?: string | null,
): { uci: string[]; san: string[] } {
  const uci: string[] = [];
  const okSan: string[] = [];
  let c: Chess;
  try {
    c = initialFen ? new Chess(initialFen) : new Chess();
  } catch {
    return { uci: [], san: [] };
  }
  for (const s of sans) {
    try {
      const m = c.move(s);
      if (!m) break;
      uci.push(m.from + m.to + (m.promotion ?? ''));
      okSan.push(m.san);
    } catch {
      break;
    }
  }
  return { uci, san: okSan };
}

export function replayMainline(
  pgn: string,
  initialFen?: string | null,
): { uci: string[]; san: string[] } {
  return replaySanMoves(pgnMainlineMoves(pgn), initialFen);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function ratingOf(perfs: Record<string, unknown> | undefined, key: string): number | undefined {
  const p = perfs?.[key] as { rating?: unknown } | undefined;
  const n = Number(p?.rating);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function fetchProfile(
  username: string,
  signal?: AbortSignal,
): Promise<LichessProfile> {
  const user = username.trim().toLowerCase();
  if (!user) throw new LichessError('Enter a Lichess username.', 'not-found');

  const text = await fetchText(
    `${API}/user/${encodeURIComponent(user)}`,
    signal,
    'application/json',
    PROFILE_TIMEOUT_MS,
  );
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(text) as Record<string, any>;
  } catch {
    throw new LichessError('Lichess returned unreadable data.', 'parse');
  }
  if (!raw || typeof raw.id !== 'string') {
    throw new LichessError('That Lichess username does not exist.', 'not-found');
  }

  const perfs = raw.perfs as Record<string, unknown> | undefined;
  const fideRaw = Number(raw.profile?.fideRating);
  return {
    username: String(raw.username ?? raw.id ?? user),
    ratings: {
      bullet: ratingOf(perfs, 'bullet'),
      blitz: ratingOf(perfs, 'blitz'),
      rapid: ratingOf(perfs, 'rapid'),
      daily: ratingOf(perfs, 'classical') ?? ratingOf(perfs, 'correspondence'),
      fide: Number.isFinite(fideRaw) && fideRaw > 0 ? fideRaw : undefined,
    },
    joined: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : null,
    /*
     * A CLOSED ACCOUNT IS A REAL ACCOUNT. Lichess answers the profile with 200
     * and `"disabled": true`; only its games 404. Reporting the flag here is
     * what lets the caller say "closed", not "does not exist".
     */
    disabled: raw.disabled === true,
    /*
     * RATED, because the games request below asks for `rated=true` only — the
     * denominator has to count the same games the numerator does, or the bar
     * stops short of the end on an account with casual games.
     */
    gameCount: (() => {
      const c = raw.count as Record<string, unknown> | undefined;
      const n = Number(c?.rated ?? c?.all);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
  };
}

/** The current rating per format. Kept as a thin alias for callers that only need ratings. */
export async function fetchRatings(
  username: string,
  signal?: AbortSignal,
): Promise<LichessRatings> {
  return (await fetchProfile(username, signal)).ratings;
}

function lichessSpeed(raw: Record<string, any>): string {
  const speed = String(raw.speed ?? raw.perf ?? '').toLowerCase();
  if (speed === 'ultrabullet' || speed === 'bullet') return 'bullet';
  if (speed === 'blitz') return 'blitz';
  if (speed === 'rapid') return 'rapid';
  // Lichess calls its slow formats classical and correspondence. The rest of
  // the app groups both under its existing "daily" class.
  return 'daily';
}

function isStandardVariant(raw: Record<string, any>): boolean {
  const v = raw.variant;
  const key = typeof v === 'string' ? v : v?.key;
  return key == null || key === 'standard';
}

function toGame(raw: Record<string, any>, user: string): LichessGame | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStandardVariant(raw)) return null;

  const status = String(raw.status ?? '');
  if (status === 'aborted' || status === 'noStart' || status === 'created' || status === 'started') {
    return null;
  }

  const moves = typeof raw.moves === 'string' ? raw.moves.trim() : '';
  if (!moves) return null;

  const white = raw.players?.white ?? {};
  const black = raw.players?.black ?? {};
  const whiteName = String(white.user?.name ?? white.user?.id ?? '');
  const blackName = String(black.user?.name ?? black.user?.id ?? '');
  if (!whiteName || !blackName) return null; // AI or engine game

  const isWhite = whiteName.toLowerCase() === user;
  const isBlack = blackName.toLowerCase() === user;
  if (!isWhite && !isBlack) return null;

  const me = isWhite ? white : black;
  const them = isWhite ? black : white;
  const winner = typeof raw.winner === 'string' ? raw.winner.toLowerCase() : '';
  const outcome: LichessGame['outcome'] = winner === 'white'
    ? (isWhite ? 'win' : 'loss')
    : winner === 'black'
      ? (isBlack ? 'win' : 'loss')
      : 'draw';

  const sans = moves.split(/\s+/).filter(Boolean);
  const { uci, san } = replaySanMoves(sans, raw.initialFen ?? null);
  if (san.length === 0) return null;
  const ref = openingRefForGame(raw.opening?.name, raw.opening?.eco, san);

  const id = String(raw.id ?? '');
  if (!id) return null;
  const clock = raw.clock;
  const timeControl = clock && Number.isFinite(Number(clock.initial))
    ? `${Number(clock.initial)}+${Number(clock.increment ?? 0)}`
    : lichessSpeed(raw);
  const endMs = Number(raw.lastMoveAt ?? raw.createdAt ?? 0);

  return {
    id,
    url: `https://lichess.org/${id}`,
    opening: ref.family,
    openingVariation: ref.name,
    ecoSlug: ref.slug,
    color: isWhite ? 'w' : 'b',
    outcome,
    playerRating: Number.isFinite(Number(me.rating)) ? Number(me.rating) : null,
    opponentRating: Number.isFinite(Number(them.rating)) ? Number(them.rating) : null,
    opponent: String(them.user?.name ?? them.user?.id ?? 'Unknown'),
    accuracy: null,
    opponentAccuracy: null,
    movesUci: uci,
    movesSan: san,
    timeClass: lichessSpeed(raw),
    timeControl,
    rated: Boolean(raw.rated),
    endTime: Number.isFinite(endMs) && endMs > 0 ? Math.floor(endMs / 1000) : 0,
  };
}

/**
 * Fetch the user's public Lichess games, newest first.
 *
 * One request. Lichess streams NDJSON; we read the body, parse line by line,
 * and stop at `maxGames`. Progress is reported as lines arrive.
 */
export async function fetchAllGames(
  username: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: FetchProgress) => void;
    /** Only games at or after this unix time (seconds). */
    since?: number;
    until?: number;
    maxGames?: number;
    /** Accepted for caller compatibility; there is no month cache to clear. */
    force?: boolean;
    /** Accepted for caller compatibility; Lichess always returns newest first. */
    newestFirst?: boolean;
    /** Lichess perfType filter, e.g. "blitz,rapid,classical,correspondence". */
    perfType?: string;
    /** Default true. Set false to include casual games. */
    rated?: boolean;
    /**
     * How many games the account is known to have (from `LichessProfile.gameCount`).
     * The progress denominator. When absent the read cap is used instead, which
     * makes the bar stop short for every account smaller than the cap.
     */
    expected?: number | null;
    /**
     * The account is known to be closed (from its profile). A 404 on the games
     * endpoint then means "closed", not "no such handle", and saying so is the
     * difference between a useful message and a wrong one.
     */
    disabledHint?: boolean;
  } = {},
): Promise<LichessGame[]> {
  const user = username.trim().toLowerCase();
  if (!user) throw new LichessError('Enter a Lichess username.', 'not-found');

  const {
    signal,
    onProgress,
    since,
    until,
    maxGames = MAX_GAMES,
    perfType,
    rated = true,
    expected = null,
    disabledHint = false,
  } = opts;

  const report = (phase: string, fraction: number | null, games: number) =>
    onProgress?.({ phase, fraction, gamesSoFar: games, monthsDone: 0, monthsTotal: 0 });

  const params: string[] = [
    'moves=true',
    'opening=true',
    'clocks=false',
    'evals=false',
    'sort=dateDesc',
    `max=${encodeURIComponent(String(Math.max(1, Math.floor(maxGames))))}`,
  ];
  if (rated) params.push('rated=true');
  if (perfType) params.push(`perfType=${encodeURIComponent(perfType)}`);
  if (since && since > 0) {
    const ms = since > 1e12 ? since : since * 1000;
    params.push(`since=${encodeURIComponent(String(Math.floor(ms)))}`);
  }
  if (until && until > 0) {
    const ms = until > 1e12 ? until : until * 1000;
    params.push(`until=${encodeURIComponent(String(Math.floor(ms)))}`);
  }

  const url = `${API}/games/user/${encodeURIComponent(user)}?${params.join('&')}`;

  /*
   * THE DENOMINATOR IS THE ACCOUNT'S OWN COUNT, NOT THE READ CAP.
   *
   * The fraction used to be `read / maxGames` with maxGames = 4000, so an
   * account with 400 games could never pass 10% and then jumped to full — the
   * bar looked broken twice over. When the profile has told us how many rated
   * games exist, that is the honest total; the cap only wins when the account is
   * bigger than we will ever read.
   */
  const denominator = expected != null && expected > 0 ? Math.min(expected, maxGames) : maxGames;

  /*
   * Indeterminate until the first lines land: the request is open but no game
   * has been read yet, so there is no fraction to report and the bar should
   * show as running rather than as a hard 0%.
   */
  report('Reading your Lichess games...', null, 0);

  const out: LichessGame[] = [];
  let unreadable = 0;
  let lastReported = 0;

  const note = (games: number) => {
    report(
      `Reading your Lichess games... (${games.toLocaleString()} read)`,
      denominator > 0 ? Math.min(0.99, games / denominator) : null,
      games,
    );
  };

  try {
    await readNdjsonLines(url, signal, 'application/x-ndjson', GAMES_TIMEOUT_MS, (line) => {
      if (out.length >= maxGames) return;
      let raw: Record<string, any>;
      try {
        raw = JSON.parse(line) as Record<string, any>;
      } catch {
        unreadable++;
        return;
      }
      const game = toGame(raw, user);
      if (!game) return;
      out.push(game);
      /*
       * EVERY FEW LINES, NOT EVERY TWENTY GAMES.
       *
       * Twenty was tuned for a buffered read, where the reports all landed at
       * once anyway. Now that the body streams in, a report every five games is
       * free and keeps the bar (and the "N read" text) moving on a slow link.
       */
      if (out.length - lastReported >= 5 || out.length === denominator) {
        lastReported = out.length;
        note(out.length);
      }
    });
  } catch (err) {
    if (err instanceof LichessError && err.kind === 'not-found') {
      throw disabledHint
        ? new LichessError('That Lichess account is closed, so its games cannot be read.', 'disabled')
        : new LichessError('That Lichess username does not exist.', 'not-found');
    }
    throw err;
  }

  if (unreadable > 0 && out.length === 0) {
    throw new LichessError('Lichess returned games the app could not read.', 'parse');
  }

  out.sort((a, b) => b.endTime - a.endTime);
  const kept = out.slice(0, maxGames);
  report(
    unreadable > 0
      ? `Read ${kept.length.toLocaleString()} games; ${unreadable} could not be read.`
      : `Read ${kept.length.toLocaleString()} games.`,
    1,
    kept.length,
  );
  return kept;
}

/** No in-memory month cache exists for Lichess; kept for the privacy reset path. */
export function clearGameCache() {
  /* nothing to clear */
}
