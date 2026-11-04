/**
 * Coach knowledge base — retrieval without embeddings.
 * A TypeScript port of the Kotlin prototype's `KnowledgeBase.kt`: same scoring
 * weights, same tiny stemmer, same ordering. The rows ship as
 * `src/data/coach_kb.json` (64 entries, dumped from the prototype's kb.db).
 */

export interface KbEntry {
  id: number;
  /** concept | structure | opening | endgame */
  kind: string;
  name: string;
  title: string;
  aka: string[];
  eco: string;
  summary: string;
  detail: string;
  whitePlan: string;
  blackPlan: string;
  tags: string[];
  keywords: string[];
  hooks: string[];
  moves: string;
  fen: string;
  example: string;
}

export const ALL_KINDS: ReadonlySet<string> = new Set(['concept', 'structure', 'opening', 'endgame']);
export const isEndgameEntry = (e: KbEntry): boolean => e.kind === 'endgame';
export const isOpeningEntry = (e: KbEntry): boolean => e.kind === 'opening';

interface Indexed {
  e: KbEntry;
  name: string;
  title: string;
  akas: string[];
  tags: string[];
  kws: string[];
  summaryWords: Set<string>;
  detailWords: Set<string>;
}

/** Split text into lowercase word tokens (>=2 chars, letters/digits only). */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9']+/)) if (t.length >= 2) out.add(t);
  return out;
}

/** Tiny stemmer: singularize simple plurals so "pawns" matches "pawn". */
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Words that describe the act of asking, not a chess concept.
 *
 * `search()` is deliberately broad: it scores prose from summaries and details,
 * which is right for "find anything related to this". It is the wrong tool for
 * attaching book pages to a student's question. "Explain this position" used to
 * retrieve the bishop pair and King-and-pawn-vs-king because both entries
 * contain the prose word "position"; neither had anything to do with the board.
 *
 * Identity matching therefore uses only titles / names / aliases, and ignores
 * these question scaffolding words. A generic request retrieves nothing, which
 * is exactly what lets the position facts answer instead.
 */
const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'what', 'which', 'who', 'how', 'why',
  'this', 'that', 'these', 'those', 'my', 'your', 'our', 'their', 'its', 'it',
  'here', 'there', 'please', 'explain', 'describe', 'tell', 'me', 'about',
  'position', 'game', 'move', 'moves', 'plan', 'plans', 'idea', 'ideas',
  'help', 'can', 'could', 'should', 'would', 'do', 'does', 'did', 'with',
  'from', 'at', 'as', 'by', 'have', 'has', 'had', 'not', 'but', 'if', 'then',
  'than', 'so', 'just', 'really', 'important', 'good', 'bad', 'best', 'better',
  'chess', 'coach', 'i', 'you', 'we', 'they', 'he', 'she', 'them', 'us',
  'more', 'most', 'much', 'many', 'some', 'any', 'no', 'yes', 'okay', 'ok',
  'now', 'next', 'think', 'see', 'going', 'happening', 'want', 'need', 'make',
  'work', 'works', 'line', 'lines', 'side', 'sides', 'tell', 'look', 'show',
  'give', 'get', 'got', 'use', 'using', 'here', 'current', 'actually', 'then',
  'also', 'very', 'too', 'only', 'again', 'still', 'vs', 'versus', 'please',
]);

/** The meaningful (stemmed) words of a chess question or a KB identity. */
function meaningfulTokens(text: string): string[] {
  return [...new Set(
    [...tokenize(text)].map(stem).filter((t) => t.length >= 2 && !QUERY_STOPWORDS.has(t)),
  )];
}

/** Identity phrases a student could use to name this entry. */
function identityPhrases(e: KbEntry): string[] {
  return [e.title, e.name, ...e.aka];
}

/**
 * True when [query] explicitly names [e] by its title, name or alias.
 *
 * A multi-word identity matches only when *all* its meaningful words are in the
 * question ("bishop pair", "weak square", "king and pawn"). A one-word identity
 * ("zugzwang", "kpk", "lucena") matches on its own. Nothing is matched from a
 * summary or detail paragraph, so prose words cannot smuggle in a book page.
 */
export function entryMentioned(e: KbEntry, query: string): boolean {
  const q = new Set(meaningfulTokens(query));
  if (q.size === 0) return false;
  for (const phrase of identityPhrases(e)) {
    const words = meaningfulTokens(phrase);
    if (words.length === 0) continue;
    if (words.length === 1) {
      if (words[0].length >= 3 && q.has(words[0])) return true;
    } else if (words.every((w) => q.has(w))) {
      return true;
    }
  }
  return false;
}

/** The subset of [entries] that the question explicitly names. */
export function mentionedEntries(entries: readonly KbEntry[], query: string): KbEntry[] {
  return entries.filter((e) => entryMentioned(e, query));
}

/**
 * In-memory inverted scoring index over the KB rows.
 *
 * Scoring (publication-grade retrieval without embeddings):
 *   full query == name/aka   120/100     tag exact 60   keyword exact 40
 *   name contains 35  aka contains 30    tag stem 25    keyword stem 20
 *   summary word 5    detail word 2      hook match 50 (per matched hook)
 */
export class KbIndex {
  private readonly entries: KbEntry[];
  private readonly indexed: Indexed[];
  private readonly byNameMap: Map<string, KbEntry>;

  constructor(entries: KbEntry[]) {
    this.entries = entries;
    this.byNameMap = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
    this.indexed = entries.map((e) => ({
      e,
      name: e.name.toLowerCase(),
      title: e.title.toLowerCase(),
      akas: e.aka.map((x) => x.toLowerCase()),
      tags: e.tags.map((x) => x.toLowerCase()),
      kws: e.keywords.map((x) => x.toLowerCase()),
      summaryWords: tokenize(e.summary),
      detailWords: tokenize(e.detail),
    }));
  }

  get size(): number {
    return this.entries.length;
  }

  byName(name: string): KbEntry | null {
    return this.byNameMap.get(name.trim().toLowerCase()) ?? null;
  }

  all(kinds: ReadonlySet<string> = ALL_KINDS): KbEntry[] {
    return this.entries.filter((e) => kinds.has(e.kind));
  }

  byHook(tokens: readonly string[], kinds: ReadonlySet<string> = ALL_KINDS, limit = 5): KbEntry[] {
    const want = new Set(tokens.map((t) => t.toLowerCase()));
    const hits: { e: KbEntry; score: number }[] = [];
    for (const ix of this.indexed) {
      if (!kinds.has(ix.e.kind)) continue;
      let overlap = 0;
      for (const h of ix.e.hooks) if (want.has(h.toLowerCase())) overlap += 1;
      if (overlap > 0) hits.push({ e: ix.e, score: overlap * 50 });
    }
    hits.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
    return hits.slice(0, limit).map((h) => h.e);
  }

  /**
   * Entries the student explicitly named, using only curated identity fields.
   *
   * This is the retrieval path for follow-up questions. `search` stays the
   * broader "anything related" probe used by the analyzer's material query; a
   * generic question such as "explain this position" must not pull arbitrary
   * endgames or concepts into a middlegame.
   */
  findMentioned(query: string, limit = 3): KbEntry[] {
    return this.entries.filter((e) => entryMentioned(e, query)).slice(0, limit);
  }

  search(query: string, kinds: ReadonlySet<string> = ALL_KINDS, limit = 5): KbEntry[] {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    const qtoks = [...tokenize(q)];
    if (qtoks.length === 0 && q.length < 2) return [];
    const hits: { e: KbEntry; score: number }[] = [];
    for (const ix of this.indexed) {
      if (!kinds.has(ix.e.kind)) continue;
      const s = this.score(ix, q, qtoks);
      if (s !== null) hits.push({ e: ix.e, score: s });
    }
    hits.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
    return hits.slice(0, limit).map((h) => h.e);
  }

  /**
   * Curated-vocabulary probe for the topic gate: true when a token matches a
   * row's name / aka / tags / keywords.
   *
   * `search` is built for RETRIEVAL and counts prose words from summaries and
   * details, which is exactly wrong for a yes/no gate: "how do I make pasta?"
   * scored a hit because a summary happened to use "make". Identity fields are
   * the curated chess vocabulary ("london" from london_system, "carlsbad",
   * "iqp"), so they prove chess intent without that leak. Substring matches on
   * names/akas need four letters — two-letter fragments like "am" live inside
   * "gambit" and would otherwise classify "I am hungry" as chess.
   */
  matchesCurated(tokens: readonly string[]): boolean {
    for (const ix of this.indexed) {
      for (const t of tokens) {
        if (t.length >= 4 && (ix.name.includes(t) || ix.akas.some((a) => a.includes(t)))) return true;
        if (ix.akas.includes(t)) return true;
        const st = stem(t);
        if (ix.tags.some((x) => x === t || stem(x) === st)) return true;
        if (ix.kws.some((x) => x === t || stem(x) === st)) return true;
      }
    }
    return false;
  }

  private score(ix: Indexed, fullQuery: string, qtoks: readonly string[]): number | null {
    let s = 0;
    if (fullQuery === ix.name) s += 120;
    if (ix.akas.includes(fullQuery)) s += 100;
    if (qtoks.length === 0) return s > 0 ? s : null;

    for (const t of qtoks) {
      if (ix.tags.includes(t)) s += 60;
      if (ix.kws.includes(t)) s += 40;
      if (ix.name.includes(t)) s += 35;
      if (ix.akas.some((a) => a === t || a.includes(t))) s += 30;
      const st = stem(t);
      if (st !== t) {
        if (ix.tags.some((x) => stem(x) === st)) s += 25;
        if (ix.kws.some((x) => stem(x) === st)) s += 20;
      }
      if (ix.summaryWords.has(st) || [...ix.summaryWords].some((x) => stem(x) === st)) s += 5;
      if (ix.detailWords.has(st) || [...ix.detailWords].some((x) => stem(x) === st)) s += 2;
    }
    return s > 0 ? s : null;
  }
}

/** JSON row shape as shipped in src/data/coach_kb.json. */
export interface KbRow {
  kind: string;
  name: string;
  title: string;
  aka: string[];
  eco: string;
  summary: string;
  detail: string;
  whitePlan: string;
  blackPlan: string;
  tags: string[];
  keywords: string[];
  hooks: string[];
  moves: string;
  fen: string;
  example: string;
}

export function kbFromRows(rows: readonly KbRow[]): KbIndex {
  return new KbIndex(rows.map((r, i) => ({ id: i + 1, ...r })));
}
