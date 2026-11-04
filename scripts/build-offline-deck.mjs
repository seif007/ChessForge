/*
 * Builds the bundled OFFLINE PUZZLE DECK for ChessForge from Lichess's public puzzle database.
 *
 * SOURCE: https://database.lichess.org/lichess_db_puzzle.csv.zst — the lichess puzzle database,
 * published CC0 (no attribution required; it is given in `src/lib/puzzlePool.ts` and here anyway).
 * A monthly 300 MB dump of ~5M puzzles. This script STREAMS it (zstd in, CSV out, one puzzle kept
 * every N rows), so it never holds the decompressed file in memory.
 *
 * WHY NOT THE PUZZLE API
 * ======================
 * The first version of this deck sampled `/api/puzzle/next` on the phone's behalf. Lichess rate
 * limits that endpoint hard for anonymous clients (it is built for "one puzzle now", not for
 * harvesting), and the run died in a 429 cooldown loop after 36 puzzles. The dump exists precisely
 * for this use: one download, no limits, the same CC0 content, and a far better sample.
 *
 * WHAT EACH ROW BECOMES
 * =====================
 * CSV columns: PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
 * Measured against real rows (see `rowToEntry`): the FEN is the position where the OPPONENT is to
 * blunder, and `Moves` begins with that blunder. The app serves the position AFTER it, with the
 * remaining moves as the solution — the same shape the live path reconstructs (`trimToPlayer`).
 * Every kept row is replayed move by move with chess.js here, so the shipped deck contains only
 * entries that are provably legal — the app re-verifies at runtime regardless (see
 * `src/lib/puzzlePool.ts`, rule 2).
 *
 * SAMPLING
 * ========
 * The dump is sorted by PuzzleId, which is random with respect to rating, so "every Nth row" is a
 * uniform random sample across the whole rating range — the property the offline pool needs most,
 * since it serves the nearest rating to whoever is holding the phone.
 *
 * Usage:  node scripts/build-offline-deck.mjs [dumpPath] [stride] [outPath]
 * Output: src/data/offline_deck.json   (written to `.partial` and renamed atomically)
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DUMP = process.argv[2]
  ?? path.join(process.env.TEMP ?? process.env.TMP ?? '.', 'opencode', 'lichess_db_puzzle.csv.zst');
const STRIDE = Number(process.argv[3] ?? 2500) || 2500;
const OUT = process.argv[4] ?? path.join(ROOT, 'src', 'data', 'offline_deck.json');
const TMP = `${OUT}.partial`;

if (!fs.existsSync(DUMP)) {
  console.error(`[deck] MISSING dump: ${DUMP}`);
  console.error('[deck] download it first:');
  console.error('[deck]   curl.exe -L -o "%TEMP%\\opencode\\lichess_db_puzzle.csv.zst" \\');
  console.error('[deck]     https://database.lichess.org/lichess_db_puzzle.csv.zst');
  process.exit(1);
}

/** Minimal CSV line parser: the dump quotes some fields, and one of them is free text. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Replay one CSV row into the compact deck entry, or null when it does not check out. */
function rowToEntry(row) {
  const [id, fen, moves, ratingStr, , , , themes] = row;
  if (!id || !fen || !moves) return null;
  const rating = Number(ratingStr);
  if (!Number.isFinite(rating)) return null;

  const uci = moves.trim().split(/\s+/).filter(Boolean);
  /*
   * THE CSV'S FIRST MOVE IS THE OPPONENT'S BLUNDER, NOT THE SOLUTION'S FIRST MOVE.
   *
   * Measured against real rows rather than assumed: `0000H` has FEN `... w - - 1 15` (White to
   * move) with moves `d1h5 d5g2`, and after `Qh5` Black plays `Qxg2#` — the mate. So the side to
   * move in the CSV's FEN is the side that BLUNDERS, the solver is the other side, and the solution
   * the app serves starts after that first move. The app's live path reconstructs exactly this
   * shape (`trimToPlayer` in `puzzleProvider.ts`), so the deck stores the position the SOLVER faces
   * — the one after the blunder — and the odd-length remainder as the solution.
   */
  if (uci.length < 2 || uci.length % 2 !== 0) return null; // blunder + an odd solver line

  let c;
  try {
    c = new Chess(fen);
  } catch {
    return null;
  }
  try {
    c.move({ from: uci[0].slice(0, 2), to: uci[0].slice(2, 4), promotion: uci[0].length > 4 ? uci[0][4] : undefined });
  } catch {
    return null;
  }
  const side = c.turn();
  const fenServed = c.fen();
  const solution = uci.slice(1);

  const sans = [];
  try {
    for (const m of solution) {
      const played = c.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m.length > 4 ? m[4] : undefined });
      sans.push(played.san);
    }
  } catch {
    return null;
  }
  if (sans.length === 0 || sans.length % 2 === 0) return null;
  return {
    id,
    fen: fenServed,
    side,
    uci: solution,
    san: sans,
    rating: Math.round(rating),
    themes: themes ? themes.trim().split(/\s+/).filter(Boolean).slice(0, 4) : [],
  };
}

console.log(`[deck] reading ${DUMP}`);
console.log(`[deck] keeping every ${STRIDE}th puzzle row -> ${OUT}`);

/**
 * The dump is a zstd stream with SKIPPABLE FRAMES between its 32 MiB sections, and Node's zstd
 * decoder does not implement skippable frames — it stops at the first one with "Unknown frame
 * descriptor" (measured: it decompressed exactly the first 33,554,432 bytes and then died). The
 * frames are dropped here instead: a skippable frame is magic `0x184D2A50..5F` (little-endian
 * `5? 2a 4d 18`), a 4-byte length, then that many bytes. A candidate counts as a frame only when
 * the bytes AFTER it are a regular zstd frame (`28 b5 2f fd`), which makes a chance match in
 * compressed data effectively impossible.
 */
function stripZstdSkippable() {
  const GUARD = 32; // bytes kept back: enough for a partial magic + length + next magic
  let buf = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _enc, cb) {
      buf = Buffer.concat([buf, chunk]);
      let i = 0;
      let safe = Math.max(0, buf.length - GUARD);
      for (;;) {
        if (i + 8 > buf.length - GUARD) break;
        const magic = buf.readUInt32LE(i);
        if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) {
          const size = buf.readUInt32LE(i + 4);
          const after = i + 8 + size;
          if (after + 4 > buf.length - GUARD) { safe = i; break; }
          const next = buf.readUInt32LE(after);
          if (next === 0xfd2fb528 || ((next & 0xfffffff0) >>> 0) === 0x184d2a50) {
            if (i > 0) this.push(buf.slice(0, i));
            buf = buf.slice(after);
            i = 0;
            safe = Math.max(0, buf.length - GUARD);
            continue;
          }
        }
        i += 1;
      }
      if (safe > 0) {
        this.push(buf.slice(0, safe));
        buf = buf.slice(safe);
      }
      cb();
    },
    flush(cb) {
      if (buf.length) this.push(buf);
      cb();
    },
  });
}

const deck = [];
let rows = 0;
let invalid = 0;

const input = fs.createReadStream(DUMP)
  .pipe(stripZstdSkippable())
  .pipe(zlib.createZstdDecompress());
const rl = readline.createInterface({ input, crlfDelay: Infinity });

for await (const raw of rl) {
  const line = raw.trim();
  if (!line || line.startsWith('PuzzleId,')) continue;
  rows++;
  if (rows % STRIDE !== 0) continue;
  const entry = rowToEntry(parseCsvLine(line));
  if (!entry) {
    invalid++;
    continue;
  }
  deck.push(entry);
  if (deck.length % 250 === 0) {
    console.log(`[deck] ${deck.length} kept · ${rows.toLocaleString()} rows read · ${invalid} rejected`);
  }
}

deck.sort((a, b) => a.rating - b.rating || a.id.localeCompare(b.id));
fs.writeFileSync(TMP, `${JSON.stringify(deck)}\n`);
fs.renameSync(TMP, OUT);

const bands = { '<800': 0, '800-1200': 0, '1200-1600': 0, '1600-2000': 0, '2000+': 0 };
for (const p of deck) {
  if (p.rating < 800) bands['<800']++;
  else if (p.rating < 1200) bands['800-1200']++;
  else if (p.rating < 1600) bands['1200-1600']++;
  else if (p.rating < 2000) bands['1600-2000']++;
  else bands['2000+']++;
}
console.log(`[deck] DONE — ${deck.length} puzzles kept from ${rows.toLocaleString()} rows `
  + `(${invalid} rejected by the legality replay)`);
console.log(`[deck] rating spread: ${Object.entries(bands).map(([k, v]) => `${k}:${v}`).join(' ')}`);
console.log(`[deck] written to ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
