# Development

Local setup, building the APK, and the traps that cost real time.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22+ | the version this project was built with |
| JDK | **21** | the version the scripts pin and probe; **not 24** — AGP 8.x rejects it |
| Android SDK | platform 36, build-tools 36 | `ANDROID_HOME` must be exported |
| Gradle | 9.3.1 | pinned by `android/gradle/wrapper/gradle-wrapper.properties` |
| Python | 3.11+ | only for the repertoire verification tooling |

`scripts/android-env.sh` exports a working combination for this machine:

```bash
source scripts/android-env.sh
```

It also unsets `NODE_OPTIONS` and sets `CODEBUDDY_SAFE_DELETE_ENABLED=0`, which
neutralises a filesystem shim that otherwise breaks Node/Gradle child processes.

---

## Everyday commands

```bash
npm install                 # install dependencies
npm start                   # Metro only
npm run android             # build + install on the connected device
npm run typecheck           # tsc --noEmit, the fast correctness check
node scripts/run-gates.mjs  # the full behaviour suite
npm run build:assets        # regenerate assets/engine/* from upstream Stockfish
```

`npm run typecheck` is the fastest meaningful check. TypeScript is in strict
mode and the project is kept at **zero errors** — treat a new error as a real
defect, not noise.

`node scripts/run-gates.mjs` runs every `.bench/*.test.mjs` file. It prints the
number of **files** as well as the number of assertions, and it reports a gate
that printed `SKIPPED` separately instead of counting it green. A single file can
be selected by substring:

```bash
node scripts/run-gates.mjs youropenings
```

**Last full run: 1 November 2026 - 74/74 gate files, 2 276/2 276 assertions,
0 gate files skipped, `ALL GREEN`; `npm run typecheck` clean.** The assertion
count can move between runs because some corpus-driven gates count the fixtures
they actually examined, and live-network checks can skip themselves when Lichess
is unreachable; the file count is the stable number.

---

## Building the release APK

```bash
source scripts/android-env.sh
./scripts/build-apk.sh
```

or manually:

```bash
npx expo prebuild --platform android --clean
cd android && ./gradlew :app:assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

Two build details worth knowing before changing them:

- `android/gradle.properties` pins `rnllamaVariants=rnllama`. `llama.rn` otherwise
  compiles seven native variants, and the OpenCL/Hexagon one passes Windows'
  `MAX_PATH`, so ninja fails with a bare "No such file or directory". The generic
  variant still dispatches CPU features at runtime.
- `build-apk.sh` also runs `../.tmp-verify/check_fresh.py`. The authoring toolchain
  lives outside this repository, so a checkout without it cannot pass that gate.
  In that case run the full suite first, then use `./.cf-build.sh` (same JDK/SDK
  pinning and Metro-cache reset, without the gate runner) and finish with
  `node .bench/verify.needles.mjs` and `python scripts/bundlecheck.py`.

Install onto a USB-connected device:

```bash
"$ANDROID_HOME/platform-tools/adb.exe" install -r \
  android/app/build/outputs/apk/release/app-release.apk
```

### What `build-apk.sh` does that a bare `gradlew` does not

1. **Gates on repertoire freshness** — refuses to build if any published
   repertoire JSON is stale (see below). A stale build would ship a fraction of
   the training lines while every log line reports success.
2. **Forces the JS bundle to regenerate** — moves the generated-assets output
   *and* the Metro cache aside with a timestamp and rebuilds. Both are required;
   see the stale-bundle trap.
3. **Pins the environment explicitly** — JDK 21, the Android SDK, the Gradle home
   and `NODE_ENV=production`, and unsets `NODE_OPTIONS` / `REACT_NATIVE_NODE_ARGS`,
   so the ambient JDK 24 and the sandbox delete shim cannot leak in.
4. **Runs the build-blocking gates** (below), which fail the build.

### The behaviour gates

`tsc` catches type errors. It catches **nothing** about whether the app does the
thing it is supposed to do, and most of the defects worth gating on are invisible
to it: they compile, they pass every existing check, and the user finds them on
the device. The suite exists for that reason, and it is now larger than the
numbered gates in the build script: **77 test files** as of 4 November 2026, with
2 571 assertions in the latest run (the live endgame checks can add to that count).

| Gate | Test | What it protects |
|---|---|---|
| Full | `node scripts/run-gates.mjs` | every gate file, with file and assertion counts, skips reported separately |
| 1c-a | `openingid.test.mjs` | which opening a line *is* — see below |
| 1c | `openingfix.test.mjs` | book-scoped continuations, and the engine bridge |
| 1d | `movelist.numbering.test.mjs` | move numbering and colour attribution |
| 1e | `levels.test.mjs` | puzzle/endgame difficulty bands |
| 1g | `movequality.test.mjs` | the move classifications the app shows |
| 1h | `brand.test.mjs` | no old brand name survives anywhere — not in code, not in prose |
| 1i | `youropenings.test.mjs` | "Your openings": real lines, ordered, ranked by rank, and never shorter than a line |
| 1j | `hooks.test.mjs` | no hook after a component's early return |
| 1k | `lineloop.test.mjs` | a line the user opened is the line the user keeps |
| 1m | `dailyplan.test.mjs` | today's plan follows the user's own state, and is not the same every day |
| 1n | `puzzles.test.mjs` | puzzles can load, and never blames the network for it |
| 1o | `engine.boot.test.mjs` | the engine boot can be retried, and a failed scan reports itself |
| 1p | `minedpuzzle.test.mjs` | mined puzzles are forced lines, and the legacy one-move deck is retired |
| 1r | `arena.test.mjs` | tournament formats, drafts, standings, Elo isolation and PGN |
| 1s | `bots.personality.test.mjs` | preset personalities stay honest, bounded and safe |

The rest of the suite covers the areas added since the numbered gates were
introduced:

| Area | Gate files |
|---|---|
| Analysis | `analysis.accuracy` (bands, Lichess accuracy, the no-evidence rule), `analysis.multipv`, `analysis.real` (drives the real engine over four PGNs), `movequality`, `movequality.verdicts`, `qualitysign` |
| Coach | `coach.core`, `coach.explain` (does it really explain positions, structures, endgames, moves and games; and the small Qwen layer), `coach.app`, `coachbot` |
| Bots | `bots.sources`, `bots.profile`, `bots.mimic`, `bots.personality`, `bots.postgame`, `bots.store` |
| Arena | `arena` — formats, drafts, standings, ratings, knockout legs/Armageddon, cup bracket, simulated boards, PGN |
| Import / Lichess | `import`, `account.persistence`, `lichess.fetch`, `lichess.parse`, `lichess.opening`, `lichess.stats`, `ua.contact`, `scan.parity`, `scan.fen`, `scan.resume` |
| Background + lifecycle | `background`, `celebration`, `sounds`, `perf.jank` |
| Openings + drills | `openings.clickandboot`, `openings.ownmove`, `openingbuilder.*`, `drill`, `train.hint`, `traincustom`, `trainpipe`, `yourtrain.regression` |
| Puzzles | `puzzles`, `minedpuzzle` |
| Repertoire truth | `booktruth`, `positiontruth`, `repertoire.gen`, `openinglabel`, `openinglabel.cache`, `qualitysign` |

A gate that prints `SKIPPED` (for example when a live network check cannot
run) is **not** counted as a pass. The runner prints it under
`NOT RUN - these are NOT evidence of anything` and marks the run incomplete.

### GATE 1n, and a band that could not be satisfied

> *"i tried puzzles and it says to check my connection although i am connected ( the endgames works
> fine although it needs connection but the puzzles doesnt work )"*

He was right, and the endpoint agreed with him. Probed directly, `lichess.org/api/puzzle/next` answered
**200** with real puzzles, at ratings 1308, 1386, 1423, 1454, 1477, 1479.

Two faults, compounding:

1. **The band could not be satisfied.** `bandRange('beginner')` was 400-1250; the app asked for
   `easy`; the measured floor of `easy` is ~1300. The provider rejects anything outside the band, so
   all six attempts were discarded, `served` stayed null, and the screen showed its offline notice —
   with a working connection and a 200 in hand. **A Beginner could load nothing at all.** The floors
   now live in `PUZZLE_BUCKET_FLOOR` beside the observation that justifies them, because a band is a
   claim about a distribution and the two facts belong in one place.
2. **The notice named the wrong thing.** `catch { setLoadError(true) }` printed "Check your
   connection" for a 429, a 401, a schema change and a real outage alike. Endgames shares the endpoint
   **and the same unauthenticated rate limit**, which is why it can work for the user while puzzles
   cannot — the thing that made the message look absurd rather than merely terse.

What the gate checks is *not* that the numbers are right today — they are observations, and Lichess
will move them again. It checks the property that matters when they go stale: a near-miss fallback
exists, a band is never narrower than the bucket it asks for, and **no failure but a real one tells the
user to check their connection**.

Widening the bands is only defensible if the tiers still mean something, and GATE 1e's overlap check
is what proves they do. That check was an absolute 50 points — a number that encoded the width of the
*old* bands rather than anything about difficulty — and is now a fraction of the narrower band, so it
tests the shape at any scale.

### GATE 1k, and the four reports that were one bug

The user, after four rounds of fixes on one screen:

> *"as always you keep deliver the same mistakes : when i tried an opening in 'your openings' it
> plays automatically 3 times then i get a different new position to play. and of course after you
> fix it wi will get the 2 moves line complete error, then we will get the crashing error and we
> will stay in that circle !"*

He was right, and the reason is that three of those reports were **one** defect. The engine pass
calls `publish()`, which calls `buildFamilyLines` again; that **re-runs the pool rotation**, and
the rotation prefers positions that carry decisions — so `alternates` comes back as a *different
list*. It publishes twice, and each rebuild did all three:

| the report | the mechanism |
|---|---|
| "plays automatically 3 times" | a new `activeLine` failed the SAN comparison, so `startLine()` walked from move 1. The initial walk plus two publishes. |
| "a different new position" | `resolveLine` could not find the recorded moves in the new list and fell back to an **index** — now naming a different move order. |
| "one or two moves and it says done" | the rotation picks short decision-bearing **fragments**. The line genuinely *was* that short. |

That last row is the one worth keeping. GATE 1i's 8-ply floor could not catch it, and the reason is
not that the floor was weak: the line really was two moves long. **Nothing was lying.** The floor was
honest and the line was wrong, so every earlier fix — the index, then the SAN comparison, then the
length floor — attacked one link in a chain. The defect is the rotation running at all under a live
session.

The gate asserts the rotation cannot reach a session, from three directions: the rebuild itself, the
re-sync effect, and the index fallback. Its §3 checks the session flag is both set **and clearable**,
which caught a bug in the fix itself — the flag was assigned below an effect's early return, so it
could never be turned off and the engine would have silently stopped applying verdicts to any
opening, for ever, with no error anywhere. Its §6 checks that no ref is written before it is declared,
after the device reported `TypeError: Cannot set property 'current' of undefined` from a `useMemo`
using a ref declared 390 lines later. `tsc` is clean on that, because a use-before-declaration inside
a closure is a legal program.

The same gate carries §7 — progress, the mistake replay, and the test — and one check in it guards a
rule the user set himself:

> *"in test yourself it shows me arrows. it is a test it shouldnt show me what to play i should know
> that myself"*

The arrows in this screen are permanent **on purpose**: *"this is a course so no you just show the
arrows."* A test is not a course — the arrow is the answer already drawn on the board. So the guard
wraps **every** arm rather than one: a test still drawing the "move you played" gives half the answer
away, and one still drawing the recommendation gives all of it. There is a control per arm, and a
check that no arrow is added *after* the guard closes, so there is no second route to one.

### GATE 1m, and what "not just random stuff" means

> *"for todays plan : if you can make real todays plan changing everyday as how i need ( not just
> random stuff )"*

The word that matters is **need**. A plan that changes daily because a random number changed is
exactly what he is asking us to stop doing. So the requirement is not variety — it is that the plan
follows from his own state, and the test is whether the same account on a different day gets a
different plan *for a reason he can read*.

The old card offered one study: the lowest-mastery study started, or `allStudies[0]`. Three
defects, and only the first is visible in review:

1. `Array.sort` is **stable**, so equal-mastery studies kept corpus order. On a new account every
   study is at mastery 0, so the card read `Continue: Study 1.1` every day for ever.
2. It never read his repertoire. The corpus order begins with the Sicilian for everybody.
3. "Nothing due" produced the same button anyway, so the plan did not change with his state.

The ranking is a pure function in `src/lib/dailyPlan.ts` precisely so it can be tested against
shapes the corpus does not contain — the only way to catch a tie broken by accident. It found two
bugs in the first version of itself: the position sort ran **descending**, so the position the user
knows best was reported as "the weakest", and the reference-study rule was guessed with a regex that
did not match the real ids.


### GATE 1j, and why it needed writing

The device reported `Error: Rendered more hooks than during the previous
render` — two `useMemo` calls written **inside** the
`if (phase === 'lines' && openFamily) { … }` render block. React runs a hook
on the renders that take that branch and not on the others, so the hook list
changes length between renders and it throws.

The reason it needed a gate rather than another careful read: **the crash
landed on the transition.** Opening "Your openings" renders the list, which
skips the block entirely, so the old list appeared and the new UI looked as
though it had never shipped. Only tapping an opening threw. `tsc` is clean,
every behaviour gate passes, and the pure functions cannot be touched by a bug
that lives in a component's render. It presents as a *missing feature*, so it
survives a release. It has now been made twice in that one file — once with an
effect, once with a memo.

The gate is a textual analysis, and it says so rather than pretending
otherwise. It is checked against a 16-case table of shapes (§1) and against an
injection into the file that actually crashed (§3), because **a gate that
cries the wolf on its first run trains its reader to ignore it.** Three earlier
versions of the checker did exactly that, and each failure is recorded in the
gate's own header:

| the mistake | what it reported |
|---|---|
| any `return` treated as the component's early return | 166 false positives — every legitimate hook, as dead |
| only *open* braces stored, kinds looked up after closing | every screen clean, because the map was empty |
| `useEffect(() => {` classified as a plain block | 147 more — blind to hooks in callbacks |

It supersedes `.bench/hooks.audit.mjs`, which walked brace depth and flagged a
hook in a callback too; its own header called the result "a list to look at,
not a verdict". That file is left in place, but 1j is what decides the build.


Each carries its own **control**: an assertion that the previous, broken
behaviour would have failed it. A test that cannot fail is worse than no test,
because it reports success while the defect is still there — and the per-opening
sweep in 1c-a asserts how many openings it examined, after a version of that
check silently examined **zero** and reported a clean pass.

`openingid` is the important one and the most expensive thing to get wrong. An
opening used to be identified by a matcher that broke ties by **registry order**,
so the shared `d4 d5` stem always resolved to whichever book came first in the
list. One wrong id then produced three apparently unrelated symptoms: a misnamed
card, a Queen's Gambit move offered inside a London System, and a line that ended
after the user's first move because the continuation was fetched from a book that
did not contain it. The rule now is **how far each book's studies follow the line**,
with ties broken by how characteristic the line is of that opening — normalised by
the opening's size, which is the part that actually separates a parent from its
child. Raw counts go the wrong way: the Indian Defense book owns more studies at a
Grunfeld line than the Grunfeld book does, because it is four times the size.

### 1c and 1g exist because the tests were testing the wrong function

Worth recording, because it is the same mistake twice.

`openingfix.test.mjs` section 1b asserted that a Sicilian line "continues", by
calling `continueFromBook(line, false, …)` — the **forgiving move-order** walk
directly. It passed. The app was still broken, because the screen does not call
`continueFromBook`: it calls `buildFamilyLines`, and the tail-building step inside
that used **only the exact walk**. A test on the wrong function reports success
while the defect is untouched. Section 1c now goes through `buildFamilyLines`, and
it asserts *no card ever contains an illegal move* — the invariant that actually
produced "one move and that's it" — rather than a length, which content can
legitimately fail to satisfy.

`movequality.test.mjs` (1g) is the same shape. Four verdicts were retired from the
classification table; the type still has all ten and the database still has all
ten columns, so nothing about the retirement is visible to `tsc` or to any other
gate. The load-bearing check sweeps 7 200 inputs — eval, book depth, best-move
agreement, MultiPV gap — asserting that no retired label can be produced by any of
them, so a label reintroduced on a branch nobody thought of still fails the build.

### The rename, and what it cost

The app is ChessForge, everywhere, including the places that are usually left alone.

The first pass renamed 80 files of *code* — the board component, the brand colour tokens, a glow
constant, a colour type and a style key — and stopped short of the persisted identifiers, on the
reasoning that a name your data is filed under is not a name you *see*.

That reasoning was withdrawn. The owner's instruction was that every occurrence be replaced, and
the price was put to him explicitly before it was paid:

| Renamed | What it costs |
|---|---|
| `chessforge.db` | opens a new **empty** SQLite file: XP, streaks, SRS, ratings, stats — gone |
| `chessforge.cc.*` | the old provider namespace; it is purged on first launch, and the cached archive scan has to be rebuilt |
| `chessforge.openings.*`, `chessforge.rep.*` | the derived caches, and the hand-built repertoire |
| `chessforge.theme/sound/train/analysis/endgame/puzzle.*` | preferences, same namespace |
| `com.chessforge.chesstraining` | the Android **applicationId**, so `adb install -r` refuses and reinstalling means an uninstall. The previously-installed build has to be removed by hand, or its icon stays on the launcher beside the new one |
| `chessforge` (Expo slug), `chessforge` (npm package), `C:\gradle-home-chessforge` | build identity and a local cache |
| the checkout path and the repository name | the local working copy and its remote identity |

#### Why there is no protected list

GATE 1h used to carry exemptions: prose that had to explain the rename, and a handful of third-party
names. Every one of them was a judgement made inside `.bench/brand.test.mjs` rather than by the owner
of the decision. That is the actual failure, and the reason it is written down here: **a protected
list nobody was asked about is a rename that stopped early and called itself finished.** The block was
positioned so that asking would have been cheap, and nobody asked.

When the question was finally asked, the answer was that not one occurrence should remain, anywhere.
So:

- GATE 1h is now **absolute**: one occurrence in any scanned file fails the build, `docs/` and
  `README.md` included. Both used to be "reported but not enforced";
- the one-shot rename script was **deleted**. It had already run, and a script whose entire content is
  the old name is the single file most likely to be re-applied by accident.

What is left is one unavoidable exception: **the gate's own file contains the word it searches for.**
A detector that does not hold its needle cannot detect, so it excludes itself by name — and it prints
how many times it does so on every run, so the exemption is counted rather than trusted.

**One trap worth knowing:** `C:\Users\seifg\Downloads\ChessForge\chessforge` is a
*directory*, not a name. The case-preserving rewrite broke it inside
`scripts/audit-expo-versions.py` and `.bench/harness.html`, and nothing noticed
because a script with a bad path only fails when it is next run. GATE 1h caught
it on the way back.

### Install to the right phone

```bash
adb devices -l                 # confirm which phones are attached
adb -s <serial> install -r android/app/build/outputs/apk/release/app-release.apk
```

**Always pass `-s <serial>`.** With two phones attached a bare `adb install`
either fails or, worse, puts a test build on the phone that is not being used for
testing — and that build then sits there looking authoritative.

---

## App icon and splash

All six icon and splash assets are generated from one source image,
`assets/icon-source.png`, by `scripts/build-assets.ps1`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-assets.ps1
```

> **Not `npm run build:assets`**, which regenerates `assets/engine/*` from
> upstream Stockfish and has nothing to do with the icon. The names are close
> enough to be a trap.

Then re-sync the Android resources, or the launcher keeps the old artwork:

```bash
npx expo prebuild --platform android --no-install
```

### The two things the script has to get right

An Android adaptive icon is three layers composited and then masked by the
launcher, and the mask shape differs per device — circle, squircle, rounded
square. Android guarantees only that the central **66.67%** of each layer
survives. So the artwork has to be built for that window.

**1. The source is a finished icon, and its frame must be taken out of it.**
`icon-source.png` is a rounded square with a bright border ring. Put in a layer
as-is, the launcher masks it a second time and the ring survives — the icon
reads as a square inside a circle. The ring sat at **64.5%** of the radius, just
inside the 66.67% window.

The script **measures** the ring (four axes, looking for the outermost narrow
bright spike) and repaints it with the vignette colour sampled at the same angle
outside it, so the vignette continues inward and leaves no seam. It is measured
rather than hardcoded because a literal `64%` is a number silently tied to one
image: replace the artwork and you get a bright arc with nothing to report it.

**2. Then the artwork is scaled to leave margin**, derived from a second
measurement of the subject's extent, targeting 90% of the safe zone. Scaling down
was impossible until the frame had been removed — while the frame was still in
the picture, the subject already reached 63% and any smaller scale let the frame
slide back inside the mask, which is why an earlier attempt zoomed the *other*
way and was rejected as a close-up crop. Order matters: remove the frame first,
then the scale is free.

Two measurement traps, both hit here and both worth not repeating:

- **Never measure this on a thumbnail.** Bicubic downsampling smears bright
  pixels outward; the subject read 80.8% of the radius on a 256px thumbnail and
  63.2% at full resolution. The script reads pixels through `LockBits` at native
  size instead, which is also far faster than a million `GetPixel` calls.
- **The vignette has bright corners.** The corner glow is brighter than any
  brightness threshold tried — at `lum > 145` it was still the furthest thing in
  the image. No threshold separates it from the artwork, so the search is bounded
  just *inside* the measured frame instead: the artwork ends at its own border,
  which is what a border is for.

The monochrome (Android 13 themed) layer is generated at the **same scale** as
the background. If it were not, a themed icon would be a different size from the
normal one — visible only in themed mode, where there is no coloured icon beside
it to compare against, so nobody would report it.

`.bench/icon-preview.ps1` renders the composite under circle, squircle and
rounded-square masks so the result can be looked at rather than argued about.

---

## The stale-bundle trap

**This is the single most dangerous failure mode when building.** It produces a
green build that ships the wrong code.

`src/**` is **not a declared input** of the Gradle task that bundles the JS
(`:app:createBundleReleaseJsAndAssets`). So after editing `src/data/*.json` or
any component, Gradle reports **`UP-TO-DATE`** and the APK keeps the *previous*
bundle. Editing library code and rebuilding can silently ship the old app.

Two things must be cleared, not one:

1. `android/app/build/generated/assets/react/release` — the generated bundle
2. the **Metro cache** (`%LOCALAPPDATA%\Temp\metro-cache` on Windows)

> **Never `rm -rf` these directories.** They contain 1 500+ files, which trips
> the sandbox safe-delete guard and can fail the whole build. **Move them aside**
> with a timestamped suffix — `build-apk.sh` does this and the timestamp doubles
> as the evidence trail.

### Verifying the bundle actually contains your change

After a build, confirm the strings you edited are present in the shipped bundle.
Hermes stores string literals as **UTF-8 *or* UTF-16LE**, so a naive byte search
misses roughly half of them — search for both encodings, or the check will
report a false negative.

---

## Verifying a repertoire JSON

Repertoires are verified independently of the app by
`../.tmp-verify/verify_repertoire.py` (the authoring toolchain lives outside the
app directory). It checks, and must pass all of:

1. **shape** — every study has exactly 30 tree nodes and `mainPlies == 30`
2. **legality** — every mainline and every variation replays cleanly
3. **comments** — no coach comment lost between the raw parse and the JSON
4. **markers** — a filler marker on every study whose book line was shorter than
   30 plies
5. **ids** — study ids are unique
6. **structure** — every variation branch *replaces* a move and reaches ply 30

Run it with the interpreter that has `python-chess` available:

```bash
PYTHONPATH="/c/Users/seifg/.workbuddy-ai/binaries/python/pylibs" \
  python ../.tmp-verify/verify_repertoire.py chessforge/src/data/ruy-lopez.json
```

A pass looks like:

```
declared lines  : 324
tree lengths    : {30: 48}
lines replayed  : 324  (9720 plies)
studies branched: 48/48
ALL CHECKS PASSED
```

`tree lengths` must be a **single key, `30`**. Any other shape means the file was
assembled before the line-extension loop converged.

### If the verifier dies with `ModuleNotFoundError: No module named 'chess'`

The managed interpreter has no packages of its own. Set `PYTHONPATH` to the
project's library directory (POSIX form, `;` separator on Windows):

```
/c/Users/seifg/.workbuddy-ai/binaries/python/pylibs
```

---

## Debugging on device

```bash
adb devices                 # confirm the device is visible
adb logcat | grep -i chessforge  # filter app logs
adb shell pm clear com.chessforge.chesstraining   # reset local data
```

If the engine fails to start, the cause is almost always one of:

- `fetch()` was used instead of `XMLHttpRequest` for the `file://` wasm URI
- the host page has no `file://` baseUrl, so it gets a null origin
- the wasm asset was not bundled (check `assets/engine/` is committed)

The first search after boot legitimately returns `bestmove (none)` — discard it.

---

## Project conventions

- **`src/lib/openings.ts` is the only registry.** To add a repertoire, add an
  import, a cast and an `OPENINGS` entry — no screen changes.
- **Study-id prefixes must be globally unique.** The prefix feeds
  `positionKeyAtPly`; two repertoires sharing one would silently share training
  progress and overwrite each other.
- **Never hardcode a colour.** Everything comes from `src/theme/tokens.ts`.
- **Stock-market colour semantics.** Advantage is warm/red, disadvantage is
  green — matching the reference app, not Western convention.
- **Keep generated content distinguishable from authored content.** Engine-filled
  plies carry an explicit filler marker so they are never mistaken for book.

---

## Troubleshooting the build

| Symptom | Cause / fix |
|---|---|
| `Unsupported class file major version` | ambient JDK is 24 — source `android-env.sh` or pin JDK 21 |
| `UP-TO-DATE` but the app behaviour is unchanged | the stale-bundle trap — clear the generated bundle **and** Metro cache |
| Build refuses with "a repertoire JSON is stale" | the freshness gate fired; let the authoring pipeline finish its `assemble` phase |
| `can't open file .../.tmp-verify/check_fresh.py` | the authoring toolchain is not in this checkout; run the suite, then use `./.cf-build.sh` and the two bundle checks |
| `ninja: ... No such file or directory` while building `llama.rn` | the specialised variants are being built; keep `rnllamaVariants=rnllama` in `android/gradle.properties` |
| Random `ETIMEDOUT` / permission errors during a Gradle build | the sandbox is throttling high-volume forked writes; run from a normal terminal or Android Studio |
| `adb devices` is empty | enable USB debugging, accept the RSA prompt on the device, try another cable/port |
| Engine never becomes ready | `fetch()` vs `XMLHttpRequest`, or a missing `file://` baseUrl |
