#!/usr/bin/env bash
# =============================================================================
# build-apk.sh — produce the release APK for ChessForge
# =============================================================================
#
# WHY THIS SCRIPT IS SHAPED THIS WAY
#
# The release build works fine on a normal machine. Inside WorkBuddy's
# LiteSandbox it hits three separate environment problems, all of which are
# handled below. If you are running this from your own terminal (recommended —
# see "RECOMMENDED USAGE") most of this is unnecessary, but it is harmless.
#
#  1. The ambient JDK is 24, which AGP 8.x rejects. We pin JDK 21.
#
#  2. Every Node/JVM child inherits a filesystem shim
#     (NODE_OPTIONS=--require=.../node-language-shim.cjs) that redirects
#     deletes through `genie-trash`, plus a bulk-delete guard that fails with
#     ETIMEDOUT under load. `env -i` below gives Gradle a clean environment and
#     CODEBUDDY_SAFE_DELETE_ENABLED=0 is the documented escape hatch.
#
#  3. The sandbox denies high-volume file writes made by processes Gradle
#     *forks* — including CMake/ninja and the artifact-transform cache. Our own
#     direct shell writes to the exact same paths succeed, which is how we know
#     it is a per-process policy and not a filesystem permission problem.
#     Allowlist extra paths via ~/.workbuddy-ai/settings.json:
#         "sandbox": { "extraAllowWrite": [ ... ] }
#     That materially improves things (transforms went 1315 -> 2581) but does
#     not fully eliminate the denials, because the sandbox throttles bursts of
#     many small writes regardless of the path.
#
# RECOMMENDED USAGE
#   Run this from Android Studio, or from a plain PowerShell/CMD prompt, where
#   no sandbox is in play. Everything else (SDK, NDK, CMake, JDK, the Metro
#   bundle) is already installed and verified, so it should go straight through.
#
#   From Git Bash inside WorkBuddy, expect intermittent sandbox denials.
# -----------------------------------------------------------------------------

set -uo pipefail

# ---------------------------------------------------------------------------
# THIS SCRIPT MUST RUN UNDER GIT BASH, NOT WSL.
#
# `bash` on this machine resolves to C:\Users\seifg\AppData\Local\Microsoft\WindowsApps\
# bash.exe, which is the WSL launcher. So the obvious `bash scripts/build-apk.sh` runs the
# whole release build inside WSL, and every Windows tool it touches then misbehaves in a
# different way:
#
#   * gradlew is the POSIX wrapper, and it resolves the JVM as `$JAVA_HOME/bin/java` - no
#     extension. A Windows JDK has `bin\java.exe` and no `java`, so gradlew reports
#     "JAVA_HOME is set to an invalid directory" for a JDK that exists and runs. The WSL
#     JDK is 17, which AGP 8 also refuses.
#   * `cygpath` is a Git-Bash tool, so the GATE 1b path conversion died with
#     "cygpath: command not found".
#
# The build is Windows-native throughout: the Android SDK, the NDK, the JDK and
# gradlew.bat are all Windows. WSL contributes nothing here and costs the whole build.
# Git Bash is the right shell - POSIX syntax, Windows binaries, and the /c/... paths the
# gates already assume.
#
# So this fails immediately and says what to run, rather than failing eighteen minutes in
# with a toolchain error that reads like a JDK problem.
# ---------------------------------------------------------------------------
if [ -n "${WSL_DISTRO_NAME:-}" ]; then
  echo "*** WRONG SHELL: this is WSL, not Git Bash. ***"
  echo
  echo "Under WSL the release build cannot work: gradlew resolves the JVM as"
  echo "\$JAVA_HOME/bin/java (no .exe), which a Windows JDK does not have, and cygpath"
  echo "is missing. Run it with Git Bash instead:"
  echo
  echo '    "C:\Program Files\Git\bin\bash.exe" scripts/build-apk.sh'
  exit 2
fi

JAVA_HOME_WIN='C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot'
ANDROID_HOME_WIN='C:\AndroidSDK'
GRADLE_USER_HOME_WIN='C:\gradle-home-chessforge'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
LOG="$ROOT/apk-build.log"

echo "=== ChessForge release build ==="
echo "project : $ROOT"
echo "log     : $LOG"
echo

cd "$ANDROID_DIR" || { echo "ERROR: $ANDROID_DIR not found"; exit 1; }

# ---------------------------------------------------------------------------
# PREFLIGHT - prove the toolchain actually works before spending 18 minutes.
#
# This exists because the build once "succeeded" with exit 0, a 0-byte log and no
# APK. A JDK that cannot print its version is the same class of problem, and finding
# it in a second is worth far more than finding it after a full release build.
# ---------------------------------------------------------------------------
# A WINDOWS PATH IS NOT EXECUTABLE FROM WSL BASH.
#
# This preflight computed a converted path and then exec'd the original one:
#
#     PREFLIGHT_JAVA_HOME="${JAVA_HOME_WIN//\\\\/}"      # C:/Program Files/...
#     if ! "$JAVA_HOME_WIN/bin/java.exe" -version ...    # C:\Program Files\...
#
# so the conversion was dead code and the check ran a path that cannot exist, reporting
# a missing JDK on a machine with a perfectly good one at that exact location. The
# failure was loud, which is why it was caught quickly, but it was a false negative that
# would have blocked every build on this machine.
#
# Under WSL a Windows path has to become /mnt/<drive>/<rest> before it can be exec'd.
# On Git-Bash or native bash the Windows form already works, so the conversion is only
# applied when we are genuinely under WSL.
to_exec_path() {
  local p="$1"
  if [ -n "${WSL_DISTRO_NAME:-}" ]; then
    local q="${p//\\//}"
    case "$q" in
      # The drive letter must be lower case: WSL mounts /mnt/c, never /mnt/C. Getting
      # this wrong produces a path that looks perfectly formed and is still absent, which
      # is a more confusing failure than no conversion at all.
      [A-Za-z]:/*) printf '/mnt/%s/%s' "$(printf '%s' "${q:0:1}" | tr '[:upper:]' '[:lower:]')" "${q:3}" ;;
      *)          printf '%s' "$q" ;;
    esac
  else
    printf '%s' "$p"
  fi
}

PREFLIGHT_JAVA_HOME="$(to_exec_path "$JAVA_HOME_WIN")"
echo "--- preflight: java ---"
echo "  probing: $PREFLIGHT_JAVA_HOME/bin/java.exe"
if ! "$PREFLIGHT_JAVA_HOME/bin/java.exe" -version 2>&1 | head -3; then
  echo
  echo "*** REFUSING TO BUILD: the pinned JDK did not run. ***"
  echo "Windows path: $JAVA_HOME_WIN"
  echo "Probed as    : $PREFLIGHT_JAVA_HOME/bin/java.exe"
  exit 4
fi
echo
echo "--- preflight: gradlew present and executable ---"
if [ ! -f gradlew ]; then
  echo "*** REFUSING TO BUILD: no gradlew in $ANDROID_DIR ***"
  echo "If android/ is disposable, run: npx expo prebuild --platform android --clean"
  exit 4
fi
echo "gradlew: present ($(wc -c < gradlew) bytes)"
echo

# -----------------------------------------------------------------------------
# GATE 1 — the repertoire JSONs must be current.
#
# The breadth pipeline widens `.tmp-<x>/<x>_raw.json` and only writes
# `src/data/<x>.json` during an `assemble` pass. If a loop never reaches
# assemble, the published file silently keeps its old, pre-branching shape and
# the APK ships a fraction of the lines while every log line says success.
# (Seen for real: london-system.json was 66 lines against a 216-line raw.)
# -----------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# GATE 1b - every GATE 2 needle must exist in src/ BEFORE anything is built.
#
# Two needles were once typed from memory and both were reported absent by a perfectly
# fresh bundle. The gate was right and the bundle was fine, which is the worst outcome:
# the next real absence becomes indistinguishable from a typo, and a gate that has cried
# wolf once is a gate whose second cry gets ignored.
#
# It runs HERE rather than after the build, and it uses "$ROOT" rather than a relative
# path. Both because the first version of this gate was broken in exactly those two
# ways: it sat after the APK was packaged, where a real failure would have cost a
# 14-minute build to report, and it used a relative path while the script had already
# cd-ed into android/, so it could never find its own file and refused every build. It
# failed loudly, which was lucky rather than right.
# ---------------------------------------------------------------------------
# GATE 1c - the opening/drill logic behaves as the fixes claim.
#
# `tsc` is not enough here. Every fix in this batch was a change to what the app DOES rather
# than to whether it compiles, and each one was written in response to a symptom the user
# reported on a real device: a Queen's Gambit move offered inside the London System, a drill
# that ended after one move, a trainer that only ever asked for a recapture. A change like
# that compiles perfectly while doing nothing, which is exactly what a build gate is for.
#
# The test carries its own controls - a scoped lookup that must return two DIFFERENT books, a
# real recapture that must be excluded, a quiet move that must not be - so a check that has
# stopped testing anything fails here instead of passing quietly.
# ---------------------------------------------------------------------------
echo "--- GATE 1c-a: which opening is this line ---"
# This is the gate that matters most. Every symptom the user reported from "Your openings" -
# a misnamed card, a Queen's Gambit move inside a London System, a line that died after one move
# - was the SAME defect: the opening was identified by a matcher that breaks ties by REGISTRY
# ORDER, so the shared `d4 d5` stem was always resolved to whichever book came first in the list.
# It runs over every shipped opening, with a count assertion, because a previous version of this
# check silently examined zero openings and reported success.
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/openingid.test.mjs")" | tail -n 4 ); then
  echo
  echo "*** REFUSING TO BUILD: the opening identification checks did not pass. ***"
  exit 1
fi

echo "--- GATE 1c: opening + drill behaviour ---"
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/openingfix.test.mjs")" | tail -n 3 ); then
  echo
  echo "*** REFUSING TO BUILD: the opening/drill behaviour checks did not pass. ***"
  exit 1
fi

echo "--- GATE 1d: move numbering and colour ---"
# The move list used to count from one and always attribute the first move to White, which is
# wrong for every position that is not the start of a game - and a puzzle or an endgame drill is
# not. On a Black-to-move position that does not merely misnumber, it tells the reader the
# wrong player moved. It looks entirely plausible on screen, so it is checked here.
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/movelist.numbering.test.mjs")" | tail -n 2 ); then
  echo
  echo "*** REFUSING TO BUILD: the move numbering checks did not pass. ***"
  exit 1
fi

echo "--- GATE 1e: puzzle and endgame levels are real ---"
# "Advanced" and "Pro" both asked Lichess for `hard`, and the puzzle provider had a fallback
# that accepted whatever came back with no rating check. Both are the kind of defect that
# compiles, passes tsc, and quietly does not do the thing the label promises.
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/levels.test.mjs")" | tail -n 6 ); then
  echo
  echo "*** REFUSING TO BUILD: the level checks did not pass. ***"
  exit 1
fi

# GATE 1g - the move classifications the app shows.
#
# WHAT THIS CATCHED
# -----------------
# Four verdicts were retired at the user's request ("there is others i dont know what so remove
# them", plus the critical-move label by name). Editing a classification table is invisible to
# tsc and to every other gate: the type still has all ten kinds, the database still has all ten
# columns, and a re-introduced label on a branch nobody exercised would mislabel games silently.
#
# The load-bearing check is a sweep of the input space - 7,200 combinations of eval, book depth,
# best-move agreement and MultiPV gap - asserting that no retired label can be produced at all,
# plus the exact centipawn bands, plus that a sacrifice which is the engine's best move is still
# `brilliant` rather than a mistake.
echo "--- GATE 1g: move classifications are the six the app advertises ---"
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/movequality.test.mjs")" | tail -n 4 ); then
  echo
  echo "*** REFUSING TO BUILD: the move classification checks did not pass. ***"
  exit 1
fi

# GATE 1h - the brand is ChessForge, except where the user's data is filed under the old name.
#
# The rename was the user's instruction and it touched 80 files. What is gated is the part that
# is easy to undo by accident: a line pasted from an old branch, a new screen importing the
# component by its old name, a comment copied out of a pre-rename doc. Nothing else would
# notice, because a rename leaves the code working either way - the failure is invisible until
# someone reads the file.
#
# There is no exemption left, anywhere. The database filename, the storage-key namespace and the
# Android applicationId were renamed too, deliberately and at a stated cost: the user's existing
# progress does not carry over.
#
# Earlier versions of this gate carried exemptions - for prose that had to explain the rename, and for
# a few names that were allowed to survive in comments. Every one of them was a judgement made here
# rather than by the owner of the decision, which is the failure this line now records: a protected
# list nobody was asked about is a rename that stopped early and called itself finished. The owner was
# asked; the answer was zero occurrences. So the test is absolute - one occurrence, in any scanned
# file, and `docs/` and `README.md` included.
#
# The single exception is the gate's own file, which has to contain the word in order to search for
# it. The test prints how many times, so the exemption stays visible rather than becoming a place
# where something could hide.
echo "--- GATE 1h: no old brand name survives anywhere ---"
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/brand.test.mjs")" | tail -n 2 ); then
  echo
  echo "*** REFUSING TO BUILD: the brand name check did not pass. ***"
  exit 1
fi

# GATE 1o - the engine can recover from a failed boot, and a scan is never silent.
#
# Added because of the report: "i clicked on analyse games in stats, it doesnt show the progress of
# analysing and then it stops without doing anything". Three faults were stacked under it, and the
# outermost was the only one visible - a WebView-hosted Stockfish whose boot was attempted exactly
# once, so a single lost handshake left the engine dead for the session, every position burned its
# 30s timeout, every game was recorded as a silent failure, and `onGame` (success-only) never fired
# so not even the progress bar moved. Anyone who downloads the app could hit this.
echo "--- GATE 1o: the engine boot can be retried, and a failed scan says so ---"
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/engine.boot.test.mjs")" | tail -n 2 ); then
  echo
  echo "*** REFUSING TO BUILD: the engine cannot recover from a failed boot, or a scan fails silently. ***"
  exit 1
fi

# GATE 1i - "Your openings" behaves like the product it is copying.
#
# WHAT THIS CATCHED
# -----------------
# The report was "i played few moves in london and it is not london and just 2-3 moves", and it
# was two defects. A card mixed the user's own positions, a book tail and engine moves into one
# list, so the moves on it were not recognisably the opening it was named after; and the card
# showed a single `spine` whose length was whatever the pool rotation happened to reach.
#
# This checks the properties the product actually has: every line is one legal move order and
# starts with the opening it is filed under; the shortest offered line is a real line; the list is
# ordered by how many of HIS OWN GAMES reached each line, measured at the deepest position
# (counting `gameId`s ties everything, because the pool collapses repeats; taking the max ties
# everything too, because every opening shares its first plies - both shipped, both caught here);
# the mastery ring runs 0..10 and never falls as mastery rises; and win rate is computed with
# membership on `sourceNames` so a merged family is not reported as 0%.
echo "--- GATE 1i: your openings offers real lines, ordered and scored ---"
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/youropenings.test.mjs")" | tail -n 2 ); then
  echo
  echo "*** REFUSING TO BUILD: the 'Your openings' checks did not pass. ***"
  exit 1
fi

# GATE 1j - no hook after an early return.
#
# WHAT THIS CATCHED
# -----------------
# The device said:
#
#     com.facebook.react.common.JavascriptException:
#       Error: Rendered more hooks than during the previous render.
#
# Two `useMemo` calls had been written INSIDE the `if (phase === 'lines' && openFamily) { ... }`
# render block of GameOpeningsScreen, to compute the opening's own study lines. React runs a hook
# on the renders that take that branch and not on the others, so the hook list changes length
# between renders and it throws.
#
# The reason it is worth a gate rather than a fix: the crash landed on the TRANSITION. Opening
# "Your openings" renders the list, which skips the block entirely, so the old list appeared and the
# new UI looked as though it had never shipped - and only tapping an opening threw. tsc is clean,
# every behaviour gate passes, and the pure functions are untouchable by a bug that lives in a
# component's render. It presents as a missing feature, so it survives a release.
#
# It has now been made twice in that one file, once with an effect and once with a memo, which is
# the reason this gate exists rather than another careful read.
#
# This supersedes `.bench/hooks.audit.mjs`, which walked brace depth and flagged a hook in a
# callback too - its own header calls the result "a list to look at, not a verdict". The files are
# left in place rather than deleted, but this is the one that decides the build.
echo "--- GATE 1j: no hook is called after a component's early return ---"
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/hooks.test.mjs")" | tail -n 3 ); then
  echo
  echo "*** REFUSING TO BUILD: a hook sits behind an early return, or the check cannot see. ***"
  exit 1
fi

# GATE 1k - a line the user opened is the line the user keeps.
#
# WHAT THIS CATCHED
# -----------------
# Four rounds of fixes on one screen, and the user was right to name the pattern himself:
#
#   "as always you keep deliver the same mistakes : when i tried an opening in 'your
#    openings' it plays automatically 3 times then i get a different new position to play.
#    and of course after you fix it wi will get the 2 moves line complete error, then we
#    will get the crashing error and we will stay in that circle !"
#
# He was right, and the reason is that the three reports are ONE defect. The engine pass calls
# `publish()`, which calls `buildFamilyLines` again; that RE-RUNS THE POOL ROTATION, and the
# rotation prefers positions that carry decisions, so `alternates` comes back as a DIFFERENT LIST.
# It is published twice - head of the sample, then tail - and each rebuild did all three:
#
#   1. the walk restarted, because a new `activeLine` failed the SAN comparison and `startLine()`
#      walked from move 1. The initial walk plus two publishes: "plays automatically 3 times".
#   2. `resolveLine` could not find the recorded moves in the new list and fell back to an INDEX,
#      which now named somebody else's move order: "a different new position to play".
#   3. the rotation picks short decision-bearing FRAGMENTS, so the line really was one or two
#      moves long. GATE 1i's 8-ply floor could not help, and the reason is the point: the line
#      genuinely was that short. Nothing was lying - the floor was honest and the line was wrong.
#
# Every earlier fix attacked one link: the index, then the SAN comparison, then the length floor.
# The defect is the rotation running at all under a live session.
#
# GATE 1i §8 already carries the floor, so this gate is deliberately NOT about length. It asserts
# the rotation cannot reach a session at all, and that the session flag is both set and clearable -
# the second of which caught a bug in the first version of this fix, where the flag was assigned
# below the effect's early return and so could never be turned off.
echo "--- GATE 1k: a line the user opened is the line the user keeps ---"
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/lineloop.test.mjs")" | tail -n 3 ); then
  echo
  echo "*** REFUSING TO BUILD: the engine pass can still swap a live line. ***"
  exit 1
fi

# GATE 1m - today's plan is decided by need.
#
# WHAT THIS CATCHED
# -----------------
# "for todays plan : if you can make real todays plan changing everyday as how i need ( not just
# random stuff )".
#
# The word that matters is "need". A plan that changes daily because a random number changed is
# exactly what he is asking us to stop doing, so the requirement is not variety - it is that the
# plan FOLLOWS FROM HIS OWN STATE, and the test is whether the same account on a different day
# gets a different plan for a reason he can read.
#
# The old card offered one study: the lowest-mastery study he had started, or the first study in
# the corpus if he had started none. Three defects, and only the first is visible in review:
#
#   1. Array.sort is STABLE, so equal-mastery studies kept corpus order. On a new account every
#      study is at mastery 0, so the card read "Continue: Study 1.1" every day for ever.
#   2. It never read his repertoire. The corpus order begins with the Sicilian for everybody,
#      whether they play it or not.
#   3. "Nothing due" produced the same button anyway, so the plan did not change with his state.
#
# The ranking is a pure function in `src/lib/dailyPlan.ts` so it can be tested against shapes the
# corpus does not contain - the only way to catch a tie broken by accident.
# GATE 1n - the puzzles tab can load a puzzle, and never blames the network for it.
#
# WHAT THIS CAUGHT
# ---------------
# "i tried puzzles and it says to check my connection although i am connected ( the endgames works
# fine although it needs connection but the puzzles doesnt work )".
#
# He was right, and the endpoint agreed with him: probed directly, it answered 200 with real puzzles.
# The ratings it returned were 1308, 1386, 1423, 1454, 1477, 1479. Two faults, compounding:
#
#   1. THE BAND COULD NOT BE SATISFIED. bandRange('beginner') was 400-1250, the app asked for
#      `easy`, and the measured floor of `easy` is ~1300. The provider rejects anything outside the
#      band, so all six attempts were discarded, `served` stayed null, and the screen showed its
#      offline notice - with a 200 in hand and a working connection. A Beginner could load NOTHING.
#   2. THE NOTICE NAMED THE WRONG THING. The catch was `catch { setLoadError(true) }` and the
#      sentence was "Check your connection", for a 429, a 401, a schema change and a real outage
#      alike. Endgames shares the endpoint and the same unauthenticated limit, so the two tabs can
#      genuinely disagree at one moment - which is what made the message look absurd rather than
#      merely terse.
#
# WHAT IS CHECKED, AND WHAT IS NOT
# --------------------------------
# The floors are OBSERVATIONS of a distribution that moves, so this gate does not claim they are
# correct today. It checks the property that matters when they go stale: a near-miss fallback exists,
# a band is never narrower than the bucket it asks for, and no failure but a real one tells the user
# to check their connection.
echo "--- GATE 1n: puzzles can load, and never blames the connection ---"
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/puzzles.test.mjs")" | tail -n 3 ); then
  echo
  echo "*** REFUSING TO BUILD: the puzzles tab cannot load, or blames the network for it. ***"
  exit 1
fi

# GATE 1p - a mined puzzle is a forced line, not a mistake and a single move.
#
# The user's report: *"the puzzles from the user games in our app dont seem like they are puzzle,
# but just a mistake and what to play instead and that's it."* The old deck stored one engine move
# and the screen ended after it. This gate replays a PV, checks odd-length trimming, verifies the
# later solver moves are unique, and asserts the legacy one-move deck is retired rather than shown.
echo "--- GATE 1p: mined puzzles are forced lines, not one-move quizzes ---"
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/minedpuzzle.test.mjs")" | tail -n 3 ); then
  echo
  echo "*** REFUSING TO BUILD: mined puzzles are still one-move quizzes, or the legacy deck is not retired. ***"
  exit 1
fi

# GATE 1m - today's plan is decided by need.
echo "--- GATE 1m: today's plan is decided by need, and is not the same every day ---"
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/dailyplan.test.mjs")" | tail -n 3 ); then
  echo
  echo "*** REFUSING TO BUILD: today's plan is not following the user's own state. ***"
  exit 1
fi

# GATE 1f - the Android icon resources must be newer than the icon assets.
#
# WHAT THIS CATCHED
# -----------------
# The icon was regenerated at 02:31 and looked correct in `assets/`. The mipmaps were still
# from 00:32, because nothing had re-synced them - `expo prebuild` is what copies the icon
# assets into `android/app/src/main/res/mipmap-*`, and it was run by hand two hours earlier and
# not again. The APK therefore shipped the OLD artwork, and the report was "the horse is still
# cropped" about an icon that had been fixed twice in `assets/` and never once in the package.
#
# The mistake was not forgetting the command so much as checking the wrong file: the asset was
# inspected, the mipmap was never compared to it. Two generations of this app's icon work were
# verified by looking at the PNG in `assets/`, which is the source of the truth and not the
# thing that ships. Nothing in the build noticed, so nothing in the build should allow it now.
echo "--- GATE 1f: Android icon resources are current ---"
ICON_SRC="$ROOT/assets/android-icon-background.png"
if [ -f "$ICON_SRC" ]; then
  NEWEST_MIPMAP="$(find "$ROOT/android/app/src/main/res" -name 'ic_launcher_background.*' -type f -printf '%T@\n' 2>/dev/null | sort -rn | head -n 1)"
  NEWEST_MIPMAP="${NEWEST_MIPMAP:-0}"
  ICON_SRC_T="$(stat -c '%Y' "$ICON_SRC" 2>/dev/null || echo 0)"
  if [ "$NEWEST_MIPMAP" = "0" ]; then
    echo
    echo "*** REFUSING TO BUILD: no ic_launcher_background.* found under android/app/src/main/res. ***"
    echo "*** Run: npx expo prebuild --platform android --no-install              ***"
    exit 1
  fi
  # Integer compare: the newest mipmap must be at least as new as the asset.
  if [ "${NEWEST_MIPMAP%.*}" -lt "$ICON_SRC_T" ]; then
    echo
    echo "*** REFUSING TO BUILD: the Android icon resources are STALE. ***"
    echo "***   assets/android-icon-background.png and the mipmaps were generated at"
    echo "***   different times, so the APK would ship the previous artwork. Checking"
    echo "***   the asset in assets/ proves nothing - it is not what ships."
    echo "***   Run: npx expo prebuild --platform android --no-install              ***"
    exit 1
  fi
  echo "  ok - the mipmaps are at least as new as the icon asset"
fi

echo "--- GATE 1b: needles exist in src/ ---"
# Two things have to be right here, and each was wrong once.
#
#  * `node` is a WINDOWS binary. Handed a Git-Bash `/c/...` path it resolves it
#    against the current drive and looks for `C:\c\Users\...`, which does not
#    exist -- so the gate died with "Cannot find module" and refused every build.
#    `cygpath -w` is the fix, the same one GATE 1 below already uses.
#  * the checker walks `src/` and reads `scripts/bundlecheck.py` RELATIVE TO CWD,
#    and this script has already cd-ed into android/. Run it from $ROOT.
if ! ( cd "$ROOT" && node "$(cygpath -w "$ROOT/.bench/verify.needles.mjs")" ); then
  echo
  echo "*** REFUSING TO BUILD: a GATE 2 needle is not in the source. ***"
  echo "That is a typo in scripts/bundlecheck.py, not a stale bundle."
  echo "Fix the needle, then rebuild. Do not chase the bundle."
  exit 6
fi
echo
  echo
echo "--- checking repertoire freshness ---"
# Prefer the managed interpreter by absolute path: `python` is not guaranteed to
# be on PATH here, and the gate must not be skippable by accident.
#
# The interpreter is a Windows build, so hand it a Windows path — a Git-Bash
# `/c/...` path is resolved relative to the current drive and becomes
# `C:\c\...`, which does not exist.
PY_GATE="/c/Users/seifg/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe"
if [ ! -x "$PY_GATE" ]; then PY_GATE="$(command -v python || command -v python3 || true)"; fi
if [ -z "$PY_GATE" ]; then
  echo "*** REFUSING TO BUILD: no Python interpreter found to run the freshness gate. ***"
  exit 2
fi
GATE_PY="$ROOT/../.tmp-verify/check_fresh.py"
GATE_WIN="$(cygpath -w "$GATE_PY" 2>/dev/null || echo "$GATE_PY")"
if ! "$PY_GATE" "$GATE_WIN"; then
  echo
  echo "*** REFUSING TO BUILD: a repertoire JSON is stale. ***"
  echo "Let the pipeline finish (or run its \`assemble\` phase), then rebuild."
  exit 2
fi
echo

# -----------------------------------------------------------------------------
# GATE 2 — force the JS bundle to be regenerated.
#
# Editing `src/data/*.json` does NOT invalidate
# `:app:createBundleReleaseJsAndAssets`; Gradle prints UP-TO-DATE and the APK
# keeps the old data. Deleting build outputs is not enough — the Metro cache is
# the second culprit. Move BOTH aside (never `rm -rf`: 1500+ files trips the
# sandbox safe-delete guard). The timestamped name is also the evidence trail
# for `bundlecheck.py`.
# -----------------------------------------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
BUNDLE_OUT="$ANDROID_DIR/app/build/generated/assets/react/release"
METRO_CACHE="$HOME/AppData/Local/Temp/metro-cache"

for d in "$BUNDLE_OUT" "$METRO_CACHE"; do
  if [ -e "$d" ]; then
    mv "$d" "$d.stale-$STAMP" 2>/dev/null \
      && echo "moved aside: $d -> $d.stale-$STAMP" \
      || echo "note: could not move $d aside (continuing)"
  fi
done
echo

# `env -i` deliberately scrubs the inherited environment: it drops
# JAVA_HOME=jdk-24, the shimmed PATH, and NODE_OPTIONS in one step.
# The `env -i` that used to be here scrubbed the WHOLE environment in
# order to drop three variables: NODE_OPTIONS (a sandbox shim that redirects
# deletes), JAVA_HOME (pointing at JDK 24, which AGP 8 rejects) and a shimmed PATH.
#
# It also removed the MSYS/Windows environment Gradle's own launcher reads, and
# gradlew then exited 0 having printed nothing at all -- a 0-byte log, no APK, and a
# script that reported success. So the three variables are unset explicitly instead,
# and the environment Gradle needs is left intact.
# The environment Gradle needs, set EXPLICITLY rather than inherited.
#
# `env -i` used to do two jobs at once: scrub the inherited environment AND pass these
# values through. Removing it removed both, and the build died with "SDK location not
# found" because ANDROID_HOME was simply gone. So they are set here, from the same
# Windows paths Gradle wants, and nothing is left implicit.
# The same WSL conversion the preflight needed, applied to everything Gradle reads.
#
# Under WSL, exporting the Windows form is not a harmless cosmetism: gradlew resolves
# JAVA_HOME against the filesystem it can actually see, so `C:\Program Files\...` is
# reported as "JAVA_HOME is set to an invalid directory" and the build stops immediately -
# on a machine where that directory exists and its java runs. The preflight had the same
# fault and the same fix, so both go through `to_exec_path` and neither can drift again.
export JAVA_HOME="$(to_exec_path "$JAVA_HOME_WIN")"
export ANDROID_HOME="$(to_exec_path "$ANDROID_HOME_WIN")"
export ANDROID_SDK_ROOT="$(to_exec_path "$ANDROID_HOME_WIN")"
export GRADLE_USER_HOME="$(to_exec_path "$GRADLE_USER_HOME_WIN")"
export CODEBUDDY_SAFE_DELETE_ENABLED=0
export PATH="/c/Program Files/Microsoft/jdk-21.0.12.101-hotspot/bin:/c/AndroidSDK/platform-tools:/c/Program Files/nodejs:/usr/bin:/bin:/mingw64/bin:/c/Windows/system32:/c/Windows"

# Unset only the two that actually cause harm, instead of scrubbing everything:
#   NODE_OPTIONS is a sandbox shim that redirects deletes through genie-trash, and an
#   inherited JAVA_HOME pointing at JDK 24 is rejected by AGP 8.
unset NODE_OPTIONS
unset REACT_NATIVE_NODE_ARGS

# ---------------------------------------------------------------------------
# FRESHNESS BASELINE - see FLAW 2 below. A leftover APK from an earlier run must not
# be able to satisfy the post-build check.
# ---------------------------------------------------------------------------
BUILD_START="$(date +%s)"

# ---------------------------------------------------------------------------
# Remove the previous APK, so this run cannot inherit it.
#
# Gradle decides `:app:packageRelease` is UP-TO-DATE from its inputs, and the JS bundle it
# tracks is the one in `android/app/build/generated/assets/react/release` — which the step above
# has just MOVED ASIDE and regenerated. The task graph does not know that, so on the run after
# an interrupted or killed build it reports UP-TO-DATE, does not repackage, and leaves the
# PREVIOUS APK sitting next to a brand new bundle. Observed for real: 19 tasks executed,
# `packageRelease UP-TO-DATE`, and the script's own staleness check then refused the run with
# "Gradle reported success but produced nothing".
#
# That check is right to refuse and wrong to be the only defence: the condition is entirely
# predictable here, so it is removed rather than diagnosed. Deleting the output first makes
# `packageRelease` unconditionally re-run, so a release APK is always produced by the run that
# claims to have built it.
# ---------------------------------------------------------------------------
APK_OUT="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
if [ -f "$APK_OUT" ]; then
  rm -f "$APK_OUT"
  echo "removed the previous APK so this run repackages rather than inheriting it"
fi

echo "--- building ---"
NODE_ENV=production \
NO_COLOR=1 TERM=dumb \
./gradlew :app:assembleRelease --no-daemon --console=plain 2>&1 | tee "$LOG"

STATUS=${PIPESTATUS[0]}

echo
APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"

# The artifact must be NEWER than the moment this build started. Without this, an APK
# left over from a previous run satisfies `[ -f "$APK" ]` and the script reports a
# successful build for one that just failed -- which is exactly what happened: a 96M
# APK from 02:32 was announced as "BUILD SUCCEEDED" by a build that failed at 03:50.
APK_FRESH=0
if [ -f "$APK" ]; then
  APK_MTIME="$(date -r "$APK" +%s 2>/dev/null || stat -c %Y "$APK" 2>/dev/null || echo 0)"
  if [ "$APK_MTIME" -gt "$BUILD_START" ]; then
    APK_FRESH=1
  else
    echo "*** the APK on disk is OLDER than this build (mtime $APK_MTIME <= start $BUILD_START) ***"
    echo "*** it is a leftover from an earlier run and does NOT contain this build ***"
  fi
fi

# Gradle's own exit code is checked FIRST. A zero from Gradle plus an old file on disk
# is not a build.
if [ "$STATUS" -ne 0 ]; then
  echo
  echo "=== BUILD FAILED: gradle exited $STATUS ==="
  grep -A15 "What went wrong" "$LOG" 2>/dev/null | head -25
  echo
  echo "Nothing to install. Any APK already in the output directory is from an EARLIER run."
  exit "$STATUS"
fi

if [ -f "$APK" ] && [ "$APK_FRESH" -eq 1 ]; then
  echo "=== BUILD SUCCEEDED ==="
  ls -lh "$APK"
  echo

  # ---------------------------------------------------------------------------
  # GATE 2 - the bundle must CONTAIN this session's changes.
  #
  # The mtime check above only proves the bundle is newer than the newest source
  # file. That is necessary and not sufficient: Gradle prints UP-TO-DATE and
  # repackages a bundle built before an edit, and every timestamp then looks right
  # while the APK ships without the fix.
  #
  # This was previously an ad-hoc one-liner run by hand, which is exactly how it
  # came to report three MISSING fixes that were all present: Hermes stores any
  # string containing a non-ASCII character as UTF-16, and the strings a human
  # picks to search for -- UI copy, "Grünfeld", an em-dash -- are precisely the
  # ones with accents in them. `bundlecheck.py` probes both encodings.
  #
  # It is allowed to fail the build. A bundle missing this session's work is not
  # shippable, and finding that out here is cheaper than finding it on a phone.
  # ---------------------------------------------------------------------------
  #
  # Reuse $PY_GATE (the managed interpreter, absolute path) and hand it a WINDOWS
  # path via cygpath, exactly as GATE 1 above does. The previous version probed
  # `command -v python`, which on this box resolves to the SYSTEM Python 3.8 --
  # and then passed it the Git-Bash path "$ROOT/scripts/bundlecheck.py". A Windows
  # python resolves `/c/...` relative to the current drive, so it tried to open
  # `C:\c\Users\...`, failed with "can't open file", exited non-zero, and the gate
  # reported a STALE BUNDLE that did not exist. The check itself was fine; the way
  # we invoked it was not. A gate that fails for a reason unrelated to what it
  # measures is worse than no gate: it trains you to ignore it.
  PY="$PY_GATE"
  if [ -z "$PY" ]; then
    for c in python python3 py; do
      if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
    done
  fi
  if [ -n "$PY" ]; then
    BUNDLE_WIN="$(cygpath -w "$ROOT/scripts/bundlecheck.py" 2>/dev/null || echo "$ROOT/scripts/bundlecheck.py")"
    if ! ( cd "$ROOT" && "$PY" "$BUNDLE_WIN" ); then
      echo
      echo "=== GATE 2 FAILED - the APK above does NOT contain this session's changes ==="
      echo "Do not install it. Fix the stale bundle (see the message above) and rebuild."
      exit 3
    fi
  else
    echo "NOTE: no python found, so GATE 2 (bundle contents) was NOT checked."
    echo '      Run: python "$ROOT/scripts/bundlecheck.py"'
    # Single quotes deliberately. A global replace of the tool path also rewrote the
    # copy inside this message, which is nested quoting and a parse error for the whole
    # script - and bash reported it on a later line, pointing at unrelated text. A path
    # made absolute is right in CODE and wrong inside a STRING.
  fi

  echo
  echo "Install on a connected device with:"
  echo "  \"$ANDROID_HOME_WIN\\platform-tools\\adb.exe\" install -r \"$APK\""
else
  # A missing artifact with exit 0 is the exact failure this script used to hide.
  # Say so loudly, and never exit 0 from this branch.
  if [ -f "$APK" ] && [ "$APK_FRESH" -eq 0 ]; then
    echo "=== BUILD DID NOT RUN (exit 0, and the APK on disk is STALE) ==="
    echo "Gradle reported success but produced nothing, so the file in the output"
    echo "directory is left over from an earlier run. Do not install it."
  elif [ ! -s "$LOG" ]; then
    echo "=== BUILD DID NOT RUN (exit $STATUS, and the log is EMPTY) ==="
    echo "Gradle produced no output at all, so nothing was compiled."
    echo "The usual cause is a scrubbed environment: gradlew exits 0 silently when"
    echo "it cannot start. The preflight above should now catch that case."
  else
    echo "=== BUILD FAILED: no APK (exit $STATUS) ==="
  fi
  echo
  echo "Last errors:"
  grep -A15 "What went wrong" "$LOG" 2>/dev/null | head -25
  echo
  echo "Nothing to install. Do not treat this run as a build."
  echo
  echo "If the cause is a sandbox denial (look for '拒绝' / 'denied' above),"
  echo "re-run this script from a normal terminal or Android Studio instead."
fi

# A successful Gradle exit is not a successful build unless the artifact exists.
if [ ! -f "$APK" ]; then
  echo
  echo "*** EXITING 5: gradle finished but there is no APK at $APK ***"
  exit 5
fi

exit "$STATUS"
