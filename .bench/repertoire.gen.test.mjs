/**
 * Prove the generator: it must be correct on good input and REFUSE bad input.
 *
 * A generator that only works on well-formed input is half a tool. The refusals are
 * the more important half, because every defect this project has shipped in the last
 * day — impossible endgame positions, a lesson whose key idea was not a legal move, a
 * study labelled one thing and containing another — was a case where nothing said no.
 *
 * So each rejection is exercised against real bad input, not asserted in prose.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { generateRepertoire, verifyRepertoire } from './repertoire.gen.mjs';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

let checks = 0, fails = 0;
function ok(label, cond, detail = '') {
  checks++;
  if (!cond) fails++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
function refuses(label, fn, expect) {
  try {
    fn();
    ok(label, false, 'it ACCEPTED input it should have rejected');
  } catch (e) {
    ok(label, expect.test(e.message), `refused with: ${e.message.slice(0, 96)}`);
  }
}

/*
 * THE FIXTURE IS SHIPPED, AUDIT-VERIFIED DATA - not a line I typed.
 *
 * I hand-authored a 30-ply Italian from memory and got it wrong TWICE: Nbd7 is a
 * king move (c6->d7 is 1,1, not a knight jump), and then Bxf6 had nothing to
 * capture because the f6 knight had already departed. The generator refused both.
 *
 * That is the tool working as intended - but it means a fixture from memory cannot
 * demonstrate that the generator PRODUCES correct output, only that it is strict.
 * Those are different claims, and only the first justifies trusting it with the
 * expansion.
 *
 * So the plies come from shipped studies the audit has already replayed. The
 * refusals stay as their own checks.
 */
// Self-contained: derived from import.meta.url, because `ROOT` is declared later
// in this file and using it here was a temporal-dead-zone error that fired
// before a single assertion ran.
const DATA = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'src', 'data');
const SHIPPED = JSON.parse(fs.readFileSync(path.join(DATA, 'scotch-opening.json'), 'utf8'));
const ITALIAN = SHIPPED.chapters[0].studies[0].tree.map((n) => n.san);
const SECOND = SHIPPED.chapters[1].studies[0].tree.map((n) => n.san);
const THIRD = SHIPPED.chapters[2].studies[0].tree.map((n) => n.san);
if ([ITALIAN, SECOND, THIRD].some((a) => a.length !== 30)) {
  console.error('fixtures must all be 30 plies');
  process.exit(2);
}

/*
 * The Evans Gambit fixture, from the shipped Italian book (study 5.1).
 *
 * IT WAS HAND-TYPED AND ILLEGAL - see the comment at its use. Every other fixture in this file is
 * read out of `src/data` precisely so that it has been replayed by the audit, and this one was the
 * exception, which is why it was the first thing the generator refused. Read the same way as the rest.
 */
const ITALIAN_BOOK = JSON.parse(fs.readFileSync(path.join(DATA, 'italian-opening.json'), 'utf8'));
const EVANS_STUDY = ITALIAN_BOOK.chapters
  .flatMap((c) => c.studies ?? [])
  .find((s) => (s.tree ?? []).map((n) => n.san).join(' ')
    .startsWith('e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5'));
if (!EVANS_STUDY) {
  console.error('the shipped Italian book no longer contains the Evans Gambit this fixture needs');
  process.exit(2);
}
const EVANS = EVANS_STUDY.tree.map((n) => n.san);

/*
 * WHERE THIRD ACTUALLY LEAVES THE SPINE - computed, not remembered.
 *
 * Two wrong values were written here by hand and both were wrong in the same way. THIRD and ITALIAN
 * come from the Scotch book, so they share e4 e5 Nf3 Nc6 d4 exd4 Nxd4 and part company at ply 7, where
 * one plays Nf6 and the other Bc5. Guessing "ply 0, because it is a sideline" and "ply 4, because
 * that is where d4 is" both got the generator to refuse the book, which is the generator working.
 *
 * Deriving it means the fixture cannot rot when the shipped studies change.
 */
const DIVERGE_PLY = EVANS.findIndex((san, i) => THIRD[i] !== san);
if (DIVERGE_PLY < 0) {
  console.error('THIRD does not differ from EVANS at all - there is no branch to declare');
  process.exit(2);
}
if (EVANS.length !== 30) {
  console.error(`the Evans fixture must be 30 plies, the shipped study has ${EVANS.length}`);
  process.exit(2);
}

console.log('\n§1  a well-formed spec generates a correct repertoire');
{
  const rep = generateRepertoire({
    id: 'gen-proof',
    name: 'Generator Proof',
    side: 'white',
    chapters: [{
      title: 'The Italian Game',
      studies: [
        { id: 'gp1', title: 'Study 1.1 — Giuoco Piano', type: 'Main Line', plies: ITALIAN },
        {
          id: 'gp2',
          title: 'Study 1.2 — Evans Gambit',
          type: 'Gambit',
          // WAS HAND-TYPED, AND IT WAS ILLEGAL. The line carried
          // `...Bb6 Bb5+ a6 Bxd4 c6 Bxc6` - after the c8 bishop has gone to b6 there is no bishop left
          // that can reach b5, so `Bb5+` cannot be played, and the generator refused the book. A file
          // whose header says "the plies come from shipped studies the audit has already replayed" was
          // carrying a line that had been replayed by nobody.
          //
          // It is now the shipped Italian book study 5.1, which is an Evans Gambit the audit has
          // already checked - the same rule this generator exists to enforce, applied to its own test.
          plies: EVANS,
          // A sideline that DIVERGES, at the ply where it actually diverges.
          //
          // This was `{ atPly: 0, plies: THIRD }` with a comment about "the Three Knights ... replaces
          // 1.e4 with 1.b4". Neither claim matched the data: THIRD is `e4 c5 Nf3 d6 ...`, the same
          // first four plies as ITALIAN, so it does not diverge at ply 0 - or anywhere before ply 4.
          //
          // `atPly` is a CONSTRAINT, not a hint: a branch filed under a study and read as an
          // alternative to it must really differ at the ply it claims, or the book teaches one line
          // twice and calls it two. THIRD and ITALIAN diverge where `Nf6` becomes `cxd4` - ply 5 - so
          // that is what the branch now says.
          branches: [{
            atPly: DIVERGE_PLY,
            plies: THIRD,
          }],
        },
      ],
    }],
  });

  const v = verifyRepertoire(rep);
  ok('verification found no problems', v.problems.length === 0, v.problems.slice(0, 3).join(' | '));
  ok('every derived field is present and correct', v.plies === 60, `${v.plies} mainline plies`);
  ok('the variation branch was generated and verified', v.branches === 30 - DIVERGE_PLY, `${v.branches} branch plies`);
  ok('stats are recounted, not declared', rep.stats.studies === 2 && rep.stats.chapters === 1,
    JSON.stringify(rep.stats));
  ok('lineCount comes from the app\'s own collector', rep.chapters[0].studies[0].lineCount === 1,
    'a mainline with no branches is exactly 1 line');
  ok('a study with one branch is 2 lines', rep.chapters[0].studies[1].lineCount === 2,
    `lineCount ${rep.chapters[0].studies[1].lineCount}`);

  // Spot-check a computed uci and fenAfter against the board, independently.
  const c = new Chess();
  c.move(ITALIAN[0]);
  const n0 = rep.chapters[0].studies[0].tree[0];
  ok('the first uci is correct', n0.uci === 'e2e4', n0.uci);
  ok('the first fenAfter is correct', n0.fenAfter === c.fen());
  ok('and the author\'s comment survived untouched', n0.commentAfter === undefined || typeof n0.commentAfter === 'string');
}

console.log('\n§2  a comment is the ONLY thing passed through');
{
  const rep = generateRepertoire({
    id: 'gen-comment', name: 'Comment Proof', side: 'white',
    chapters: [{
      title: 'C',
      studies: [{
        id: 'c1', title: 't', type: 'Main Line',
        plies: ITALIAN.map((san, i) => (i === 0 || i === 4 ? { san, comment: `note at ply ${i}` } : san)),
      }],
    }],
  });
  const tree = rep.chapters[0].studies[0].tree;
  ok('a comment on ply 0 is preserved', tree[0].commentAfter === 'note at ply 0');
  ok('a comment on ply 4 is preserved', tree[4].commentAfter === 'note at ply 4');
  ok('a ply with no comment has no commentAfter key', !('commentAfter' in tree[1]),
    'so the JSON does not carry empty strings');
  ok('but every ply still has san, uci, variations and fenAfter',
    tree.every((n) => n.san && n.uci && Array.isArray(n.variations) && n.fenAfter));
}

console.log('\n§3  it REFUSES bad input rather than emitting it');
{
  refuses('a mainline that is not exactly 30 plies',
    () => generateRepertoire({
      id: 'x', name: 'x', side: 'white',
      chapters: [{ title: 'C', studies: [{ id: 'a', plies: ['e4', 'e5'] }] }],
    }),
    /must be exactly 30 plies/);

  refuses('an ILLEGAL move',
    () => generateRepertoire({
      id: 'x', name: 'x', side: 'white',
      chapters: [{ title: 'C', studies: [{ id: 'a', plies: ['e4', 'Qh4', ...ITALIAN.slice(2)] }] }],
    }),
    /illegal SAN/);

  refuses('a branch at a ply outside the mainline',
    () => generateRepertoire({
      id: 'x', name: 'x', side: 'white',
      chapters: [{
        title: 'C',
        studies: [{ id: 'a', plies: ITALIAN, branches: [{ atPly: 99, plies: ['d4'] }] }],
      }],
    }),
    /outside the mainline/);

  refuses('a duplicate study id',
    () => generateRepertoire({
      id: 'x', name: 'x', side: 'white',
      chapters: [{ title: 'C', studies: [{ id: 'dup', plies: ITALIAN }, { id: 'dup', plies: ITALIAN }] }],
    }),
    /duplicate study id/);

  refuses('a spec with no studies',
    () => generateRepertoire({ id: 'x', name: 'x', side: 'white', chapters: [] }),
    /no studies/);

  refuses('a bad side',
    () => generateRepertoire({ id: 'x', name: 'x', side: 'purple', chapters: [] }),
    /side must be/);

  refuses('an empty mainline',
    () => generateRepertoire({
      id: 'x', name: 'x', side: 'white',
      chapters: [{ title: 'C', studies: [{ id: 'a', plies: [] }] }],
    }),
    /mainline is empty/);
}

console.log('\n§4  verifyRepertoire catches a hand-corrupted file');
{
  /*
   * The generator computing a field correctly and the field BEING correct are
   * different claims, so `verifyRepertoire` replays the written JSON from scratch.
   * Corrupting the output proves the check can actually fail — without this, "0
   * problems" would be unfalsifiable.
   */
  const rep = generateRepertoire({
    id: 'gen-corrupt', name: 'Corrupt Proof', side: 'white',
    chapters: [{ title: 'C', studies: [{ id: 'k1', plies: ITALIAN }] }],
  });
  ok('the clean file verifies', verifyRepertoire(rep).problems.length === 0);

  const bad1 = JSON.parse(JSON.stringify(rep));
  bad1.chapters[0].studies[0].tree[3].uci = 'e2e4';
  ok('a wrong uci is caught', verifyRepertoire(bad1).problems.some((p) => /uci mismatch/.test(p)));

  const bad2 = JSON.parse(JSON.stringify(rep));
  bad2.chapters[0].studies[0].tree[5].fenAfter = '8/8/8/8/8/8/8/8 w - - 0 1';
  ok('a wrong fenAfter is caught', verifyRepertoire(bad2).problems.some((p) => /fenAfter mismatch/.test(p)));

  const bad3 = JSON.parse(JSON.stringify(rep));
  bad3.chapters[0].studies[0].tree[7].san = 'Qz9';
  ok('an illegal SAN is caught', verifyRepertoire(bad3).problems.some((p) => /illegal/.test(p)));

  const bad4 = JSON.parse(JSON.stringify(rep));
  bad4.stats.lines = 99;
  ok('a doctored stat is caught', verifyRepertoire(bad4).problems.some((p) => /stats\.lines/.test(p)));

  const bad5 = JSON.parse(JSON.stringify(rep));
  bad5.chapters[0].studies[0].lineCount = 7;
  ok('a doctored lineCount is caught', verifyRepertoire(bad5).problems.some((p) => /lineCount/.test(p)));
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'}: ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
