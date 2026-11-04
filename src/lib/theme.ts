/**
 * Theme preference — persisted in expo-sqlite/kv-store, defaulting to light.
 *
 * Kept separate from the zustand app store on purpose. The palette has to be
 * readable from module scope (see `theme/tokens.ts`), and zustand's `create`
 * lives behind React; the token module instead exposes a plain listener set
 * that `applyTheme` notifies. This file is the only writer.
 */
import Storage from 'expo-sqlite/kv-store';
import { applyTheme, type ThemeName } from '@/theme/tokens';

const THEME_KEY = 'chessforge.theme.v1';

/**
 * Theme to use before the stored preference has loaded — light.
 *
 * This is the app's default for anyone who has not chosen, and it is ALSO what
 * `tokens.ts` seeds the live palette with. Both have to move together: the store
 * read is async, so for the first frame the app renders from the module-scope
 * palette in `tokens.ts`, and seeding that to dark while this constant says light
 * produces a dark flash on every cold start before the app settles on white.
 */
export const DEFAULT_THEME: ThemeName = 'light';

export async function loadTheme(): Promise<ThemeName> {
  try {
    const raw = await Storage.getItem(THEME_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch { /* fall through to the default */ }
  return DEFAULT_THEME;
}

export async function saveTheme(name: ThemeName): Promise<void> {
  try { await Storage.setItem(THEME_KEY, name); } catch { /* ignore */ }
}

/**
 * Load the stored preference and apply it. Called once from App.tsx before the
 * first paint so the app never flashes the wrong theme: the returned value is
 * applied synchronously here, and the promise resolves with it for callers that
 * want to reflect it in state.
 */
export async function initTheme(): Promise<ThemeName> {
  const name = await loadTheme();
  applyTheme(name);
  return name;
}

/** Apply a theme and remember it. */
export async function setTheme(name: ThemeName): Promise<void> {
  applyTheme(name);
  await saveTheme(name);
}
