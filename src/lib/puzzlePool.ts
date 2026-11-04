/**
 * THE BUNDLED OFFLINE PUZZLE DECK — what the Puzzles tab falls back to when the live service cannot
 * serve one.
 *
 * WHY IT EXISTS
 * =============
 * The live path asks Lichess once per puzzle and NEVER caches (see the header of `puzzleProvider`):
 * always fresh from the internet — at the cost that the tab is empty exactly when the internet is
 * not there, or when the service's unauthenticated limit says "not now". Those are the two reports
 * this deck answers: *"i tried the app without connection for puzzles and it says provider
 * problem"*, and the standing rate-limit complaints behind it.
 *
 * The deck is the half of that the app can control: a few thousand puzzles shipped INSIDE the app,
 * reconstructed at build time into exactly the shape the provider serves.
 *
 * THE RULES IT PLAYS BY
 * =====================
 *   1. LIVE FIRST, ALWAYS. `fetchNextPuzzle` makes its one live request before this module is
 *      consulted; the deck answers only when that request produced nothing usable. Online behaviour
 *      is unchanged — nothing is cached, and a pool puzzle only ever fills in for a failed fetch.
 *   2. TRUST NOTHING IN THE DECK AT RUNTIME. The deck was generated and verified by
 *      `scripts/build-offline-deck.mjs` (a streamed sample of Lichess's CC0 puzzle database), but it
 *      is data in a source tree: every entry is replayed with chess.js the first time the pool is
 *      opened, and an entry that does not replay LEGALLY is dropped rather than served. A malformed
 *      deck degrades to fewer puzzles, never to a broken one.
 *   3. NOTHING PERSISTS. The unseen set and the last-served id live in module memory only. The app
 *      must not accumulate a second, stale puzzle history; the profile's `PuzzleStat` rows are
 *      written by the screen, exactly as they are for live puzzles.
 *   4. NEAREST FIRST, UNSEEN OVER REPEATS. Entries carry their Lichess rating, so the pool serves
 *      the nearest rating to the ask, skipping anything already served this session until the deck
 *      is exhausted; then the unseen set is emptied and the nearest entry other than the one served
 *      just before goes again. A fixed offline dataset cannot promise no repeats at all — this is
 *      the honest arrangement of the repeats it must have.
 *
 * CONTENT: generated from Lichess's public puzzle API. Lichess publishes its puzzle database under
 * CC0; that attribution travels here and in the generator's header.
 */
import { Chess } from 'chess.js';
import deck from '@/data/offline_deck.json';
import type { ServedPuzzle } from './puzzleProvider';

/** One entry as it is stored in `src/data/offline_deck.json`. */
export interface DeckEntry {
  id: string;
  fen: string;
  side: 'w' | 'b';
  uci: string[];
  san: string[];
  rating: number;
  themes: string[];
}

const DECK = deck as DeckEntry[];

/**
 * Replay one deck entry into the served shape, or return null when the entry cannot be trusted.
 *
 * The legality replay is the same one the live provider performs on a fresh payload, for the same
 * reason: the screen's whole contract is "the solution is a legal sequence from this position", and
 * an entry that fails it must be DROPPED rather than served and discovered on the board. The SAN is
 * additionally required to match the replay, because the summary renders SAN, and a solution that
 * is merely half-right renders as a review of a game that never happened.
 *
 * Odd length: Lichess solutions and the screen both end on the PLAYER'S move, which makes them odd
 * in plies (the opponent's replies sit between them). An even-length entry is a malformed deck, not
 * a puzzle with one move left off.
 */
export function poolEntryToPuzzle(entry: DeckEntry): ServedPuzzle | null {
  if (!entry || typeof entry.fen !== 'string' || !Array.isArray(entry.uci)) return null;
  if (!Number.isFinite(entry.rating)) return null;
  if (entry.uci.length === 0 || entry.uci.length % 2 === 0) return null;
  if (!Array.isArray(entry.san) || entry.san.length !== entry.uci.length) return null;
  if (entry.side !== 'w' && entry.side !== 'b') return null;

  let c: Chess;
  try {
    c = new Chess(entry.fen);
  } catch {
    return null;
  }
  if (c.turn() !== entry.side) return null;

  const sans: string[] = [];
  try {
    for (const uci of entry.uci) {
      const m = c.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      sans.push(m.san);
    }
  } catch {
    return null;
  }
  if (sans.join(' ') !== entry.san.join(' ')) return null;

  return {
    // Prefixed so a pooled puzzle can never be confused with the live puzzle of the same id when
    // the screen writes its PuzzleStat row.
    id: `offline-${entry.id}`,
    fen: entry.fen,
    side: entry.side,
    solutionUci: entry.uci.slice(),
    solutionSan: sans,
    rating: entry.rating,
    themes: Array.isArray(entry.themes) ? entry.themes.slice() : [],
    source: 'pool',
  };
}

/** Build (and verify) the whole pool from raw deck entries, sorted by rating. */
export function buildPool(entries: DeckEntry[]): ServedPuzzle[] {
  const out: ServedPuzzle[] = [];
  for (const e of entries) {
    const p = poolEntryToPuzzle(e);
    if (p) out.push(p);
  }
  out.sort((a, b) => a.rating - b.rating);
  return out;
}

/**
 * The nearest entry to `rating` that `accept` allows.
 *
 * Generic over anything rated so the serve path can walk RAW deck entries and decide, per candidate
 * as it is visited, whether the entry is usable — see `fallbackPuzzle` for why that matters. `list`
 * must be sorted by rating: the walk starts at the insertion point and moves outward, so it visits
 * candidates in exactly rating-distance order and "nearest" is decided in one pass.
 */
export function pickNearest<T extends { rating: number }>(
  list: T[],
  rating: number,
  accept: (item: T) => boolean = () => true,
): T | null {
  if (list.length === 0) return null;
  let lo = 0;
  let hi = list.length; // first index whose rating is >= the ask
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].rating < rating) lo = mid + 1;
    else hi = mid;
  }
  let below = lo - 1;
  let above = lo;
  while (below >= 0 || above < list.length) {
    const a = below >= 0 ? list[below] : null;
    const b = above < list.length ? list[above] : null;
    let next: T | null;
    if (a == null) next = b;
    else if (b == null) next = a;
    // Ties go to the lower rating so the walk is deterministic for a given deck.
    else next = rating - a.rating <= b.rating - rating ? a : b;
    if (next == null) break;
    if (next === a) below--;
    else above++;
    if (accept(next)) return next;
  }
  return null;
}

/**
 * LAZY VERIFICATION, NOT EAGER.
 *
 * The deck holds thousands of entries and verifying one means replaying its whole solution with
 * chess.js — a few hundred microseconds each, so verifying the entire deck on the first offline
 * serve would stall the JS thread for seconds at exactly the moment the user is waiting for a
 * puzzle (the moment they have no network). Instead the deck is kept as entries sorted by rating,
 * and `served()` verifies a candidate only when the walk actually lands on it, memoising the
 * answer. The common case — the nearest entry is fine — verifies ONE entry.
 */
let ordered: DeckEntry[] | null = null;
const verified = new Map<string, ServedPuzzle | null>();
const servedIds = new Set<string>();
let lastServedId: string | null = null;

function orderedEntries(): DeckEntry[] {
  if (ordered == null) {
    ordered = DECK.slice().sort((a, b) => a.rating - b.rating || a.id.localeCompare(b.id));
  }
  return ordered;
}

/** The verified served shape of one entry, or null if it does not check out. Memoised. */
function served(entry: DeckEntry): ServedPuzzle | null {
  if (verified.has(entry.id)) return verified.get(entry.id) ?? null;
  const p = poolEntryToPuzzle(entry);
  verified.set(entry.id, p);
  return p;
}

/**
 * The puzzle served when the live request failed.
 *
 * `offBandBy` is computed exactly as the live path computes it — distance to the window the caller
 * asked for, present only when positive — so the screen's "outside your level by N" note works for
 * a pooled puzzle without knowing where the puzzle came from.
 */
export function fallbackPuzzle(rating: number, lo: number, hi: number): ServedPuzzle | null {
  const list = orderedEntries();
  if (list.length === 0) return null;

  const usable = (e: DeckEntry) => served(e) != null;

  /* eslint-disable-next-line prefer-const */
  let chosenEntry = pickNearest(list, rating, (e) => !servedIds.has(e.id) && usable(e));
  if (!chosenEntry) {
    // The deck is exhausted for this session: refill it, avoiding an immediate repeat of the entry
    // served just before when the deck has anything else to offer.
    servedIds.clear();
    chosenEntry = pickNearest(list, rating, (e) => e.id !== lastServedId && usable(e))
      ?? pickNearest(list, rating, usable);
  }
  if (!chosenEntry) return null;
  const chosen = served(chosenEntry);
  if (!chosen) return null;

  // The sets are keyed by the DECK's id, not the served `offline-` prefixed one: the walk visits
  // deck entries, so anything else would silently stop the unseen check from ever matching.
  servedIds.add(chosenEntry.id);
  lastServedId = chosenEntry.id;

  const off = chosen.rating < lo ? lo - chosen.rating : chosen.rating > hi ? chosen.rating - hi : 0;
  return off > 0 ? { ...chosen, offBandBy: off } : chosen;
}
