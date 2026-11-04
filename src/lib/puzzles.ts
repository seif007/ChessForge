/**
 * Puzzle difficulty system (shared client + server).
 *
 * Difficulty adapts to the user's puzzle rating: as they climb, harder
 * puzzles are served. Modes can also be forced manually.
 *
 * The four difficulty bands are `warmup` → `steady` → `sharp` → `relentless`, labelled Warm-up,
 * Steady, Sharp and Relentless. They were renamed off a set of chess strength titles; only the labels
 * and the ids moved, and the bands themselves are byte-identical — `id` order, `label` and `range`
 * are otherwise exactly as before.
 *
 * `TIER ORDER IS LOAD-BEARING IN FIVE PLACES`, and only one of them would have complained:
 *   - `PUZZLE_MODES` here, and `autoModeFor` below;
 *   - `ratingBand()` in `rating.ts` — a second copy of the same band edges, which nothing makes agree
 *     with this one;
 *   - `TrainerTier` in `endgameTrainer.ts`, which shares the same four edges;
 *   - `TIER_LICHESS_DIFFICULTY` / `TIER_RATING_BAND` there;
 *   - `src/data/endgame_pool.json`, whose 136 exercises carry a `tier` field matched with `===`.
 *
 * A miss in any of them fails SILENTLY: `modeWindow` and `bandRange` fall back to the whole pool for
 * a name they do not recognise, `POOL.filter(p => p.tier === tier)` matches nothing, and the screen
 * shows an empty list with no error. That is why GATE 1e asserts the ids, and why the pool file is
 * checked against `TrainerTier` rather than trusted.
 *
 * `auto` is not a band. It has no `PUZZLE_MODES` entry and is resolved through `autoModeFor` first.
 */

export type PuzzleMode = 'auto' | 'warmup' | 'steady' | 'sharp' | 'relentless';

/**
 * THE LOWEST RATING EACH LICHESS BUCKET HAS ACTUALLY RETURNED.
 *
 * Measured, not assumed, and this table is the reason the Puzzles tab worked at all. The report:
 * *"i tried puzzles and it says to check my connection although i am connected (the endgames works
 * fine although it needs connection but the puzzles doesnt work)"*.
 *
 * `api/puzzle/next` was probed directly and answered **200** with real puzzles. The ratings it
 * returned were:
 *
 *     easy     1308  1386  1423  1454  1477  1479
 *     medium   1386
 *     hard     1479
 *
 * So the `easy` bucket has no floor anywhere near 400-1250. Meanwhile `fetchNextPuzzle` REJECTS any
 * puzzle outside the band it was given, and the bottom band's ceiling was 400-1250 with a ceiling of
 * 1250 — below the bucket's floor. A beginner therefore had **no reachable puzzle at all**: all six
 * attempts were discarded as "off-level", `served` stayed null, and the screen showed its offline
 * notice. The user's connection was never the problem, and the notice was about the wrong thing.
 *
 * These floors are the observed minima, which is deliberately the CONSERVATIVE direction: it lets a
 * slightly-too-hard puzzle through rather than refusing to serve anything. Refusing is the failure
 * being fixed here, so the bias has to be towards serving. GATE 1n asserts the floors are not raised
 * above a bucket's observed minimum, because that is exactly how the tab died — the band was a
 * promise about a distribution nobody had measured, and the distribution moved.
 */
export const PUZZLE_BUCKET_FLOOR: Record<'easy' | 'medium' | 'hard' | 'hardest', number> = {
  easy: 1300,
  medium: 1300,
  hard: 1400,
  hardest: 1600,
};

/**
 * The bands, widened so each one can actually be satisfied by the bucket it asks for.
 *
 * The lower edges still say what the band MEANS — beginner is easier than pro — but a band that no
 * bucket can supply is a band that shows an error message forever, and "matched to your level" is
 * false in the other direction too: refusing to serve is not matching anyone to anything.
 */
export const PUZZLE_MODES: { id: PuzzleMode; label: string; range: [number, number] }[] = [
  { id: 'warmup', label: 'Warm-up', range: [400, 1350] },
  { id: 'steady', label: 'Steady', range: [1250, 1800] },
  { id: 'sharp', label: 'Sharp', range: [1750, 2300] },
  { id: 'relentless', label: 'Relentless', range: [2200, 2900] },
];

export function modeWindow(mode: PuzzleMode, rating: number): [number, number] {
  if (mode !== 'auto') {
    const m = PUZZLE_MODES.find((x) => x.id === mode);
    return m ? m.range : [rating - 250, rating + 150];
  }
  return [Math.max(450, rating - 250), rating + 150];
}

/**
 * Rating range of a concrete band. `auto` is not a band, so it reports the
 * whole pool — callers that need a real band resolve it with `autoModeFor`
 * first.
 *
 * This exists so difficulty selection can be clamped: a window may be widened
 * for tolerance, but the served puzzle must never leave the user's own band.
 */
export function bandRange(mode: PuzzleMode): [number, number] {
  const m = PUZZLE_MODES.find((x) => x.id === mode);
  return m ? m.range : [450, 2900];
}

/**
 * Which difficulty to ASK Lichess for.
 *
 * FIVE BUCKETS EXIST (`easiest`/`easy`/`medium`/`hard`/`hardest`) and the four levels were
 * being mapped onto three of them, with `sharp` AND `relentless` both returning `hard`. That made
 * those two levels the SAME request to the network: the user chose the top band and the app asked for a
 * hard puzzle, which is exactly *"i dont want to click on hard and found an easy one"*. The
 * rating band check is what actually separates them now, but asking the right question first
 * is cheaper and gets there in one request instead of three.
 */
export function lichessDifficulty(
  mode: PuzzleMode,
  rating: number,
): 'easy' | 'medium' | 'hard' | 'hardest' {
  if (mode === 'warmup') return 'easy';
  if (mode === 'steady') return 'medium';
  if (mode === 'sharp') return 'hard';
  if (mode === 'relentless') return 'hardest';
  return rating < 1300 ? 'easy' : rating < 1900 ? 'medium' : 'hard';
}

/**
 * The label for a puzzle RATING - a word for the player's own strength.
 *
 * Six bands, ascending. These were a set of chess strength titles until they were renamed; the
 * CUT-OFFS are untouched, so a rating shows exactly the same band it always did, under a different
 * word. Note these edges deliberately do NOT line up with the four `PUZZLE_MODES` bands above: this
 * is a six-step description of a player, that is a four-step selector.
 */
export function ratingLabel(rating: number): string {
  if (rating < 1000) return 'Newcomer';
  if (rating < 1400) return 'Casual';
  if (rating < 1800) return 'Regular';
  if (rating < 2200) return 'Solid';
  if (rating < 2600) return 'Elite';
  return 'Apex';
}

/** Auto mode label for the current rating. */
/**
 * WHICH BAND A RATING FALLS IN, and why the cut-offs are here rather than in the table above.
 *
 * Every cut-off is a band's own UPPER edge, so `autoModeFor(r)` and `bandRange(autoModeFor(r))` agree
 * for every rating — the property GATE 1e checks across the whole 400-2900 range, and the reason a
 * tier cannot be asked to serve a rating it has no band for.
 *
 * The first cut is 1250 rather than the Warm-up band's ceiling of 1350, so the two overlap between
 * 1250 and 1350. That overlap is deliberate and narrow: `autoModeFor` picks exactly ONE band, and a
 * rating in the overlap goes to the higher one. Pulling the bands apart until they touched exactly
 * would be tidier on paper and would put a 1300-rated player in a band whose ceiling sits
 * below the measured floor of the `easy` bucket, which is the failure GATE 1n exists to prevent. The
 * overlap costs nothing; a band that cannot serve anything costs the user the whole tab.
 */
export function autoModeFor(rating: number): PuzzleMode {
  if (rating < 1250) return 'warmup';
  if (rating < 1750) return 'steady';
  if (rating < 2250) return 'sharp';
  return 'relentless';
}

/** Human hint text derived from Lichess puzzle themes. */
const THEME_HINTS: Record<string, string> = {
  fork: 'Look for a double attack — one piece hitting two targets.',
  pin: 'A pin may freeze the defender — exploit it.',
  discoveredAttack: 'Move the front piece and the piece behind it strikes.',
  'discovered attack': 'Move the front piece and the piece behind it strikes.',
  doubleCheck: 'A double check forces the king to move.',
  sacrifice: 'Consider a sacrifice — material back with interest.',
  hangingPiece: 'Something is loose. Find the undefended piece.',
  'hanging piece': 'Something is loose. Find the undefended piece.',
  skewer: 'Line up two pieces — the front one must move.',
  xRayAttack: 'An x-ray may pierce the defense.',
  deflection: 'Distract a defender from its duty.',
  attraction: 'Lure a piece onto a fatal square.',
  interference: 'Cut the line between the defender pieces.',
  overloading: 'One piece cannot do two jobs — overload it.',
  trapping: 'Trap a piece with no escape squares.',
  promotion: 'A pawn touch from glory — promotion decides it.',
  promotionAttacker: 'Push or capture to promote.',
  underPromotion: 'Careful: the choice of promotion piece matters.',
  zugzwang: 'Every move loses — make them move first.',
  quietMove: 'Not a check, not a capture — the quiet move wins.',
  intermediateMove: 'Insert an in-between move first.',
  'intermezzo': 'Insert an in-between move first.',
  crushing: 'A strong tactic may settle the game at once.',
  advantage: 'Convert your edge — find the forcing sequence.',
  matingPattern: 'A mating pattern is hiding here.',
  backRankMate: 'The back rank may be weak — check it.',
  'back rank mate': 'The back rank may be weak — check it.',
  smotheredMate: 'The king may be smothered by its own army.',
  'smothered mate': 'The king may be smothered by its own army.',
  AnastomosisMate: 'A knight and rook may combine on the h-file.',
  'anastasia\u0027s mate': 'A knight and rook may combine on the h-file.',
  arabianMate: 'Rook + knight near the corner spells danger.',
  'arabian mate': 'Rook + knight near the corner spells danger.',
  bishopEndgame: 'Bishop endgame technique decides.',
  rookEndgame: 'Rook endgame technique decides.',
  pawnEndgame: 'King and pawn geometry decides — opposition!',
  queenside: 'Action is brewing on the queenside.',
  kingsideAttack: 'The king is exposed — attack it.',
  'kingside attack': 'The king is exposed — attack it.',
  defensiveMove: 'Defend precisely — only one move holds.',
  master: 'A high-level shot — think deeply.',
  veryLong: 'This one takes several accurate moves.',
  long: 'A longer calculation — stay sharp.',
  oneMove: 'One precise move is enough.',
  short: 'A short forcing sequence.',
  normal: 'A standard combination.',
  endgame: 'Endgame technique decides.',
  opening: 'An opening trap may be springing.',
  middlegame: 'A middlegame clash — tactics rule.',
};

export function themesList(themes: string | null | undefined): string[] {
  if (!themes) return [];
  return themes.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4);
}

export function hintForTheme(theme: string): string | null {
  if (THEME_HINTS[theme]) return THEME_HINTS[theme];
  // prettify unknown theme names
  const pretty = theme.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return `Theme: ${pretty}. Look for the most forcing move.`;
}
