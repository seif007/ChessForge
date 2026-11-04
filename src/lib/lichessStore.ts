/**
 * Lichess account + scan state, persisted in expo-sqlite/kv-store.
 *
 * WHY THIS IS ITS OWN MODULE
 * -------------------------
 * The Lichess scan is long (see `gameScan.ts`): a 200-game scan is roughly
 * 9,400 engine searches, which is over an hour on a phone. That means every
 * boundary in this feature has to survive the app being killed:
 *
 *   - Which account is being tracked, and its profile (so the screen paints
 *     instantly on launch instead of re-fetching).
 *   - Every game that has been classified so far, keyed by game id, so a
 *     resumed scan picks up where it stopped instead of redoing an hour of work.
 *   - The mined puzzle deck, so "From your games" has content the moment the
 *     user opens it.
 *
 * A key-value store is the right fit: the rows are tiny (a score tally per game,
 * not a report), there is no querying, and the only access pattern is
 * "load all / write all". It deliberately does NOT go into SQLite tables — that
 * would mean a schema migration for data that is a derived cache, and this data
 * must be **wipeable in one call** because the user asked that switching accounts
 * deletes the previous account's data.
 *
 * ONE KEY PER ACCOUNT
 * -------------------
 * Everything is namespaced by the account name, so switching accounts is a
 * *different key*, and deleting the old account's data is a single `removeItem`.
 * Storing one blob under one global key would make wiping tangled with keeping.
 */

import Storage from 'expo-sqlite/kv-store';

import { relabelGameOpening } from '@/lib/lichess';

/** The tracked account. The username is the identity; nothing else is stored. */
export interface LichessAccount {
  username: string;
  /** When the Lichess account was created (ms), if the profile supplied it. */
  joined: number | null;
  /** Rating per time class, from the profile payload, for a friendly header. */
  ratings: Record<string, number>;
  /** When we last successfully refreshed the game list (ms). */
  lastRefresh: number;
}

/** Mutable scan progress for one account. */
export interface ScanState {
  /** Game ids already classified, with their tally. Keys are Lichess game ids. */
  records: Record<string, import('@/lib/gameScan').ScanRecord>;
  /** Mined "from your games" puzzles, ready to train. */
  puzzles: import('@/lib/gameScan').MinedPuzzle[];
  /** Number of kept games in the last fetch, so progress can say "x/y". */
  totalGames: number;
  /** Whether the last run finished, so the UI can offer "finish scanning". */
  complete: boolean;
  updatedAt: number;
}

/**
 * The user's own opening decisions, keyed by position.
 *
 * ONE REPERTOIRE PER ACCOUNT
 * --------------------------
 * The scan and the mined puzzles are DERIVED — they can be recomputed from the
 * account's games, so switching accounts legitimately throws them away. A custom
 * repertoire is not derived: it is a series of choices the user made by hand
 * ("I play Nf3 here, not the book's Bc4"). Those choices are still ANSWERS TO A
 * NAMED ACCOUNT'S GAMES — the position keys come from its openings screen — and
 * an account is what the user was looking at when they made them.
 *
 * Sharing one blob across accounts was the reported defect: connect a second
 * account and its openings train the FIRST account's adopted moves, with no
 * screen saying whose they were. So the repertoire is namespaced like everything
 * else here.
 *
 * A repertoire adopted before this namespacing has no account attached to it, so
 * it lives under `CUSTOM_KEY_LEGACY` and is CLAIMED by the first account that
 * reads one after the update, then removed: the user was using that account when
 * they made those choices, and losing them on an update is not an option.
 */
export interface CustomRepertoire {
  /** position key -> the decision made there, with the context to re-render it. */
  positions: Record<string, import('@/lib/gameOpenings').CustomLine>;
  updatedAt: number;
}

const ACCOUNT_KEY = (u: string) => `chessforge.li.account.v1.${u.toLowerCase()}`;
const SCAN_KEY = (u: string) => `chessforge.li.scan.v1.${u.toLowerCase()}`;
/** The one pointer that says which account is active. */
const ACTIVE_KEY = 'chessforge.li.active.v1';
/**
 * The user's custom repertoire, per account. `CUSTOM_KEY_LEGACY` holds the
 * account-less blob written before namespacing — see the note on
 * `CustomRepertoire`.
 */
const CUSTOM_KEY = (u: string) => `chessforge.rep.custom.v1.${u.toLowerCase()}`;
const CUSTOM_KEY_LEGACY = 'chessforge.rep.custom.v1';

/**
 * The key this device's custom repertoire is read from and written to: the
 * account's own when one is connected, the legacy shared key otherwise (which is
 * then claimed by the next account that connects — see `loadCustomRepertoire`).
 */
async function customKeyForActiveAccount(): Promise<string> {
  const u = await loadActiveUsername();
  return u ? CUSTOM_KEY(u) : CUSTOM_KEY_LEGACY;
}

/**
 * The CACHED opening analysis — the answer to "he doesn't need to wait for the
 * app to read his openings each time he clicks on 'your openings'".
 *
 * THE PROBLEM IT SOLVES (measured, not assumed)
 * --------------------------------------------
 * Opening "Your openings" used to, every single time:
 *   1. re-fetch up to 200 games from Lichess,
 *   2. replay every game with chess.js to derive positions,
 *   3. run a MultiPV engine search at each one.
 *
 * Step 3 is the killer: one search per position, ~80-120 positions, seconds
 * each on a phone. Re-opening the tab therefore meant minutes of waiting for an
 * answer that had not changed — the games are the same, the engine is the same.
 *
 * So the result is cached under the account that produced it. It is keyed by
 * username for the same reason the games are: switching accounts must not show
 * the previous account's openings.
 *
 * WHY A VERSION FIELD
 * -------------------
 * The derived shape will change as the builder evolves (new fields, a different
 * rotation, extra families). A cached blob from an older build would be read as
 * if it were current and produce subtly wrong cards, so `v` is compared and a
 * mismatch is treated as "no cache" rather than migrated.
 */
export interface CachedOpenings {
  /** Schema version of the derivation — bump when the shape changes. */
  v: number;
  username: string;
  /** The family lines, already rotated and ready to play. */
  families: import('@/lib/openingBuilder').FamilyLine[];
  /** When this was built (ms), so the UI can offer a refresh. */
  builtAt: number;
  /** How many of the user's games went into it, for an honest "from N games". */
  gameCount: number;
  /**
   * How many games had been ANALYSED when these families were derived.
   *
   * The families are built from the analysed positions, and an engine-free position has no
   * recommendation to disagree with, so a cache built before the engine ran describes a screen where
   * nothing can be a decision. That is what "0 in the opening" and "1 to decide" on every opening was:
   * 200 games analysed, and the openings screen still reading the pre-analysis derivation.
   *
   * This is the field that lets it notice. Absent on older caches, and absent is treated as stale -
   * otherwise the first open after an update would keep the old derivation for its whole TTL.
   */
  analysedGameCount?: number;
}

const OPENINGS_CACHE = (u: string) => `chessforge.openings.cache.v1.${u.toLowerCase()}`;

/**
 * Bump when `FamilyLine`'s shape or the rotation changes.
 *
 * Bumping is cheap (the next open rebuilds once) and NOT bumping is expensive
 * (every open shows cards built by an older algorithm). When in doubt, bump.
 *
 * **Bumped to 2 for `bookReplies`.** The "is this our move" answer is now read
 * from the reply set, and a cached blob written by version 1 has no such field —
 * so it would render every position as "your move", which is precisely the lie
 * this change set out to remove. The screen was still serving a version-1 blob
 * after the fix had shipped, which is why the device kept reporting the old
 * behaviour.
 */
/**
 * 2026-09-29, version 3: the derivation now groups a family by the LIBRARY opening the
 * games match, not by Lichess's opening label.
 *
 * The user's report was "there is 2 queens gambit in your opening", and the cause was
 * visible on screen: Lichess calls the same opening "Queen's Gambit" in one move order
 * and "Queen's Pawn" in another, and the family was keyed on that label, so one shipped
 * opening produced two cards.
 *
 * The bump is the whole point of this field, and its absence is why the first attempt at the
 * fix appeared to do nothing: the corrected builder shipped, the screen re-read its cache,
 * and the cache still held families derived by the OLD code - "Up to date 4 h ago", so
 * `openingsCacheIsStale` was false and nothing was recomputed. A derivation change is
 * invisible until the version says so.
 */
/**
 * 2026-09-29, version 4: `openingIdFor` no longer requires a position we ship a book for,
 * so a family the user plays but we do not teach is still named after the opening its moves
 * belong to.
 *
 * Version 3 fixed the grouping but kept the `inBook` gate, so it merged only the families we
 * happen to have books for. The user checked again and reported "it is not fixed: there is 2
 * queens gambit and 2 sicilian" - correct, because the Alapin Sicilian, the Closed Sicilian
 * and Queen's Pawn are lines we do not ship, so under version 3 they could never be
 * recognised as the openings they plainly are.
 *
 * Each of these needed its own bump. A derivation change is invisible until the version
 * says so: the corrected builder shipped, the screen served a cache derived by the old
 * code, and `openingsCacheIsStale` reported "21 min ago" and did nothing.
 */
/**
 * 2026-09-29, version 5: a family is keyed by the opening ALONE, not by the opening and the
 * colour.
 *
 * The user, after versions 3 and 4: "still seeing 2 queens gambit, 2 kings indian attack,
 * 2 polish opening". Reading the screen properly showed the two were
 *
 *     Queen's Gambit   (black)  18 games
 *     Queen's Gambit   (white)  56 games
 *
 * so the colour was in the key the whole time. Versions 3 and 4 both keyed on the opening
 * and kept the side, which is why they fixed the Lichess-label duplication and left this
 * one standing. Anyone who plays an opening with both colours - which is most people, since
 * 1.d4 d5 is reachable by either side - saw two cards for one opening.
 *
 * The colours are merged into one CARD rather than into one line: our White and Black books
 * for an opening are different studies, and interleaving them into a single playable
 * sequence would be wrong. So the colour played most becomes the main line and the other
 * colour's line is attached as a sibling.
 */
/**
 * 2026-09-29, version 6: `FamilyLine` gains `sourceNames`, the SET of Lichess labels a
 * family absorbed, alongside the `sourceName` display string.
 *
 * Version 5 merged several Lichess labels into one card and set `sourceName` to their
 * joined form, "Queen's Gambit + Queen's Pawn". Three places then searched the user's games
 * and stored lines against that string with `===`, and no single game or line can equal it,
 * so a merged family silently recovered nothing: the engine pass got an empty list and the
 * user was shown no evaluation for the move he played or the one recommended, and the "N
 * saved" badge read zero for the families he had practised most.
 * Version 8: WHICH OPENING A LINE IS, decided by how far each book FOLLOWS it.
 *
 * Every opening identification used to come from a matcher that breaks ties by registry order.
 * `1.d4 d5` is two plies that both the London System and the Queen's Gambit Declined contain, so
 * the registry decided — Queen's Gambit is second in the list, London is seventh — and a London
 * System user's games were named Queen's Gambit. That one wrong id then caused all three
 * remaining symptoms, which is what made this look like three separate bugs:
 *
 *   * the card was misnamed;
 *   * the book that finished the line was the wrong book, so the move recommended inside a
 *     London System card was `c4`, and inside the Queen's Gambit card it was `e4` — the reply
 *     was chosen from EVERY opening's book at that position, first one registered;
 *   * and because the line was continued from a book that does not contain the line, the
 *     continuation came back empty, the line ended after the user's first move, and the board
 *     went non-interactive: "i played the knight move then it is blocked".
 *
 * So the derivation itself changed, twice over: the identification, and the reply. The
 * positions cache is deliberately untouched, as ever — a family is a grouping artefact, and
 * re-grouping the stored positions costs a second rather than a re-analysis of 160 games.
 */
export const OPENINGS_CACHE_VERSION = 8;

// ---------------------------------------------------------------------------
// THE POSITION CACHE — WHY IT IS SEPARATE, AND WHY THAT IS THE WHOLE FIX
// ---------------------------------------------------------------------------
/**
 * The ungrouped positions, cached under their OWN key and their OWN version.
 *
 * WHAT WAS WRONG
 * --------------
 * `OPENINGS_CACHE_VERSION` guarded ONE blob holding the finished families. The engine pass
 * runs per family when a family is opened, so the expensive part of a build is not the
 * engine at all - it is `fetchAllGames` re-downloading up to 160 games and then replaying
 * ~4,100 moves through chess.js. A version bump set `fresh`, and `fresh` set `force: true`,
 * so making any change to the GROUPING forced a complete re-fetch and re-replay.
 *
 * Measured on the device after each of five version bumps: the first open took about 90
 * seconds, every time. The bumps were mine - each one made a grouping fix visible - so the
 * instrumentation that was supposed to be measuring the timing was the thing causing it.
 *
 * THE SPLIT
 * ---------
 * Two artefacts with completely different costs and lifetimes:
 *
 *   positions  expensive (fetch + replay), independent of how families are grouped
 *   families   cheap (grouping and rotation), changes whenever the grouping logic does
 *
 * They now have separate keys and separate versions. A grouping change re-groups the
 * existing positions and costs nothing; only a change to the fetch or the replay - the
 * `maxPly` of the derivation, the game filter, the position shape itself - needs this
 * version bumped, and that is the expensive one.
 *
 * The versions are deliberately NOT tied together. Tying them would recreate the original
 * bug in a more convincing-looking form.
 */
export const POSITIONS_CACHE_VERSION = 1;

export interface CachedPositions {
  v: number;
  username: string;
  /** The engine-free positions, exactly as `buildFamilyLines` consumes them. */
  positions: import('@/lib/gameOpenings').GamePosition[];
  /** How many of the user's games these came from, for an honest "from N games". */
  gameCount: number;
  /**
   * How many games had been ANALYSED when these positions were derived.
   *
   * The positions come from the analysed games, so this is part of their identity: a cache written
   * before the engine had run describes engine-free positions, where out of book the recommendation
   * IS the move the user played and therefore nothing disagrees with anything. `loadCachedPositions`
   * cannot detect that on its own - it reads one version number - so this is what the openings screen
   * compares, and a mismatch is treated as a miss rather than as a cache hit.
   *
   * Absent on caches written before this field existed. Absent means "unknown", and unknown is not
   * allowed to pass for fresh, or the first run after the update would keep the stale data for ever.
   */
  analysedGameCount?: number;
  builtAt: number;
}

const POSITIONS_CACHE = (u: string) => `chessforge.openings.positions.v1.${u.toLowerCase()}`;

export async function loadCachedPositions(username: string): Promise<CachedPositions | null> {
  const raw = await readJson<CachedPositions>(POSITIONS_CACHE(username));
  if (!raw || raw.v !== POSITIONS_CACHE_VERSION) return null;
  if (!Array.isArray(raw.positions) || raw.positions.length === 0) return null;
  return raw;
}

export async function saveCachedPositions(
  username: string,
  positions: import('@/lib/gameOpenings').GamePosition[],
  gameCount: number,
  analysedGameCount = 0,
): Promise<void> {
  await writeJson(POSITIONS_CACHE(username), {
    v: POSITIONS_CACHE_VERSION,
    username,
    positions,
    gameCount,
    analysedGameCount,
    builtAt: Date.now(),
  } satisfies CachedPositions);
}

/**
 * How long a cached opening analysis is trusted before we re-check in the
 * background.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The cache had NO time component: `loadCachedOpenings` only compared `v`, so a
 * blob built last month was served forever. The user plays new games every day,
 * so "Your openings" quietly drifted from what they actually play — and the only
 * ways out were switching accounts or finding the manual re-read button, neither
 * of which a user should have to know about.
 *
 * WHY SIX HOURS
 * -------------
 * The refresh costs a full game-list fetch plus a re-rotation, so doing it
 * on every open would throw away the whole point of the cache. Six hours is short
 * enough that a user who plays a session and comes back later the same day sees
 * their new games, and long enough that flicking between tabs costs nothing. It
 * is deliberately NOT tied to midnight — a "new day" is not a chess event.
 */
export const OPENINGS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Is this cached derivation out of date?
 *
 * TWO REASONS, AND THE SECOND IS THE ONE THAT MATTERED.
 *
 * Age is the original rule and it is still right for its purpose: a background refresh of a screen the
 * user is looking at.
 *
 * But age alone cannot see the case that actually happened here. The families are derived from the
 * ANALYSED positions, so an analysis changes them - and the derived screen goes from showing nothing
 * to showing mistakes, without a single byte of the cache getting older. A TTL is a statement about
 * time; this is a statement about the input having changed, and only the input can say so.
 *
 * So a cache whose analysed-game count no longer matches the scan is stale immediately, whatever its
 * age. An absent count is stale too, so a cache written before this field existed cannot survive its own
 * TTL with the old derivation still in place.
 */
export function openingsCacheIsStale(
  cached: CachedOpenings,
  analysedGameCount?: number,
): boolean {
  if (typeof analysedGameCount === 'number' && cached.analysedGameCount !== analysedGameCount) {
    return true;
  }
  if (cached.analysedGameCount === undefined) return true;
  const built = cached.builtAt ?? 0;
  if (!Number.isFinite(built) || built <= 0) return true;
  return Date.now() - built > OPENINGS_CACHE_TTL_MS;
}

/**
 * Does this cached derivation describe the games the account has NOW?
 *
 * THE GAP THIS CLOSES. `openingsCacheIsStale` watches the analysis and the clock, and both are real
 * signals - but neither of them notices a refresh that ADDED GAMES. A refresh clears the derived
 * POSITIONS, while the family list the screen paints from lives in a different blob that the refresh
 * never touches. So a user who refreshed, gained a game in an opening they had never shown, and
 * reopened this screen inside the TTL got the old list painted instantly - and, because the cache
 * read as fresh, got no background re-derivation either. The new game stayed invisible until the
 * next analysis, which is the "we keep having the same problems" loop in its purest form: the
 * screen was fast, correct about everything it knew, and wrong about the one thing that had changed.
 *
 * UNKNOWN IS NOT STALE. An absent number on either side means the question cannot be answered, and
 * answering it with "rebuild" would discard a warm cache on a guess. The analysed-count rule above
 * already handles the case of a cache written before this field existed; this one only speaks when
 * both counts are known.
 */
export function openingsCacheGameCountIsStale(
  cached: CachedOpenings,
  gameCount?: number | null,
): boolean {
  if (typeof gameCount !== 'number') return false;
  if (typeof cached.gameCount !== 'number') return false;
  return cached.gameCount !== gameCount;
}

export async function loadCachedOpenings(username: string): Promise<CachedOpenings | null> {
  const raw = await readJson<CachedOpenings>(OPENINGS_CACHE(username));
  if (!raw || raw.v !== OPENINGS_CACHE_VERSION) return null;
  if (!Array.isArray(raw.families)) return null;
  return raw;
}

export async function saveCachedOpenings(
  username: string,
  families: import('@/lib/openingBuilder').FamilyLine[],
  gameCount: number,
  analysedGameCount = 0,
): Promise<void> {
  await writeJson(OPENINGS_CACHE(username), {
    v: OPENINGS_CACHE_VERSION,
    username,
    families,
    builtAt: Date.now(),
    gameCount,
    analysedGameCount,
  } satisfies CachedOpenings);
}

/** Drop the cached opening analysis (used by an explicit "refresh" action). */
export async function clearCachedOpenings(username: string): Promise<void> {
  try {
    await Storage.removeItem(OPENINGS_CACHE(username));
  } catch { /* ignore */ }
}

/**
 * Drop the derived opening positions.
 *
 * They are DERIVED from the analysed games, so new verdicts make them wrong, and they were the one
 * cache with no staleness check at all - `loadCachedPositions` reads its own version and nothing else,
 * so a cache written before the engine had ever run stayed "fresh" for ever. That is why analysing
 * two hundred more games changed nothing on the openings screen.
 *
 * Called where the truth changes (the end of an analysis run) rather than polled for, so the
 * invalidation cannot itself be the thing that quietly stops happening.
 */
export async function clearCachedPositions(username: string): Promise<void> {
  try {
    await Storage.removeItem(POSITIONS_CACHE(username));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// The engine's verdicts
// ---------------------------------------------------------------------------

/**
 * THE ENGINE PASS SURVIVES A LAUNCH, SO OPENING AN OPENING IS FAST THE SECOND TIME.
 *
 * THE REPORT: *"when i open the app and go to your openings and open an opening it takes too much
 * time as before so we keep having the same problems after fixing them thousand times"*.
 *
 * "As before" is the operative phrase, and it was literally true. The verdicts lived in
 * `analysedRef`, a `useRef` in the screen, which dies with the process — so every cold launch
 * re-ran the pass for every opening the user opened, up to 24 searches at depth 10 with multipv 3
 * on a phone. The work was already being cached; it was being cached in the one place that cannot
 * outlive the app.
 *
 * The key is POSITIONAL (`GamePosition.key` is a FEN key), which is what makes persisting it safe:
 * a verdict is a statement about a position, not about a game list, so a refresh that adds games
 * leaves every stored verdict still true. That is also why nothing here is cleared when the games
 * change — clearing would throw away correct work and re-buy the very wait this removes.
 *
 * What is NOT safe across accounts is the family id, which is why this is namespaced per user like
 * every other cache here. A switch seeds the new account's verdicts and leaves the old ones alone.
 *
 * DISTINCT FROM THE OPENINGS CACHE ON PURPOSE. That one holds the derived families and is dropped
 * when the games change; this one holds answers about positions and is not. Merging them would
 * make the cheap thing expensive again.
 */
export interface CachedVerdicts {
  v: number;
  username: string;
  /** family id -> the engine's verdicts for the positions in it. */
  families: Record<string, import('@/lib/gameOpenings').GamePosition[]>;
  savedAt: number;
}

const VERDICTS_CACHE = (u: string) => `chessforge.openings.verdicts.v1.${u.toLowerCase()}`;
export const VERDICTS_CACHE_VERSION = 1;

export async function loadCachedVerdicts(username: string): Promise<CachedVerdicts | null> {
  const raw = await readJson<CachedVerdicts>(VERDICTS_CACHE(username));
  if (!raw || raw.v !== VERDICTS_CACHE_VERSION) return null;
  // A blob with no families object is not an empty cache, it is an unreadable one.
  if (!raw.families || typeof raw.families !== 'object') return null;
  return raw;
}

export async function saveCachedVerdicts(
  username: string,
  families: Record<string, import('@/lib/gameOpenings').GamePosition[]>,
): Promise<void> {
  // Never overwrite good stored verdicts with nothing: an empty map is the state before the pass,
  // not a finding of the pass.
  if (Object.keys(families).length === 0) return;
  await writeJson(VERDICTS_CACHE(username), {
    v: VERDICTS_CACHE_VERSION,
    username: username.toLowerCase(),
    families,
    savedAt: Date.now(),
  } satisfies CachedVerdicts);
}

export async function clearCachedVerdicts(username: string): Promise<void> {
  try {
    await Storage.removeItem(VERDICTS_CACHE(username));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// The game list itself
// ---------------------------------------------------------------------------

/**
 * The user's fetched games, persisted so the app does not have to ask for them
 * again on every launch.
 *
 * WHY THIS EXISTS
 * ---------------
 * "i dont want the user to need to refresh every time he opens the app."
 *
 * The client keeps no in-memory game cache, so without this the process dying
 * meant there was NO game data anywhere on the device: the stats screen restored
 * the account and painted an empty screen until the network answered again. The
 * openings screen had its own persistent cache and opened instantly, which is
 * exactly why the two screens disagreed about whether the app remembered
 * anything.
 *
 * WHY THE MAPPED GAMES AND NOT THE RAW PAYLOAD
 * --------------------------------------------
 * `toGame` has already thrown away the PGN text, the clocks and the rest of the
 * Lichess response; what is left is the fields the app actually reads. That is
 * ~0.3-0.7 MB for 200 games, which is a reasonable thing to keep in a key-value
 * store and far smaller than the payloads it replaces.
 *
 * WHY A VERSION FIELD
 * -------------------
 * Same reason as the openings cache: `LichessGame` gains fields over time, and
 * a blob written by an older build must be treated as absent rather than read as
 * if it were current.
 */
export interface CachedGames {
  v: number;
  username: string;
  games: import('@/lib/lichess').LichessGame[];
  /** When this was fetched (ms), so staleness can be judged without a fetch. */
  savedAt: number;
  /**
   * The opening-label pass that produced these games.
   *
   * The games are stored mapped (`toGame`), and their opening label now comes
   * from our own books where the moves support it. A blob written before that
   * existed would keep Lichess's label forever - the games are only refetched
   * every six hours, and a user who never refreshes would never see the fix. So
   * the pass is versioned: a blob that predates it is RELABELLED ONCE on load,
   * from the moves it already carries, with no refetch and no data loss.
   *
   * Absent (older blobs) reads as 0, which is exactly "before the pass".
   */
  labelsV?: number;
}

const GAMES_CACHE = (u: string) => `chessforge.li.games.v1.${u.toLowerCase()}`;
export const GAMES_CACHE_VERSION = 1;
/** Bump when the per-game opening label is derived differently. See `CachedGames.labelsV`. */
export const OPENING_LABEL_VERSION = 1;

/**
 * How long a persisted game list is trusted before a silent background refresh.
 *
 * Shorter than the openings TTL on purpose. The openings are a DERIVATION of the
 * games — they only change when the games change — whereas these ARE the games,
 * and the whole point of showing them instantly is that they are worth showing.
 * Six hours is the same promise the openings make, so the two screens cannot
 * drift apart on the question "is this fresh".
 */
export const GAMES_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export async function loadCachedGames(username: string): Promise<CachedGames | null> {
  const raw = await readJson<CachedGames>(GAMES_CACHE(username));
  if (!raw || raw.v !== GAMES_CACHE_VERSION) return null;
  if (!Array.isArray(raw.games)) return null;

  /*
   * RELABEL, ONCE, WITHOUT REFETCHING.
   *
   * `savedAt` is preserved deliberately: this is not a fetch, and a migration
   * that stamped "just saved" would silence the staleness check and delay the
   * user's next real refresh by up to six hours.
   */
  if ((raw.labelsV ?? 0) !== OPENING_LABEL_VERSION) {
    const games = raw.games.map(relabelGameOpening);
    const migrated: CachedGames = { ...raw, games, labelsV: OPENING_LABEL_VERSION };
    void writeJson(GAMES_CACHE(username), migrated);
    return migrated;
  }
  return raw;
}

export async function saveCachedGames(
  username: string,
  games: import('@/lib/lichess').LichessGame[],
): Promise<void> {
  if (games.length === 0) return; // never overwrite a good list with an empty one
  await writeJson(GAMES_CACHE(username), {
    v: GAMES_CACHE_VERSION,
    username: username.toLowerCase(),
    games,
    savedAt: Date.now(),
    labelsV: OPENING_LABEL_VERSION,
  } satisfies CachedGames);
}

/** Is this cached game list old enough to warrant a silent background refresh? */
export function gamesCacheIsStale(cached: CachedGames): boolean {
  const at = cached.savedAt ?? 0;
  if (!Number.isFinite(at) || at <= 0) return true;
  return Date.now() - at > GAMES_CACHE_TTL_MS;
}

export async function clearCachedGames(username: string): Promise<void> {
  try {
    await Storage.removeItem(GAMES_CACHE(username));
  } catch { /* ignore */ }
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await Storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt or half-written JSON: treat as absent rather than crashing the
    // screen. The scan is a derived cache and can always be rebuilt.
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await Storage.setItem(key, JSON.stringify(value));
  } catch {
    /* a failed cache write must never break the UI */
  }
}

// ---------------------------------------------------------------------------
// Active account
// ---------------------------------------------------------------------------

export async function loadActiveUsername(): Promise<string | null> {
  try {
    return await Storage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export async function loadAccount(username: string): Promise<LichessAccount | null> {
  return readJson<LichessAccount>(ACCOUNT_KEY(username));
}

/**
 * Forget WHICH account is active, without touching any account's data.
 *
 * The counterpart to "Change account" on the stats screen. Distinct from
 * `forgetAccount`, which deletes a named account's profile and scan: this only
 * drops the pointer, so a relaunch shows the connect form instead of silently
 * restoring the account the user just navigated away from.
 *
 * Deliberately does NOT delete the account's own key — re-entering the same name
 * is a refresh, and must find its profile and scan progress intact.
 */
export async function clearActiveUsername(): Promise<void> {
  try {
    await Storage.removeItem(ACTIVE_KEY);
  } catch {
    /* a failed clear must not break the screen */
  }
}

export async function saveAccount(account: LichessAccount): Promise<void> {
  await writeJson(ACCOUNT_KEY(account.username), account);
  try {
    await Storage.setItem(ACTIVE_KEY, account.username.toLowerCase());
  } catch { /* ignore */ }
}

/**
 * Forget an account completely.
 *
 * The user was explicit: entering a *different* account name must **delete the
 * saved data for the old account**, not merge it. Removing both keys (profile +
 * scan) in one place keeps that promise in a single auditable spot rather than
 * spread across the screen's switch handler.
 *
 * The SRS state of the mined puzzles is intentionally left alone: those are
 * positions the user has trained, their progress is theirs, and the deck can be
 * re-mined without it. Deleting someone's training history because they typed a
 * different name would be a surprising and destructive reading of the request.
 */
export async function forgetAccount(username: string): Promise<void> {
  const u = username.toLowerCase();
  try {
    await Storage.removeItem(ACCOUNT_KEY(u));
    await Storage.removeItem(SCAN_KEY(u));
    // The cached opening analysis is derived from THIS account's games, so it
    // goes with them. Leaving it would show the deleted account's openings the
    // next time an account is connected.
    await Storage.removeItem(OPENINGS_CACHE(u));
    // Same reasoning, one step closer to the source: this IS the account's game
    // list. Keeping it would let a switch show the previous account's stats from
    // disk before the new account's fetch landed.
    await Storage.removeItem(GAMES_CACHE(u));
    /*
     * THE POSITIONS AND THE ENGINE'S VERDICTS STAY, ON PURPOSE.
     *
     * They are keyed by account, so the next account cannot see them - the question is only whether
     * WIPING them is right, and it is not. Both are derived from THIS account's games, and the games
     * come back identical when the account is reconnected (Lichess game ids do not change), so the
     * work is still true. Wiping them would make a user who steps away and returns re-buy a full
     * replay plus an engine pass for data we already hold.
     *
     * What made the other two caches dangerous is what they do NOT carry: the openings blob holds a
     * game count and an analysed count, and the games blob IS the game list - a wipe leaves both
     * saying something about a fetch that no longer exists, and the screen would paint them. The
     * positions blob carries both counts too, and it is checked against the live ones on every read
     * (`deriveFamilies`), so a stale one reads as a miss rather than as an answer.
     */
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Scan state
// ---------------------------------------------------------------------------

export function emptyScanState(): ScanState {
  return { records: {}, puzzles: [], totalGames: 0, complete: false, updatedAt: 0 };
}

export async function loadScanState(username: string): Promise<ScanState> {
  const s = await readJson<ScanState>(SCAN_KEY(username));
  if (!s) return emptyScanState();
  // Defend against a partially-written older shape rather than crashing on
  // `undefined.map` somewhere deep in the screen.
  return {
    records: s.records ?? {},
    puzzles: s.puzzles ?? [],
    totalGames: s.totalGames ?? 0,
    complete: Boolean(s.complete),
    updatedAt: s.updatedAt ?? 0,
  };
}

export async function saveScanState(username: string, state: ScanState): Promise<void> {
  await writeJson(SCAN_KEY(username), { ...state, updatedAt: Date.now() });
}

/**
 * The active account and its mined deck, in one read.
 *
 * "From your games" and Your openings both paint from this, and both used to open-code the same
 * two calls with the same empty-account branch — a second definition of "what the mined deck is",
 * waiting to drift. One helper, so the mount load, a reload after an in-place import, and any fix
 * to the read itself reach every surface at once.
 */
export async function loadMinedDeck(): Promise<{ username: string | null; puzzles: ScanState['puzzles'] }> {
  const username = await loadActiveUsername();
  if (!username) return { username: null, puzzles: [] };
  const scan = await loadScanState(username);
  return { username, puzzles: scan.puzzles };
}

/**
 * Persist just the records, without rewriting the puzzle deck.
 *
 * Called after EVERY scanned game. Two reasons it is split out from
 * `saveScanState`:
 *   1. the puzzle deck is a large array and rewriting it per game is wasteful,
 *   2. the records map is what resumption depends on, so it must be written
 *      often and cheaply.
 */
export async function saveScanRecords(
  username: string,
  records: Record<string, import('@/lib/gameScan').ScanRecord>,
  totalGames: number,
  complete: boolean,
): Promise<void> {
  const existing = await loadScanState(username);
  await writeJson(SCAN_KEY(username), {
    ...existing,
    records,
    totalGames,
    complete,
    updatedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Custom repertoire
// ---------------------------------------------------------------------------

/** Load the user's custom repertoire (never null — an absent one is empty). */
export async function loadCustomRepertoire(): Promise<CustomRepertoire> {
  const u = await loadActiveUsername();
  const key = u ? CUSTOM_KEY(u) : CUSTOM_KEY_LEGACY;

  const raw = await readJson<CustomRepertoire>(key);
  if (raw && typeof raw === 'object' && raw.positions) return raw;

  /*
   * CLAIM THE PRE-NAMESPACING REPERTOIRE, ONCE.
   *
   * A blob under the legacy key has no account recorded, and it must not be
   * shown to every account that reads one - that is the defect this namespacing
   * fixes. The first account to look is the one the user was using when those
   * choices were made (the active account is only replaced when a new account is
   * connected), so it takes them and the legacy key is removed. From then on the
   * key is per account and an empty result means empty.
   */

  if (u) {
    const legacy = await readJson<CustomRepertoire>(CUSTOM_KEY_LEGACY);
    if (legacy && typeof legacy === 'object' && legacy.positions
      && Object.keys(legacy.positions).length > 0) {
      await writeJson(key, legacy);
      try { await Storage.removeItem(CUSTOM_KEY_LEGACY); } catch { /* keep going */ }
      return legacy;
    }
  }

  return { positions: {}, updatedAt: 0 };
}

/**
 * Record one decision at one position.
 *
 * Read-modify-write rather than a blind overwrite, because the caller only ever
 * knows about the one position it is showing. Writing the whole map from a stale
 * in-memory copy would silently drop decisions made on another position.
 */
export async function saveAdoption(
  line: import('@/lib/gameOpenings').CustomLine,
): Promise<CustomRepertoire> {
  return saveAdoptions([line]);
}

/**
 * Save a WHOLE BATCH of adoptions in one read and one write.
 *
 * WHY THIS EXISTS — A PERFORMANCE REGRESSION, NOT A CONVENIENCE
 * ----------------------------------------------------------
 * `saveAdoption` was called once per PLY. Each call re-read the entire custom
 * repertoire, merged one key, and wrote the whole thing back. Playing one 12-ply line
 * therefore meant 12 full read-modify-writes of a JSON document that grows with
 * every decision the user has ever made.
 *
 * The visible symptom was not slowness, it was **the board stopping responding to
 * touches**: every call returned a freshly-parsed object, the caller assigned it to
 * state, and the whole screen re-rendered mid-gesture. A user dragging a piece was
 * fighting a re-render on every ply.
 *
 * So the same write is now done once for a batch, and the state object only changes
 * once per batch. Nothing about the stored data changes: same keys, same values, same
 * `updatedAt` semantics.
 *
 * `saveAdoption` is kept as a one-line wrapper so existing callers are unaffected.
 */
export async function saveAdoptions(
  lines: import('@/lib/gameOpenings').CustomLine[],
): Promise<CustomRepertoire> {
  if (lines.length === 0) return loadCustomRepertoire();
  const key = await customKeyForActiveAccount();
  const cur = await loadCustomRepertoire();
  const positions = { ...cur.positions };
  // Later entries win, so a batch replays in order if it somehow contains a
  // duplicate key — which is what the single-write version did too.
  for (const line of lines) positions[line.key] = line;
  const next: CustomRepertoire = { positions, updatedAt: Date.now() };
  await writeJson(key, next);
  return next;
}

/** Forget one position's decision (used by "reset to our recommendation"). */
export async function clearAdoption(key: string): Promise<CustomRepertoire> {
  const storeKey = await customKeyForActiveAccount();
  const cur = await loadCustomRepertoire();
  const positions = { ...cur.positions };
  delete positions[key];
  const next: CustomRepertoire = { positions, updatedAt: Date.now() };
  await writeJson(storeKey, next);
  return next;
}

/** Wipe the whole custom repertoire — an explicit, user-initiated action. */
export async function clearCustomRepertoire(): Promise<void> {
  const key = await customKeyForActiveAccount();
  await writeJson(key, { positions: {}, updatedAt: Date.now() });
}

