/**
 * Repertoire utilities: parse the training tree into lines, level system,
 * and practice-session helpers. Each repertoire trains ONE color:
 * the Sicilian trains Black (default), the Queen's Gambit trains White —
 * every helper takes an optional userColor ('b' default, 'w' for White).
 */
import { Chess } from 'chess.js';

export interface RepMove {
  san: string;
  uci: string;
  commentAfter?: string;
  variations: RepMove[][];
  fenAfter: string;
}

export interface RepStudy {
  id: string;
  chapter: string;
  title: string;
  type: string;
  intro?: string;
  tree: RepMove[];
  mainPlies: number;
  lineCount: number;
}

export interface RepChapter {
  title: string;
  order: number;
  studies: RepStudy[];
}

export interface Repertoire {
  generatedAt: string;
  source: string;
  intro?: string;
  chapters: RepChapter[];
  stats: { chapters: number; studies: number; lines: number };
}

export interface TrainLine {
  id: string;            // stable id: studyId + '#' + index
  studyId: string;
  index: number;
  sans: string[];        // full line in SAN
  isVariation: boolean;  // uses a deviation (variation) branch
  plyCount: number;
}

// ---------- Levels (ChessForge-style progression) ----------
/**
 * The six training tiers, on a heat ladder: the first struck spark up to the crucible.
 *
 * Nothing but the labels moved. `id`, `maxPly`, `variations` and `hintAfterMs` are untouched, so the
 * ladder still admits exactly the same plies at exactly the same thresholds as before — this is the
 * name on each rung, not the rung.
 *
 * `key` is not read anywhere in the project; it was renamed with the names because a stale
 * `key: 'old-name', name: 'Spark'` pair would read as a bug to the next person.
 *
 * The same six names, in the same order, are the rank ladder in `yourOpenings.ts` (`RANKS`) and the
 * XP title on the Home card (`xpTitle`). Those are three separate arrays that have to agree, and
 * nothing in the type system makes them — see the note on `LINES_PER_RANK` there for why that matters
 * more than it looks, and `.bench/youropenings.test.mjs` for the check that holds them together.
 */
export const LEVELS = [
  { id: 1, key: 'spark', name: 'Spark', desc: 'First moves only, with hints', maxPly: 8, variations: false, hintAfterMs: 4000 },
  { id: 2, key: 'ember', name: 'Ember', desc: 'Shorter lines, hints later', maxPly: 12, variations: false, hintAfterMs: 7000 },
  { id: 3, key: 'flame', name: 'Flame', desc: 'Full mainline, no hints', maxPly: 999, variations: false, hintAfterMs: 12000 },
  { id: 4, key: 'blaze', name: 'Blaze', desc: 'Opponent may deviate into side lines', maxPly: 999, variations: true, hintAfterMs: 20000 },
  { id: 5, key: 'forge', name: 'Forge', desc: 'Deeper, deviations, late hints only', maxPly: 999, variations: true, hintAfterMs: 30000 },
  { id: 6, key: 'crucible', name: 'Crucible', desc: 'Everything, deviations any time, no hints', maxPly: 999, variations: true, hintAfterMs: 0 },
] as const;

export type LevelDef = typeof LEVELS[number];

// ---------- Line collection ----------

/**
 * Memoised `collectStudyLines`.
 *
 * The collection itself is cheap in isolation but was being paid over and over
 * on the render thread: the Train customize sheet walks the ENTIRE library
 * (10 openings, ~500 studies) and each screen that shows a study count does
 * the same walk. Measured: the sheet performed **four full-library traversals
 * during its first render alone** (the tree memo plus the open-opening and
 * open-chapter state initializers, each of which re-walked every study), on
 * top of a per-line `new Chess()` replay for mastery.
 *
 * The key is the study OBJECT, not its id: repertoire JSON is imported once and
 * never re-created, so object identity is stable for the process lifetime and a
 * `WeakMap` lets the cache die with the module. That also makes it correct for
 * custom (user-built) repertoires, whose study ids can collide with book ids.
 */
const lineCache = new WeakMap<RepStudy, TrainLine[]>();

/** Collect all trainable lines of a study (mainline + variation branches).
 *  Memoised per study object — see `lineCache`. */
export function collectStudyLines(study: RepStudy): TrainLine[] {
  const hit = lineCache.get(study);
  if (hit) return hit;
  const res = collectStudyLinesUncached(study);
  lineCache.set(study, res);
  return res;
}

function collectStudyLinesUncached(study: RepStudy): TrainLine[] {
  const lines: string[][] = [];

  const nestedLines = (vari: RepMove[], prefix: string[]): string[][] => {
    const out: string[][] = [];
    for (let i = 0; i < vari.length; i++) {
      const node = vari[i];
      for (const sub of node.variations) {
        const base = [...prefix, ...vari.slice(0, i).map((m) => m.san)];
        out.push([...base, ...sub.map((m) => m.san)]);
        out.push(...nestedLines(sub, base));
      }
    }
    return out;
  };

  const walk = (idx: number, prefix: string[]) => {
    if (idx >= study.tree.length) {
      if (prefix.length) lines.push(prefix);
      return;
    }
    const node = study.tree[idx];
    walk(idx + 1, [...prefix, node.san]);
    for (const vari of node.variations) {
      lines.push([...prefix, ...vari.map((m) => m.san)]);
      lines.push(...nestedLines(vari, prefix));
    }
  };
  walk(0, []);

  const seen = new Set<string>();
  const out: TrainLine[] = [];
  lines.forEach((sans, i) => {
    const key = sans.join(' ');
    if (seen.has(key) || sans.length < 2) return;
    seen.add(key);
    out.push({
      id: `${study.id}#${out.length}`,
      studyId: study.id,
      index: out.length,
      sans,
      isVariation: !isMainline(study, sans),
      plyCount: sans.length,
    });
  });
  return out;
}

function isMainline(study: RepStudy, sans: string[]): boolean {
  const main = study.tree.map((m) => m.san);
  if (sans.length > main.length) return false;
  return main.slice(0, sans.length).every((m, i) => m === sans[i]);
}

// ---------------------------------------------------------------------------
// THE POSITION INDEX — finding our book by POSITION, not by move order
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS, and it is the whole of the bug behind
// *"i tried sicilian in your openings and the same problem that you keep repeating each time:
// i only played one move and thats it!"*
//
// Everything above matches by MOVE ORDER. `matchTree`, `buildCoverageTrie` and
// `lookupCoverage` are all a SAN trie: they ask "which of our lines has this list of moves as a
// prefix?". A real game is not a prefix of any study.
//
// The user's Sicilian is `e4 c5 Nf3 d6 c4 d5 Nc3 a6 d4`. The book's Sicilian studies teach
// specific lines from the same starting moves, and the moment the user plays a move that is not
// the study's next move, there is no longer any relationship between the two lists. Measured on
// the reported line: the SAN trie matches 2 plies. `walkStudy`'s resync walks down looking for a
// depth whose next move is legal in the user's actual position and finds NONE at any depth, so
// the book contributes nothing, the family card is exactly as long as the user's own games, and
// the board dies after one move.
//
// But the POSITION the user reached is a perfectly ordinary Najdorf position, and the book very
// likely teaches it - reached by a different route. Move order is an accident of how a game was
// played; position is what the position actually is. A transposition is the same position with a
// different move history, and a trie cannot see that at all.
//
// So: index every position every shipped line passes through, and look the user's position up
// directly. This is the question the feature was always asking ("where does OUR line go from
// HERE?") and the only index that can answer it.
//
// SIZE, AND WHY IT IS NOT BUILT EAGERLY
// ------------------------------------
// The comment on `COVERAGE_MAX_PLY` records what happened when the SAN trie was built at full
// depth over every study: 8 seconds to open "Your openings" and 37 MB, because ~200,000 nodes
// were constructed synchronously on the UI thread before the list could paint. A position index
// over every line of every study is the same shape of thing and would be worse.
//
// So this is built PER OPENING, ON DEMAND, and cached. A single opening is tens of studies and a
// few thousand positions — a couple of milliseconds, once, the first time that opening is
// opened, and never again. The caller always has an `openingId` by the time it needs this
// (the family card is named before its tail is built), so nothing needs a library-wide build.

/** One of our lines passing through one position. */
export interface PositionEntry {
  study: RepStudy;
  /** The whole line, from the initial position. */
  sans: string[];
  /** How many plies of `sans` have been played to reach the indexed position. */
  ply: number;
}

/**
 * The identity of a position for the purpose of "is this our position too?".
 *
 * Four of the six FEN fields, and the reasoning is not laziness:
 *
 *   - the halfmove clock and the fullmove number are bookkeeping. They decide whether a
 *     fifty-move or seventy-five-move claim is available, and neither game nor book here is
 *     anywhere near either, but they change on every single move, so including them would mean
 *     almost nothing ever matched.
 *   - everything that decides which moves are LEGAL is kept: piece placement, side to move,
 *     castling rights, and the en passant square. Dropping the en passant square would be a
 *     real error — it is the one field that can make a capture available or unavailable — so it
 *     stays even though it is the field most likely to differ spuriously.
 */
export function positionKey(fen: string): string {
  const parts = fen.split(' ');
  if (parts.length < 4) return fen;
  return `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]}`;
}

/**
 * Index every position these studies' lines pass through.
 *
 * Positions are recorded BEFORE each move, so `ply` is the number of moves already played and
 * `sans.slice(ply)` is the continuation. The starting position is included, which lets a line be
 * continued from move one.
 *
 * WHERE SEVERAL OF OUR LINES PASS THROUGH THE SAME POSITION - which happens constantly, and is
 * the normal case rather than an exception - ALL of them are kept. Choosing between them is a
 * judgement about how much to teach, so it belongs to the caller, not to the index.
 *
 * WHY THIS WALKS THE TREE AND NOT `collectStudyLines`, and why that mattered
 * -----------------------------------------------------------------------
 * The first version replayed every collected line on a `Chess` board, calling `fen()` at each
 * ply. It was correct, and it cost **1,536 ms for the Sicilian** and 874-1,156 ms for the other
 * openings - synchronously, on the UI thread, the first time the user opened the opening. That
 * is the "it take too much time" report, and it was caused by this function. A full-library
 * build would have been about 37 seconds.
 *
 * The corpus already stores the answer. Every `RepMove` carries `fenAfter` as shipped in the
 * JSON, so the position BEFORE a node is the `fenAfter` of the node before it on its path, and
 * no board needs replaying at all. This is the same technique used to independently verify the
 * index, which is a nice property: the fast implementation and the check that the fast
 * implementation is right share no code.
 */
export function buildPositionIndex(studies: RepStudy[]): Map<string, PositionEntry[]> {
  const index = new Map<string, PositionEntry[]>();

  const add = (fenBefore: string, study: RepStudy, sans: string[], ply: number) => {
    const key = positionKey(fenBefore);
    const entry: PositionEntry = { study, sans, ply };
    const bucket = index.get(key);
    if (bucket) bucket.push(entry);
    else index.set(key, [entry]);
  };

  // The position every line starts from. Replaying nothing means the start position has to be
  // named rather than derived, and chess.js is the authority for what it is.
  const START = positionKey(new Chess().fen());

  for (const study of studies) {
    /*
     * One path down the tree. `pathSans` is the move order that reaches `fenBefore`, and `nodes`
     * are the moves still to come from there.
     *
     * A VARIATION IS NOT AN ALTERNATIVE BRANCH. It REPEATS the move it hangs off and then
     * continues differently — which is why `descendTree` returns `v.slice(1)` and why the
     * coverage index documents "a repeated-head variation extends the chain from the node AFTER
     * the move it repeats". So the path into a variation is everything up to and including its
     * parent move, and its own new moves start after that.
     *
     * Getting this wrong is not subtle: the first version treated a variation as replacing its
     * parent, so `ply` came back as 0 for every variation entry and the caller was handed a
     * move list starting at `d4`. It looked like a working index and returned an unplayable
     * line. The `ply` below is `pathSans.length + i` and cannot drift from the line it indexes.
     */
    const walk = (nodes: RepMove[], pathSans: string[], fenBefore: string) => {
      let fen = fenBefore;
      const lineSans = [...pathSans, ...nodes.map((m) => m.san)];
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        add(fen, study, lineSans, pathSans.length + i);
        for (const v of node.variations) {
          if (v.length === 0) continue;
          walk(
            v.slice(1),
            [...pathSans, ...nodes.slice(0, i + 1).map((m) => m.san)],
            node.fenAfter,
          );
        }
        fen = node.fenAfter;
      }
    };
    walk(study.tree, [], START);
  }

  return index;
}

/**
 * Filter lines for a level.
 *
 * Every level includes ALL of the study's lines (mainline + variation branches) —
 * variations are alternative White systems that are part of the repertoire, so the
 * session advances through all of them at every level. The level controls how deep
 * into each line you train (maxPly), hint timing, and (Blaze+) random deviations.
 */
export function linesForLevel(study: RepStudy, level: LevelDef): TrainLine[] {
  const all = collectStudyLines(study);
  return dedupe(all.map((l) => truncate(l, level.maxPly)));
}

function truncate(l: TrainLine, maxPly: number): TrainLine {
  if (l.plyCount <= maxPly) return l;
  return { ...l, sans: l.sans.slice(0, maxPly), plyCount: maxPly };
}

function dedupe(lines: TrainLine[]): TrainLine[] {
  const seen = new Set<string>();
  const out: TrainLine[] = [];
  for (const l of lines) {
    // drop lines that are prefixes of longer kept lines
    const k = l.sans.join(' ');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/** Remove lines that are strict prefixes of another line (they finish mid-line). */
export function removePrefixLines(lines: TrainLine[]): TrainLine[] {
  const keys = lines.map((l) => l.sans.join(' '));
  return lines.filter((l, i) => !keys.some((k, j) => j !== i && k.length > keys[i].length && k.startsWith(keys[i] + ' ')));
}

// ---------- Position keys (for SRS) ----------
export function fenKey(fen: string): string {
  // strip move counters — position identity
  return fen.split(' ').slice(0, 4).join(' ');
}

// ---------- Practice session model ----------
export type PracticePhase = 'user' | 'opponent' | 'done';

export interface PracticeState {
  line: TrainLine;
  sans: string[];        // the actual sequence being played (line as-is)
  moveIndex: number;     // index of the next move in sans
  mistakes: number;      // total mistakes this run
  firstTryPerfect: boolean;
  userMoveErrors: number; // per-position error count for hint escalation
}

export function createPractice(line: TrainLine): PracticeState {
  return { line, sans: line.sans, moveIndex: 0, mistakes: 0, firstTryPerfect: true, userMoveErrors: 0 };
}

/** Whose turn at the current point (user plays `userColor`, default Black). */
export function userToMove(ps: PracticeState, userColor: 'w' | 'b' = 'b'): boolean {
  // starts at initial position; even ply count = white to move (index 0 = white move)
  const userPlies = userColor === 'b' ? 1 : 0;
  return ps.moveIndex % 2 === userPlies;
}

/** The SAN the user is expected to find at the current position, or null if opponent's turn. */
export function expectedUserMove(ps: PracticeState, userColor: 'w' | 'b' = 'b'): string | null {
  if (ps.moveIndex >= ps.sans.length) return null;
  return userToMove(ps, userColor) ? ps.sans[ps.moveIndex] : null;
}

/** Validate a user SAN at the current point. */
export function checkUserMove(ps: PracticeState, san: string): boolean {
  return ps.sans[ps.moveIndex] === san;
}

/** Build a chess.js board for the current position of the line. */
export function positionFor(ps: PracticeState): Chess {
  const c = new Chess();
  for (let i = 0; i < ps.moveIndex; i++) {
    try { c.move(ps.sans[i]); } catch { /* data verified at build time */ }
  }
  return c;
}

/**
 * Follow `sans` through the tree and return the node reached at ply `target`
 * (0-based). At each ply the branch's own move continues the line; when it
 * does not match, the variation branches attached to that node (which REPLACE
 * its move, starting at the same ply) are searched instead. Variations nest
 * arbitrarily. Returns null when the line leaves the tree before the target.
 *
 * Extra case (Queen's Gambit book style): a variation may repeat the attach
 * node's own move as its head ("(2...dxc4 3.e4 ...)" attached after the
 * mainline 2...dxc4). The emitted line then shares plies with the mainline
 * before diverging one ply later — so on mismatch we also try variations of
 * the PREVIOUS matched node whose head repeats that node's own move.
 */
function followLine(nodes: RepMove[], sans: string[], depth: number, target: number, prev?: RepMove): RepMove | null {
  if (depth > target || nodes.length === 0) return null;
  const node = nodes[0];
  if (node.san !== sans[depth]) {
    // deviation point: the line plays something else here — try this node's
    // variation branches (they replace this move, starting at the same ply)
    for (const vari of node.variations) {
      const hit = followLine(vari, sans, depth, target);
      if (hit) return hit;
    }
    // redundant-variation-head: the line entered a variation of the previous
    // node that repeats the previous node's move, then diverged here
    if (prev) {
      for (const vari of prev.variations) {
        if (vari.length > 1 && vari[0].san === prev.san) {
          const hit = followLine(vari.slice(1), sans, depth, target);
          if (hit) return hit;
        }
      }
    }
    return null; // the line cannot skip this move within the branch
  }
  if (depth === target) return node;
  return followLine(nodes.slice(1), sans, depth + 1, target, node);
}

/** Find the comment attached to the node reached by playing sans[0..idx] (comment AFTER that move). */
export function commentForPly(study: RepStudy, sans: string[], idx: number): string | null {
  if (idx < 0 || idx >= sans.length) return null;
  const node = followLine(study.tree, sans, 0, idx);
  return node?.commentAfter ?? null;
}

/** Find the tree node reached after playing sans[0..idx] (the node whose san === sans[idx]). */
export function nodeForPly(study: RepStudy, sans: string[], idx: number): RepMove | null {
  if (idx < 0 || idx >= sans.length) return null;
  return followLine(study.tree, sans, 0, idx);
}

/** If the opponent (White) has a deviation available at ply idx, return the replacement line. */
export function opponentDeviation(study: RepStudy, sans: string[], idx: number): string[] | null {
  const node = nodeForPly(study, sans, idx);
  if (!node || node.variations.length === 0) return null;
  const vari = node.variations[0];
  if (!vari || vari.length === 0) return null;
  return [...sans.slice(0, idx), ...vari.map((m) => m.san)];
}

// ---------- Study helpers ----------

/**
 * Every study of a repertoire, flattened ONCE.
 *
 * `chapters.flatMap(...)` allocates a fresh array on every call, and these
 * callers are hot: `bestCoverage` calls it once per lookup, and the opening
 * builder asks the book for a move at every user move of every one of the
 * user's games. The repertoire objects are imported once and never re-created,
 * so object identity is a stable cache key for the process lifetime (the same
 * reasoning as `lineCache` above).
 */
const studiesCache = new WeakMap<Repertoire, RepStudy[]>();

export function allStudies(rep: Repertoire): RepStudy[] {
  const hit = studiesCache.get(rep);
  if (hit) return hit;
  const out: RepStudy[] = [];
  for (const c of rep.chapters) for (const s of c.studies) out.push(s);
  studiesCache.set(rep, out);
  return out;
}

export function findStudy(rep: Repertoire, id: string): RepStudy | undefined {
  return allStudies(rep).find((s) => s.id === id);
}

/** Next chapter study ordering key like "4.10b" for sensible sort. */
export function studyShortTitle(title: string): string {
  return title.replace(/^Study\s*/, '');
}

// ---------- Game ↔ repertoire coverage (mistake analysis) ----------
export interface RepCoverage {
  study: RepStudy;
  matchedPly: number;       // number of plies that follow this study's tree
  expectedNext: string[];   // book replies at the point the game leaves the tree
}

/**
 * Match game SANs against a node sequence. Variations attached to node X are
 * alternatives that replace X's move (they start from the position before X).
 * Returns max matched plies + book moves at the divergence point.
 */
function matchTree(nodes: RepMove[], sans: string[], depth: number): { matched: number; expected: string[] } {
  // walk the mainline while it matches the game
  let i = 0;
  while (i < nodes.length && depth + i < sans.length && nodes[i].san === sans[depth + i]) i++;

  let best: { matched: number; expected: string[] } = { matched: i, expected: [] };
  if (i < nodes.length) {
    // game leaves the tree at this ply (or ends here): book options =
    // the mainline move itself + alternative branch starts attached to this node
    const exp = [nodes[i].san];
    for (const v of nodes[i].variations) if (v.length) exp.push(v[0].san);
    best.expected = exp.slice(0, 3);
  }

  // try variation branches: game matches nodes[0..j-1] then plays vari[0] instead of nodes[j]
  for (let j = 0; j < i; j++) {
    for (const vari of nodes[j].variations) {
      if (!vari.length || vari[0].san !== sans[depth + j]) continue;
      const sub = matchTree(vari, sans, depth + j);
      if (j + sub.matched > best.matched) {
        best = { matched: j + sub.matched, expected: sub.expected };
      }
    }
  }
  return best;
}

/** Find the study whose tree best matches the game's move sequence. */
export function bestCoverage(rep: Repertoire, sans: string[]): RepCoverage | null {
  if (sans.length === 0) return null;
  let best: RepCoverage | null = null;
  for (const study of allStudies(rep)) {
    const r = matchTree(study.tree, sans, 0);
    if (r.matched > 0 && (!best || r.matched > best.matchedPly)) {
      best = { study, matchedPly: r.matched, expectedNext: r.expected };
    }
  }
  return best;
}

/**
 * ONE study's coverage — the same walk `bestCoverage` performs, for one study.
 *
 * Exposed so the trie in `openings.ts` can use the trie to CHOOSE the winning
 * study and then this to produce its exact answer. See the note there: the trie
 * is a `matchedPly` oracle, and this keeps the returned `expectedNext` byte-for
 * -byte what the exhaustive scan would have produced.
 */
export function studyCoverage(
  study: RepStudy,
  sans: string[],
): { matched: number; expected: string[] } {
  if (sans.length === 0) return { matched: 0, expected: [] };
  return matchTree(study.tree, sans, 0);
}

// ---------- The book index: a SAN trie over every line we ship ----------
//
// WHY THIS EXISTS — THE MEASURED FREEZE
// -------------------------------------
// `bestCoverageAcrossOpenings` used to answer every question by walking ALL 692
// shipped studies with `matchTree`. The opening builder asks that question twice
// for EVERY user move of EVERY game, and "Your openings" derives ~12 user moves
// from each of 160 games — about 3,800 lookups per derivation, and the screen
// derives twice (once to name the openings, once for the engine pass).
//
// Measured on the real corpus with the real library: **2.3-2.5 s of pure JS per
// derivation**, on a desktop. Under Hermes on a mid-range Android phone that is
// tens of seconds of a completely blocked JS thread — which is exactly the
// report: "i clicked on an opening and it took too much time to open … then
// when I click on a piece to move it stays blocked".
//
// The fix is structural, not a constant: the answer to "how far does the library
// follow this line, and which study follows it furthest" is a walk down a
// prefix tree, and a trie answers it in O(plies) instead of O(studies x plies).
//
// A node is a position in the union of every line the library teaches, reached
// by SAN. `studies` holds every study whose line set passes THROUGH it, in the
// order the studies were added — which is the order the exhaustive scan used, so
// "first one wins" reproduces the old tie-break exactly.

export interface CoverageNode {
  /** Child positions, keyed by the SAN that reaches them. */
  children: Map<string, CoverageNode>;
  /** Studies whose lines pass through here, in insertion (== scan) order. */
  studies: RepStudy[];
}

/** The deepest point of the library that follows `sans`, and where it got to. */
export interface CoverageHit {
  /** Consecutive plies the library follows from the start of the line. */
  depth: number;
  node: CoverageNode;
}

function coverageChild(node: CoverageNode, san: string): CoverageNode {
  let child = node.children.get(san);
  if (!child) {
    child = { children: new Map(), studies: [] };
    node.children.set(san, child);
  }
  return child;
}

function coverageMark(node: CoverageNode, study: RepStudy): void {
  // A repetition inside one study can reach the same node twice; the list is
  // 1-3 entries in practice, so a linear scan is cheaper than a per-node Set.
  if (node.studies.indexOf(study) === -1) node.studies.push(study);
}

/**
 * Add one study's whole line set to the trie.
 *
 * `moves` are the moves still to come and `parent` is the node they continue
 * from. The mainline is a chain, so this is a linear walk: each move adds an
 * edge `parent --san--> next` and the walk continues from `next`.
 *
 * WHY ONLY *REPEATED-HEAD* VARIATIONS GO IN — AND WHY THAT IS NOT A SHORTCUT
 * ------------------------------------------------------------------------
 * The obvious reading of a variation is "an alternative that replaces this
 * node's move", and `collectStudyLines` and `descendTree` both use that
 * convention. `matchTree` — the function whose answer this index has to
 * reproduce — does not:
 *
 *     for (let j = 0; j < i; j++)            // j < i, and the mainline matched at j,
 *       for (const vari of nodes[j].variations)
 *         if (!vari.length || vari[0].san !== sans[depth + j]) continue;
 *
 * At `j` the mainline already matched, so `nodes[j].san === sans[depth + j]`,
 * and the filter therefore only accepts a variation whose head REPEATS the move
 * it is attached to. A variation that starts with a different move is never
 * followed for the purpose of coverage.
 *
 * Indexing those anyway was measured, and it is not a rounding error: it made
 * the index claim a deeper match than the tree walk on **529 of 1,456 in-book
 * prefixes in the reference corpus** (`e4 c5 Nc3` -> trie depth 3, `s1`'s own
 * walk 2). Every one of those would have quietly fallen back to the exhaustive
 * scan, so the index would have been correct and useless. It only ever made the
 * coverage SHALLOWER than it could be — which is why it was never noticed: the
 * symptom is "we don't quite know this opening", not a crash.
 *
 * So a repeated-head variation extends the chain from the node AFTER the move it
 * repeats (which is `child`, already created), and everything else is left out.
 * The answer's `expectedNext` is unaffected either way, because it is always read
 * from `studyCoverage` on the winning study rather than from the index.
 */
/**
 * How deep into a line the coverage index is built.
 *
 * WHY A CAP, AND WHY IT IS NOT A LOSS OF FIDELITY
 * -------------------------------------------------
 * The index existed to answer one question: "which of our openings is this game's line
 * in?". Every opening in the library is identified by roughly its first ten plies, and
 * `deriveFamilies` only ever asks about the OPENING moves of a game. But the trie was
 * built to the full depth of every line - 30 plies, plus every sideline - which for 1,204
 * studies is roughly 200,000 nodes, each a Map plus a study array. That is what made the
 * first "Your openings" open take 8 seconds and add 37 MB: the whole index was constructed
 * synchronously, on the UI thread, before the list could paint.
 *
 * So the index stops once a line is deep enough to have been identified. Anything shallower
 * would be guessing, and this is not a guess - `.bench/bookindex.diff.test.mjs` compares the
 * capped index against the exhaustive implementation over EVERY prefix of EVERY real game
 * the test has, plus whole games and hand-picked awkward cases, and fails on any
 * divergence. If the cap changed an answer, that test fails.
 */
const COVERAGE_MAX_PLY = 12;

function insertCoverageStudy(
  moves: RepMove[],
  parent: CoverageNode,
  study: RepStudy,
  depth = 0,
): void {
  if (depth >= COVERAGE_MAX_PLY) return;
  let cur = parent;
  for (let i = 0; i < moves.length; i++) {
    const node = moves[i];
    const child = coverageChild(cur, node.san);
    coverageMark(child, study);
    for (const vari of node.variations) {
      if (vari.length === 0 || vari[0].san !== node.san) continue;
      insertCoverageStudy(vari.slice(1), child, study, depth + 1);
    }
    cur = child;
  }
}

/**
 * Build the index over an ORDERED list of studies.
 *
 * Order matters and is the caller's to keep: the winner of a tie is
 * `studies[0]` at the deepest node, so the list must be in the same order the
 * exhaustive scan visited them (opening, then chapter, then study) for the
 * answer to be identical.
 */
export function buildCoverageTrie(studies: RepStudy[]): CoverageNode {
  const root: CoverageNode = { children: new Map(), studies: [] };
  for (const study of studies) insertCoverageStudy(study.tree, root, study);
  return root;
}

/**
 * How far into `sans` the library follows, and which studies got there.
 *
 * One `Map.get` per ply, stopping at the first SAN the library does not know.
 * A full 200-ply game costs the same as a 24-ply one, because the walk is
 * bounded by the depth of the deepest study.
 */
export function lookupCoverage(root: CoverageNode, sans: string[]): CoverageHit | null {
  let node = root;
  let depth = 0;
  for (let i = 0; i < sans.length; i++) {
    const next = node.children.get(sans[i]);
    if (!next) break;
    node = next;
    depth++;
  }
  if (depth === 0) return null;
  return { depth, node };
}

// ---------- Train mode (mixed spaced-repetition review) ----------

/**
 * An exercise = "you are at position P inside a learned line; play the rest of the
 * line from there". P may be the beginning (startPly 0), the middle, or the very
 * end of the line. Moves before startPly are auto-played in front of the user.
 */
export interface TrainExercise {
  id: string;          // `${line.id}|${startPly}`
  studyId: string;
  studyTitle: string;
  line: TrainLine;
  startPly: number;    // 0 = from the beginning; user to move at that point
  userColor: 'w' | 'b'; // the color this exercise trains
  score: number;       // selection priority (due learned positions first)
}

export interface PositionLike {
  asked: number;
  mastery: number;
  dueAt: string | null;
}

/** Key of the position reached after playing sans[0..ply-1] (ply 0 = initial position). */
export function positionKeyAtPly(studyId: string, sans: string[], ply: number): string {
  if (ply <= 0) return `${studyId}|${fenKey(START_FEN)}`;
  const c = new Chess();
  for (let i = 0; i < ply; i++) {
    try { c.move(sans[i]); } catch { /* verified data */ }
  }
  return `${studyId}|${fenKey(c.fen())}`;
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ---------- Fast prefix replay ----------
/**
 * Position after `ply` moves of `sans`, replayed in ONE pass.
 *
 * Every screen used to rebuild the whole history for each derived value — the
 * board position, the last move, the book eval, the arrow preview — which is
 * four independent `new Chess()` replays per render, and each replay is
 * quadratic in `ply` because `c.fen()` re-serialises the board on every move.
 * On a 30-ply line that is ~10ms of pure JS on the render thread (measured),
 * which is exactly the lag you feel when tapping Next or dragging a piece.
 *
 * `plies` holds the FEN *after* each move (`plies[0]` is the start position, so
 * `plies[i]` follows `sans[i-1]`), letting callers read any prefix in O(1).
 * `moves` carries from/to for last-move highlighting.
 */
export interface LineReplay {
  plies: string[];
  moves: { from: string; to: string; san: string }[];
}

/**
 * Replay a line ONCE.
 *
 * Every per-ply value the screens need — the FEN, the move that produced it, the
 * SAN of that move — is captured here in a single pass, so a render is an array
 * index rather than a fresh `new Chess()` walk. `san` is included because the
 * Course screen's "next move" preview and the "Your move: Nf3" status line used
 * to each rebuild a board just to read one SAN.
 */
export function replayLine(sans: string[]): LineReplay {
  const c = new Chess();
  const plies: string[] = [c.fen()];
  const moves: { from: string; to: string; san: string }[] = [];
  for (const san of sans) {
    try {
      const m = c.move(san);
      moves.push({ from: m.from, to: m.to, san: m.san });
    } catch {
      // verified data — a corruption here is a data bug, not a runtime case
      moves.push({ from: '', to: '', san });
    }
    plies.push(c.fen());
  }
  return { plies, moves };
}

/** Position after `ply` moves of a replayed line (clamped to the available plies). */
export function fenAtPly(rep: LineReplay, ply: number): string {
  const i = Math.max(0, Math.min(rep.plies.length - 1, ply));
  return rep.plies[i];
}


/** Plies of a line where the user (`userColor`, default Black) is to move. */
export function userToMovePlies(line: TrainLine, userColor: 'w' | 'b' = 'b'): number[] {
  const out: number[] = [];
  const mod = userColor === 'b' ? 1 : 0;
  for (let i = 0; i < line.sans.length; i++) if (i % 2 === mod) out.push(i);
  return out;
}

/** Odd plies of a line = points where Black (the user) is to move. @deprecated use userToMovePlies */
export function blackToMovePlies(line: TrainLine): number[] {
  return userToMovePlies(line, 'b');
}

/**
 * Line-level mastery: average SRS mastery over the line's user-to-move
 * positions that have been asked at least once. Uses the SAME position keys
 * Practice/Train record (`${studyId}|${fenKey(position BEFORE the user's
 * move)}`), so the numbers reflect exactly what has been drilled.
 * `mastery === null` when no position of the line was ever asked ("new").
 *
 * `fens` is optional: pass the `plies` array of an existing `replayLine` call
 * and the whole line is never replayed again. Without it this falls back to its
 * own single-pass replay (one `new Chess()`, not one per ply) — the previous
 * implementation built a fresh board inside the loop *and* re-serialised the
 * FEN on every ply, which is quadratic and was the dominant cost when the
 * customize sheet rated every line in the library.
 */
export function lineMastery(
  studyId: string,
  sans: string[],
  userColor: 'w' | 'b',
  positions: Record<string, PositionLike>,
  fens?: string[],
): { asked: number; mastery: number | null } {
  const mod = userColor === 'b' ? 1 : 0;
  // `plies[i]` is the position BEFORE `sans[i]` (plies[0] = initial position),
  // which is exactly the key the user's move at ply `i` is stored under.
  const plies = fens && fens.length >= sans.length ? fens : replayLine(sans).plies;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < sans.length; i++) {
    if (i % 2 !== mod) continue;
    const p = positions[`${studyId}|${fenKey(plies[i])}`];
    if (p && p.asked > 0) {
      sum += p.mastery;
      n++;
    }
  }
  return { asked: n, mastery: n > 0 ? sum / n : null };
}

/**
 * Rate every line of a study in ONE pass each.
 *
 * Same result as calling `lineMastery` per line, but each line is replayed a
 * single time and the resulting FEN array is reused for the key lookups. The
 * customize sheet used to call `lineMastery` once per line, and the aggregate
 * study/chapter/opening averages were then recomputed from those numbers — this
 * keeps the shape the sheet sorts on (`index`, `isVariation`, `moves`,
 * `mastery`) so the UI is untouched.
 */
export interface RatedLine {
  id: string;
  index: number;
  isVariation: boolean;
  moves: number;
  mastery: number | null;
}

export function rateStudyLines(
  study: RepStudy,
  userColor: 'w' | 'b',
  positions: Record<string, PositionLike>,
): { lines: RatedLine[]; mastery: number | null } {
  const lines = collectStudyLines(study);
  const out: RatedLine[] = [];
  let sum = 0;
  let n = 0;
  for (const l of lines) {
    const { asked, mastery } = lineMastery(study.id, l.sans, userColor, positions);
    if (asked > 0 && mastery != null) {
      sum += mastery;
      n++;
    }
    out.push({
      id: l.id,
      index: l.index,
      isVariation: l.isVariation,
      moves: Math.ceil(l.plyCount / 2),
      mastery,
    });
  }
  return { lines: out, mastery: n > 0 ? sum / n : null };
}

export interface OpeningProgress {
  /**
   * Positions the user has actually practised in "Your openings" for THIS opening.
   *
   * Reported separately from `started` because the two are different units — a study
   * and a position are not comparable — and summing them into one ratio would produce
   * a number that means nothing. They are added for the RANK, which is a claim about
   * skill rather than a ratio, and shown side by side.
   */
  ownPractised: number;
  /** 0 = not started, else 1..6 matching `LEVELS`. */
  level: number;
  /** The rank name to show — `LEVELS[level-1].name`. */
  label: string;
  /** The NEXT rank, or null at the top. */
  nextLabel: string | null;
  /** Studies the user has opened at all. */
  started: number;
  /** Studies whose every asked position is mastered. */
  mastered: number;
  /** Drillable studies. Excludes `type: 'Reference'` indexes — see `isReferenceStudy`. */
  total: number;
  /** How many `Reference` indexes this opening ships, reported but not counted. */
  references: number;
  /** 0..1 — started studies over total, so the bar is honest on a fresh account. */
  pct: number;
}

/**
 * How far the user has got in one opening, as a RANK.
 *
 * The request: *"show to me in each opening my advancement (from novice to pro like
 * in chessforge chess) in 'your openings' and in the normal openings of the app"*.
 *
 * It is derived from the same SRS records the rest of the app already keeps — the
 * study attempts and the per-position mastery — so it cannot drift from what the
 * user has actually done, and it is a pure function of them, which is what makes it
 * testable without a device.
 *
 * THE RANK IS THE HIGHEST REACHED, NOT THE AVERAGE
 * ------------------------------------------------
 * Averaging levels sounds fairer and is worse: a player who has ground through one
 * chapter properly and not touched the rest would be told they are at Spark,
 * which reads as "you have barely started" and is the opposite of what happened.
 * The highest level actually reached is both simpler to explain and more
 * encouraging, and `started`/`mastered` carry the nuance beside it.
 *
 * `level: 0` means not started, which is a different thing from level 1 (Spark)
 * and is shown differently — otherwise a fresh account would claim the user is at
 * the first rank over something they have never opened.
 */
/**
 * Is this study a REFERENCE INDEX rather than a drillable line?
 *
 * `type: 'Reference'` studies are prose. Their content lives in `commentAfter` — a
 * "Tactical Motifs Index" listing ten recurring motifs with pointers to the studies
 * that demonstrate each one — and their `tree` holds a single placeholder move
 * (`1.e4` or `1.d4`) purely so the study renders as a card. There is no opening to
 * learn from them, so they yield zero trainable lines **by design**.
 *
 * WHY THIS MATTERS, WHEN IT WAS FOUND, AND WHY
 * ---------------------------------------------
 * The repertoire audit flagged all four of them as "degenerate trees: single-move
 * study, yields zero trainable lines", which is how a prose index looks if you
 * assume every study is a game. It is a true observation and a false conclusion:
 * the fix is NOT to invent lines for a tactics checklist, which would be fabricating
 * chess content to satisfy a linter.
 *
 * The real defect was that `type: 'Reference'` was a documented value that the app
 * did not handle ANYWHERE. `'Reference'` appeared in four data files and in zero
 * source files. So a reference index was:
 *
 *   - offered in Train's Customize list, where selecting it silently produced no
 *     exercises — the same dead-control shape already fixed for un-practised lines;
 *   - counted in `openingProgress`'s denominator, so every opening's progress bar
 *     and "N/M studies" figure was permanently dragged down by a study that can
 *     never be started; and
 *   - shown in the study list as "Lv 1 · Beginner · 0 lines" with a mastery bar that
 *     could never move — the app claiming a thing was unfinished when it is not a
 *     thing that can be finished.
 *
 * So the fix is to make the app honour the type that its own data already uses.
 */
export function isReferenceStudy(study: RepStudy): boolean {
  return study.type === 'Reference';
}

/** A study the trainer can actually drill: it has lines, and it is not an index. */
export function isTrainableStudy(study: RepStudy): boolean {
  return !isReferenceStudy(study) && study.lineCount > 0;
}

export function openingProgress(
  rep: Repertoire,
  studiesState: Record<string, { attempts?: number; level?: number; mastery?: number }>,
  _positionsState?: Record<string, PositionLike>,
  _userColor: 'w' | 'b' = 'b',
  /**
   * How many "Your openings" positions the user has practised, keyed by opening id.
   *
   * WITHOUT THIS THE RANK COULD NOT MOVE, and that is the bug it fixes. The rank used
   * to be derived only from `studiesState` — the SRS record for the SHIPPED studies.
   * Practising in "Your openings" writes to the custom repertoire and never touches the
   * SRS, because those lines are not shipped studies. So the Sicilian rank was
   * structurally incapable of changing however much the user played it, and the card
   * was honestly reporting effort the user had not made.
   *
   * The user reads that card as "how far have I got in the Sicilian", so it has to
   * count the lines he actually plays in his own games.
   */
  ownByOpening: Record<string, number> = {},
  /** This opening's registry id, e.g. `sicilian`. */
  openingId?: string,
): OpeningProgress {
  const all = allStudies(rep);
  // Reference indexes are excluded from the denominator. Including them meant a
  // user's progress could never reach 100% in an opening that ships one, and the
  // number shown was wrong rather than merely pessimistic.
  const studies = all.filter((s) => !isReferenceStudy(s));
  const references = all.length - studies.length;
  const total = studies.length;
  const ownPractised = openingId ? (ownByOpening[openingId] ?? 0) : 0;
  let started = 0;
  let mastered = 0;
  let level = 0;
  /*
   * THE RANK IS THE HIGHEST LEVEL REACHED, ACROSS BOTH SOURCES OF PRACTICE.
   *
   * A study the user has drilled moves the rank. So does a position they have played
   * and recorded in their own games, which is the same claim about the same opening
   * from a different direction. Treating only the first as "practice" is what left the
   * user staring at a frozen rank.
   */
  const ownLevel = ownPractised >= 24 ? 4 : ownPractised >= 12 ? 3 : ownPractised >= 4 ? 2 : ownPractised > 0 ? 1 : 0;
  for (const st of studies) {
    const s = studiesState[st.id];
    if ((s?.attempts ?? 0) > 0) {
      started++;
      const lv = Math.min(6, Math.max(1, s?.level ?? 1));
      if (lv > level) level = lv;
    }
    /*
     * `mastered` IS READ, NOT RECOMPUTED. THIS IS A PERFORMANCE FIX.
     *
     * This used to call `lineMastery(st.id, studyMainlineSans(st), ...)`, which
     * allocates a fresh SAN array per study and replays the line with a `new Chess()`
     * — for the Sicilian, 114 studies, on the UI thread, before the opening screen
     * had drawn a pixel.
     *
     * `.bench/perf.openingprogress.mjs` measures it:
     *
     *     sicilian   614.3 ms  ->  0.46 ms
     *     all 13     2853 ms   ->  0.97 ms
     *
     * That is the "it takes a time to open when I click on it" complaint, and it was
     * introduced by the rank feature itself. It is paid on EVERY tap, because the
     * screen remounts.
     *
     * The replay was not buying anything. Mastery is not a property of the
     * repertoire — it is a property of THIS USER, and the store already holds it at
     * `studies[id].mastery`, written by the same SRS that `lineMastery` reads its
     * inputs from. Recomputing a user's mastery from a static line, per study, per
     * render, was deriving a number that was already sitting in memory.
     *
     * A study the store has never seen has no mastery, so it is not mastered — the
     * same answer the replay gave, for free.
     */
    if ((s?.mastery ?? 0) >= 0.95) mastered++;
  }
  const shown = level > ownLevel ? level : ownLevel;
  return {
    level: shown,
    label: shown > 0 ? LEVELS[shown - 1].name : 'Not started',
    nextLabel: shown > 0 && shown < 6 ? LEVELS[shown].name : null,
    started,
    mastered,
    total,
    references,
    ownPractised,
    pct: total > 0 ? started / total : 0,
  };
}

export function dueLike(p: PositionLike | undefined, now: number): boolean {
  if (!p) return true; // never asked → treat as due/new
  return !p.dueAt || new Date(p.dueAt).getTime() <= now;
}

/**
 * Build the exercise pool for a Train session across ALL learned studies
 * (studies the user has practiced at least once). Each learned study contributes
 * lines at its unlocked level; each line contributes one exercise whose start
 * position is randomly the beginning, the middle, or the end of the line.
 * Exercises anchored on due (weakest) positions are prioritized; the pool is
 * capped at `max` and returned in random order.
 *
 * `filter.includeUnlearned` drops the "must have been practiced" requirement.
 * WITHOUT it the Train customize sheet could not select anything at all on a fresh
 * account: it only offered the lines of studies with `attempts > 0`, so every
 * chapter's selectable set was empty, the toggle short-circuited, and the control
 * still looked enabled. The user's report was exactly that — "i tried clicking
 * all the sicilian chapter for example and nothing happened".
 *
 * It is opt-in rather than removed because the default pool ("All openings") is
 * genuinely a review of what you have LEARNED, and drilling a library you have
 * never seen is a different thing from what that button says. The customize sheet
 * is an explicit choice, so it passes the flag.
 *
 * `userColor` is the side the repertoire trains ('b' default = Black, 'w' = White).
 */
export function buildTrainExercises(
  rep: Repertoire,
  studiesState: Record<string, { attempts?: number; level?: number }>,
  positionsState: Record<string, PositionLike>,
  max = 12,
  filter?: { studyIds?: string[] | Set<string>; lineIds?: string[] | Set<string>; includeUnlearned?: boolean },
  userColor: 'w' | 'b' = 'b',
): TrainExercise[] {
  const now = Date.now();
  const allowed = filter?.studyIds
    ? (filter.studyIds instanceof Set ? filter.studyIds : new Set(filter.studyIds))
    : null;
  const allowedLines = filter?.lineIds
    ? (filter.lineIds instanceof Set ? filter.lineIds : new Set(filter.lineIds))
    : null;
  const includeUnlearned = filter?.includeUnlearned === true;
  const learned = allStudies(rep).filter((s) =>
    (includeUnlearned || (studiesState[s.id]?.attempts ?? 0) > 0)
    && (!allowed || allowed.has(s.id)));
  if (learned.length === 0) return [];

  const candidates: TrainExercise[] = [];

  for (const study of learned) {
    const lv = Math.min(6, Math.max(1, studiesState[study.id]?.level ?? 1));
    // truncate at the level depth, THEN apply the line-level custom scope, then
    // dedupe (a selected line survives even when its truncated form duplicates
    // a line that was not selected)
    const all = collectStudyLines(study).map((l) => truncate(l, LEVELS[lv - 1].maxPly));
    const scoped = allowedLines ? all.filter((l) => allowedLines.has(l.id)) : all;
    const lines = removePrefixLines(dedupe(scoped));
    for (const line of lines) {
      const oddPlies = userToMovePlies(line, userColor);
      if (oddPlies.length === 0) continue;
      // choose start: 35% beginning, 35% middle, 30% end of the line
      const r = Math.random();
      let startPly: number;
      if (r < 0.35) startPly = 0;
      else if (r < 0.7) startPly = oddPlies[Math.floor(Math.random() * Math.max(1, oddPlies.length - 1))];
      else startPly = oddPlies[oddPlies.length - 1];

      // score: how urgent is the anchor position (and the line overall)?
      let score = 1;
      if (startPly > 0) {
        const key = positionKeyAtPly(study.id, line.sans, startPly);
        const p = positionsState[key];
        if (dueLike(p, now)) score = p && p.asked > 0 ? 4 : 3;
        else score = 1 + (p?.mastery != null ? (1 - p.mastery) : 0.5);
      } else {
        // whole-line exercise: score by the share of due positions in it
        const keys = userToMovePlies(line, userColor).map((ply) => positionKeyAtPly(study.id, line.sans, ply));
        const dueCount = keys.filter((k) => dueLike(positionsState[k], now)).length;
        score = dueCount > 0 ? 2.5 + Math.min(1, dueCount / keys.length) : 1.2;
      }

      candidates.push({
        id: `${line.id}|${startPly}`,
        studyId: study.id,
        studyTitle: study.title,
        line,
        startPly,
        userColor,
        score: score + Math.random() * 0.5, // random tiebreak
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, max)
    .map((e) => ({ e, k: Math.random() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.e);
}
