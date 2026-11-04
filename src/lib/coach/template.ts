/**
 * Narrator contract + the deterministic template narrator.
 * Port of the prototype's `CoachNarrator.kt` (TemplateNarrator part).
 *
 * The template narrator is the offline default and the fallback whenever an
 * LLM draft fails the grounding guard. It only ever arranges the grounded
 * facts and KB excerpts — it cannot invent chess content.
 */

import { GroundedContext } from './facts';
import { FactFactory } from './facts';
import { mentionedEntries } from './kb';
import { CoachMoveReview } from './review';

export type ChatHistory = readonly (readonly [string, string])[];

export interface CoachNarrator {
  /** Human-readable tier name, surfaced in the coach UI. */
  readonly name: string;
  explainMove(ctx: GroundedContext, mr: CoachMoveReview): Promise<string>;
  explainPosition(ctx: GroundedContext): Promise<string>;
  /** Explain the engine's recommended move in this position. */
  explainHint(ctx: GroundedContext, san: string): Promise<string>;
  /** Whole-game walkthrough (facts from `forGame`). */
  explainGame(ctx: GroundedContext): Promise<string>;
  answer(ctx: GroundedContext, question: string, history?: ChatHistory): Promise<string>;
}

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0].toLowerCase() + s.slice(1);
}

/** Deterministic template narration built strictly from the grounded facts and KB excerpts. */
export const TemplateNarrator: CoachNarrator = {
  name: 'Rulebook (offline)',

  async explainMove(ctx: GroundedContext, mr: CoachMoveReview): Promise<string> {
    const paras: string[] = [];

    const num = mr.moveNumber;
    const label = mr.moverIsWhite ? `${num}.${mr.san}` : `${num}...${mr.san}`;
    const grade = FactFactory.gradeWord(mr.grade);
    const head = mr.grade === 'best' || mr.grade === 'excellent'
      ? `${label} is ${grade}.`
      : `${label} was ${grade}.`;
    paras.push(head);

    const evalFact = ctx.facts.find((f) => f.kind === 'eval');
    if (evalFact) paras.push(`What happened: ${lowerFirst(evalFact.text.replace('Engine grade: ', ''))}`);
    const bestFact = ctx.facts.find((f) => f.kind === 'best');
    if (bestFact) paras.push(`Better plan: ${bestFact.text.replace('Engine preferred ', '')}`);

    const posKinds = new Set(['phase', 'material', 'structure', 'holes', 'outposts', 'colour', 'king', 'loose', 'passed', 'development']);
    const posBits = ctx.facts.filter((f) => posKinds.has(f.kind)).slice(0, 5);
    if (posBits.length > 0) paras.push(`Position now: ${posBits.map((f) => f.text).join(' ')}`);

    const teaching = teachingBlock(ctx);
    if (teaching !== null) paras.push(teaching);

    return paras.join('\n\n');
  },

  async explainPosition(ctx: GroundedContext): Promise<string> {
    const paras: string[] = [];
    const overview = ctx.facts.filter((f) => f.kind === 'phase' || f.kind === 'material').map((f) => f.text).join(' ');
    if (overview.length > 0) paras.push(overview);

    /*
     * A PASSED PAWN IS A STRUCTURAL FACT AND BELONGS IN THE STRUCTURE LINE.
     *
     * The line was cut at four facts, and a position with several structure
     * facts and a passed pawn lost the passed pawn — the single most
     * actionable thing on the board. Six is enough for the facts that exist
     * without turning the line into a paragraph.
     */
    const structure = ctx.facts.filter((f) => f.kind === 'structure' || f.kind === 'passed').slice(0, 6).map((f) => f.text).join(' ');
    if (structure.length > 0) paras.push(`Structure: ${structure}`);

    const featureKinds = new Set(['holes', 'outposts', 'colour', 'king', 'loose', 'rooks', 'development']);
    const features = ctx.facts.filter((f) => featureKinds.has(f.kind)).slice(0, 4).map((f) => f.text).join(' ');
    if (features.length > 0) paras.push(`What matters: ${features}`);

    const plan = planBlock(ctx);
    if (plan !== null) paras.push(plan);
    else {
      const teaching = teachingBlock(ctx);
      if (teaching !== null) paras.push(teaching);
    }

    return paras.join('\n\n');
  },

  /**
   * The engine has already picked the move (it is the ground truth); this only
   * arranges what is verified about the position around it. It never claims an
   * evaluation the facts do not contain.
   */
  async explainHint(ctx: GroundedContext, san: string): Promise<string> {
    const paras: string[] = [`The engine's move here is ${san}.`];

    const kindOrder = ['structure', 'holes', 'outposts', 'colour', 'king', 'loose', 'passed', 'development'];
    const bits: string[] = [];
    for (const kind of kindOrder) {
      const f = ctx.facts.find((x) => x.kind === kind);
      if (f) bits.push(lowerFirst(f.text));
      if (bits.length >= 3) break;
    }
    if (bits.length > 0) paras.push(`What the position says: ${bits.join(' ')}`);

    const plan = planBlock(ctx);
    if (plan !== null) paras.push(plan);
    else {
      const teaching = teachingBlock(ctx);
      if (teaching !== null) paras.push(teaching);
    }

    return paras.join('\n\n');
  },

  async explainGame(ctx: GroundedContext): Promise<string> {
    const paras: string[] = [];

    const brief = ctx.facts.filter((f) => f.kind === 'game-summary').map((f) => f.text).join(' ');
    if (brief.length > 0) paras.push(`The game in brief: ${brief}`);

    const keys = ctx.facts.filter((f) => f.kind === 'game-key');
    if (keys.length > 0) paras.push(`Turning points:\n${keys.map((f) => `- ${f.text}`).join('\n')}`);

    const finalKinds = new Set(['phase', 'material', 'structure', 'passed', 'holes', 'outposts', 'colour', 'king', 'loose', 'rooks']);
    const finalBits = ctx.facts.filter((f) => finalKinds.has(f.kind)).slice(0, 4).map((f) => f.text).join(' ');
    if (finalBits.length > 0) paras.push(`Where the game ended: ${finalBits}`);

    const plan = planBlock(ctx);
    if (plan !== null) paras.push(plan);
    else {
      const teaching = teachingBlock(ctx);
      if (teaching !== null) paras.push(teaching);
    }

    return paras.join('\n\n');
  },

  async answer(ctx: GroundedContext, question: string, history: ChatHistory = []): Promise<string> {
    void history;
    const q = question.toLowerCase();

    /*
     * ANSWER THE QUESTION THAT WAS ASKED, FROM THIS BOARD.
     *
     * The old template ended every answer with the first two `kbHits` under
     * "From the coach's book", whatever the question. In a queen/rook
     * middlegame with one bishop each it printed the bishop-pair and
     * King-and-pawn-vs-king pages because a broad retrieval had put them in
     * the context. Those pages were neither asked for nor true here. The
     * branches below use only position facts (and explicitly named entries),
     * and the generic branch explains the actual position instead of printing
     * an unrelated book page.
     */
    if (isPositionQuestion(q)) return TemplateNarrator.explainPosition(ctx);
    if (isPlanQuestion(q)) return planAnswer(ctx);
    if (/\b(weak squares?|holes?)\b/.test(q)) return weakSquareAnswer(ctx);
    if (/\b(last move|what was played|moves played|move history|opening moves)\b/.test(q)) {
      const context = ctx.facts.find((f) => f.kind === 'game-context');
      return context
        ? context.text
        : 'I do not have the game history for this position — ask me about the board instead.';
    }

    const parts: string[] = [];
    const facts = relevantFacts(ctx, question).slice(0, 2);
    if (facts.length > 0) parts.push(`From this position: ${facts.map((f) => f.text).join(' ')}`);

    /*
     * Only pages the student explicitly named. `mentionedEntries` uses
     * title/name/aka, never summary prose, so "explain this position" cannot
     * mean "bishop pair" just because both contain the word "position".
     */
    const named = mentionedEntries(ctx.kbHits, question).slice(0, 2);
    if (named.length > 0) {
      const lines: string[] = ["From the coach's book:"];
      for (const e of named) {
        let line = `- ${e.title}: ${e.summary}`;
        const plan = ctx.stm === 0 ? e.whitePlan : e.blackPlan;
        if (plan.length > 0) line += ` Plan: ${plan}.`;
        lines.push(line);
      }
      parts.push(lines.join('\n'));
      /*
       * A CONCEPT THE STUDENT ASKED FOR IS NOT A CLAIM ABOUT THE BOARD.
       *
       * "What is the bishop pair?" deserves the definition, and the guard
       * allows it because the student named the concept. But the definition
       * must not be read as a claim that THIS position has one: in a K+P
       * ending or a queen-against-rook ending, nobody has the pair, and the
       * answer has to say so. The analyzer knows who owns it, so the answer
       * says it in one line instead of leaving the student to guess.
       */
      const pair = named.find((e) => e.name === 'bishop_pair');
      if (pair) parts.push(bishopPairStatus(ctx));
    }

    if (parts.length === 0) {
      // No named concept and no fact matched the wording. The honest answer is
      // the verified position, not the first two rows of the book.
      return TemplateNarrator.explainPosition(ctx);
    }
    return parts.join('\n\n');
  },
};

/**
 * What the bishop pair means ON THIS BOARD.
 *
 * The student asked about the concept, so the definition is the answer. But a
 * definition is not a claim: if neither side has the pair here, the answer has
 * to say so, or the student carries away "we have the bishop pair" from a
 * position where nobody does.
 */
function bishopPairStatus(ctx: GroundedContext): string {
  switch (ctx.bishopPairState) {
    case 'white':
      return 'On this board White has the bishop pair.';
    case 'black':
      return 'On this board Black has the bishop pair.';
    case 'both':
      // Each side has two bishops, so neither has the ADVANTAGE of the pair.
      return 'On this board both sides have the two bishops, so the pair is no advantage to either of them.';
    default:
      return 'On this board neither side has the bishop pair — it is a concept, not a fact about this position.';
  }
}

/** "Explain this position" / "what is going on" -> the position narrator. */
function isPositionQuestion(q: string): boolean {
  if (/\bwhat(?:'s| is)\s+(?:going on|happening)\b/.test(q)) return true;
  if (/\b(?:position|board)\s+(?:explanation|overview|summary)\b/.test(q)) return true;
  return /\b(explain|describe|summari[sz]e|analy[sz]e|assess|review)\b/.test(q)
    && /\b(position|board)\b/.test(q);
}

function isPlanQuestion(q: string): boolean {
  return /\b(plan|ideas?|strategy|what should i do|what do i do|how do i proceed|what(?:'s| is) next)\b/.test(q);
}

/**
 * A plan from the position, not from a random opening page.
 *
 * If the analyzer detected a named structure, its plan is the best answer and
 * `planBlock` supplies it verbatim. Otherwise the verified structure and
 * features are arranged into a side-to-move plan. No concrete move is invented:
 * the guard would reject one anyway, and a book line that does not fit the pawn
 * structure (the old "Rc1, b4 against c5" in a QGD position) is worse than no
 * line at all.
 */
function planAnswer(ctx: GroundedContext): string {
  const namedPlan = planBlock(ctx);
  if (namedPlan !== null) return namedPlan;

  const side = ctx.stm === 0 ? 'White' : 'Black';
  const them = ctx.stm ^ 1;

  /*
   * A PLAN HAS A DIRECTION: WHAT TO ATTACK, AND WHAT TO WATCH.
   *
   * The old answer listed the position's facts in whatever order the
   * analyzer produced them, so "Plan for White" was followed by Black's
   * isolated pawn, then a weakness in White's own camp, then a target in
   * Black's camp — all in one run, with nothing saying which was which. The
   * student had to work out that one of them was their problem and two
   * were their opportunities.
   *
   * The facts carry the side they are about, so the plan can say it: the
   * opponent's weaknesses come first, because they are what the plan is
   * FOR, and the mover's own weaknesses come last, as the thing to watch.
   */
  /*
   * A TARGET IS A WEAKNESS OF THE OPPONENT; A CAUTION IS A WEAKNESS OF YOURS.
   *
   * The facts carry the side they are about AND what they are: a hole in the
   * opponent's camp is something to attack, a hole in your own camp is
   * something to watch, an outpost is something to use, and a description of
   * the board (a majority, a named structure) is neither. Listing a majority
   * as a "target" taught that a majority was a weakness.
   */
  const targets = ctx.facts
    .filter((f) => f.side === them && f.role === 'weakness')
    .map((f) => f.text)
    .slice(0, 3);
  const assets = ctx.facts
    .filter((f) => f.side === ctx.stm && f.role === 'asset')
    .map((f) => f.text)
    .slice(0, 2);
  const cautions = ctx.facts
    .filter((f) => f.side === ctx.stm && f.role === 'weakness')
    .map((f) => f.text)
    .slice(0, 2);

  const bits: string[] = [];
  if (targets.length > 0) bits.push(`Your targets: ${joinWords(targets)}`);
  if (assets.length > 0) bits.push(`Use it: ${joinWords(assets)}`);
  if (cautions.length > 0) bits.push(`Watch out: ${joinWords(cautions)}`);

  if (bits.length === 0) {
    return `The verified position does not point to a concrete plan for ${side} here.`;
  }

  const teaching = teachingBlock(ctx);
  return `Plan for ${side}: ${bits.join(' ')}${teaching ? `\n\n${teaching}` : ''}`;
}

/**
 * "a; b; and c" for a list of sentences.
 *
 * The facts are full sentences, so the separator cannot be a comma and
 * cannot be a full stop followed by another full stop. The trailing stop of
 * each sentence is dropped and the list is re-punctuated.
 */
function joinWords(parts: readonly string[]): string {
  if (parts.length === 0) return '';
  const clauses = parts.map((p) => p.replace(/\.\s*$/, ''));
  if (clauses.length === 1) return `${clauses[0]}.`;
  return `${clauses.slice(0, -1).join('; ')}; and ${clauses[clauses.length - 1]}.`;
}

function weakSquareAnswer(ctx: GroundedContext): string {
  const facts = ctx.facts.filter((f) => f.kind === 'holes' || f.kind === 'outposts' || f.kind === 'colour')
    .slice(0, 4)
    .map((f) => f.text);
  if (facts.length === 0) {
    return 'The verified position does not flag a weak square or a hole here.';
  }
  return `Weak squares and holes: ${facts.join(' ')}`;
}

/**
 * The question words that can actually match a fact.
 *
 * "the" was in this set, and it is in every fact sentence, so EVERY question
 * matched every fact: "What is the bishop pair?" came back with "Black has
 * doubled pawns on the f-file" because both contain the word "the". The
 * words that carry no meaning of their own are excluded.
 */
const QUESTION_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'which', 'who', 'how', 'why',
  'are', 'was', 'were', 'has', 'have', 'had', 'been', 'being', 'does', 'did', 'you',
  'your', 'our', 'their', 'its', 'his', 'her', 'them', 'they', 'she', 'him',
  'from', 'into', 'about', 'tell', 'explain', 'describe', 'show', 'give', 'here',
]);

function relevantFacts(ctx: GroundedContext, question: string): typeof ctx.facts {
  const qWords = new Set(
    question.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 2 && !QUESTION_STOPWORDS.has(w)),
  );
  return ctx.facts
    .map((f) => [f, f.text.toLowerCase().split(/[^a-z0-9']+/).filter((w) => qWords.has(w)).length] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);
}

function teachingBlock(ctx: GroundedContext): string | null {
  const hits = ctx.kbHits;
  if (hits.length === 0) return null;
  /*
   * AN ENDING TEACHES ITS TECHNIQUE AND ONE RELATED PAGE.
   *
   * The ending's own page leads, because the analyzer chose it from the
   * material on the board. The related page is the one the ending's page
   * points at — the counting rule for a pawn race, the drawing resources for
   * a dead position — and NOT whatever else happened to be in the context,
   * which is how a king-and-pawn ending ended up quoting rook technique.
   */
  if (ctx.endgameLesson) {
    const { title, summary, related } = ctx.endgameLesson;
    let text = `Concept to remember - ${title}: ${summary}`;
    if (related) text += ` Related idea: ${related.title} (${related.summary})`;
    return text;
  }
  // Teach the idea class that matches the context: endgame technique when
  // we are in an endgame, otherwise the concept behind the position/mistake.
  const priority = ctx.phase === 'endgame' ? 'endgame' : 'concept';
  const first = hits.find((h) => h.kind === priority) ?? hits[0];
  let text = `Concept to remember - ${first.title}: ${first.summary}`;
  /*
   * The related idea must be the same KIND of thing. Falling back to any hit
   * dragged named openings into unrelated positions: the hint after 1.e4 e5
   * ended with "Related idea: Caro-Kann Defence", a line Black never played.
   * Teaching a concept alongside another concept is useful; teaching a random
   * opening name is noise and reads as a mistake.
   */
  const second = hits.find((h) => h !== first && h.kind === priority);
  if (second) text += ` Related idea: ${second.title} (${second.summary})`;
  return text;
}

function planBlock(ctx: GroundedContext): string | null {
  /*
   * AN ENDING IS TAUGHT BY ITS OWN TECHNIQUE.
   *
   * The ending's page is chosen by the material on the board, and its plan is
   * the one written for the side to move — the winning method for the side
   * that is trying, the holding method for the side that is defending. A
   * king-and-pawn ending answered with rook technique was the old failure.
   */
  if (ctx.endgameLesson) {
    const { title, plan } = ctx.endgameLesson;
    if (plan.length === 0) return null;
    const side = ctx.stm === 0 ? 'White' : 'Black';
    return `Coach's plan (${side}, from ${title}): ${plan}`;
  }

  // Only named structures (detector-verified via structure tags) earn a plan
  // block; generic openings cannot be matched to the student's position, so
  // those positions teach a concept instead.
  const structure = ctx.structureName
    ? ctx.kbHits.find((h) => h.name === ctx.structureName)
    : ctx.kbHits.find((h) => h.kind === 'structure');
  if (!structure) return null;
  /*
   * SOME PAGES ARE KEYED BY ROLE, NOT BY COLOUR.
   *
   * The isolated queen's pawn and the hanging pawns are weaknesses ONE side
   * holds and the OTHER attacks, so the two plans on those pages are the
   * attacker's and the defender's. Choosing by the side to move handed the
   * defender the attacker's plan — the side with the weak pawn was told to
   * attack it.
   */
  const roleAttacker = ctx.structureAttacker;
  const plan = roleAttacker === null
    ? (ctx.stm === 0 ? structure.whitePlan : structure.blackPlan)
    : (ctx.stm === roleAttacker ? structure.whitePlan : structure.blackPlan);
  if (plan.length === 0) return null;
  const side = ctx.stm === 0 ? 'White' : 'Black';
  return `Coach's plan (${side}, from ${structure.title}): ${plan}`;
}
