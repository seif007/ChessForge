/**
 * The chess-only gate: the coach must answer chess questions and apologize for
 * everything else. Applied BEFORE any narrator (template or LLM) is asked, so
 * an off-topic question never reaches the model at all; the LLM system prompt
 * carries the same rule as a second line of defence.
 *
 * Design bias: false NEGATIVES (rejecting a real chess question) are worse
 * than false positives, so short conversational follow-ups are allowed and a
 * knowledge-base hit is treated as proof of chess intent.
 */

import { KbIndex, stem } from './kb';

const CHESS_TERMS = new Set<string>([
  // pieces & board
  'pawn', 'knight', 'bishop', 'rook', 'queen', 'king', 'piece', 'board', 'square', 'centre', 'center',
  'castle', 'castling', 'castle', 'file', 'rank', 'diagonal', 'wing', 'kingside', 'queenside', 'move',
  // rules & results
  'check', 'checkmate', 'mate', 'stalemate', 'draw', 'win', 'loss', 'winning', 'losing', 'equal',
  'promotion', 'promote', 'en', 'passant', 'fifty',
  // tactics
  'tactic', 'fork', 'pin', 'skewer', 'discovered', 'double', 'sacrifice', 'gambit', 'combination',
  'threat', 'trap', 'exchange', 'material', 'invasion', 'seventh',
  // strategy & structure
  'strategy', 'positional', 'structure', 'outpost', 'hole', 'weak', 'island', 'isolated', 'doubled',
  'backward', 'passed', 'majority', 'minority', 'blockade', 'space', 'development', 'tempo',
  'initiative', 'safety', 'shield', 'prophylaxis', 'plan', 'advantage', 'attack', 'defence', 'defense',
  // phases & openings
  'opening', 'middlegame', 'endgame', 'repertoire', 'line', 'variation', 'transposition', 'fianchetto',
  // endgames
  'zugzwang', 'opposition', 'triangulation', 'fortress', 'lucena', 'philidor', 'passer',
  // evaluation & review
  'evaluation', 'eval', 'centipawn', 'accuracy', 'blunder', 'mistake', 'inaccuracy', 'brilliant',
  'best', 'excellent', 'good', 'book', 'review', 'analyse', 'analyze', 'analysis',
  // training vocabulary
  'puzzle', 'tactic', 'drill', 'train', 'practice', 'coach', 'game', 'match', 'player', 'opponent',
]);

const SQUARE_RE = /\b[a-h][1-8]\b/;
const FOLLOW_UP_RE = /^(why|how|what|and|but|ok|okay|is|it|does|did|can|should|would|could|explain|more|continue|tell)\b/;
/** Words that point at the board in front of the student ("here", "that move", "now"). */
const POSITIONAL_RE = /\b(here|there|this|that|these|those|now|next|instead|better)\b/;

/*
 * Stopwords were a real leak: "what is the capital of France?" scored a KB hit
 * because the token "of" appears in hundreds of summaries, so ANY sentence used
 * to look chess-related. Retrieval only counts CONTENT words now.
 */
const STOP = new Set<string>([
  'the', 'a', 'an', 'of', 'is', 'are', 'was', 'were', 'to', 'in', 'on', 'at', 'for', 'my', 'me',
  'i', 'you', 'it', 'this', 'that', 'these', 'those', 'and', 'or', 'do', 'does', 'did', 'be',
  'with', 'about', 'what', 'why', 'how', 'can', 'could', 'should', 'would', 'will', 'not', 'no',
  'yes', 'but', 'if', 'then', 'than', 'so', 'as', 'we', 'he', 'she', 'they', 'them', 'his', 'her',
  'their', 'our', 'your', 'from', 'by', 'up', 'down', 'here', 'there', 'now', 'just', 'very',
  'really', 'more', 'most', 'some', 'any', 'all', 'one', 'two', 'three', 'please', 'tell',
  'explain', 'help', 'want', 'need', 'know', 'think', 'say', 'give', 'show', 'again', 'too',
  'also', 'when', 'where', 'which', 'who', 'whom', 'whose',
]);

/** True when [question] is plausibly about chess (or a follow-up to one that was). */
export function isChessRelated(question: string, kb: KbIndex): boolean {
  const q = question.trim().toLowerCase();
  if (q.length === 0) return true;
  if (SQUARE_RE.test(q)) return true;
  const words = q.split(/[^a-z0-9']+/).filter((w) => w.length > 0);
  if (words.some((w) => CHESS_TERMS.has(w) || CHESS_TERMS.has(stem(w)))) return true;
  const content = words.filter((w) => !STOP.has(w));
  /*
   * A question that echoes a row's curated vocabulary ("the London System",
   * "Caro-Kann", "Carlsbad") is chess. PROSE is deliberately not consulted:
   * the previous `kb.search` probe matched summary words like "make" and
   * classified "how do I make pasta?" as chess.
   */
  if (content.length >= 1 && kb.matchesCurated(content)) return true;
  // "why?", "and then?", "explain that" — a conversation about the board stays open.
  if (words.length <= 4 && FOLLOW_UP_RE.test(q)) return true;
  /*
   * "What should I aim for here?" / "What do I do now?" — full questions whose
   * only non-stopword content is an abstraction ("aim") plus a pointer at the
   * shown board. Requiring the pointer keeps "what is the capital of France?"
   * (also six words, no board reference) out.
   */
  if (words.length <= 8 && FOLLOW_UP_RE.test(q) && POSITIONAL_RE.test(q)) return true;
  return false;
}

export const CHESS_ONLY_APOLOGY =
  "I'm your chess coach, so I can only help with chess — positions, plans, mistakes, openings and endgames. "
  + "Ask me anything about the game and I'll explain!";
