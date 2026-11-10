# ChessForge privacy notice

Last updated: 30 October 2026

ChessForge is a local-first Android chess training app. It has no ChessForge
user accounts, no analytics, no advertising SDK, and no ChessForge server. The
developer does not receive the games, usernames, or training data you import.

## Lichess imports

When you enter a Lichess username, ChessForge reads that account's **public**
data directly from the official Lichess API. It does not log in, ask for a
password, or write anything back to Lichess. You can enter any public username;
the app does not verify that the account belongs to you.

The imported games and the material derived from them — statistics, opening
lines, mined puzzles, custom repertoire decisions, and bot profiles — are stored
in this app's private storage on your device. Raw PGN archives are not kept as a
downloadable archive and are not uploaded anywhere.

Lichess bots are labelled by account handle (`Style of @username`) and are
statistical style models, not the person. The app does not use a Lichess profile
photograph or country as part of a bot, and neither Lichess nor any player
endorses a bot. Bot profiles are stored separately and can be deleted
individually from the Bots screen.

## Other network access

- **Lichess** is also contacted for live puzzle requests.
- **FIDE, PGN Mentor, and The Week in Chess** are contacted when you build a bot
  from over-the-board archives.
- **Hugging Face** is contacted only if you choose to download an optional coach
  model.

Those services have their own privacy policies. ChessForge sends only the
request needed for the action you chose; it does not send your imported games to
them.

## Deleting data

Profile → **Delete imported data** removes:

- every stored Lichess account and its cached games;
- derived opening analysis, positions, and verdicts;
- mined puzzles and scan records;
- custom repertoire decisions derived from those games;
- every saved bot, including Lichess bots, OTB bots, bot profiles and the bot list.

Training progress such as XP, streaks, mastered lines, puzzle history, and
spaced-repetition schedules is kept. Profile → **Reset progress** deletes that
separate training data. Uninstalling the app removes all app data from the
device.

## Contact

The repository is public under MIT, so privacy questions can be raised through
the public issue tracker at <https://github.com/seif007/ChessForge/issues>.
The Lichess request User-Agent is `ChessForge/1.0 (Android)` and carries no
personal contact.

## Independence

ChessForge is an independent project. It is not affiliated with, endorsed by,
or sponsored by Lichess or any player. Lichess is a trademark of its respective
owner.
