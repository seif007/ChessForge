# Repertoires

How the opening repertoires are authored, extended and verified. This is the
highest-effort part of the project and the part with the most non-obvious rules.

---

## What a repertoire is

Each repertoire is a set of **studies**. A study is:

- a **mainline** of exactly **30 plies** (15 moves per side), and
- any number of **variation branches**, each of which *replaces* one move of the
  mainline from that point on.

Branches are the teaching content: "if they play this instead, here is the plan".
They are what makes a study a lesson rather than a line.

### The 42 repertoires

| | Chapters | Studies | Lines |
|---|---|---|---|
| **Total** | **249** | **1 204** | **5 435** |

The per-opening breakdown is NOT repeated here. It lives in the README, and it used to
be duplicated in this file as well — two hand-maintained tables of the same thing,
which is how this one came to claim 18 openings and 2 247 lines while the corpus had
long since passed 42 and 5 435. One table is better than two. The gate suite
(`node scripts/run-gates.mjs`) verifies the repertoire structure, ids and line counts;
update the README table when the corpus changes.

The last five are **promoted chapters** — the Catalan, the Semi-Slav, the Slav, the QGA
and the Grünfeld were chapters 5-8 of the Queen's Gambit and chapter 6 of the Indian
Defenses. See "Promoting a chapter to its own opening" below, because the way they were
created is the part worth copying.

> These two paragraphs used to both be here, saying the same thing in slightly different
> words. That is the same failure as the duplicated table above, in prose: nothing stops a
> restatement from surviving, because it is correct both times and nobody diffs a document
> against itself.

---

## Why every line is 30 plies

A training line has to run long enough to reach a *position you can play*, not
just the first few moves. Truncating at 6–8 plies — which the port originally
did in the Practice screen — means you drill the opening and then stop exactly
where the thinking starts.

So the rule is: **every mainline is 30 plies.** Where the authored book line is
shorter (a gambit that resolves by move 9, a forced trade sequence), the
remaining plies are filled with **engine-verified top play**, and the first
generated ply carries an explicit filler marker:

> Book line ends here — engine-verified top play completes the line to 15 moves
> for each side.

That marker is not decoration. It is what keeps *authored* content and
*generated* content distinguishable forever, in the data and in the UI.

---

## Authoring pipeline

The toolchain lives **outside the app directory**, in `.tmp-<abbrev>/` at the
repository root (`ruy`, `ita`, `kid`, `kia`, `lon`, `col`, `audit`, `verify`,
`rc`). It is a development tool and is not shipped in the app.

The general shape, per opening:

```
emit_<x>.py  ->  <x>.pgn  ->  parse_<x>.py  ->  <x>_raw.json
build_<x>.py  jobs | absorb | assemble        ->  src/data/<x>.json
```

- **`jobs`** — emit one engine job per line still short of 30 plies
- **`absorb`** — read the engine results, gate them, extend the lines
- **`assemble`** — rebuild the tree and write the published JSON

A driver (`drive_<x>.py`) loops `jobs` → engine → `absorb` until every line
reaches 30 plies, then runs `assemble`.

### The engine loop

An **on-device-equivalent Stockfish 18 WASM** build is driven headlessly in a
batch harness for this. Two hard constraints shape it:

- **The wasm page wedges after ~15–17 searches**, so work is sliced and the page
  recycled between slices. The slice size is the *only* thing bounding heap
  growth.
- **The engine's reported score is not usable** and its `bestmove` glitches
  roughly 3% of the time. So the loop follows one rule:

> **The engine proposes; a static exchange evaluation disposes.**

A proposed move is accepted only if it:

1. does not end the game before ply 30 (a mate at ply 27 cannot be extended),
2. does not allow the opponent a mate in 1 (the static exchange test is blind to
   the king), and
3. does not concede forced material above a threshold.

Otherwise the move is replaced by the legal move with the best static exchange
delta, tie-broken by a develop / centralise / castle heuristic. That fallback
cannot hang material by construction, so a generated tail is sound even when the
engine misbehaves.

---

## Rules that are easy to get wrong

These all cost real debugging time. They are invariants, not preferences.

### Line length and the tree

- **Every study has exactly 30 tree nodes and `mainPlies: 30`.**
- A branch reconstructs as `tree[0..i-1] + branch`, so its absolute length is
  `i + len(branch)`.
- **`assemble` is a publish step, not a checkpoint.** Running it before the loop
  converges *overwrites the good published file in place*, normally with no
  backup. The tell is in the verifier: `tree lengths: {29: 16, 26: 1, 30: 31}`
  instead of `{30: N}`. It is benign — re-assembling after convergence repairs
  it — but do not mistake it for corruption.
- **A line that ends in mate can never reach 30 plies.** Such a line makes the
  loop report `terminal position at ply N` every round and never converge. Scan
  for it before starting and truncate the authored branch where the trap springs.

### Stale published data

The loop widens the **raw** file; the **published** JSON is only written during
an `assemble` pass. If assemble never runs, the published file silently keeps its
old shape **while every log line reports success**. This shipped a London
repertoire with 66 lines against a 216-line raw file.

The build gates on this: `check_fresh.py` compares every published file with its
raw file and refuses the build on a mismatch.

### Editing rules

- **Edit → re-emit → re-parse → prune, always.** The builder reads the **raw**
  JSON, never the authoring modules. Editing an authoring module and restarting
  the loop extends the *old* lines while every gate stays green.
- **Editing a mainline invalidates every branch downstream of it.** Re-run the
  legality check immediately after any mainline edit.
- **A re-parse invalidates every extension state. Delete it; do not salvage it.**
  Extension state is keyed positionally (`"<study>:<line>"`), so growing the line
  list silently repoints those keys at *different* lines. Measured once: raw went
  65 → 193 lines, all 56 existing keys still *resolved*, but 11 could not legally
  follow their new line and 137 of 184 short lines had no state at all.
  Comment-only edits do **not** invalidate state.

### Indices

- A branch's `at=N` is the **0-based** index of the replaced move. The audit label
  `var@plyN` is **1-based**. Mixing them up silently reads the wrong variation.
- `at` parity: **even ⇒ the branch opens with White, odd ⇒ with Black.**

### Job identity

Job ids must be **unique per position**, not per line. The harness caches by id
and skips ids it already holds, so a positional id collides when the round-robin
revisits a line deeper — the harness then returns the *old* ply's move, it is
illegal, and the fallback silently absorbs it.

Telltale of a collision: `4 new, 16/12 total` in the engine log. Healthy is
`12 new, 12/12`.

---

## Common position-key prefixes

The study-id prefix determines the training-progress key (`positionKeyAtPly`).
**Prefixes must be globally unique** — two repertoires sharing one would silently
share progress and overwrite each other.

| Prefix | Repertoire |
|---|---|
| `ruy` | Ruy Lopez |
| `ita` | Italian Opening |
| `kid` | King's Indian Defense |
| `kia` | King's Indian Attack |
| `lon` | London System |
| `col` | Colle System |
| `s*` | Sicilian (`repertoire.json`) |
| `qg` | Queen's Gambit |
| `ind` | Indian Defense |
| `eng` | English Opening |

---

## Promoting a chapter to its own opening

The Catalan, the Semi-Slav, the Slav, the Queen's Gambit Accepted and the Gruenfeld
were each a chapter inside a larger repertoire. They became openings in their own
right, and the recipe is the reusable part.

**Never retype a move tree.** Copying ~600 kB of `uci` / `fenAfter` / `comment`
fields by hand is how typos get in, and no reviewer will ever read them. Use
`.bench/opening.split.mjs`, which takes the chapter object **verbatim** and changes
only the three things that must change:

1. **`study.id`.** `studyIndexAll()` builds ONE flat index across every opening, so
   two openings holding `qg59` would silently shadow each other: Train's `studyIds`
   filter would match the wrong study and the SRS would write progress to whichever
   loaded last. Ids are re-prefixed, and the tool **fails** if a new id collides with
   one already in the library.
2. **`study.chapter`** and the chapter `title`. A study records which chapter it is
   in; leaving the old string makes a Catalan study claim to live in "Chapter 10:
   Traps and Tactics".
3. **`mainPlies`, `lineCount` and `stats`.** These describe the whole file, so a
   copied chapter's counts are wrong by definition. They are recomputed with the
   app's **own** `collectStudyLines` — imported and compiled, not reimplemented.

The source chapter is left completely untouched, so the parent repertoire keeps its
own copy. That duplication is deliberate: these are now edited independently, and a
shared in-memory reference would mean the next edit to the Catalan silently rewrote
the Queen's Gambit too.

Before writing, the tool replays every mainline and every variation branch with
chess.js and compares the resulting FEN against each stored `fenAfter`.

### Why "the trees are copied" is not the interesting part

The interesting part is the invariant the tool has to protect: **a study id is a
global key, not a local one.** Most of this document assumes ids are unique inside a
file. They are not — they are unique across the library, and a promoted chapter that
keeps its parent's ids is a silent, data-shaped bug that nothing in the suite was
looking for.

---

## Verification

Two layers, and the second is the one that matters.

### 1. Per-file structural check (authoring time)

Verify the **published** file, not the loop that produced it — never trust a
converged loop:

```bash
python ../.tmp-verify/verify_repertoire.py chessforge/src/data/ruy-lopez.json
```

It checks shape, legality, comment preservation, filler markers, id uniqueness and
branch structure, and must end with `ALL CHECKS PASSED`. See
[`DEVELOPMENT.md`](DEVELOPMENT.md#verifying-a-repertoire-json) for the exact
invocation. Then confirm nothing is stale:

```bash
python ../.tmp-verify/check_fresh.py
```

which must report `all repertoires current — safe to build`.

### 2. Whole-library checks (before any release)

These run as part of the gate suite, over the shipped corpus rather than one file:

```bash
node scripts/run-gates.mjs
```

- `repertoire.gen.test.mjs` — the generator is correct on shipped data and
  **refuses** bad SAN, impossible positions, wrong chapter labels and empty trees.
- `booktruth.test.mjs` — "our book" is the union of what the corpus actually
  contains, filtered by the side to move, not a fact about a shared first move.
- `positiontruth.test.mjs` — every step's `fen`, `moveSan` and board replay agree
  across every family, which is what stops the screen asking for an illegal move.
- `openingid.test.mjs` — all 42 openings are identified by the line, not by registry
  order; a line through `d4 d5` must resolve to the opening that actually follows it.
- `youropenings.test.mjs` and `openinglabel.test.mjs` — cards, labels, ordering,
  win-rate membership and the minimum line depth.

The last standalone audit (October 2026, with the authoring toolchain outside this
repository) replayed **36 033 mainline moves across 42 openings**, field-checked `uci`
and `fenAfter`, verified the `fenAfter` chain node-to-node, recounted `stats` and every
`lineCount`, and checked id uniqueness within and across openings. It also ran **20
mutation self-tests** — corrupt a SAN, a `uci`, a `fenAfter`, a `mainPlies`, a
`lineCount`, a `level`, empty a tree, point a study at the wrong chapter — and required
each to fire its own class. Result: **0 illegal moves, 0 uci mismatches, 0 broken FEN
chains, 0 duplicate ids, 0 wrong statistics, 20/20 self-tests fired.**

The only thing it still reported was the three genuine `type: "Reference"` indexes.
Those are prose, not corruption: a single placeholder move plus a long `commentAfter`
checklist, zero lines *by design*. The app honours the type — excluded from the
progress denominator, no Practice button, skipped by the Train picker — so the audit's
classifier, which predates that handling, is what is imprecise here, not the data.

---

## A note on quality bar

A repertoire that trains the wrong move is worse than no repertoire, because it
teaches you the error confidently. Two consequences:

- **Filler is marked.** Generated plies are never presented as book.
- **Placeholder studies are not acceptable.** A study that exists only to pad a
  chapter count, presenting filler as if it were authored content, is a defect to
  be fixed rather than shipped.
