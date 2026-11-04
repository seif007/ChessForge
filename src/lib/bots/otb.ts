/**
 * BOT SOURCES — over the board.
 *
 * Lichess only covers players who play there. The FIDE ecosystem does not
 * hand out an API, so a player's published games are assembled from the two
 * archives that together cover most of the rated world:
 *
 *   Tier 1 — PGN Mentor's notable-players archive: ~250 legends, deep history,
 *            one zip per player.
 *   Tier 2 — TWIC weekly reports: any internationally active FIDE-rated player,
 *            one zip per week, scanned backwards from the latest issue.
 *
 * The web version of this pipeline ran on a server with a disk cache and a
 * streaming response. On a phone there is no server, so:
 *
 *   - fetches go straight to the archives (the device's network, the device's
 *     IP — no proxy to keep alive),
 *   - progress is reported through a callback instead of a stream,
 *   - "which player did you mean" is an exception carrying its options instead
 *     of an event that ends the stream,
 *   - zips are cached in memory for the length of the session, never on disk:
 *     a TWIC week is ~2.5 MB compressed and ~20 MB of them would be a rude thing
 *     to keep on a phone forever,
 *   - the scan is six months deep by default rather than two years — a bot needs
 *     the player's CURRENT style, and 26 weekly downloads is already a build
 *     measured in minutes on a slow connection.
 */

import { strFromU8, unzipSync } from 'fflate';
import { pgnHeaders, splitPgnGames } from './profile';
import { BOT_GAMES_TARGET, MAX_BOT_GAMES, MIN_GAMES_FOR_BOT } from './sources';
import type { BotBuildProgress, BotMeta, RawBotGame } from './types';

const UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

const JSON_HEADERS = { 'User-Agent': UA, 'Accept-Encoding': 'identity', Accept: '*/*' };

export const TWIC_MAX_WEEKS = 26;
export const TWIC_BATCH_WEEKS = 13;
const TWIC_PARALLEL = 6;
const TWIC_TIME_BUDGET_MS = 100_000;
export const TWIC_FALLBACK_LATEST = 1666;
const SESSION_TTL = 24 * 60 * 60 * 1000;

/* --------------------------------------------------------------- session cache */

const memCache = new Map<string, { t: number; data: unknown }>();

async function cached<T>(key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
  const hit = memCache.get(key) as { t: number; data: T } | undefined;
  if (hit && Date.now() - hit.t < ttl) return hit.data;
  const data = await loader();
  memCache.set(key, { t: Date.now(), data });
  return data;
}

/** Forget everything this session cached about the archives. */
export function clearOtbSessionCache() {
  memCache.clear();
  twicPgnCache.clear();
}

/* ------------------------------------------------------------ network retry */

/**
 * Thrown when a partner archive cannot be reached at all.
 *
 * The message is the one the user reads under the create-bot button, so it is
 * written for them: what happened, and what to do about it. The raw failure —
 * a resolver refusing, a TCP reset — is deliberately dropped;
 * `java.net.UnknownHostException` under a build button tells a person nothing.
 */
export class ArchiveUnreachableError extends Error {
  constructor(readonly source: string) {
    super(`Could not reach ${source} — check your internet connection and try again.`);
    this.name = 'ArchiveUnreachableError';
  }
}

/**
 * A GET that forgives a flaky resolver.
 *
 * THE REPORT: an OTB build died with a raw `java.net.UnknownHostException`
 * from the device's DNS while the archive was answering again a second later.
 * Phones change networks mid-request and resolvers hiccup; three attempts
 * with a short pause between them turn almost all of that into a build that
 * merely took a second longer. Only when every attempt fails does the caller
 * hear about it — in words meant for a person.
 */
async function netFetch(
  url: string,
  source: string,
  signal?: AbortSignal,
  attempts = 3,
): Promise<Response> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetch(url, { headers: JSON_HEADERS, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
      }
    }
  }
  throw new ArchiveUnreachableError(source);
}

/* ---------------------------------------------------------------- FIDE lookup */

/**
 * A FIDE profile page's name and standard rating, or null for anything that is
 * not a real profile. Exported because the shape of third-party HTML is not
 * something to discover in production: the gate feeds it real fragments.
 */
export function parseFideProfileHtml(html: string): { name: string; stdRating?: number } | null {
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
  const name = title.replace(/\s*FIDE\s+Profile.*$/i, '').trim();
  // Real profiles always have "Surname, Given" in the title; a generic page
  // means the ID does not exist.
  if (!/^[A-Za-z][A-Za-z'.-]*,\s*[A-Za-z][A-Za-z'.-]*(\s+[A-Za-z][A-Za-z'.-]*)*$/.test(name)) {
    return null;
  }
  const stdRating =
    // current layout: <img src="/img/logo_std.svg" alt="standart" height=25><p>2792</p>
    // ([\s\S] because the img attributes contain digits that [^0-9] cannot cross)
    Number(html.match(/logo_std\.svg[\s\S]{0,150}?(\d{4})\s*<\/p>/i)?.[1] ?? 0) ||
    Number(html.match(/(?:Standard Classical|std)[\s\S]{0,200}?(\d{4})/i)?.[1] ?? 0) ||
    undefined;
  return { name, stdRating };
}

/**
 * FIDE ID → the player's canonical "Surname, Given" name.
 *
 * Failures are never cached: the site serves intermittently empty pages from a
 * flaky micro-cache, and a poisoned lookup must not stick for a day. The
 * cache-buster query sidesteps that micro-cache in the first place.
 */
export async function resolveFideProfile(
  fideId: string,
  signal?: AbortSignal,
): Promise<{ name: string; stdRating?: number } | null> {
  const key = `fide-${fideId}`;
  const hit = memCache.get(key) as { t: number; data: { name: string; stdRating?: number } } | undefined;
  if (hit && Date.now() - hit.t < SESSION_TTL) return hit.data;

  const url = `https://ratings.fide.com/profile/${encodeURIComponent(fideId)}`;
  try {
    const res = await netFetch(`${url}?_=${Date.now().toString(36)}`, 'the FIDE ratings site', signal);
    if (!res.ok) return null;
    const parsed = parseFideProfileHtml(await res.text());
    if (parsed) memCache.set(key, { t: Date.now(), data: parsed });
    return parsed;
  } catch (err) {
    /*
     * A network that never answered is not "no such player" — the difference
     * matters when a FIDE ID is all the user has. An aborted build is not a
     * miss either; it is the user leaving, and it must stop the build.
     */
    if (err instanceof ArchiveUnreachableError || signal?.aborted) throw err;
    return null;
  }
}

/* ------------------------------------------------------------ fuzzy name match */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/**
 * How close is an archive's spelling of a name to the query, 0-100?
 *
 * The thresholds in this file (60 to count, 92 to call two spellings the same
 * player) were tuned against what the archives actually publish, so the levels
 * are deliberate: an exact string, the same words in the other order, a
 * surname with matching or missing initials, and only then prefix overlap.
 */
export function scoreName(query: string, entry: string): number {
  const q = norm(query);
  const e = norm(entry);
  if (!q || !e) return 0;
  if (q === e) return 100;
  // word-order independent ("Magnus Carlsen" vs "Carlsen,Magnus")
  const qw = query.toLowerCase().replace(/[^a-z, ]/g, '').split(/[,\s]+/).filter(Boolean);
  const ew = entry.toLowerCase().replace(/[^a-z, ]/g, '').split(/[,\s]+/).filter(Boolean);
  const qJoined = norm([...qw].reverse().join(''));
  if (qJoined === e) return 96;
  // first/last token pairing ("Nakamura, Hikaru" ≈ "Nakamura,Hikaru")
  const qSur = qw[qw.length - 1];
  const qInit = qw[0]?.[0] ?? '';
  const eSur = ew[ew.length - 1];
  const eInit = ew[0]?.[0] ?? '';
  if (qSur === eSur && (qInit === eInit || !qInit || !eInit)) return 92;
  if (qSur === eSur) return 78;
  if (e.startsWith(q) || q.startsWith(e))
    return 70 + (Math.min(q.length, e.length) / Math.max(q.length, e.length)) * 10;
  if (e.startsWith(qJoined) || qJoined.startsWith(e)) return 68;
  return 0;
}

/** "Aronian,L" → "L Aronian", so "Given Surname" queries match abbreviated entries. */
export function swapName(name: string): string {
  const m = name.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}` : name;
}

/** Does a game-header name refer to our player? (the query may be either word order) */
export function nameMatches(headerName: string, query: string): boolean {
  return scoreName(query, headerName) >= 60 || scoreName(query, swapName(headerName)) >= 60;
}

export function nameMatchScore(headerName: string, query: string): number {
  return Math.max(scoreName(query, headerName), scoreName(query, swapName(headerName)));
}

/* --------------------------------------------------- PGN Mentor player archive */

export interface PlayerEntry {
  file: string;
  name: string;
  games: number;
}

const MENTOR_LIST_TTL = 7 * 24 * 60 * 60 * 1000;

async function getPlayersList(signal?: AbortSignal): Promise<PlayerEntry[]> {
  return cached('pgn-mentor-players', MENTOR_LIST_TTL, async () => {
    const res = await netFetch('https://www.pgnmentor.com/files.html', 'PGN Mentor', signal);
    const html = await res.text();
    const entries: PlayerEntry[] = [];
    const re =
      /<a href="players\/([^"]+)\.zip"[^>]*>[^<]*<\/a>[\s\S]{0,300}?<td>([A-Za-z][^,<]*(?:,[^<\n]*)?),\s*(\d+)\s*games<\/td>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const name = m[2].trim();
      if (name) entries.push({ file: m[1] + '.zip', name, games: Number(m[3]) });
    }
    return entries;
  });
}

export function bestPlayerMatch(query: string, entries: readonly PlayerEntry[]): PlayerEntry | null {
  let best: PlayerEntry | null = null;
  let bestScore = 0;
  for (const entry of entries) {
    const s = Math.max(scoreName(query, entry.name), scoreName(query, entry.file.replace(/\.zip$/, '')));
    if (s > bestScore) {
      bestScore = s;
      best = entry;
    }
  }
  return bestScore >= 60 ? best : null;
}

/* ------------------------------------------------------------------ PGN shapes */

export interface ParsedOtbGame {
  pgn: string;
  white: string;
  black: string;
  whiteRating?: number;
  blackRating?: number;
  date?: string;
  eco?: string;
  timeControl?: string;
  /** which header value matched the query */
  matchedName: string;
}

/** The .pgn member of a zip, as text. Null when there is none or it is unreadable. */
export function unzipPgn(buf: Uint8Array): string | null {
  try {
    const files = unzipSync(buf);
    const pgnName = Object.keys(files).find((f) => f.toLowerCase().endsWith('.pgn'));
    return pgnName ? strFromU8(files[pgnName]) : null;
  } catch {
    return null;
  }
}

/**
 * One game out of an archive file, if it is this player's.
 *
 * `matchedName` is the header spelling that matched — not the query — because
 * the same player appears under several spellings ("Nakamura,Hi" and
 * "Nakamura,Hikaru") and the disambiguation below groups by the spelling.
 */
export function parseOtbGame(game: string, query: string): ParsedOtbGame | null {
  const tags = pgnHeaders(game);
  const white = tags.White ?? '?';
  const black = tags.Black ?? '?';
  const whiteScore = nameMatchScore(white, query);
  const blackScore = nameMatchScore(black, query);
  if (Math.max(whiteScore, blackScore) < 60) return null;
  return {
    pgn: game.trim(),
    white,
    black,
    whiteRating: Number(tags.WhiteElo) || undefined,
    blackRating: Number(tags.BlackElo) || undefined,
    date: tags.UTCDate ?? tags.Date,
    eco: tags.ECO,
    timeControl: tags.TimeControl,
    matchedName: whiteScore >= blackScore ? white : black,
  };
}

/** Every game in an archive file that has the two player tags. */
function otbGames(pgnText: string): string[] {
  return splitPgnGames(pgnText).filter((g) => g.includes('[White ') && g.includes('[Black '));
}

/* ------------------------------------------------------------- TWIC weeklies */

async function twicLatestIssue(signal?: AbortSignal): Promise<number> {
  return cached('twic-latest', 12 * 60 * 60 * 1000, async () => {
    try {
      const res = await netFetch('https://theweekinchess.com/twic', 'the weekly reports', signal);
      if (res.ok) {
        const html = await res.text();
        const nums = [...html.matchAll(/twic(\d{3,4})/gi)].map((m) => Number(m[1]));
        const latest = Math.max(0, ...nums);
        if (latest > 1000) return latest;
      }
    } catch {
      /* fall through */
    }
    return TWIC_FALLBACK_LATEST;
  });
}

/**
 * The decompressed PGN of one TWIC issue.
 *
 * A week is fetched once per build; the last few stay in memory so a retry
 * after a failure does not re-download what it already had. The cap is what
 * keeps that from becoming a pile of 2.5 MB zips that lives until the app is
 * killed.
 */
const twicPgnCache = new Map<number, string>();
const TWIC_PGN_KEEP = 8;

function rememberTwicPgn(issue: number, pgn: string) {
  twicPgnCache.set(issue, pgn);
  while (twicPgnCache.size > TWIC_PGN_KEEP) {
    const oldest = twicPgnCache.keys().next().value;
    if (oldest === undefined) break;
    twicPgnCache.delete(oldest);
  }
}

export async function twicWeekPgn(issue: number, signal?: AbortSignal): Promise<string | null> {
  const cachedPgn = twicPgnCache.get(issue);
  if (cachedPgn) return cachedPgn;

  const res = await fetch(`https://theweekinchess.com/zips/twic${issue}g.zip`, {
    headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' },
    signal,
  }).catch(() => null);
  if (!res || !res.ok) return null;

  const pgn = unzipPgn(new Uint8Array(await res.arrayBuffer()));
  if (pgn) rememberTwicPgn(issue, pgn);
  return pgn;
}

/* ------------------------------------------------------------- disambiguation */

export interface OtbVariant {
  /** the most specific (longest) spelling seen */
  name: string;
  normKey: string;
  games: number;
  latestDate?: string;
}

export function variantKey(name: string): string {
  const m = name.match(/^([^,]+),\s*(.+)$/);
  const surname = (m ? m[1] : name.split(/\s+/).pop() ?? name).toLowerCase().replace(/[^a-z]/g, '');
  const given = (m ? m[2] : name.split(/\s+/).slice(0, -1).join(' ')).toLowerCase().replace(/[^a-z]/g, '');
  return `${surname}|${given}`;
}

/**
 * Merge abbreviated spellings with full ones: "Nakamura,Hi" ⊂ "Nakamura,Hikaru".
 *
 * The length guard is what keeps an abbreviation rule from becoming a
 * same-surname rule: "Carlsen,M" is Carlsen, but "Carlsen,Ma" and
 * "Carlsen,Mi" are two different people and must stay two variants.
 */
export function mergeVariants(variants: readonly OtbVariant[]): OtbVariant[] {
  const merged: OtbVariant[] = [];
  for (const v of variants) {
    const [vs, vg] = v.normKey.split('|');
    let target: OtbVariant | undefined;
    for (const m of merged) {
      const [ms, mg] = m.normKey.split('|');
      if (ms !== vs) continue;
      if ((vg.startsWith(mg) || mg.startsWith(vg)) && Math.min(vg.length, mg.length) <= 4) {
        target = m;
        break;
      }
    }
    if (target) {
      target.games += v.games;
      if (v.name.length > target.name.length) target.name = v.name;
      if ((v.latestDate ?? '') > (target.latestDate ?? '')) target.latestDate = v.latestDate;
    } else {
      merged.push({ ...v });
    }
  }
  return merged;
}

/** A raw game that still remembers which header spelling matched the query. */
type OtbRawGame = RawBotGame & { matchedName: string };

/** Thrown when the archives hold more than one plausible player. */
export class OtbAmbiguityError extends Error {
  constructor(
    message: string,
    readonly options: { name: string; games: number; latestDate?: string }[],
  ) {
    super(message);
    this.name = 'OtbAmbiguityError';
  }
}

/** Thrown when the player exists but no published games were found. */
export class OtbNoGamesError extends Error {
  constructor(
    message: string,
    readonly suggestions: string[],
  ) {
    super(message);
    this.name = 'OtbNoGamesError';
  }
}

/* ------------------------------------------------------------------ pipeline */

/**
 * The whole OTB lookup: name (or FIDE ID) in, recent games and a meta record
 * out. Throws `OtbAmbiguityError` when the archives disagree about who the
 * player is, and `OtbNoGamesError` when there is nothing to build from.
 */
export async function fetchOtbBotGames(
  query: string,
  onProgress: (p: BotBuildProgress) => void,
  opts: { maxGames?: number; signal?: AbortSignal } = {},
): Promise<{ games: RawBotGame[]; meta: BotMeta }> {
  const q = query.trim();
  if (q.length < 2) throw new Error('Provide a player name or FIDE ID.');

  const maxGames = Math.max(
    MIN_GAMES_FOR_BOT,
    Math.min(MAX_BOT_GAMES, Math.floor(opts.maxGames ?? BOT_GAMES_TARGET)),
  );
  const signal = opts.signal;
  const t0 = Date.now();

  // 1 — a FIDE ID resolves to the canonical name before anything is searched.
  onProgress({ stage: 'fetch', label: 'Resolving player', detail: q, done: 0, total: 100, pct: 6 });
  let name = q;
  let fideId: string | undefined;
  let stdRating: number | undefined;
  if (/^\d{6,10}$/.test(q)) {
    const profile = await resolveFideProfile(q, signal);
    if (!profile) throw new Error(`No FIDE player found with ID ${q}.`);
    name = profile.name;
    fideId = q;
    stdRating = profile.stdRating;
    onProgress({ stage: 'fetch', label: 'Resolved FIDE profile', detail: name, done: 5, total: 100, pct: 12 });
  }

  // 2 — Tier 1: the notable-players archive.
  onProgress({
    stage: 'fetch',
    label: 'Checking notable-players archive',
    detail: 'PGN Mentor',
    done: 10,
    total: 100,
    pct: 18,
  });
  /*
   * A DEAD ARCHIVE HALF IS NOT A DEAD BUILD. If PGN Mentor cannot be reached
   * at all, the weekly reports below can still cover the player, so the
   * failure is remembered and the pipeline walks on. It is only reported if
   * the build then comes up with nothing — a full run of failed downloads
   * says the connection died even when the list fetch happened to succeed.
   */
  let mentorUnreachable = false;
  const players = await getPlayersList(signal).catch((err: unknown) => {
    if (err instanceof ArchiveUnreachableError) {
      mentorUnreachable = true;
      return [] as PlayerEntry[];
    }
    throw err;
  });
  const mentorMatch = bestPlayerMatch(name, players);

  const mentorGames: OtbRawGame[] = [];
  if (mentorMatch) {
    onProgress({
      stage: 'fetch',
      label: 'Downloading player archive',
      detail: `${mentorMatch.name} · ${mentorMatch.games} games`,
      done: 15,
      total: 100,
      pct: 24,
    });
    /*
     * A zip that cannot be downloaded is not the end either: the weekly scan
     * below still runs, and only a build that ends with nothing at all will
     * say the connection was the problem.
     */
    try {
      const zipUrl = `https://www.pgnmentor.com/players/${encodeURIComponent(mentorMatch.file)}`;
      const zipBuf = await cached(`zip-${mentorMatch.file}`, SESSION_TTL, async () => {
        const res = await netFetch(zipUrl, 'PGN Mentor', signal);
        if (!res.ok) throw new Error(`PGN Mentor download failed (${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
      });
      const pgnText = unzipPgn(zipBuf);
      if (pgnText) {
        for (const g of otbGames(pgnText)) {
          const parsed = parseOtbGame(g, name);
          if (parsed) mentorGames.push({ ...parsed, source: 'otb' });
        }
      }
    } catch (err) {
      if (err instanceof ArchiveUnreachableError) mentorUnreachable = true;
    }
  }
  mentorGames.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  // 3 — Tier 2: TWIC weeklies, unless the archive already holds plenty.
  let twicGames: OtbRawGame[] = [];
  let variants: OtbVariant[] = [];
  let weeksScanned = 0;
  const needTwic = mentorGames.length < maxGames + 10;
  let matchedName: string | undefined = mentorMatch?.name;

  if (needTwic) {
    const latest = await twicLatestIssue(signal);
    const variantMap = new Map<string, OtbVariant>();
    const allTwic: OtbRawGame[] = [];

    scan: for (let off = 0; off < TWIC_MAX_WEEKS; off += TWIC_BATCH_WEEKS) {
      if (signal?.aborted) throw new Error('Bot build cancelled.');
      if (Date.now() - t0 > TWIC_TIME_BUDGET_MS) break;

      const issues: number[] = [];
      for (let i = 0; i < TWIC_BATCH_WEEKS && off + i < TWIC_MAX_WEEKS; i++) {
        const issue = latest - off - i;
        if (issue >= 1) issues.push(issue);
      }
      if (!issues.length) break;

      for (let i = 0; i < issues.length; i += TWIC_PARALLEL) {
        const chunk = issues.slice(i, i + TWIC_PARALLEL);
        const results = await Promise.all(chunk.map((issue) => twicWeekPgn(issue, signal)));
        for (const pgn of results) {
          if (!pgn) continue;
          weeksScanned++;
          for (const g of otbGames(pgn)) {
            const parsed = parseOtbGame(g, name);
            if (!parsed) continue;
            allTwic.push({ ...parsed, source: 'otb' });
            const key = variantKey(parsed.matchedName);
            const agg = variantMap.get(key);
            if (agg) {
              agg.games++;
              if (parsed.matchedName.length > agg.name.length) agg.name = parsed.matchedName;
              if ((parsed.date ?? '') > (agg.latestDate ?? '')) agg.latestDate = parsed.date;
            } else {
              variantMap.set(key, {
                name: parsed.matchedName,
                normKey: key,
                games: 1,
                latestDate: parsed.date,
              });
            }
          }
        }
      }

      const found = allTwic.length;
      onProgress({
        stage: 'fetch',
        label: 'Scanning international tournament reports',
        detail: `TWIC weeks ${issues[issues.length - 1]}–${issues[0]} · ${found} game${found === 1 ? '' : 's'} found`,
        done: weeksScanned,
        total: TWIC_MAX_WEEKS,
        pct: 28 + Math.min(50, ((off + TWIC_BATCH_WEEKS) / TWIC_MAX_WEEKS) * 50),
      });

      /*
       * The adaptive stop. A cold scan of every week is minutes of downloading
       * for a player who was already found in the first quarter of it. Each
       * step trades coverage for time in a way the progress line can justify:
       * the scan stops early only when it already holds what the build wants.
       */
      const scanned = off + TWIC_BATCH_WEEKS;
      if (found >= maxGames) break scan;
      if (scanned >= TWIC_BATCH_WEEKS && found >= 35) break scan;
      if (scanned >= TWIC_MAX_WEEKS && found >= MIN_GAMES_FOR_BOT) break scan;
      if (found === 0 && scanned >= TWIC_BATCH_WEEKS && mentorGames.length > 0) break scan;
    }

    variants = mergeVariants([...variantMap.values()]);
    variants.sort((a, b) => {
      const sa = nameMatchScore(a.name, name);
      const sb = nameMatchScore(b.name, name);
      if (sb !== sa) return sb - sa;
      return b.games - a.games;
    });

    /*
     * More than one plausible player is not a detail to average over: two
     * people's games folded into one profile would produce a bot that is
     * neither of them. The caller decides, which on a phone means the screen
     * asks — it never guesses.
     */
    if (variants.length > 1) {
      const leader = variants[0];
      const runner = variants[1];
      if (runner.games >= 5 && runner.games >= 0.3 * leader.games) {
        throw new OtbAmbiguityError(
          `"${q}" matches several players in the international archives. Pick one:`,
          variants.slice(0, 6).map((v) => ({ name: v.name, games: v.games, latestDate: v.latestDate })),
        );
      }
    }

    if (variants.length) {
      const chosen = variants[0];
      matchedName = chosen.name;
      twicGames = allTwic.filter((g) => {
        const key = variantKey(g.matchedName);
        const [cs, cg] = chosen.normKey.split('|');
        const [gs, gg] = key.split('|');
        return gs === cs && (gg.startsWith(cg) || cg.startsWith(gg));
      });
    }
  }

  // 4 — merge the tiers and dedupe (same date + same two names = same game).
  const seen = new Set<string>();
  const merged: OtbRawGame[] = [];
  for (const g of [...mentorGames, ...twicGames]) {
    const key = `${g.date ?? ''}|${norm(g.white)}|${norm(g.black)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(g);
  }
  merged.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const recent = merged.slice(0, maxGames);

  /*
   * Judge by games FOUND, not games returned: the caller may ask for fewer
   * than the minimum, and the honest thing to say is then about the archive,
   * not about the request.
   */
  if (merged.length < MIN_GAMES_FOR_BOT) {
    /*
     * AN ARCHIVE THAT COULD NOT BE REACHED IS NOT A PLAYER WITHOUT GAMES.
     * Without this branch the text below would blame the player for the
     * network. When the player archive was unreachable, or every weekly
     * download failed, say what actually happened instead.
     */
    if (mentorUnreachable || (needTwic && weeksScanned === 0)) {
      throw new ArchiveUnreachableError('the over-the-board archives');
    }
    const suggestions = mentorMatch
      ? []
      : players
          .map((p) => ({ p, s: scoreName(name, p.name) }))
          .sort((a, b) => b.s - a.s)
          .slice(0, 5)
          .map((x) => x.p.name)
          .filter(Boolean);
    throw new OtbNoGamesError(
      `No public over-the-board games found for "${name}" in the sources we can search ` +
        `(PGN Mentor's notable-players archive plus the last six months of TWIC international reports). ` +
        `Players whose games aren't published online — club players, national leagues without PGNs — ` +
        `can't be mimicked from OTB data. Try a more specific name, a FIDE ID, or their Lichess username.`,
      suggestions,
    );
  }

  const displayName = fideId
    ? name
    : mentorMatch
      ? mentorMatch.name.replace(/,(\S)/, ', $1')
      : (matchedName ?? name).replace(/,(\S)/, ', $1');

  const meta: BotMeta = {
    name: displayName,
    key: matchedName ?? name,
    source: 'otb',
    fideId,
    ratings: { fide: stdRating },
  };

  onProgress({
    stage: 'fetch',
    label: 'Read the archives',
    detail: `${merged.length} games · ${weeksScanned} TWIC weeks scanned`,
    done: merged.length,
    total: merged.length,
    pct: 80,
  });

  return { games: recent, meta };
}
