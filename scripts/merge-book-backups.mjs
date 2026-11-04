#!/usr/bin/env node
/**
 * MERGE A BOOK'S PRE-REGROUPING BACKUP INTO THE CURRENT BOOK, KEEPING THE NEW CHAPTERS.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two shipped books carry a `.json.bak` beside them, produced by the SAME generation run as the live
 * file - `generatedAt` and `source` are identical to the millisecond. They are the output of the
 * generator before a regrouping pass that split one flat chapter into three themed ones:
 *
 *     grunfeld-defense        1 chapter, 9 studies, 45 distinct lines   (.bak)
 *                              3 chapters, 9 studies, 31 distinct lines  (current)
 *     queens-gambit-accepted  1 chapter, 7 studies, 36 distinct lines   (.bak)
 *                              3 chapters, 7 studies, 36 distinct lines  (current)
 *
 * So the regrouping is worth keeping - three themed chapters read better in a course than one chapter
 * of nine studies - and for the Queen's Gambit Accepted it cost nothing at all. The Grünfeld lost 14
 * distinct lines, and the shape of the loss is the tell: EVERY study in the regrouped file has exactly
 * 4 lines, where the backup has 5, 5, 5, 5, 5, 4, 6, 5, 5. A uniform 4 is a cap, not a count, and the
 * lines it removed were the long ones - 30 to 43 plies against a 30-ply spine.
 *
 * Everything in both files is legal chess; that was checked with chess.js and it is NOT the problem here.
 * (An earlier reading of `Be3 cxd4 cxd4` as an illegal double capture was wrong - the first `cxd4` is
 * Black recapturing and the second is White taking on d4.)
 *
 * WHAT IT DOES
 * ------------
 * Takes the STUDY TREES from the backup - the content that was lost - and the CHAPTER STRUCTURE from
 * the current file - the improvement that was kept. Then recomputes every count that moved, because a
 * book that says `lines: 36` and holds 45 is a lie the course screen would repeat in its header.
 *
 * It refuses rather than guesses. If a study in the current file has no counterpart in the backup, or
 * the two disagree about which studies exist, it stops: this is a repair tool, and a repair tool that
 * half-succeeds is worse than one that stops.
 *
 * Usage:  node scripts/merge-book-backups.mjs [--check]
 *           --check  report what would change and exit without writing
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'src', 'data');

/** The books that have a pre-regrouping backup beside them. */
const TARGETS = ['grunfeld-defense', 'queens-gambit-accepted'];

/* -------------------------------------------------------------------------- */

/** Every distinct line a study contains, using the same walk the app uses. */
export function studyLines(study) {
  const lines = [];
  const nestedLines = (vari, prefix) => {
    const out = [];
    for (let i = 0; i < vari.length; i += 1) {
      for (const sub of vari[i].variations ?? []) {
        const base = [...prefix, ...vari.slice(0, i).map((m) => m.san)];
        out.push([...base, ...sub.map((m) => m.san)]);
        out.push(...nestedLines(sub, base));
      }
    }
    return out;
  };
  const walk = (idx, prefix) => {
    if (idx >= study.tree.length) { if (prefix.length) lines.push(prefix); return; }
    const node = study.tree[idx];
    walk(idx + 1, [...prefix, node.san]);
    for (const vari of node.variations ?? []) {
      lines.push([...prefix, ...vari.map((m) => m.san)]);
      lines.push(...nestedLines(vari, prefix));
    }
  };
  walk(0, []);
  return lines;
}

/** The distinct line count of a whole book, which is what `stats.lines` means. */
export function bookLines(book) {
  const set = new Set();
  for (const ch of book.chapters) {
    for (const st of ch.studies ?? []) {
      for (const seq of studyLines(st)) set.add(seq.join(' '));
    }
  }
  return set;
}

/* -------------------------------------------------------------------------- */

function mergeOne(name, checkOnly) {
  const livePath = path.join(DATA, `${name}.json`);
  const bakPath = path.join(DATA, `${name}.json.bak`);
  if (!fs.existsSync(bakPath)) return { name, skipped: 'no backup' };

  const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  const bak = JSON.parse(fs.readFileSync(bakPath, 'utf8'));

  const bakById = new Map();
  for (const ch of bak.chapters) for (const st of ch.studies ?? []) bakById.set(st.id, st);

  const liveIds = [];
  for (const ch of live.chapters) for (const st of ch.studies ?? []) liveIds.push(st.id);

  // REFUSE RATHER THAN GUESS.
  const missing = liveIds.filter((id) => !bakById.has(id));
  if (missing.length) {
    throw new Error(`${name}: no backup for ${missing.join(', ')} - refusing to guess at the content`);
  }
  const extra = [...bakById.keys()].filter((id) => !liveIds.includes(id));
  if (extra.length) {
    throw new Error(`${name}: the backup has studies the live book does not (${extra.join(', ')}); `
      + 'a study appearing or disappearing is a content change, not a regrouping');
  }

  const before = bookLines(live).size;
  const after = new Set();
  let restored = 0;

  const merged = {
    ...live,
    chapters: live.chapters.map((ch) => ({
      ...ch,
      studies: (ch.studies ?? []).map((st) => {
        const src = bakById.get(st.id);
        const out = {
          ...src,
          // The chapter title is the CURRENT one: that is the regrouping being kept.
          chapter: ch.title,
          title: st.title,
          type: st.type,
          // Counts are recomputed below, never carried over from either side.
          lineCount: 0,
        };
        const lines = studyLines(out);
        out.lineCount = new Set(lines.map((l) => l.join(' '))).size;
        if (out.lineCount < st.lineCount) {
          throw new Error(`${name}/${st.id}: the backup holds FEWER lines (${out.lineCount}) than the `
            + `live book (${st.lineCount}); merging would lose content, not restore it`);
        }
        if (out.lineCount > st.lineCount) restored += out.lineCount - st.lineCount;
        for (const l of lines) after.add(l.join(' '));
        return out;
      }),
    })),
  };

  const studyCount = merged.chapters.reduce((a, c) => a + (c.studies ?? []).length, 0);
  merged.stats = { chapters: merged.chapters.length, studies: studyCount, lines: after.size };

  const text = `${JSON.stringify(merged, null, 2)}\n`;
  const report = {
    name,
    chapters: `${bak.chapters.length} -> ${merged.chapters.length}`,
    studies: studyCount,
    lines: `${before} -> ${after.size}`,
    restored,
  };
  if (!checkOnly && text !== fs.readFileSync(livePath, 'utf8')) fs.writeFileSync(livePath, text);
  return report;
}

/* -------------------------------------------------------------------------- */

const checkOnly = process.argv.includes('--check');
const reports = [];
for (const name of TARGETS) {
  try {
    reports.push(mergeOne(name, checkOnly));
  } catch (e) {
    console.error(`  ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}
for (const r of reports) {
  if (r.skipped) { console.log(`  ${r.name}: ${r.skipped}`); continue; }
  console.log(`  ${r.name.padEnd(24)} chapters ${r.chapters.padEnd(12)} `
    + `studies ${String(r.studies).padEnd(3)} lines ${r.lines.padEnd(12)} restored ${r.restored}`);
}
console.log(checkOnly ? '  (check only - nothing written)' : '  written');