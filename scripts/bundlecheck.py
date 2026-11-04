#!/usr/bin/env python3
"""
GATE 2 - prove the JS bundle actually contains this session's changes.

GATE 1 (mtime) only proves the bundle is NEWER than the newest source file. That is
necessary and nowhere near sufficient: Metro/Gradle will happily report UP-TO-DATE
and repackage a bundle built before an edit, and the APK then ships without the fix
while every timestamp looks correct. GATE 2 looks for the actual strings.

THE ENCODING TRAP, AND WHY THIS SCRIPT CHECKS TWO WAYS
------------------------------------------------------
The first version of this check was a one-liner that read the bundle as latin1 and
reported three MISSING fixes:

    Reference index . not a drill      -> "absent"
    Mar del Plata ... Queen sortie     -> "absent"
    Grunfeld Defense                   -> "absent"

All three were present. Hermes stores a string as UTF-16 when it contains any
non-ASCII character, and as single-byte ASCII when it does not. So:

  * "Reference index \u00b7 not a drill"  contains U+00B7  -> UTF-16 -> invisible
    to a latin1 read. Its ASCII sibling "reading, not drilling" was found, which
    made the failure look like a real absence rather than an encoding artefact.
  * "Study 8.6 \u2014 The Mar del Plata ..." contains an em-dash -> UTF-16.
  * "Gr\u00fcnfeld Defense" -> UTF-16.

A single-encoding probe therefore reports absent for roughly every string a human
would choose to search for, because UI copy and opening names are exactly the
strings that contain accents, dashes and middots. Probing both encodings costs
nothing and removes the entire class of false alarm - and, more importantly, the
class of FALSE PASS where a genuinely missing string happens to be ASCII.

USAGE
-----
    python scripts/bundlecheck.py                      # default needle list
    python scripts/bundlecheck.py needle1 "needle two"  # explicit needles
    python scripts/bundlecheck.py --bundle path/to.bundle

Needles are probed as utf8, latin1 AND utf-16-le: a UTF-8 bundle read as
latin1 turns "u" into two characters, which silently made every accented needle
unreportable until utf8 was added.

Exit code 0 = every needle found in at least one encoding.
"""

import os
import sys

DEFAULT_BUNDLE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "android", "app", "build", "generated", "assets", "react", "release",
    "index.android.bundle",
)

# Every entry must be a substring you are CERTAIN your change introduced.
#
# `Reading, not drilling` and `isReferenceStudy` are pure ASCII on purpose: they are
# the canaries. If a future change makes them UTF-16 the probe still works, and if
# this script ever silently stopped finding ASCII strings the canaries would be the
# first thing to notice.
DEFAULT_NEEDLES = [
    # per-opening advancement + the reference-study handling
    "isReferenceStudy",
    "reading, not drilling",
    "Reference index",
    # the promoted openings
    "Catalan Opening",
    "Slav Defense",
    "Semi-Slav Defense",
    "Gr\u00fcnfeld Defense",
    # Straight apostrophe, because that is what `openings.ts` uses for BOTH
    # "Queen's Gambit" and "Queen's Gambit Accepted". The first version of this
    # needle had a curly U+2019 and reported ABSENT for a string that IS in the
    # bundle - the guard working, but on the wrong evidence. A needle must be a
    # substring of the SOURCE, not of how one imagines the source reads.
    "Queen's Gambit Accepted",
    "queens-gambit-accepted",
    "grunfeld-defense",
    "semi-slav",
    # THE ELEVEN BOOK-BUILT OPENINGS.
    #
    # These are registered ids and card names from `openings.ts`, so they are string
    # literals and survive minification. Both the id and the display name are listed
    # for the ones whose id is not already a substring of the name, because a missing
    # UI name is the case a user would actually notice.
    "nimzo-indian",
    "Nimzo-Indian Defense",
    "queens-indian",
    "Queen's Indian Defense",
    "bogo-indian",
    "Bogo-Indian Defense",
    "benoni",
    "dutch-defense",
    "alekhine-defense",
    "petrov-defense",
    "four-knights",
    "vienna-game",
    "pirc-defense",
    "kings-gambit",
    "King's Gambit",
    # the earlier session's fixes, so a stale bundle is caught rather than shipped
    "buildBookExercisesForAdoptions",
    "formatEvalCp",
    "openingProgress",
    # The play-loop regression. Only the EXPORTED name goes in this list.
    #
    # `queueAdoption` and `flushAdoptions` were here first and both came back ABSENT
    # from a bundle that provably contains the fix. They are local `useCallback`
    # bindings inside a component, and the minifier renames those — so a local
    # identifier is simply not in the output under any encoding. `saveAdoptions` is a
    # module export, which is why it survives, and it is the right needle: the bug was
    # a call to `saveAdoption` per ply, so finding the batched export is the evidence
    # that the write was batched.
    #
    # THE GENERAL RULE, since it will otherwise be relearned:
    #   a bundle needle can only assert a change that survives minification — an
    #   exported name, a data string, or user-visible copy. A purely BEHAVIOURAL
    #   refactor (queueing instead of writing, removing a re-render) leaves no string
    #   to find, and the only honest guard for it is a source-level test. For the
    #   adoption batching that is `.bench/board.playloop.test.mjs`, which asserts the
    #   handler -> adopt -> queueAdoption -> one-write chain by reading the source.
    "saveAdoptions",
    # The rename to ChessForge. This is the ideal needle for the rename work: pure
    # ASCII (so it can never be a false negative from the UTF-16 trap above), and
    # it is user-visible UI copy, so the minifier cannot drop or mangle it. If the
    # bundle still reads "ChessForge" the Home screen title is stale, which is the one
    # part of the rename a user would actually notice.
    "ChessForge",
    # The two openings added this session, and their REGISTERED ids.
    #
    # The id, not the display name, is the needle that matters here. The audit
    # registers nothing by itself: `AVAILABLE_OPENINGS` is a hand-written literal, and an
    # unregistered JSON file is invisible to the app while still sitting in src/data. The
    # string that only appears if openings.ts actually wired it up is the id, because the
    # file's own contents are reachable from the import either way.
    "scandinavian-defense",
    "philidor-defense",
    "Scandinavian Defense",
    "Philidor Defense",
    # A hand-written study title from each of those two files. These prove the DATA
    # shipped and not just the registry entry, and they are the needles most likely
    # to break: they are the only strings in these two files that are both
    # hand-written and non-repeating.
    #
    # The previous pair quoted a coaching note from each study ("The gambit. White
    # offers a pawn to open the" / "The most common Philidor move order by a
    # distance."). Both were genuinely gone: those two files were later regenerated
    # and their per-ply prose replaced with the `ENGINE, not authored.` comments, so
    # the needles pointed at text that no longer exists anywhere. `verify.needles.mjs`
    # caught it before the build, which is exactly what it is for -- but a needle must
    # be re-pointed at real text, never deleted, or the data stops being covered.
    "The pin, the critical ...c6, and the dark-squared bishop",
    "The closed structure: ...c5, ...c4 and the Bayonet",
    # 2026-09-28: the five single-chapter openings were split into thematic chapters
    # and their studies renumbered `Study <chapter>.<n>`. These needles assert the
    # RESTRUCTURE reached the bundle -- the data-only changes above would not notice
    # it, because every opening id and study id stayed the same.
    "Chapter 2: The Botvinnik and Anti-Moscow Gambits",
    "Chapter 3: Black's Alternatives",
    "Chapter 4: The Noteboom",
    # ...and the prose added to the one new branch a material-only check flags: the
    # Scotch Gambit bishop sacrifice, which is theory, not a blunder.
    "7.Bxd5 is the point of the Scotch Gambit",
    # THE TWELVE BOOK-BUILT OPENINGS OF BATCH 2 (2026-09-28).
    #
    # Same rule as the batch-1 block above: a registered id is a string literal in
    # `openings.ts` and survives minification, and the DISPLAY NAME is the thing a user
    # would actually notice missing. The file's own contents are reachable from the
    # import either way, which is why the ids and not the JSON filenames are listed.
    # 2026-09-28: "queens-pawn" was removed from this block. The Queen's Pawn Game
    # duplicated the Queen's Gambit (both open with 1.d4) and shipped four studies, so
    # there was nothing in it that the Queen's Gambit did not already have. Its data file,
    # its import, its const and its OPENINGS entry are all gone, which is why its id can
    # no longer be asserted. This block therefore asserts ELEVEN of the twelve batch-2
    # openings, and this comment is the record of the twelfth.
    "reti-opening",
    "nimzowitsch-defense",
    "modern-defense",
    "pterodactyl-defense",
    "bishops-opening",
    "van-geet-opening",
    "blackmar-diemer-gambit",
    "tarrasch-defense",
    "birds-opening",
    "polish-opening",
    "zukertort-opening",
    "Chapter 9: The Chigorin, Albin, and Other Rare Black Tries",
    "R\u00e9ti Opening",
    "Nimzowitsch Defense",
    "Modern Defense",
    "Pterodactyl Defense",
    "Bishop's Opening",
    "Van Geet Opening",
    "Blackmar-Diemer Gambit",
    "Tarrasch Defense",
    "Bird's Opening",
    "Polish Opening",
    "Zukertort Opening",
    # ...and one hand-written STUDY TITLE from each of the twelve files. The ids above
    # prove the registry was wired up; these prove the DATA shipped. They are the
    # strings most likely to break on a regeneration, because they are the only text in
    # these files that is both hand-written and non-repeating.
    #
    # NOTE the U+00FC in "T\u00fcbingen": a needle containing a non-ASCII character is stored
    # UTF-16 by Hermes, which is exactly the trap the docstring above describes, and
    # probing both encodings is what makes it safe to keep the real spelling.
    "The Chigorin, Albin, and Other Rare Black Tries",
    "the Bogoljubow Variation",
    "the Pseudo-Spanish Variation",
    "the Mongredien Defense",
    "the Grand Prix Pterodactyl",
    "the Calabrese Countergambit",
    "the T\u00fcbingen Gambit",
    "the Lange Gambit",
    "the Schara Gambit",
    "the Langheld Gambit",
    "the Wolferts Gambit",
    "the Nimzo-Larsen Variation",
    # 2026-10-02: the six-tier rank ladder, renamed from chess strength titles to
    # this app's own heat ladder (Spark -> Crucible), and the "what you played /
    # what we suggest" copy rewritten.
    #
    # Both ends of the ladder are needles because both are string literals in
    # `repertoire.ts` and `yourOpenings.ts`, and both are user-visible on the Home
    # card and the Your-openings header. `Spark` alone would be satisfied by any
    # word containing it; the pair is what pins the ladder. The ladder is the one
    # change in this session that could pass every gate and still ship the OLD
    # labels, because all three lookup tables that consume the names fall back
    # silently on a name they do not recognise - which is exactly why
    # `.bench/youropenings.test.mjs` now asserts they agree, and why the shipped
    # bundle is worth asserting here as well.
    "Spark",
    "Crucible",
    # The rewritten sentence. Straight ASCII, so the UTF-16 trap above cannot make
    # it a false negative, and it is a template literal in a component so the
    # minifier keeps it verbatim.
    "This is the move you chose in your own game",
    "ChessForge would take",
    # ...and the Profile copy that spells the unlock thresholds out in full, which is
    # the one place all five middle names appear together on screen.
    "Levels unlock as mastery grows",
    # 2026-10-02: the four puzzle/endgame DIFFICULTY bands, renamed from chess strength
    # titles to warm-up / steady / sharp / relentless, plus the light default.
    #
    # The labels are the needles because the ids are lowercase tokens that also appear as
    # object keys, and a key survives minification whether or not the screen that shows it
    # shipped. `Warm-up` only appears where the band is named to the user. `Crucible` is
    # already in the list above and covers the top of the training ladder.
    "Warm-up",
    "Relentless",
    # ...and the light theme. `lightPalette` is a module-scope binding that the minifier
    # renames, so the id is the wrong needle; what cannot be renamed away is the value a
    # fresh install actually renders from, and the two palettes have different `background`.
    # Checking `userInterfaceStyle` is not possible from the bundle - it is native config -
    # so the copy is what is asserted, plus the rating labels which only exist in light mode's
    # rename.
    "Newcomer",
    # The offline copy, which was unreachable before this session: nothing could ever set the
    # 'offline' diagnostic, so the card existed and could not be shown.
    "The app could not reach the puzzle service at all",
    # 2026-10-02: three defects found by testing on a real phone, plus the copy that
    # reports them. Each of these strings exists BECAUSE a check was silent, so their
    # presence in the bundle is the evidence that the reporting shipped at all.
    #
    # The engine-boot failure and the total-scan failure are the two the user hit as
    # "no progress, then it stops without doing anything".
    "The chess engine did not start",
    "The engine answered nothing",
    # ...and the honesty fix on puzzle level-matching: a near-miss is served, and now
    # says so. Without this needle the disclosure could be deleted and nothing upstream
    # would notice, which is exactly how it was already lost once.
    "the range for your level",
    # The provider is referred to as "the provider" in the UI, never by name. The user's instruction
    # was explicit, and it is also the honest phrasing: the app can say where a puzzle came from
    # ("fresh from the provider") without it mattering which service answered, which is the part that
    # actually varies — the same tabs share one unauthenticated, rate-limited endpoint.
    #
    # The name is still in the source where it belongs — the URL, the code comments that explain the
    # 429 and the bucket floors, and the `source` provenance field of each repertoire file. Those are
    # attribution and engineering notes, not something shown to a player.
    "Fresh from the provider",
]


def main(argv):
    bundle = DEFAULT_BUNDLE
    args = list(argv[1:])
    if args and args[0] == "--bundle":
        args.pop(0)
        bundle = args.pop(0)

    if not os.path.isfile(bundle):
        print("GATE 2 FAILED - no bundle at:\n  %s" % bundle)
        print("The bundle is only present after a build. If the build was skipped,")
        print("this is the failure you want: nothing was packaged.")
        return 1

    with open(bundle, "rb") as fh:
        raw = fh.read()

    latin1 = raw.decode("latin1")
    utf16 = raw.decode("utf-16-le", errors="ignore")
    # UTF-8 IS PROBED, AND IT HAD TO BE ADDED.
    #
    # This probed latin1 and utf-16-le only. A UTF-8 bundle read as latin1 turns "ü" into two characters,
    # and utf-16-le does not match UTF-8 either - so every needle containing an accent, a dash or a
    # middot was silently UNREPORTABLE. Three of the 89 were in that position: the Gruenfeld, the Reti
    # and the Tuebingen. All three are present in the bundle, confirmed by decoding it as UTF-8, and all
    # three were reported ABSENT.
    #
    # That is the worst shape a needle check can have: it looks like it is guarding the book titles and
    # is not. The header of this file already argued for probing more than one encoding because of
    # exactly this class of character; it just did not include the one the bundler emits.
    utf8 = raw.decode("utf-8", errors="ignore")

    print("GATE 2 - %s (%d bytes)" % (os.path.basename(bundle), len(raw)))
    print("-" * 68)

    needles = args if args else DEFAULT_NEEDLES
    missing = []
    for needle in needles:
        hits = [name for name, text in (("utf8", utf8), ("latin1", latin1), ("utf16", utf16))
                if needle in text]
        found = bool(hits)
        if not found:
            missing.append(needle)
        print("  %-9s %-8s %s" % ("PRESENT" if found else "ABSENT", "+".join(hits) or "-", needle))

    print("-" * 68)
    if missing:
        print("GATE 2 FAILED - %d of %d needles absent:" % (len(missing), len(needles)))
        for m in missing:
            print("    %s" % m)
        print("")
        print("The bundle does not contain this session's changes. Check for a")
        print("STALE bundle: the build script moves the previous output aside with a")
        print("`.stale-<timestamp>` suffix, and a stale one is a false negative here.")
        return 1

    print("GATE 2 PASSED - all %d needles found (each probed as utf8, latin1 and utf-16-le)" % len(needles))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
