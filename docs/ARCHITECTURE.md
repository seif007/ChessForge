# Architecture

How ChessForge is put together: the engine bridge, the repertoire data model, the
screen/state layer, the coach and bots, and the local persistence.

---

## The engine: Stockfish inside a hidden WebView

This is the most interesting part of the port and the part most likely to break
if changed carelessly.

### Why a WebView

The original web app did:

```js
new Worker('/engine/stockfish-18-lite-single.js')
```

React Native has **no Web Worker**, and the Emscripten loader assumes a browser
environment (`document.currentScript`, `URL.createObjectURL`, …). A JSI/native
thread is not an option for a WASM build. So the engine runs inside a
**zero-sized, non-interactive `WebView`** and the app talks to it over
`postMessage`.

The public API in `src/lib/engine.ts` is intentionally **identical** to the web
version — `ChessEngine.init()`, `.analyse()`, `.bestMove()`, `.destroy()`,
`getEngine()`, `uciToSan()`, `applyUci()`. Screens ported from the web reference
did not need to change; only the transport did.

```
┌──────────────┐   postMessage (string)   ┌────────────────────────────┐
│  ChessEngine │ ───────────────────────► │  stockfish-host.js         │
│  (singleton) │ ◄─────────────────────── │  (inside hidden WebView)   │
└──────────────┘   {ready|info|bestmove}  │   ├─ inlined UCI loader    │
                                          │   └─ wasmBinary ← XHR      │
                                          └────────────────────────────┘
```

`EngineHost.tsx` renders the WebView once, near the app root in `AppShell`, and
wires it to the `ChessEngine` singleton via `attachEngineHost(ref)`.

### How the 7 MB wasm reaches the engine

Two deliberate decisions, both the result of a failure:

1. **The Emscripten JS loader is inlined verbatim into the page.** It therefore
   needs no network and no `file://` resolution *for itself*.
2. **The wasm is NOT inlined.** It ships as a normal Metro asset, and the host
   page reads it and hands the loader a `wasmBinary`. Inlining the wasm caused
   build blowups (documented in `scripts/build-engine-assets.mjs`).

The bytes are read **inside the page**, not passed across the bridge — the
bridge is string-only, and base64 would re-introduce the size penalty.

> ### The `fetch` trap that cost the whole port
>
> The asset arrives as a `file://` URI from `expo-asset`. **Chromium's `fetch()`
> does not implement the `file://` scheme**, so `fetch(uri)` always rejects with
> *"Failed to fetch"* — no matter how the WebView is configured. Read it with
> **`XMLHttpRequest`** instead.
>
> The page also needs a `file://` `baseUrl`, otherwise it gets a **null origin**,
> from which Chromium blocks file access *even via XHR*.

### Engine usage rules learned the hard way

- **The first search after boot answers `bestmove (none)`.** Always warm the
  engine up and discard the first result before trusting one.
- **Changing MultiPV costs a search.** Batch positions by MultiPV setting rather
  than toggling it per position.
- **A hung search produces no output and no exit code.** Any code that drives
  the engine in a loop needs an explicit wall-clock timeout, or it will hang
  indefinitely looking like it is still working.
- **The wasm page wedges after roughly 15–17 searches** in one session. Batch
  work must be sliced and the page recycled between slices.

---

## Data model

### Repertoires

A repertoire file (`src/data/<opening>.json`) has the shape:

```jsonc
{
  "generatedAt": "…",
  "source": "…",
  "intro": "…",
  "chapters": [
    {
      "id": "…", "title": "…",
      "studies": [
        {
          "id": "ruy4.5",          // globally unique, feeds positionKeyAtPly
          "chapter": "…",
          "title": "…",            // survives the whole authoring chain
          "type": "…",
          "mainPlies": 30,
          "lineCount": 7,
          "tree": [
            {
              "san": "e4", "uci": "e2e4",
              "variations": [ { "at": 4, "moves": [ … ] } ],
              "fenAfter": "…",
              "commentAfter": "…"
            }
            // exactly 30 nodes
          ]
        }
      ]
    }
  ],
  "stats": { "chapters": 8, "studies": 48, "lines": 324 }
}
```

Hard invariants, enforced by the verifier:

- **Every study has exactly 30 tree nodes and `mainPlies: 30`** (15 moves each).
  Shorter book lines are completed by the engine; the first generated ply carries
  the filler marker text so authored and generated content are distinguishable.
- `variations[]` on `tree[i]` **replaces** that node's move at the same ply. A
  branch reconstructs as `tree[0..i-1] + branch`.
- `fenAfter` is the position **after** the move.
- Study ids are unique and their **prefix determines the training-progress key**
  (`positionKeyAtPly`). Two repertoires sharing a prefix would silently share
  progress and overwrite each other.

### The opening registry

`src/lib/openings.ts` is the **single registry** — every screen picks entries up
automatically. Adding a repertoire means adding an import, a cast, and one
`OPENINGS` entry (`id`, `name`, `side`, `tagline`, `available`, `repertoire`,
`accent`). Nothing else needs touching.

> There is **no `sicilian.json`**: the `sicilian` id maps onto
> `repertoire.json`, which holds both the main black repertoire and the Sicilian
> material.

### Which opening a line *is*

Everything that needs to name an opening asks `bestOpeningForLine`. It scores
each available opening by **how far that opening's own studies follow the line**,
and breaks a tie on depth by **how characteristic the line is of that opening** —
studies through the position, over studies in the opening.

Two properties this has that a lookup-by-list-order does not:

- **It is evidence, not enumeration.** `1.d4 d5` is two plies into both the
  London System and the Queen's Gambit Declined, so a tie-break on list order
  always picks the same one regardless of what the user played. Depth cannot,
  because the London book follows `d4 d5 Nf3 Nf6 Bf4` and the Queen's Gambit's
  stops at `d4 d5`.
- **Typicality is normalised by the opening's size.** A broad book is large, so
  raw study counts favour the *parent*: the Indian Defense owns more studies at a
  Grunfeld line than the Grunfeld book does, purely because it is four times the
  size. Dividing by the opening's own study count is what separates them
  (Grunfeld 0.33 against 0.05).

This matters far beyond the card title. The id feeds the book that finishes a
line, the move recommended inside it, and the tail appended when the user's own
games run out — so one wrong id produces a misnamed card, a move from the wrong
opening, and a line that ends early because the book asked for a continuation
does not contain the line. All three were reported as unrelated bugs.
`.bench/openingid.test.mjs` checks all 42 openings and fails the build.

### Continuing a line, and why a move-order index cannot

Three lookups answer "where does our line go from here?", tried in order. The
first two existed and were not enough; the reason is worth stating once.

1. **Exact move order** (`continueFromBook(..., requireExactDepth)`) — the book's
   tree must contain every ply. Correct and strict; returns nothing for a real
   game, whose move order is not a prefix of any study.
2. **Forgiving move order** — walks the tree and resyncs at the deepest ply the
   tree does not break before. `verifyFrom` is what makes it answerable: given
   the FEN the line actually reached, `walkStudy` walks its resync depth *down*
   until the book's next move is legal there.
3. **By position** (`bookContinuationFromPosition`) — indexes every position the
   opening's lines pass through, keyed by piece placement, side to move, castling
   and en passant, and looks the user's position up directly.

The third exists because the first two are **SAN tries**, and a transposition is
the same position reached by a different move order — which a trie cannot see at
all. For the reported Najdorf `e4 c5 Nf3 d6 c4 d5 Nc3 a6 d4` the trie matches two
plies, no resync depth yields a move that is legal where the game actually is, and
the position index comes back empty too: a walk of the raw study trees, using
each node's own `fenAfter` and sharing no code with either index, finds that
position nowhere in the Sicilian's 7 322 nodes. **The position is one we do not
teach.** That is a fact about the content, not a bug to be indexed around.

So where the corpus runs out, `continueLineWithEngine` asks Stockfish what to
play, and hands the line back to a book the moment it reaches a position one
teaches. Engine moves are flagged `fromEngine` and are never given a `fromStudy`,
so nothing is passed off as ours. The search is bounded (4 plies by default) — an
unbounded run would drift out of the opening and turn a repertoire card into a
general engine game.

The position index is built **per opening, on first use, and cached**. It is not
built library-wide: the comment on `COVERAGE_MAX_PLY` records what a full-depth
eager index cost before — 8 seconds to open "Your openings" and 37 MB, all of it
synchronous on the UI thread.

`.bench/openingfix.test.mjs` covers all of this: the scoping, that no card ever
contains an illegal move, that a taught position *does* extend a card, that three
openings asked about the same position return three different books, and the
engine bridge (with a stub engine that returns real legal moves, so the bridge's
own decisions are what is under test).

### Other data files

| File | Contents | Used? |
|---|---|---|
| `endgame_pool.json` | 136 engine-verified endgame positions | yes — `endgameTrainer.ts` |
| `endgames.json` | 18 guided endgame studies | yes |
| `evals.json` | Static evaluation book keyed by FEN prefix — lets the UI show an eval instantly without waking the engine | yes |
| `offline_deck.json` | 2 990 CC0 Lichess puzzles (ratings 399–3004) | yes — offline fallback in `puzzlePool.ts` |
| `coach_kb.json` | 64 curated knowledge entries used by the coach | yes — `coach/kb.ts` |
| `puzzles.json` | 17 curated/featured puzzles | **no** |

The puzzle tab once had a bundled deck of ~17 000 pre-fetched Lichess positions. It was removed on
request — 3 MB of dead weight in the bundle, and a second source of truth for "what is a puzzle".
The tab was then driven only by positions mined from the user's own games plus a live fetch. Since
then the decision was revisited: `offline_deck.json` now ships 2 990 puzzles as a **fallback**, not a
second source of truth. The live Lichess request is always tried first; the deck answers only when
that request produces nothing usable. Every entry is replayed with chess.js when the pool is opened,
and an entry that does not replay legally is dropped.

`puzzles.json` survived the earlier removal and is still on disk, still not imported.
`PuzzlesScreen.tsx` says so in a comment where the decision is recorded. It is kept rather than
deleted because the corpus is the owner's to curate, and a file nothing imports costs nothing but a
few kB.

**The `Used?` column exists because this table had been wrong twice.** It listed
`puzzle_pool.json` with a confident count for a file that had already been deleted, and listed
`puzzles.json` as live content next to it. A data-file table with no liveness column degrades into
a list of things the project once did.

---

## Screens and state

### "Your openings": the four things that are one line

This screen is where the reported defects clustered, and the reason is a single mechanism that
produced three symptoms at once. It is worth writing down in one place, because each earlier fix
stopped at one link in this chain.

**The engine pass re-runs the POOL ROTATION.** `publish()` calls `buildFamilyLines` again once the
verdicts land, and the rotation prefers positions that carry decisions — so `family.alternates`
comes back as a *different list*. It publishes twice, head then tail. Each rebuild did all three of:

| the report | the mechanism |
|---|---|
| "plays automatically 3 times" | a new `activeLine` failed the SAN comparison, so `startLine()` walked from move 1 |
| "a different new position" | `resolveLine` could not find the recorded moves in the new list and fell back to an **index** |
| "one or two moves and it says done" | the rotation picks short decision-bearing **fragments** — the line genuinely *was* that short |

That last row is why the 8-ply floor could not catch it: the line was not wrongly truncated, it was
correctly short. Nothing was lying. The floor was honest and the line was wrong, so the fix had to be
upstream of the length.

The line is therefore identified by its **moves**, never by its index, and `sessionLiveRef` stops the
rebuild reaching a session at all. GATE 1k asserts all three doors.

### Progress: the rings had no writer

Every ring reads `positions[step.position.key].mastery`. Until recently the only writer of that map
was `applyResult` — the **Train** path — so drilling in "Your openings" moved nothing, on any line,
ever. A display fix would have looked like work and changed nothing.

`store.recordPositions` now writes position progress without running a session, and completing a line
credits the studies it actually reached. Study credit is deliberately narrow: a study is marked when
the line *reached* it, not because it belongs to the same opening, since "you drilled a Sicilian line"
is not evidence you have touched the Sveshnikov.

The mastery curve is one function, `mergePositionMastery`, used by both the optimistic merge and the
SQLite write. There were two copies and they disagreed — a flat `+0.25` in memory against a decaying
step on disk — so the ring the user watched while drilling was computed differently from the one
stored, and **moved on the next launch**.

### Test, learn, and the arrows

Learning shows arrows permanently: the user asked for that twice, with the reason *"because this is a
course so no you just show the arrows."* A test is not a course — the arrow is the answer already
drawn on the board — so `testing` suppresses every arrow arm. The difference is a property of the
mode, not a switch, and the arrows return on `endTest`.

A wrong answer in a test still names the move, because a test that never tells you anything is a
locked door rather than a test.

`askablePositions` decides what a test may ask: any move that is the **user's to play**, whether or not
it has a position key. Requiring the key made playing our own recommendation — the outcome the app
steers toward — the surest way to get no test at all, because `continueLine` re-derives that tail and
those steps have `position: null`. The key is bookkeeping; a missing one means the answer is not
*scored*, not that the question cannot be *asked*.

### Today's plan

`buildDailyPlan` is a pure function in `src/lib/dailyPlan.ts`, and the ranking is the whole of the
feature:

1. positions the user **got wrong**, weakest first — a wrong answer schedules a position for *now*;
2. studies behind on, weakest first;
3. new material from **his own repertoire**, read from the custom repertoire;
4. a light task only when nothing is due and nothing is unstarted.

`Array.sort` is stable, which is why the old single-button plan read `Study 1.1` on every new account:
equal-mastery studies kept corpus order. GATE 1m checks the ranking against shapes the corpus does
not contain, which is the only way to catch a tie broken by accident.

### The coach

`src/lib/coach/` is a port of the prototype's `Coach.kt`. The contract is a one-way
pipeline:

```
game review / position  ->  FactFactory  ->  GroundedContext  ->  narrator  ->  guard  ->  student
coach knowledge base    ->                                    (template or LLM)
```

- **`FactFactory`** derives the facts the coach is allowed to say from the position,
  the engine lines and the knowledge base.
- **The narrator is pluggable.** `TemplateNarrator` is the default: deterministic,
  fully offline, and composed from verified facts. `llm.ts` defines the same interface
  for a local Qwen2.5 narrator. Any transport failure, timeout, empty answer or
  rejected draft falls back to the template, so the coach never stops working because
  a model is missing.
- **`guard.ts` is the safety boundary.** It checks a draft against the grounded
  context; any concrete move or claim that is not in the context is rejected. Rejected
  output is replaced by the template narration, never shown.
- **`findMentioned` only attaches book pages the user named.** A generic "explain this
  position" therefore contributes no random knowledge-base hits; the position facts
  remain the source of truth. The same path is gated by `topic.ts` so the coach
  answers chess questions only.

The optional model lives in `model.ts`: `COACH_MODELS` lists the Qwen2.5 0.5B and 1.5B
Q4_K_M GGUFs with their real Content-Length, `expo-file-system` downloads them into
the app's documents directory, and `llama.rn` loads them on the CPU. Installation is
accepted only at the exact expected size, so a half-finished download is offered a
retry rather than advertised as installed. Downloading is a background job, so
leaving the screen does not cancel it.

### Bots

`src/lib/bots/` builds an opponent from a real player's games:

1. **Sources** — `sources.ts` fetches a Lichess account's recent public games; `otb.ts`
   reads pasted PGN. Bullet games are excluded by type, not filtered late; six games is
   the minimum for a profile and 200 the maximum fetched.
2. **Profile** — `profile.ts` reduces the games to a `BotProfile`: an opening book
   keyed by position (the moves that player actually chose), move-type rates per phase,
   opening records and four human-readable style dials.
3. **Personality** — `personality.ts` is a layer on the existing profile, not a second
   engine. Five presets (Aggressive Attacker, Positional Player, Defensive Player,
   Gambit Enthusiast, Endgame Specialist) supply five style weights and a safety cap;
   a custom bot derives its starting weights from the imported style and the user can
   edit them afterwards. A preset bot has an empty book and zero imported games, and
   `playElo` is separate from the character, so strength can change without changing
   style. Profiles without `personality` keep the original mimic formula exactly.
4. **Move choice** — `mimic.ts` scores every MultiPV line with three terms: engine
   quality, generic human plausibility, and this player's personality. The weights
   decide whether the result is an engine wearing the player's name or a recognisably
   human opponent. A small amount of score noise for lower-rated players makes them
   blunder at a human rate. When a style choice falls too far below the engine's best
   move, safety damping pulls the score back toward neutral.
5. **Play and review** — `play.ts` drives the game, `postgame.ts` produces the review,
   and `store.ts` persists the profiles so a bot survives leaving and reopening the
   screen.

The build is a background job because fetching and profiling 60 games takes long
enough to outlive a tab.

### ChessForge Arena

`src/lib/arena/` is a local tournament manager. It never calls Lichess and never
touches the account's Lichess Elo:

- **Formats** — `pairing.ts` implements round robin, double round robin (circle
  method with balanced colours), seeded knockout (the top seed gets an odd field's
  bye), Swiss (score groups, no rematches where possible) and Arena (score groups,
  rematches allowed). Standings carry points, Buchholz, Sonneborn-Berger and a
  performance estimate that uses starting ratings and excludes byes.
- **One champion, by published rules** — league formats order the table by points,
  then head-to-head, Buchholz, Sonneborn-Berger, wins, games with Black and finally
  the seed; the final sheet names the rule that separated first from second. A
  knockout match is 1 game or 2 legs with both colours (`knockoutLegs`); a level
  match is decided by an **Armageddon** game (Black advances on a draw, White has
  the longer clock). `normaliseGame` must carry `leg`, `armageddon` and `clockStart`
  through a storage round trip — dropping them made the tie-break replay as a
  normal game forever.
- **Lifecycle** — `store.ts` creates an immediate tournament or a draft. A draft
  stores frozen participant snapshots and no games; the name, format, time control,
  rated flag, match length and Swiss/Arena round count can be edited until
  `startTournament` draws the first round. Later bot edits cannot rewrite history.
  Creating always lands on the tournament sheet; a game opens only on the user's tap.
- **Ratings** — `ratings.ts` keeps four local pools (Bullet, Blitz, Rapid,
  Classical), K=32, with both Elo deltas computed from pre-game ratings. A human
  game moves the human pool and the bot's pool; a bot-vs-bot game moves only bot
  ratings. Untimed games can be rated (Classical pool). `recordCasualGame` applies
  the same Elo to a plain game against a bot outside a tournament.
- **Other boards play themselves** — `autoPlay.ts` plays every bot-only board on
  the tournament sheet out in the background (short movetime, same bot move chooser)
  and stores a complete game, so the user plays only their own games and reads the
  other results; any finished board can still be opened to watch.
- **Games** — `game.ts` owns result detection, clock arithmetic and PGN export.
- **Screens** — `ArenaScreen` is the lobby and ratings card, `CreateTournamentScreen`
  takes the setup, `TournamentScreen` shows the cup bracket or league table, the
  pairings and the podium, and `ArenaGameScreen` is the live board with clocks,
  flag/undo/½-draw controls and bot auto-play. Both the game screen and the sheet
  (which simulates boards) are in the `AppShell` mount condition and the GATE 1o
  roster. `KnockoutBracket.tsx` renders the cup: rounds as columns, possible
  opponents in every future slot, played ties tappable.

### Background jobs

`src/lib/background.ts` is a small job owner for work that must survive navigation:
one job per id, an observable state record, cooperative cancellation through an
`AbortSignal`, and a promise that is reused while the same job is running. Work never
touches component state; a screen starts a job and subscribes with `useJob`.

The long Lichess import path lives in `statsJobs.ts` and `scanPlan.ts`: refreshing the
game list, the 200-game engine scan and puzzle mining. Results are written to the normal
persistent store **before** the job reports `done`, so a screen that mounts later reads
the same truth from disk. That is also what makes the scan resumable after the app is
killed — completed game records are stored per account and picked up where they stopped.
The same `importGames` driver is used by Stats, Puzzles and the inline import card, so
the three surfaces cannot disagree about depth, caps or progress.

Mined puzzles are stored as forced lines, not single moves: `puzzleLine.ts` replays the
engine's principal variation, trims it to an odd number of plies (solver, opponent,
solver, ...), and re-checks every later solver move with MultiPV. A line already in the
deck is skipped on later import batches. Decks from the old one-move format are still
readable but are retired from the puzzle tab; re-importing rebuilds the same stable
`gameId:ply` ids with the new lines, so SRS history reattaches.

`App.tsx` is the navigation shell. Screens live in `src/components/screens/`:

`Home` · `Openings` · `Your openings` · `Course` · `Practice` · `Train` · `Puzzles` ·
`Endgames` · `Analysis` · `Stats` · `Bots` · `Bot play` · `Arena` · `Profile`

Shared chrome lives in `AppShell.tsx` (which also mounts `EngineHost`, `SoundHost`
and `CelebrationBanner`), with the board stack in `src/components/chess/`:

- `ChessForgeBoard.tsx` — the board, drag input, highlights and arrows
- `pieces.tsx` — SVG piece set
- `EvalBar.tsx` — live evaluation bar
- `MoveList.tsx` — SAN move list
- `QualityBadge.tsx` / `DriftBadge.tsx` — move-classification and out-of-book feedback

### Move classification — six labels

`classifyMove` gives every analysed move exactly one of **brilliant, best, good,
book, mistake, blunder**. Four further verdicts — `great` (the only-move /
critical-move label), `excellent`, `inaccuracy` and `miss` — are **retired**: they
are no longer produced and no longer shown, because the user named the six he
wants and said the rest were labels he did not know what they meant.

The bands are **expected-score loss from the mover's point of view** (the
reference classifier), not raw centipawns — a 100cp loss is trivial at +9.00 and
serious at equality. The `inaccuracy` band is folded into `good` because the app
shows six labels, not nine:

| Label | Expected-score loss | Roughly, from equality |
|---|---|---|
| `good` | < 0.12 | < 140cp |
| `mistake` | 0.12 – 0.22 | 140 – 260cp |
| `blunder` | ≥ 0.22 | ≥ 260cp |

`book` claims a move only when it is in the repertoire **and** harmless (less than
110cp and below the mistake boundary). `brilliant` is the engine's best move, a
genuine material offer (`sacrificeValue`), a gap of at least 150cp to the
second-best MultiPV line, not already winning and not a forced reply. A move that
keeps a clearly won game won (≥ +400) is never relabelled a mistake — that guard
exists for the mate-to-score transition. Glyphs follow the familiar convention (★ best, ✓ good,
📖 book, ? mistake, ?? blunder, !! brilliant).

**A review with no evidence is refused.** If fewer than half the positions return
an evaluation (engine not mounted, torn down, or superseded), the Analysis screen
shows an error instead of publishing a report where every move "lost" 0cp — the
`100% / 0.0` output the user reported. It restarts the engine first, retries a
blank position once, and cancels early if the engine stays silent.
`.bench/analysis.real.test.mjs` drives the real engine over four PGNs and asserts
both the evaluations and the verdicts; `.bench/analysis.accuracy.test.mjs` pins
the maths.

**The retired names are still in the type, in `QUALITY_META` and in the database
columns.** A game analysed before this change has them stored, and a review that
could not name its own verdicts would render an old report blank. Nothing
produces them; `ACTIVE_KINDS` is what the UI iterates.

A sacrifice that is *also* the engine's best move stays `brilliant`, and one that
is not is graded on its merits — a hanging queen that lost the game is still a
blunder. `.bench/movequality.test.mjs` (GATE 1g) sweeps the input space asserting
no retired label can be produced and checks every band boundary.

Domain logic lives in `src/lib/` — see the table in the
[README](../README.md#srclib--the-domain-layer).

### Persistence

`src/lib/db.ts` wraps **expo-sqlite**. Progress, SRS scheduling, ratings and
statistics are stored locally; there is no ChessForge account and no server.
`store.ts` (Zustand) holds the in-memory session state and hydrates from SQLite on
launch.

**Training progress is per Lichess account.** Schema v4 gives `StudyProgress`,
`PositionStat`, `PuzzleStat` and `EndgameProgress` an `account` column and a
composite `UNIQUE(account, id)`, and the profile row is keyed by the account name.
Rows written before v4 are claimed once by the first account that loads, so an
existing user keeps their mastery while a later account starts at zero.
`store.reloadForAccount()` re-reads the scope when Stats or the inline import card
saves a different handle.

**Android auto-backup is disabled** (`allowBackup="false"` plus
`res/xml/data_extraction_rules.xml`). It was restoring an earlier copy of the
kv-store and the database on reinstall, so a bot the user had deleted came back.

Derived and wipeable data lives in `expo-sqlite/kv-store` instead: the linked
Lichess account, the cached game list, per-account scan state and mined puzzles,
and saved bot profiles. Everything is namespaced by the account where that matters,
so switching accounts deletes the previous account's data with one key. Coach models
are plain files in the app's documents directory, outside both stores, so removing a
model never touches progress.

---

## Theming

All colours, fonts, spacing and arrow colours come from `src/theme/tokens.ts`.
Screens import from there and never hardcode a colour, which is how visual
parity with the web reference is maintained.

One project-wide convention: **stock-market colour semantics**, not Western ones.
An *advantage for White* is rendered in the warm/red accent and a *disadvantage*
in green, matching the convention the reference app uses.

---

## Engine licensing

ChessForge bundles **Stockfish 18 Lite (single-threaded, WASM)**, which is licensed
under the **GNU General Public License v3.0**. Stockfish is a separate work
invoked through a message-passing interface; its licence is not the licence of
this application's own source. The upstream project is at
<https://github.com/official-stockfish/Stockfish>.

`assets/engine/stockfish-18-lite-single.js` is the Emscripten loader emitted by
that build; `stockfish-18-lite-single.wasm` is the compiled engine binary. Both
are committed so a fresh clone builds without network access.

---

## Known constraints

- **Android only.** There is no iOS target and no web target in this port.
- **Offline-first.** The engine, repertoires, offline puzzle fallback and coach
  template all work without a network. Network access is used only for the Lichess
  import and live puzzle attempt (the bundled deck answers when it fails), and the
  optional coach-model download.
- **Bundle staleness.** `src/**` is not a declared Gradle input for the
  JS-bundling task, so a rebuild can silently ship the previous bundle. See
  [`DEVELOPMENT.md`](DEVELOPMENT.md#the-stale-bundle-trap).
