# Third-party notices

ChessForge's own source code is licensed under the MIT License — see
[`LICENSE`](LICENSE). It bundles the third-party components below, which keep
their own licences.

## Stockfish 18 Lite (single-threaded, WASM) — GPL-3.0

`assets/engine/stockfish-18-lite-single.js` and
`assets/engine/stockfish-18-lite-single.wasm` are a build of **Stockfish 18**
("Lite", single-threaded), the open-source chess engine by the Stockfish
developers.

- Upstream project: <https://github.com/official-stockfish/Stockfish>
- Licence: **GNU General Public License, version 3** (GPL-3.0). The full text
  ships at [`assets/engine/LICENSE-GPL-3.0.txt`](assets/engine/LICENSE-GPL-3.0.txt).
- Build provenance and the steps that produce these two files are documented in
  [`README.md`](README.md) and in
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#engine-licensing).

Stockfish is a separate program that ChessForge invokes over a message-passing
interface; it is not linked into, and not derived from, ChessForge's own source.

### Corresponding source

GPL-3.0 requires that the corresponding source of the engine be made available
to everyone who receives the binary. The complete source of the Stockfish
revision used, together with the build recipe that emits
`stockfish-18-lite-single.{js,wasm}`, is available from the upstream project
above and is reproduced in this repository's `README.md` and
`docs/ARCHITECTURE.md`. Recipients of a ChessForge build that contains this
engine can obtain that source from those locations at no charge.

## Other dependencies

React Native, Expo and the remaining npm packages are used under their own
licences; see `package.json` and the respective upstream projects for details.
