/**
 * ChessForge theme — light (default) and dark palettes, plus the token constants
 * ported from the web app's `globals.css` (`@theme inline` + `:root` vars).
 *
 * PORT NOTE. The web app was dark-only, so the original port exported a frozen
 * `colors` constant consumed by ~19 files inside module-level
 * `StyleSheet.create` calls. That is the hard part of adding a light theme:
 * `StyleSheet.create` runs ONCE at module load, so a palette swapped at runtime
 * would never reach those styles.
 *
 * Rather than rewrite 19 files to thread a palette through every call site,
 * `colors` is exported as a live Proxy over the *active* palette:
 *
 *  1. Reads always reflect the current palette, so any inline style evaluated
 *     during render picks up a switch for free.
 *  2. Components re-render on switch because `useThemeName()` subscribes via
 *     `useSyncExternalStore` — no provider, so no screen needs wrapping.
 *
 * Sheets that must repaint use `useThemedStyles(...)`. For the module-level
 * sheets that were not converted, `ThemeProvider` bumps a remount key on the
 * whole tree, which rebuilds them too.
 *
 * LIGHT is the default. It was dark until the rebrand, and the file kept saying dark in three
 * places after the code changed - which is how .bench/round4.fixes came to be failing on the DEFAULT rather than on the thing it exists to check. The
 * choice persists via expo-sqlite/kv-store, so this is only the first frame.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { StyleSheet } from 'react-native';

/* ------------------------------------------------------------ palettes */

export interface Palette {
  // surfaces
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;

  // brand
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  chessforge: string;
  gold: string;
  emeraldDeep: string;
  destructive: string;

  // lines & focus
  border: string;
  input: string;
  ring: string;

  // charts
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;

  // sidebar
  sidebar: string;
  sidebarForeground: string;
  sidebarPrimary: string;
  sidebarPrimaryForeground: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  sidebarBorder: string;
  sidebarRing: string;

  // semantic board
  boardDark: string;
  boardLight: string;
  white: string;
  black: string;

  /* ---- derived helpers the UI needs per-theme ---- */
  /** Tint for the "raised" surface of a pressed/selected row. */
  surfaceRaised: string;
  /** Faint fill for chips and track backgrounds (was rgba(255,255,255,…)). */
  subtleFill: string;
  /** Stronger variant of `subtleFill`. */
  subtleFillStrong: string;
  /** Default track behind progress bars. */
  track: string;
  /** Backdrop scrim behind modals. */
  scrim: string;
  /** Muted-but-readable meta text (was rgba(147,168,154,…)). */
  faint: string;
  /** Move-quality colours, shaded per theme so they stay readable on text. */
  good: string;
  warn: string;
  bad: string;
  goodText: string;
  warnText: string;
  badText: string;
  /**
   * A low-opacity wash of `bad`, for surfaces that REPORT a failure rather than
   * performing one. The training mistake notice uses it: the drill lets you retry
   * immediately, so the message has to carry the weight that a blocking dialog would
   * otherwise carry, and it does that far better as a tinted band under the board than
   * as a modal that would have to be dismissed between attempts.
   */
  badSoft: string;
  /** "as White" / "as Black" chips in the opening picker. */
  whiteSide: string;
}

/**
 * The original web palette — unchanged.
 *
 * It is no longer the DEFAULT: the app opens light. The colours themselves are exactly as they
 * shipped, so switching to dark still looks the way it was designed to. Comments here said "and still
 * the default" long after the rebrand changed that, and one of them is why `.bench/round4.fixes` spent
 * a while failing about the default theme instead of about the thing it exists to check.
 */
export const darkPalette: Palette = {
  background: '#0a1310',
  foreground: '#e9f1ea',
  card: '#10201a',
  cardForeground: '#e9f1ea',
  popover: '#142520',
  popoverForeground: '#e9f1ea',

  primary: '#2e8b6a',
  primaryForeground: '#f4faf6',
  secondary: '#1a3029',
  secondaryForeground: '#d7e6da',
  muted: '#16281f',
  mutedForeground: '#93a89a',
  accent: '#e88fa2',
  accentForeground: '#2a0f16',
  chessforge: '#e88fa2',
  gold: '#d4af37',
  emeraldDeep: '#0f241b',
  destructive: '#e05252',

  border: 'rgba(233, 241, 234, 0.09)',
  input: 'rgba(233, 241, 234, 0.12)',
  ring: '#2e8b6a',

  chart1: '#2e8b6a',
  chart2: '#e88fa2',
  chart3: '#d4af37',
  chart4: '#7fc8a9',
  chart5: '#b06a7d',

  sidebar: '#10201a',
  sidebarForeground: '#e9f1ea',
  sidebarPrimary: '#2e8b6a',
  sidebarPrimaryForeground: '#f4faf6',
  sidebarAccent: '#1a3029',
  sidebarAccentForeground: '#d7e6da',
  sidebarBorder: 'rgba(233, 241, 234, 0.09)',
  sidebarRing: '#2e8b6a',

  boardDark: '#4a6f5c',
  boardLight: '#dfe9db',
  white: '#ffffff',
  black: '#000000',

  surfaceRaised: 'rgba(255,255,255,0.04)',
  subtleFill: 'rgba(255,255,255,0.06)',
  subtleFillStrong: 'rgba(255,255,255,0.10)',
  track: 'rgba(255,255,255,0.10)',
  scrim: 'rgba(0,0,0,0.6)',
  faint: 'rgba(147,168,154,0.6)',
  good: '#e88fa2',
  warn: '#fbbf24',
  bad: '#f87171',
  goodText: '#e88fa2',
  warnText: '#fcd34d',
  badText: '#fca5a5',
  badSoft: 'rgba(248,113,113,0.12)',
  whiteSide: '#7cc4f8',
};

/**
 * The light palette.
 *
 * Two constraints shaped these values rather than a naive inversion:
 *
 *  - `boardDark`/`boardLight` are shared with the dark theme on purpose. The
 *    board is a chess diagram, not a UI surface; it reads correctly against
 *    both backgrounds, so keeping it identical means the piece and arrow
 *    contrast was already proven and needs no re-validation.
 *  - Every *text* tone is darkened against a measured contrast ratio, not by
 *    eye. The brand gold (#d4af37) reaches only 3.50:1 on a white card and the
 *    chessforge pink 3.93:1 — both unreadable, and both are used as text in dozens
 *    of places (section labels, "Show hint", counters, mastery figures). Each
 *    light tone below was picked to clear 4.5:1, verified by
 *    `.bench/theme_contrast.mjs`, which reads these very values.
 *
 * The same audit shows the DARK palette fails three of its own checks —
 * `primary` as text on a card is 4.03:1, and `primaryForeground` on a primary
 * button is 3.96:1. Those predate this feature, so the dark values are left
 * exactly as they shipped rather than silently restyling the default theme.
 */
export const lightPalette: Palette = {
  /*
   * THE PAGE IS NOT NEAR-WHITE, AND CARDS ARE NOT PURE WHITE.
   *
   * The complaint: *"i didnt liked the white theme so if you could make it better"*.
   *
   * This palette shipped `#f7faf8` for the page and `#ffffff` for every card. That
   * is a ~2% difference, which is not a surface — it is a page and the same page
   * again with an outline. Three things went wrong at once:
   *
   *   1. **No depth.** A card is only distinguishable from its background by an
   *      0.12-alpha border, which on a near-white field is close to invisible, so
   *      the whole screen read as one flat sheet.
   *   2. **Glare.** `#ffffff` is the brightest thing a phone screen can show, and
   *      a large white card on a white page is the single most tiring thing to
   *      look at for the least information. Off-white is measurably easier.
   *   3. **No hue.** The page was a very slightly green white. A hint of warmth
   *      reads as paper rather than as a screen being on, and it stops the
   *      greys (`muted`, `secondary`) from looking like the same colour as the
   *      background.
   *
   * So the page moves down to `#eef2ee` and the cards sit at `#fbfcfb` — still the
   * brightest surfaces in the app, so the hierarchy is unchanged, but now a
   * readable step apart. The board is untouched: it is a diagram, and its tones
   * were validated against both backgrounds already.
   */
  background: '#eef2ee',
  foreground: '#14211c',
  card: '#fbfcfb',
  cardForeground: '#14211c',
  popover: '#fbfcfb',
  popoverForeground: '#14211c',

  primary: '#237a5c',
  primaryForeground: '#ffffff',
  secondary: '#eaf2ee',
  secondaryForeground: '#24382f',
  muted: '#f1f5f3',
  mutedForeground: '#5d7268',
  accent: '#c75f79',
  accentForeground: '#2a0f16',
  chessforge: '#9e4053',
  // Darkened from `#8a6b1f` because the page moved from `#f7faf8` to `#eef2ee`.
  // That step is what makes the cards read as surfaces, and it is exactly the step
  // that pushed gold-on-page from 4.58:1 to 4.42:1 — under the 4.5 floor, so the
  // "Gold" tier labels and the xp captions would have been failing WCAG AA. The
  // page is not negotiable and gold is not negotiable, so gold gives.
  gold: '#7d5f16',
  emeraldDeep: '#e8f2ec',
  destructive: '#c93b3b',

  // Borders carry the card separation that the page/card step no longer has to.
  // 0.12 was chosen against a `#f7faf8`-on-`#ffffff` pair where it was doing almost
  // no work; at 0.15 against `#eef2ee`-on-`#fbfcfb` it is a visible edge without
  // becoming a drawn box around every element.
  border: 'rgba(20, 33, 28, 0.15)',
  input: 'rgba(20, 33, 28, 0.20)',
  ring: '#237a5c',

  chart1: '#237a5c',
  chart2: '#9e4053',
  chart3: '#8a6b1f',
  chart4: '#4d9b7c',
  chart5: '#8f5568',

  sidebar: '#fbfcfb',
  sidebarForeground: '#14211c',
  sidebarPrimary: '#237a5c',
  sidebarPrimaryForeground: '#ffffff',
  sidebarAccent: '#eaf2ee',
  sidebarAccentForeground: '#24382f',
  sidebarBorder: 'rgba(20, 33, 28, 0.15)',
  sidebarRing: '#237a5c',

  // shared with dark — the board is a diagram, not a surface
  boardDark: '#4a6f5c',
  boardLight: '#dfe9db',
  white: '#ffffff',
  black: '#000000',

  surfaceRaised: 'rgba(20,33,28,0.03)',
  subtleFill: 'rgba(20,33,28,0.05)',
  subtleFillStrong: 'rgba(20,33,28,0.09)',
  track: 'rgba(20,33,28,0.10)',
  scrim: 'rgba(20,33,28,0.42)',
  // Opaque, not translucent: compositing a grey alpha over white loses too much
  // and this tone is used for 9px "new"/"…" labels where every point counts.
  faint: '#74887e',
  good: '#9e4053',
  warn: '#b8860b',
  bad: '#c93b3b',
  goodText: '#9e4053',
  warnText: '#8a6508',
  badText: '#b02f2f',
  badSoft: 'rgba(201,59,59,0.12)',
  whiteSide: '#26648f',
};

export type ThemeName = 'dark' | 'light';

export const PALETTES: Record<ThemeName, Palette> = {
  dark: darkPalette,
  light: lightPalette,
};

/* ------------------------------------------------- active palette (live) */

/**
 * Seeded to LIGHT, which is the app's default.
 *
 * This is what the app renders with on the very first frame, before
 * `initTheme()` has read the stored preference. It is deliberately the same value
 * as `DEFAULT_THEME` in `lib/theme.ts`: the read is async, so any disagreement
 * between the two shows up as a flash of the wrong theme on every cold start. The
 * two are changed together.
 */
let active: Palette = lightPalette;
let activeName: ThemeName = 'light';

/**
 * Live view of the active palette.
 *
 * Both an index read (`colors.gold`) and a spread (`{ ...colors }`) resolve
 * against whichever palette is active at that moment, so untouched call sites
 * stay correct after a switch.
 */
export const colors: Palette = new Proxy({} as Palette, {
  get: (_t, prop: string | symbol) =>
    typeof prop === 'string' ? active[prop as keyof Palette] : undefined,
  has: (_t, prop: string | symbol) => typeof prop === 'string' && prop in active,
  ownKeys: () => Reflect.ownKeys(active),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
}) as Palette;

/**
 * Board arrow colours — one source of truth, re-resolved per theme.
 *
 * Previously inlined as hex literals across five screens, which let them drift
 * apart: the trainer drew the engine's exploring reply in cyan while the course
 * screen drew the same thing in chessforge pink, yet the web copy said "the pink
 * arrow". Keeping them here fixes the meaning of a colour in one place:
 *
 *   hint  — the move the app wants *you* to play (gold, the brand accent)
 *   reply — the engine answering an idea *you* invented while exploring (pink)
 *   book  — the opponent's scripted move in a guided walkthrough (sky)
 *   best  — the engine's best move in the review, behind an explicit toggle
 */
export const arrowColors = {
  get hint() { return active.gold; },
  get reply() { return active.chessforge; },
  get book() { return active.whiteSide; },
  get best() { return active.primary; },
} as const;

export function activePalette(): Palette { return active; }
export function activeThemeName(): ThemeName { return activeName; }

/** Swap the active palette. Called by the theme store only. */
export function setActiveTheme(name: ThemeName): void {
  activeName = name;
  active = PALETTES[name] ?? darkPalette;
}

/* --------------------------------------------------------------- store */

/*
 * A tiny external store rather than a React context: the palette lives outside
 * React (module-level styles read it directly) and must be usable from
 * non-component code. `useSyncExternalStore` gives a correct subscription with
 * no provider, so no existing screen needs to be wrapped.
 */
const listeners = new Set<() => void>();

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getThemeSnapshot(): ThemeName { return activeName; }

/** Switch theme and notify every subscriber. */
export function applyTheme(name: ThemeName): void {
  if (name === activeName) return;
  setActiveTheme(name);
  listeners.forEach((fn) => fn());
}

/** Subscribe a component to the active theme name (re-renders on switch). */
export function useThemeName(): ThemeName {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot);
}

/** Everything a screen needs to theme itself: the name and the palette. */
export function useTheme(): { name: ThemeName; colors: Palette } {
  const name = useThemeName();
  return useMemo(() => ({ name, colors: PALETTES[name] }), [name]);
}

/**
 * Build a stylesheet that is rebuilt whenever the theme changes.
 *
 * A plain module-scope `StyleSheet.create` captures the palette at import time
 * and would keep the old colours forever. Screens that must repaint pass their
 * sheet factory through this hook instead:
 *
 *   const s = useThemedStyles(makeStyles);
 *
 * `makeStyles` re-runs only on a theme change, so the per-render cost is a memo
 * lookup. Pass a module-level factory (not an inline arrow) or the memo misses.
 */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (c: Palette) => T,
): T {
  const name = useThemeName();
  return useMemo(() => StyleSheet.create(factory(PALETTES[name])), [factory, name]);
}

/**
 * A MODULE-LEVEL sheet that still follows the theme.
 *
 * WHY THIS EXISTS
 * ---------------
 * `useThemedStyles` fixes a sheet inside a component, but most of this app's
 * sheets are declared at module scope:
 *
 *   const styles = StyleSheet.create({ card: { backgroundColor: colors.card } });
 *
 * `colors` is a live Proxy, so it *looks* like that would follow the palette —
 * and it does not. `StyleSheet.create` is handed an object literal, and the
 * literal's `colors.card` is evaluated ONCE, when the module is imported. What
 * gets frozen into the sheet is the dark value. Remounting the tree (the
 * `key={theme}` trick in App.tsx) cannot help: a remount re-runs the component,
 * never the module.
 *
 * That is why the light theme appeared to do nothing. The backdrop
 * (`AppBackground`), the tab bar and every screen's card/text/border colours
 * were all still the dark palette; only the handful of *inline* styles that read
 * `colors.x` during render had switched — which is invisible under an opaque
 * dark background.
 *
 * THE FIX, AND WHY IT IS A ONE-LINE CHANGE PER FILE
 * ------------------------------------------------
 * Wrap the literal in a function so it is evaluated on first READ instead of at
 * import:
 *
 *   const styles = themedStyles(() => ({ card: { backgroundColor: colors.card } }));
 *
 * The body needs no edits: `colors` is still the imported Proxy, it is simply
 * read later — and by then `active` is the newly selected palette. One built
 * sheet is cached per theme name, so the per-read cost is a Map lookup and the
 * body of the factory runs at most twice.
 *
 * Reads go through a Proxy rather than being resolved once, because a module
 * cannot know when the theme will change. Everything a stylesheet is used for
 * (`styles.card`, `StyleSheet.flatten(styles.card)`, `{...styles.card}`) is a
 * property read, so the Proxy covers all of it.
 */
export function themedStyles<T extends StyleSheet.NamedStyles<T>>(factory: () => T): T {
  const cache = new Map<ThemeName, T>();

  const built = (): T => {
    const name = activeName;
    let sheet = cache.get(name);
    if (!sheet) {
      sheet = StyleSheet.create(factory());
      cache.set(name, sheet);
    }
    return sheet;
  };

  return new Proxy({} as T, {
    // `T` is a sheet of style objects, so a string read is always a style name.
    get: (_t, prop: string | symbol) =>
      typeof prop === 'string' ? (built() as Record<string, unknown>)[prop] : undefined,
    has: (_t, prop: string | symbol) =>
      typeof prop === 'string' && prop in (built() as Record<string, unknown>),
    ownKeys: () => Reflect.ownKeys(built()),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  }) as T;
}

/* ------------------------------------------------- static token groups */

/** `--radius: 0.75rem`, with sm/md/lg/xl derived as in the web `@theme`. */
export const radii = {
  sm: 8, // calc(0.75rem - 4px)
  md: 10, // calc(0.75rem - 2px)
  lg: 12, // 0.75rem
  xl: 16, // calc(0.75rem + 4px),
  full: 9999,
} as const;

/**
 * The web layout is a centred column: `<div className="w-full max-w-lg">`.
 * `max-w-lg` = 32rem = 512px. On phones the viewport is narrower so this
 * effectively means "full width"; we keep the constant for tablets/web.
 */
export const layout = {
  maxContentWidth: 512,
  /** `pb-24` on <main> to clear the fixed bottom tab bar. */
  tabBarClearance: 96,
  tabBarHeight: 58,
} as const;

/**
 * Body background: two stacked radial gradients on the web.
 *   radial-gradient(1200px 600px at 80% -10%, rgba(46,139,106,0.12), transparent 60%),
 *   radial-gradient(900px 500px at -10% 110%, rgba(232,143,162,0.07), transparent 55%)
 * RN has no radial-gradient primitive; we approximate with expo-linear-gradient
 * layers (see components/AppBackground.tsx). Re-resolved per theme.
 */
export const backgrounds = {
  get emeraldGlow() { return activeName === 'dark' ? 'rgba(46, 139, 106, 0.12)' : 'rgba(35, 122, 92, 0.10)'; },
  get chessforgeGlow() { return activeName === 'dark' ? 'rgba(232, 143, 162, 0.07)' : 'rgba(199, 95, 121, 0.07)'; },
} as const;

/**
 * Fonts: web uses Geist Sans / Geist Mono via next/font.
 *
 * PORT NOTE: the original port referenced `Geist_400Regular` etc., but the
 * font files were never bundled and `useFonts` was never called — Android
 * crashed instantly on launch trying to resolve the missing family. Until real
 * Geist .ttf files are added under assets/fonts with a `useFonts` call in
 * App.tsx, every slot maps to the platform default, which never throws.
 */
export const fonts = {
  sans: 'System',
  sansMedium: 'System',
  sansSemiBold: 'System',
  sansBold: 'System',
  mono: 'System',
} as const;

export type ChessForgeColor = keyof Palette;
