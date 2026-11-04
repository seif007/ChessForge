/**
 * Bot storage — the list the Bots screen shows, and one blob per bot.
 *
 * Two keys, on purpose:
 *
 *   chessforge.bots.index.v1        { v, bots: BotSummary[] }   — light, for the list
 *   chessforge.bots.v1.<id>         { v, profile }              — heavy, loaded on demand
 *
 * A profile carries the full book (position → move → count), which is by far the
 * biggest thing a bot owns. The list screen needs names, ratings and the four
 * style dials to draw its cards, and nothing else; keeping that in an index
 * means opening the tab does not deserialize every profile.
 *
 * WRITE ORDER: profile first, index second.
 *
 * If the app dies between the two writes, the worst case is an orphaned profile
 * — invisible, replaced the next time a bot is saved under a new id. The other
 * order would leave a card with nothing behind it, which is the failure the user
 * actually sees. For the same reason the list refuses to show a summary whose
 * profile cannot be read back (a version bump or a corrupted blob), so a card is
 * always a promise the screen can keep.
 */

import Storage from 'expo-sqlite/kv-store';
import type { BotProfile, BotSummary } from './types';

const INDEX_KEY = 'chessforge.bots.index.v1';
const INDEX_V = 1;
const BOT_V = 1;

/** Storage key for one bot's profile. Exported for tests and migrations. */
export const botProfileKey = (id: string) => `chessforge.bots.v1.${id}`;

/** A fresh id for a new bot. Time-prefixed so the list can be read in order. */
export function newBotId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `bot_${t}_${r}`;
}

/** The list card's view of a profile. */
export function botSummaryOf(profile: BotProfile): BotSummary {
  return {
    id: profile.id,
    name: profile.name,
    key: profile.meta.key,
    source: profile.source,
    rating: profile.rating,
    ratingLabel: profile.ratingLabel,
    gamesAnalyzed: profile.gamesAnalyzed,
    createdAt: profile.createdAt,
    style: profile.style,
    title: profile.source === 'lichess' ? undefined : profile.meta.title,
    country: profile.source === 'lichess' ? undefined : profile.meta.country,
    avatar: profile.source === 'lichess' ? undefined : profile.meta.avatar,
    personalityPreset: profile.personality?.preset,
  };
}

/**
 * Keep Lichess bots about the account, not the person behind it.
 *
 * New builds already store only the handle, but an older blob may still carry
 * a real name, title, avatar URL or country. Sanitising on read and write means
 * those fields disappear from the app without needing a destructive migration.
 * OTB profiles are left alone: their published player name is the identifier
 * the archive itself uses.
 */
function sanitizeBotProfile(profile: BotProfile): BotProfile {
  if (profile.source !== 'lichess') return profile;

  /*
   * meta.key is the normal handle. recipe.query is the fallback for profiles
   * built before the field existed; it is what the user actually typed, so a
   * public username or profile URL is still better than falling back to a real
   * name that an old blob may carry.
   */
  const rawKey = profile.meta.key || profile.recipe?.query || profile.name;
  const handle = rawKey
    .replace(/^@+/, '')
    .replace(/^https?:\/\/(?:www\.)?lichess\.org\/@\//i, '')
    .replace(/^https?:\/\/(?:www\.)?lichess\.org\/user\//i, '')
    .replace(/\/+$/, '')
    .trim();
  const nextName = handle || profile.name;
  const nextMetaName = handle || profile.meta.name;
  const nextKey = handle || profile.meta.key;
  const needsRewrite =
    profile.name !== nextName ||
    profile.meta.name !== nextMetaName ||
    profile.meta.key !== nextKey ||
    profile.meta.title !== undefined ||
    profile.meta.avatar !== undefined ||
    profile.meta.country !== undefined;
  if (!needsRewrite) return profile;

  return {
    ...profile,
    name: nextName,
    meta: {
      ...profile.meta,
      key: nextKey,
      name: nextMetaName,
      title: undefined,
      avatar: undefined,
      country: undefined,
    },
  };
}

/** A summary is only trusted if it still has every field the card draws. */
function isSummary(x: unknown): x is BotSummary {
  if (!x || typeof x !== 'object') return false;
  const s = x as Partial<BotSummary>;
  return (
    typeof s.id === 'string' &&
    s.id.length > 0 &&
    typeof s.name === 'string' &&
    (s.key === undefined || typeof s.key === 'string') &&
    (s.source === 'lichess' || s.source === 'otb' || s.source === 'coach' || s.source === 'preset') &&
    typeof s.rating === 'number' &&
    typeof s.gamesAnalyzed === 'number' &&
    typeof s.createdAt === 'number' &&
    !!s.style &&
    typeof s.style.aggression === 'number'
  );
}

async function readIndex(): Promise<BotSummary[]> {
  try {
    const raw = await Storage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { v?: number; bots?: unknown };
    if (!parsed || parsed.v !== INDEX_V || !Array.isArray(parsed.bots)) return [];
    return parsed.bots.filter(isSummary);
  } catch {
    // An unreadable index is an empty list, not a crash on the tab the user
    // just tapped.
    return [];
  }
}

async function writeIndex(bots: BotSummary[]): Promise<void> {
  await Storage.setItem(INDEX_KEY, JSON.stringify({ v: INDEX_V, bots }));
}

/**
 * The bots to show, newest first, with every card backed by a readable profile.
 *
 * The existence check is what keeps an old-version blob from becoming a card
 * that opens onto an error: `loadBot` returning null is the same condition, so
 * the two functions cannot disagree about which ids are real.
 */
export async function loadBotSummaries(): Promise<BotSummary[]> {
  const bots = await readIndex();
  const alive: BotSummary[] = [];
  for (const s of bots) {
    const profile = await loadBot(s.id);
    if (profile) alive.push(botSummaryOf(profile));
  }
  const next = alive.sort((a, b) => b.createdAt - a.createdAt);
  /*
   * A list written before the handle-only rule may still contain an old real
   * name or avatar. loadBot rewrites the profile it reads; this rewrites the
   * light index too, so the personal fields do not survive on disk merely
   * because nobody opened that card.
   */
  if (JSON.stringify(next) !== JSON.stringify(bots)) {
    try { await writeIndex(next); } catch { /* serving the clean list is still useful */ }
  }
  return next;
}

/** Create or replace a bot. Returns the new list, newest first. */
export async function saveBot(profile: BotProfile): Promise<BotSummary[]> {
  const safe = sanitizeBotProfile(profile);
  await Storage.setItem(botProfileKey(safe.id), JSON.stringify({ v: BOT_V, profile: safe }));
  const bots = await readIndex();
  const next = [botSummaryOf(safe), ...bots.filter((b) => b.id !== safe.id)];
  await writeIndex(next);
  return next.sort((a, b) => b.createdAt - a.createdAt);
}

/** Load one profile, or null when it is missing, corrupt or from an older layout. */
export async function loadBot(id: string): Promise<BotProfile | null> {
  try {
    const raw = await Storage.getItem(botProfileKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: number; profile?: BotProfile };
    if (!parsed || parsed.v !== BOT_V) return null;
    const p = parsed.profile;
    if (!p || typeof p.id !== 'string' || !p.book || !p.typeRates) return null;
    const safe = sanitizeBotProfile(p);
    if (safe !== p) {
      try {
        await Storage.setItem(botProfileKey(id), JSON.stringify({ v: BOT_V, profile: safe }));
      } catch {
        // The clean view is still what the screen gets; a failed rewrite can be
        // retried on the next read.
      }
    }
    return safe;
  } catch {
    return null;
  }
}

/** Delete one bot (profile and card). Returns the new list. */
export async function deleteBot(id: string): Promise<BotSummary[]> {
  try {
    await Storage.removeItem(botProfileKey(id));
  } catch {
    /* the card goes either way: a summary without a profile is never shown */
  }
  const bots = await readIndex();
  const next = bots.filter((b) => b.id !== id);
  await writeIndex(next);
  return next.sort((a, b) => b.createdAt - a.createdAt);
}
