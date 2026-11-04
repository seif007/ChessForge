# ChessForge — Chess Training

A native Android chess training app built with **Expo + React Native**, running a
full **Stockfish 18** engine on-device (WASM inside a hidden WebView). ChessForge combines an
opening repertoire trainer, a spaced-repetition study system, tactical puzzles,
endgame drills, game analysis, a grounded on-device coach, and bots built from
public game archives in one offline-first app.

This is a personal/private project. The app is the `chessforge/` React Native
project in this repository. It is a native port of an earlier Next.js web
prototype, which is no longer part of this repository.

**Release status.** The repository stays private until the app is finished,
then goes public under MIT. The Lichess client identifies itself as
`ChessForge/1.0 (Android)` in `src/lib/lichess.ts`; no personal contact address
is embedded. When the repository is public, the public issue tracker can be
added to the User-Agent and the privacy notice.

`.bench/ua.contact.test.mjs` guards that identity: it fails if a personal email
address is put back into the User-Agent or the privacy notice.

ChessForge is an independent project. It is not affiliated with, endorsed by, or
sponsored by Lichess or any player. Lichess is a trademark of its respective
owner. The app does not log in to Lichess; imports read public data by username.
See [PRIVACY.md](PRIVACY.md) for what is stored and how to delete it.

---

## What it does

| Area | Description |
|---|---|
| **Openings** | 42 curated opening repertoires across 249 chapters — 1204 studies and 5 435 training lines, each fully annotated and 30 plies deep |
| **Your openings** | Lines mined from an imported Lichess account's public games: every move in those games is recorded as the repertoire, judged by the engine, and shown with blunders named on the board. Lines are drilled rank by rank and round-robin across chapters, mistakes are replayed to where the account went wrong, and **Test yourself** asks random positions from what you have just studied — with no arrows, because the arrow is the answer |
| **Course** | Step-by-step annotated walkthrough of each repertoire with coach commentary, alternative branches and plan explanations |
| **Practice** | Drill a repertoire against your own knowledge; every line runs the full depth of the course (not a truncated sample) |
| **Train** | Spaced-repetition (SRS) queue that resurfaces the lines you are about to forget, mixing your own decisions with the app's lines for the same openings |
| **Puzzles** | Forced-line puzzles mined from an imported account's games - the opponent's best replies are played for you, and each of your moves is checked against the engine's only move - plus a live Lichess fetch for fresh material. When the live service is unavailable, a bundled 2,990-position CC0 deck (ratings 399-3004) answers offline |
| **Endgames** | 136-position engine-verified drill pool with 18 guided studies, plus a generator for mate patterns |
| **Analysis** | Play out any position and get a live engine evaluation, with six move classifications — **brilliant / best / good / book / mistake / blunder** — using WintrChess's expected-score bands and glyphs, and a coach panel that explains the position. A review refuses to publish when the engine returns no evaluations instead of showing a fake 100% / 0.0 game |
| **Bots** | Build an unofficial style model from a public Lichess account or an OTB game set, or start from a personality preset — Aggressive Attacker, Positional Player, Defensive Player, Gambit Enthusiast or Endgame Specialist. Every bot weighs engine quality, human plausibility and its style; strength is a separate setting, so an aggressive 1400 and an aggressive 2600 share a character but not an accuracy. A bot built from an account is capped at that account's rating, so an 1800 import really plays at 1800 rather than at Stockfish's full strength. Presets open with a curated repertoire — the Gambit Enthusiast plays the King's Gambit, Danish, Evans, Smith-Morra, Latvian, Marshall, Alien and more instead of quiet development. A bot pauses like a human before moving (briefly on forced replies) and declines draw offers before move 10 or in an Armageddon. Lichess bots are labelled by handle and do not use a profile photo or real name |
| **Arena** | Create local ChessForge tournaments: round robin, double round robin, knockout, Swiss or Arena. Play against your bots or watch a bot championship; choose how many bots take part, whether it is rated or unrated, and a time control, name the event, save it as a draft, and edit the setup before starting. Knockouts are drawn as a **cup bracket** (rounds as columns, the players you could meet in every later slot), the other formats as a **league table**; a knockout match is one game or two legs with both colours, and a level match goes to **Armageddon** (Black advances on a draw). Bot-only boards play themselves in the background, so you play your own games and can open any finished board to watch. Every tournament keeps frozen bot snapshots, standings, performance estimates and medals, and its finished games replay, analyse and export as PGN |
| **Coach** | Grounded explanations of moves, positions, hints and whole games, tested across material/tactics, pawn structures, endgames and full-game reviews. The default narrator is deterministic and offline; an optional Qwen2.5 0.5B ("quick") or 1.5B ("sharper") GGUF model can be downloaded on the device for richer prose. The model receives the verified facts, may not invent moves (a hallucinated move is rejected and replaced by the offline coach), and falls back cleanly when it is not loaded |
| **Stats / Profile** | Rating tracking, win-rate and opening history, per-opening rank, and a resumable Lichess public-game import that mines the account's recent games for mistakes and puzzles. **Training progress is per Lichess account** — a new username starts fresh and its own rings/rank come back when you switch back. ChessForge ratings are local and separate from Lichess Elo, with their own Bullet / Blitz / Rapid / Classical pools; Home and Profile show your rating in the format you play most **in this app** |
| **Today's plan** | A ranked list, not one button: what you got wrong first, then what is behind on, then new material from your own repertoire, each row saying why it is there |

Core training works **offline**: the engine is bundled (7 MB WASM), the repertoires
are local JSON, the offline puzzle fallback ships in the bundle, the coach's
deterministic narrator needs no model, and every Arena tournament is stored on the
device. Network access is used only for public game imports (Lichess and the OTB
archives), a fresh Lichess puzzle (the bundled deck answers when that fails), and
an optional coach-model download.

---

## Tech stack

- **Expo SDK 57** / **React Native 0.86.3** / **React 19.2.3**
- **TypeScript 6** (strict)
- **Stockfish 18 Lite (single-threaded, WASM)** — runs in a hidden WebView
  bridge; see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **chess.js** for move generation/legality
- **Zustand** for state management
- **expo-sqlite** for local persistence, and `expo-sqlite/kv-store` for preferences and caches
- **react-native-svg** for the board, pieces, arrows and evaluation bar
- **react-native-webview** for the engine bridge
- **llama.rn** for the optional on-device coach model, with **expo-file-system**
  handling the one-time GGUF download
- **Android only** — this port does not target iOS

---

## Requirements

- Node.js 22+
- **JDK 21** — the version `scripts/android-env.sh` pins and `scripts/build-apk.sh`
  probes. Not the ambient JDK: AGP 8.x rejects 24.
- Android SDK with `ANDROID_HOME` and `ANDROID_SDK_ROOT` set (the script uses `C:\AndroidSDK`)
- For a physical device: USB debugging enabled

`scripts/android-env.sh` points a shell at a local Android SDK, JDK and Gradle:

```bash
source scripts/android-env.sh
```

---

## Getting started

Clone this repository with your usual GitHub access, then from its checkout:

```bash
cd ChessForge/chessforge
npm install
```

Run on a connected device or emulator (this builds the native project too):

```bash
npm run android
```

Start Metro only:

```bash
npm start
```

Type-check the whole project:

```bash
npm run typecheck
```

Run the full behaviour suite — every gate file, with an honest file and
assertion count:

```bash
node scripts/run-gates.mjs
```

A single gate can be run by name:

```bash
node scripts/run-gates.mjs youropenings
```

### Regenerating the engine assets

The bundled Stockfish build is produced from the upstream package by:

```bash
npm run build:assets
```

`assets/engine/stockfish-18-lite-single.{js,wasm}` are generated artifacts but
**are committed**, so a fresh clone builds without this step.

---

## Building a release APK

The build runs entirely locally — no EAS cloud account is required.

```bash
# from the repository root
source scripts/android-env.sh      # export ANDROID_HOME + JAVA_HOME
./scripts/build-apk.sh
```

The APK lands at:

```
android/app/build/outputs/apk/release/app-release.apk
```

`scripts/build-apk.sh` wraps the same steps, and `scripts/build-detached.cmd`
runs it in the background on Windows. **Use `build-apk.sh`.** A bare `gradlew`
skips every gate below, which is how a build ends up shipping a bundle that
predates the change you just made.

The manual equivalent, for debugging a build step rather than shipping one:

```bash
source scripts/android-env.sh
npx expo prebuild --platform android --clean   # only when app.json/native config changed
cd android && ./gradlew :app:assembleRelease
```

> `build-apk.sh` also runs the authoring toolchain's
> `../.tmp-verify/check_fresh.py`. That toolchain lives outside this repository;
> in a checkout without it the freshness gate cannot run. Run the full suite
> first, then use `./.cf-build.sh` — it performs the same JDK/SDK pinning and
> Metro-cache reset without the gate runner — and finish with
> `node .bench/verify.needles.mjs` and `python scripts/bundlecheck.py`.

Install onto a connected device over USB:

```bash
adb devices -l                                                   # which phone?
adb -s <serial> install -r android/app/build/outputs/apk/release/app-release.apk
```

> Always pass `-s <serial>`. With two phones attached, a bare `adb install` puts a
> test build on whichever one it picks — and that build then sits there looking
> authoritative.

### The gates

`build-apk.sh` **refuses to build** if any of these fails. Each gate that reports
a number also carries a **control** — an assertion that the previous broken
behaviour would have failed — because a check that reports success without having
examined anything is worse than no check.

Before a release, run the full suite as well: `node scripts/run-gates.mjs` (74
files, 2 276 assertions in the latest run; the runner prints the exact count each time).

| Gate | Test | Protects |
|---|---|---|
| 1b | `verify.needles.mjs` | every bundle needle exists in `src/` **before** anything is built |
| 1 | timestamp | the APK is newer than the newest source file |
| 2 | `scripts/bundlecheck.py` | the bundle **contains** this session's changes |
| 1f | icon freshness | the Android icon resources are not older than the icon asset |
| 1c-a | `openingid.test.mjs` | which opening a line *is*, across all 42 |
| 1c | `openingfix.test.mjs` | book-scoped continuations, drill shape, recapture filtering |
| 1d | `movelist.numbering.test.mjs` | move numbering and which colour a move is attributed to |
| 1e | `levels.test.mjs` | puzzle and endgame difficulty bands |
| 1g | `movequality.test.mjs` | the six move classifications are the six the app advertises |
| 1h | `brand.test.mjs` | no old brand name survives anywhere |
| 1i | `youropenings.test.mjs` | "Your openings" offers real lines, ordered and scored |
| 1j | `hooks.test.mjs` | no hook is called after a component's early return |
| 1k | `lineloop.test.mjs` | a line the user opened is the line the user keeps |
| 1m | `dailyplan.test.mjs` | today's plan is decided by need, and changes day to day |
| 1n | `puzzles.test.mjs` | puzzles can load, and never blames the connection |
| 1o | `engine.boot.test.mjs` | the engine can recover from a failed boot, and a scan never fails silently |
| 1p | `minedpuzzle.test.mjs` | mined puzzles are forced lines, and the legacy one-move deck is retired |

Gates 1a–1p exist because the defects they cover all compiled cleanly and passed
every other check. Each one is a bug that was found on a device, after being
reported as fixed more than once. The write-ups are in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

The table above is the subset `build-apk.sh` runs inline. The full suite is
broader and is the thing to run before a build: it also covers the coach
(`coach.core`, `coach.app`, `coachbot`), bots (`bots.*`), in-place import,
background jobs, account persistence, celebration, performance and the whole
"Your openings" surface. `run-gates.mjs` reports **skipped** gates separately
from passes, because a gate that did not run is not evidence of anything.

> **Note on bundle staleness.** `src/**` is not a declared Gradle input for the
> JS-bundling task, so Gradle will happily print `UP-TO-DATE` and package a bundle
> built *before* your edit. Every timestamp then looks correct while the APK silently
> ships without the change.
>
> One limit worth knowing: a bundle needle can only assert a change that survives
> minification — an exported name, a data string, or user-visible copy. A purely
> *behavioural* refactor (queueing writes instead of doing them per ply, removing a
> re-render) leaves no string to find, and the honest guard for that is a
> source-level test. That is what gates 1c-a onward are.

---

## Project layout

```
chessforge/
├── App.tsx                     app entry, navigation shell
├── index.ts                    Expo registration
├── app.json                    Expo/Android manifest config
├── src/
│   ├── components/
│   │   ├── screens/            13 screens (Home, Openings, Your openings, Course, Practice,
│   │   │                       Train, Puzzles, Endgames, Analysis, Stats, Bots, Bot play,
│   │   │                       Profile)
│   │   ├── chess/              board, pieces, eval bar, move list, badges
│   │   ├── ui/                 shared primitives and icons
│   │   ├── Coach*.tsx          coach avatar, panel, game chat and model manager
│   │   ├── GameImportInline.tsx  import a Lichess public account in place
│   │   ├── CelebrationBanner.tsx  non-blocking streak celebration
│   │   ├── EngineHost.tsx      hidden WebView hosting the engine bridge
│   │   └── SoundHost.tsx       move/capture sound playback
│   ├── engine/                 engine bridge, asset loading, sound host page
│   ├── lib/                    domain logic (see below)
│   ├── data/                   the repertoires and pools (JSON)
│   └── theme/tokens.ts         colours, fonts, spacing, arrow colours
├── assets/                     icons, splash, bundled Stockfish WASM
├── scripts/                    local build + environment helpers
├── .bench/                     the behaviour gates, and the scripts that read the corpus
└── docs/                       this documentation
```

`android/`, `node_modules/`, `.gradle-home/` and `.expo/` are generated locally
and are not in version control. Run `npx expo prebuild --platform android
--no-install` after changing `app.json`, or gate 1f will fail.

### `src/lib` — the domain layer

| Module | Responsibility |
|---|---|
| `openings.ts` | **Single registry** of every repertoire the UI can see |
| `repertoire.ts` | Line/tree model, `collectStudyLines`, SRS scheduling, per-opening rank |
| `openingBuilder.ts` | Builds the annotated "Your openings" lines from your games, plus the Train bridge |
| `yourOpenings.ts` | The drill itself: which lines are offered at a rank, which positions are askable, the minimum line depth |
| `dailyPlan.ts` | Pure function: today's ranked plan, and the reason each row is there |
| `gameOpenings.ts` | Derives training lines and positions from Lichess public games; decides what is a book move |
| `gameScan.ts`, `scanPlan.ts` | Scan recent games for move quality, mine puzzles, and drive the resumable import |
| `lichess.ts`, `lichessStore.ts` | Lichess client + PGN reader, and persistence of account, games and decisions |
| `engine.ts` | Engine protocol: search, evaluation, MultiPV, PGN/analysis helpers |
| `evals.ts` | Static evaluation book for fast, engine-free feedback |
| `moveQuality.ts` | Classifies a played move against the engine's best, into exactly six labels |
| `drift.ts` | Detects when you leave the book and measures the cost |
| `srs.ts` | Spaced-repetition scheduling |
| `puzzles.ts`, `puzzleProvider.ts` | Puzzle bands and the live Lichess fetch, with a reason for every failure |
| `puzzleLine.ts` | Mined-puzzle line replay, odd-length trimming, later-move uniqueness and legacy one-move retirement |
| `puzzlePool.ts` | Bundled offline puzzle deck and its legality replay |
| `endgameTrainer.ts` | Endgame drill generation, live position fetching and scoring |
| `coach/` | Grounded coach pipeline: facts, prompt, grounding guard, template or local-model narrator |
| `bots/` | Bots built from public game archives: sources, profile, mimic scoring, play and review |
| `background.ts`, `statsJobs.ts` | Long-running jobs that outlive a screen (import, scan, bot build, model download) |
| `rating.ts`, `stats.ts`, `statsFromLichess.ts` | Rating model and statistics aggregation |
| `store.ts` | Zustand store (progress, settings, session state), including the position-progress writer |
| `db.ts` | SQLite persistence |
| `sounds.ts`, `theme.ts` | Sound and theme preferences |

---

## Opening repertoires

Every repertoire is a flat list of studies, each with a 30-ply (15 moves per
side) mainline and any number of replacing variation branches. Line counts:

| Repertoire | Side | Chapters | Studies | Lines |
|---|---|---|---|---|
| Sicilian Defense | Black | 12 | 114 | 441 |
| Indian Defenses | Black | 10 | 88 | 325 |
| Ruy Lopez | White | 8 | 48 | 322 |
| Queen's Gambit | White | 10 | 83 | 315 |
| Italian Opening | White | 8 | 48 | 290 |
| Blackmar-Diemer Gambit | White | 9 | 49 | 289 |
| King's Indian Defense | Black | 8 | 48 | 275 |
| Bishop's Opening | White | 10 | 41 | 225 |
| Réti Opening | White | 9 | 43 | 223 |
| Modern Defense | Black | 11 | 39 | 221 |
| Tarrasch Defense | Black | 5 | 27 | 219 |
| Pterodactyl Defense | Black | 7 | 33 | 217 |
| London System | White | 8 | 50 | 216 |
| King's Indian Attack | White | 8 | 51 | 210 |
| Colle System | White | 8 | 51 | 206 |
| Nimzowitsch Defense | Black | 8 | 43 | 203 |
| English Opening | White | 9 | 65 | 191 |
| Zukertort Opening | White | 11 | 49 | 164 |
| Van Geet Opening | White | 8 | 33 | 109 |
| Bird's Opening | White | 7 | 28 | 80 |
| Scotch Opening | White | 8 | 17 | 68 |
| Polish Opening | White | 7 | 29 | 64 |
| Caro-Kann Defense | Black | 7 | 15 | 60 |
| French Defense | Black | 7 | 14 | 56 |
| Semi-Slav Defense | Black | 4 | 9 | 51 |
| Catalan Opening | White | 3 | 11 | 44 |
| Grünfeld Defense | Black | 3 | 9 | 36 |
| Queen's Gambit Accepted | White | 3 | 7 | 36 |
| Philidor Defense | Black | 4 | 4 | 36 |
| Slav Defense | Black | 3 | 8 | 32 |
| Nimzo-Indian Defense | Black | 3 | 7 | 28 |
| Scandinavian Defense | Black | 3 | 3 | 27 |
| Queen's Indian Defense | Black | 2 | 4 | 16 |
| Bogo-Indian Defense | Black | 2 | 4 | 16 |
| Alekhine Defense | Black | 2 | 4 | 16 |
| Pirc Defense | Black | 2 | 4 | 16 |
| Petrov Defense | Black | 2 | 4 | 16 |
| Four Knights Game | Black | 2 | 4 | 16 |
| King's Gambit | White | 2 | 4 | 16 |
| Benoni Defense | Black | 2 | 4 | 15 |
| Vienna Game | White | 2 | 4 | 15 |
| Dutch Defense | Black | 2 | 4 | 14 |
| **Total** | | **249** | **1204** | **5 435** |

<!-- Corpus totals, recounted from the repertoire JSON. Do not hand-edit a row without
     recounting the whole corpus: the per-opening counts and the totals are two views
     of the same data. An earlier copy of this note said "18 openings", which is how a
     table outlives the thing it describes: the prose above it had moved on to 42 and
     the number in the comment never did. The gate suite
     (`node scripts/run-gates.mjs`) verifies repertoire structure, ids and line counts;
     update this table when the corpus changes. -->

### Promoted chapters

The Catalan, the Semi-Slav, the Slav, the Queen's Gambit Accepted and the Grünfeld
were originally *chapters inside* other repertoires — chapters 5-8 of the Queen's
Gambit, and chapter 6 of the Indian Defenses. They are now openings in their own
right, because they are taught, drilled and edited independently from now on.

The chapters they came from are still in place, so the Queen's Gambit keeps its own
copy of the Catalan, the Slav, the QGA and the Semi-Slav. That is deliberate
duplication, not an oversight: sharing one copy in memory would mean the next content
update to the Catalan silently rewrote the Queen's Gambit too.

The move trees were **moved rather than retyped** — the split changes only what must
change (the study `id`, because `studyIndexAll()` builds one flat index across all
openings, so a shared id would make one opening silently shadow another; the
`chapter` string; and the `lineCount` / `stats`, recomputed with the app's own
`collectStudyLines`).

### Reference indexes

Four studies are `type: "Reference"`: prose "Tactical Motifs Index" entries whose
content is a checklist pointing at the studies that demonstrate each motif, with a
single placeholder move so they render as a card. They have **no lines by design** and
are not drillable. The app honours that type — they are excluded from the progress
denominator, offered no Practice button, shown with no mastery bar, and skipped by the
Train picker. A fifth study (`kia8.6`) was *mislabelled* as a reference while holding
a real 30-ply line, and was corrected to `Tactics`.

Each mainline is exactly **30 plies**. Where a book line is shorter, the
remaining moves are completed with engine-verified top play and carry an
explicit filler marker so authored content is never confused with generated
content. Every generated move passes a static-exchange gate: it may not allow a
mate in one, may not end the game before ply 30, and may not concede forced
material.

---

## Naming

The app is **ChessForge** everywhere: the launcher label, the URL scheme, the
repository, the directory, the Expo slug, the npm package, the SQLite filename, the
storage-key namespace and the Android applicationId. Renaming the last three costs
the existing local data — the app opens with a fresh database, and the build is a
new application id rather than an upgrade. That was a deliberate choice, and the
reasoning is in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

The previous brand name appears nowhere in this repository — not in code, not in
comments, not in the docs, anywhere. Gate 1h enforces that and fails the build on a
single occurrence. The only place the word still exists is inside that gate's own
source, which has to contain it in order to search for it; the gate prints the count
on every run so the exemption is visible rather than silent.

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — engine bridge, data model, coach,
  bots, background jobs and state
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — local setup, build, the full gate
  suite, troubleshooting
- [`docs/REPERTOIRES.md`](docs/REPERTOIRES.md) — how the repertoires are authored
  and verified

---

## Licence

See [`LICENSE`](LICENSE). Stockfish is bundled under **GPL-3.0**; its licence
text and provenance are documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#engine-licensing).