/**
 * Curated opening repertoires for the five personality presets.
 *
 * WHY THIS EXISTS
 * ===============
 * A preset bot has no imported games, so its `book` used to be empty. The
 * mimic could only choose from Stockfish's five MultiPV candidates, and
 * Stockfish does not care whether the bot is called a Gambit Enthusiast. The
 * result was five differently-labelled engines playing the same reasonable
 * development moves — the exact report this file answers.
 *
 * A personality is a STYLE, and a style has lines. The Gambit Enthusiast has
 * the King's Gambit, Evans, Danish, Smith-Morra and the Falkbeer; the Attacker
 * has the Open Sicilian and the Austrian; the Strategist has the Queen's
 * Gambit and the Catalan; the Wall has the Berlin and the Caro-Kann; the
 * Endgame Specialist steers into exchange variations. These are not claims
 * about a real player's history (the profile still says "no imported games").
 * They are the repertoire the preset is built to play, and the move reason says
 * "opening repertoire", not "you played this".
 *
 * The lines are stored in the same `BookMemory` shape as an imported book, so
 * the move chooser needs no preset-specific branch. `weight` lets a signature
 * line outvote a sideline without inventing counts in the UI: the profile only
 * shows the number of positions, not these weights.
 */

import { Chess } from 'chess.js';
import type { BookMemory, PersonalityId } from './types';

interface RepertoireLine {
  /** SAN moves from the standard initial position. */
  sans: string[];
  /** Relative frequency inside this curated repertoire. */
  weight?: number;
}

type PresetId = Exclude<PersonalityId, 'custom'>;

/**
 * A preset's repertoire, split by the side the bot is playing.
 *
 * WHY THE SPLIT IS STRUCTURAL, NOT COSMETIC
 * =========================================
 * A book is a map from position to the moves the player chose there. `presetBook`
 * replays each line and stores its moves under the position they were played
 * from — but a line as written contains BOTH sides' moves, and only one of them
 * is the bot's. Keeping both in one array meant the opponent's moves were stored
 * as if the bot had chosen them: at the starting position, every Black line's
 * `1.e4` counted as a white opening, and after `1.e4 e5` the Black lines' `Nf3`
 * piled up beside the King's Gambit's `f4`. The weighted first move stopped being
 * the line the preset is named after — the bot opened 1.e4 with the defensive
 * repertoire and answered 1...e5 with Nf3 as a "gambit", which is precisely the
 * report that started this work.
 *
 * Splitting the data states the one fact the flat map could not infer: whose
 * repertoire this is. White lines store the moves at plies 1, 3, 5...; Black
 * lines store the replies at plies 2, 4, 6...
 */
interface PresetRepertoire {
  white: readonly RepertoireLine[];
  black: readonly RepertoireLine[];
}

/**
 * The lines are kept compact on purpose: each one is a route to the
 * personality's characteristic position, not an encyclopaedia. If the opponent
 * leaves the line, the style dials and the engine take over.
 */
export const PRESET_REPERTOIRES: Record<PresetId, PresetRepertoire> = {
  gambit: {
    white: [
    // ── White: the gambits the preset is named after ────────────────────────
    /*
     * THE KING'S GAMBIT IS THE SIGNATURE, so it outweighs the also-good
     * development lines that share this position (Evans, Scotch, Halloween).
     * Weight is the only thing that decides between repertoire moves — the
     * bot does not consult the engine in the opening — so if Nf3 outweighs
     * 2.f4 the bot plays Nf3 and the personality's name is a lie.
     */
    { weight: 16, sans: ['e4', 'e5', 'f4'] }, // King's Gambit
    { weight: 2, sans: ['e4', 'e5', 'f4', 'exf4', 'Nf3'] }, // Kieseritzky
    { weight: 1, sans: ['e4', 'e5', 'f4', 'exf4', 'Bc4'] }, // Bishop's Gambit
    { weight: 1, sans: ['e4', 'e5', 'f4', 'd5', 'exd5'] }, // Falkbeer, White side
    { weight: 2, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4'] }, // Evans
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4', 'Bxb4', 'c3'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4', 'Bxb4', 'c3', 'Ba5', 'd4'] },
    { weight: 2, sans: ['e4', 'e5', 'd4', 'exd4', 'c3'] }, // Danish
    { weight: 1, sans: ['e4', 'e5', 'd4', 'exd4', 'c3', 'dxc3', 'Nxc3'] },
    { weight: 1, sans: ['e4', 'e5', 'd4', 'exd4', 'c3', 'd5', 'exd5'] },
    { weight: 3, sans: ['e4', 'c5', 'd4', 'cxd4', 'c3'] }, // Smith-Morra
    { weight: 1, sans: ['e4', 'c5', 'd4', 'cxd4', 'c3', 'dxc3', 'Nxc3'] },
    { weight: 2, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Bc4'] }, // Scotch Gambit
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Nc3', 'Nf6', 'Nxe5'] }, // Halloween
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Nc3', 'Nf6', 'Nxe5', 'Nxe5', 'd4'] },
    { weight: 2, sans: ['e4', 'e5', 'Nc3', 'Nf6', 'f4'] }, // Vienna Gambit
    { weight: 1, sans: ['e4', 'e5', 'Nc3', 'Nf6', 'f4', 'exf4'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nf6', 'Nxe5'] }, // Petrov's Damiano
    { weight: 2, sans: ['e4', 'd5', 'exd5', 'Nf6', 'd4', 'Nxd5', 'Nf3'] },
    { weight: 1, sans: ['e4', 'c5', 'b4', 'cxb4', 'a3'] }, // Sicilian Wing Gambit
    { weight: 1, sans: ['e4', 'c5', 'b4', 'cxb4', 'a3', 'bxa3', 'Nxa3'] },
    { weight: 1, sans: ['d4', 'd5', 'c4', 'dxc4', 'e4'] }, // Queen's Gambit accepted

    /*
     * MORE GAMBITS. The owner's note: *"there is a lot of other gambits the bot
     * could play, so add to him to play other gambits"*. Each line is a real,
     * named gambit reachable after an opponent's ordinary development, and each
     * puts a pawn or a piece on offer on purpose rather than by accident.
     */
    { weight: 2, sans: ['d4', 'd5', 'e4', 'dxe4', 'Nc3', 'Nf6', 'f3'] }, // Blackmar-Diemer Gambit
    { weight: 2, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'c3'] }, // Göring Gambit
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd4'] }, // Italian Gambit
    { weight: 1, sans: ['e4', 'e5', 'f4', 'exf4', 'Nf3', 'g5', 'Bc4', 'g4', 'O-O'] }, // Muzio Gambit
    { weight: 1, sans: ['e4', 'e5', 'Bc4', 'Nf6', 'd4', 'exd4', 'Nf3'] }, // Urusov Gambit
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nf6', 'Nxe5', 'd6', 'Nxf7'] }, // Cochrane Gambit
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'Bc5'] }, // Traxler (White's side)
    { weight: 2, sans: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'f3'] }, // Alien Gambit

    // ── Black: genuine counter-gambits, not just development ───────────────
    ],
    black: [
    { weight: 5, sans: ['e4', 'e5'] }, // King's Gambit / open game
    { weight: 2, sans: ['e4', 'e5', 'Nf3', 'Nc6'] },
    /*
     * The Latvian Gambit outweighs the solid ...Nc6 so that as Black the bot
     * actually answers 2.Nf3 with a counter-gambit. Equal weights would be
     * decided by insertion order — a coin flip, not a repertoire.
     */
    { weight: 14, sans: ['e4', 'e5', 'Nf3', 'f5'] }, // Latvian Gambit
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'f5', 'exf5'] },
    { weight: 2, sans: ['e4', 'e5', 'Nc3', 'Nf6'] },
    { weight: 1, sans: ['e4', 'e5', 'Nc3', 'Nf6', 'f4', 'd5'] },
    { weight: 2, sans: ['e4', 'e5', 'Bc4', 'Nf6'] },
    { weight: 1, sans: ['e4', 'e5', 'Bc4', 'Nf6', 'Ng5', 'd5'] },
    { weight: 1, sans: ['e4', 'e5', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5', 'Na5'] },
    { weight: 2, sans: ['e4', 'e5', 'f4', 'exf4'] }, // King's Gambit accepted
    { weight: 2, sans: ['e4', 'e5', 'f4', 'd5'] }, // Falkbeer Countergambit
    { weight: 1, sans: ['e4', 'e5', 'f4', 'd5', 'exd5', 'e4'] },
    { weight: 2, sans: ['e4', 'e5', 'd4', 'exd4'] }, // Danish accepted
    { weight: 1, sans: ['e4', 'e5', 'd4', 'exd4', 'c3', 'dxc3'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4', 'Bxb4'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4', 'Bxb4', 'c3', 'Ba5'] },
    { weight: 3, sans: ['d4', 'd5'] },
    { weight: 2, sans: ['d4', 'd5', 'c4', 'e5'] }, // Albin Countergambit
    { weight: 1, sans: ['d4', 'd5', 'c4', 'e5', 'dxe5', 'd4'] },
    { weight: 1, sans: ['d4', 'd5', 'c4', 'dxc4'] }, // Queen's Gambit accepted
    { weight: 2, sans: ['d4', 'e5'] }, // Englund Gambit
    { weight: 1, sans: ['d4', 'e5', 'dxe5', 'Nc6'] },
    { weight: 2, sans: ['d4', 'Nf6'] },
    { weight: 1, sans: ['d4', 'Nf6', 'c4', 'e5'] }, // Budapest Gambit
    { weight: 1, sans: ['d4', 'Nf6', 'c4', 'e5', 'dxe5', 'Ng4'] },
    { weight: 1, sans: ['d4', 'Nf6', 'c4', 'g6'] },
    { weight: 2, sans: ['c4', 'e5'] },
    { weight: 1, sans: ['c4', 'e5', 'Nc3', 'Nf6'] },
    { weight: 1, sans: ['c4', 'Nf6'] },
    { weight: 1, sans: ['c4', 'e6'] },
    { weight: 2, sans: ['Nf3', 'd5'] },
    { weight: 1, sans: ['Nf3', 'd5', 'c4', 'e5'] },
    { weight: 1, sans: ['Nf3', 'Nf6'] },
    { weight: 1, sans: ['Nf3', 'Nf6', 'c4', 'e5'] },
    { weight: 1, sans: ['e3', 'e5'] },
    { weight: 1, sans: ['d3', 'e5'] },
    { weight: 1, sans: ['g3', 'd5'] },
    { weight: 1, sans: ['b3', 'e5'] },
    { weight: 1, sans: ['f4', 'd5'] },

    /*
     * MORE COUNTER-GAMBITS as Black. The bot's moves sit at the odd plies; the
     * even plies are what the opponent was assumed to play to reach the line.
     */
    { weight: 2, sans: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'b5'] }, // Benko Gambit
    { weight: 1, sans: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'c5', 'd5', 'b5'] }, // Blumenfeld Gambit
    { weight: 2, sans: ['e4', 'e5', 'Nf3', 'd5'] }, // Elephant Gambit
    { weight: 2, sans: ['f4', 'e5'] }, // From's Gambit
    { weight: 1, sans: ['d4', 'f5'] }, // Dutch, inviting the Staunton Gambit
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'f5'] }, // Schliemann Defence
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'f5'] }, // Rousseau Gambit
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'Bc5'] }, // Traxler Counterattack
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'f5'] }, // Portuguese Gambit
    { weight: 3, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'O-O', 'c3', 'd5'] }, // Marshall Attack
    { weight: 1, sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'c6', 'e4', 'dxe4', 'Nxe4', 'Bb4'] }, // Marshall Gambit (Semi-Slav)
    ],
  },

  aggressive: {
    white: [
    // White: open games, opposite-side castling, initiative.
    { weight: 4, sans: ['e4'] },
    { weight: 2, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd4', 'exd4', 'c3'] },
    { weight: 2, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O', 'h3'] },
    { weight: 2, sans: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'Be3', 'e5'] },
    { weight: 1, sans: ['e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'g6', 'Nc3', 'Bg7', 'Be3', 'Nf6'] },
    { weight: 1, sans: ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5', 'Ng3', 'Bg6', 'h4', 'h6'] },
    { weight: 1, sans: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Nf6', 'e5', 'Nfd7', 'f4', 'c5'] },
    { weight: 1, sans: ['e4', 'e5', 'Nc3', 'Nf6', 'f4', 'd5'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Nf6', 'Nc3', 'Bb4'] },
    { weight: 1, sans: ['d4', 'd5', 'c4', 'dxc4', 'e4'] },
    { weight: 1, sans: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'f4'] },
    /* The gambits the owner named for this bot too: Scotch and Alien. */
    { weight: 2, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Bc4'] }, // Scotch Gambit
    { weight: 2, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'c3'] }, // Göring Gambit
    { weight: 1, sans: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'f3'] }, // Alien Gambit
    ],
    black: [
    // Black: Sicilian and King's Indian, never a passive wall.
    { weight: 5, sans: ['e4', 'c5'] },
    { weight: 2, sans: ['e4', 'c5', 'Nf3', 'd6'] },
    { weight: 2, sans: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'] },
    { weight: 1, sans: ['e4', 'c5', 'Nc3', 'Nf6'] },
    { weight: 1, sans: ['e4', 'c5', 'd4', 'cxd4', 'Nxd4', 'Nf6'] },
    { weight: 1, sans: ['e4', 'c5', 'Bc4', 'e6'] },
    { weight: 2, sans: ['e4', 'e5'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd4', 'exd4', 'c3'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Nf6'] },
    { weight: 3, sans: ['d4', 'Nf6'] },
    { weight: 2, sans: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6'] },
    { weight: 1, sans: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'] },
    { weight: 1, sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6'] },
    { weight: 1, sans: ['d4', 'd5', 'c4', 'dxc4', 'e4'] },
    { weight: 2, sans: ['c4', 'e5'] },
    { weight: 1, sans: ['Nf3', 'd5'] },
    { weight: 1, sans: ['e4', 'e6'] },
    /* The Marshall Attack is an attacking player's reward for meeting the Ruy Lopez. */
    { weight: 3, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'O-O', 'c3', 'd5'] }, // Marshall Attack
    { weight: 1, sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'c6', 'e4', 'dxe4', 'Nxe4', 'Bb4'] }, // Marshall Gambit
    ],
  },

  positional: {
    white: [
    // White: Queen's Gambit, Catalan, English — space and files, not tactics.
    { weight: 4, sans: ['d4'] },
    { weight: 2, sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'O-O', 'Nf3', 'h6', 'Bh4', 'b6'] },
    { weight: 1, sans: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'dxc4', 'a4', 'Bf5'] },
    { weight: 2, sans: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'O-O', 'Bd3', 'd5', 'Nf3', 'c5'] },
    { weight: 2, sans: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'Nf3', 'O-O', 'Be2', 'e5'] },
    { weight: 1, sans: ['d4', 'f5', 'g3', 'Nf6', 'Bg2', 'e6', 'Nf3', 'Be7', 'O-O', 'O-O', 'c4'] },
    { weight: 2, sans: ['c4', 'e5', 'Nc3', 'Nf6', 'Nf3', 'Nc6', 'g3', 'd5', 'cxd5', 'Nxd5', 'Bg2'] },
    { weight: 2, sans: ['Nf3', 'd5', 'g3', 'Nf6', 'Bg2', 'e6', 'O-O', 'Be7', 'd4', 'O-O', 'c4'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O'] },
    { weight: 1, sans: ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5', 'Ng3', 'Bg6', 'h4', 'h6'] },
    { weight: 2, sans: ['Nf3'] },
    { weight: 1, sans: ['c4'] },
    ],
    black: [
    // Black: solid structures with a plan, not a gambit.
    { weight: 2, sans: ['e4', 'e5'] },
    { weight: 2, sans: ['e4', 'e5', 'Nf3', 'Nc6'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O'] },
    { weight: 2, sans: ['e4', 'e6'] },
    { weight: 1, sans: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Nf6'] },
    { weight: 2, sans: ['e4', 'c6'] },
    { weight: 1, sans: ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5'] },
    { weight: 2, sans: ['e4', 'd5'] },
    { weight: 1, sans: ['e4', 'd5', 'exd5', 'Nf6'] },
    { weight: 3, sans: ['d4', 'd5'] },
    { weight: 2, sans: ['d4', 'd5', 'c4', 'e6'] },
    { weight: 1, sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'O-O', 'Nf3', 'h6'] },
    { weight: 1, sans: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'dxc4', 'a4', 'Bf5'] },
    { weight: 3, sans: ['d4', 'Nf6'] },
    { weight: 1, sans: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'O-O'] },
    { weight: 1, sans: ['c4', 'e5'] },
    { weight: 1, sans: ['c4', 'Nf6'] },
    { weight: 1, sans: ['Nf3', 'd5'] },
    ],
  },

  defensive: {
    white: [
    // White: closed Ruy, Giuoco, French/Caro advance, exchange Slav.
    /*
     * d4 LEADS. The two groups were weighted 3 and 2+2+... for a total tie, and a
     * tie at the starting position is decided by insertion order — a coin flip
     * dressed as a repertoire. The closed structures are the point of this
     * personality, so the Queen's-pawn line carries the extra weight and the
     * first move is not ambiguous.
     */
    { weight: 4, sans: ['d4'] },
    { weight: 2, sans: ['e4'] },
    { weight: 2, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O', 'd4'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O', 'Re1'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Nf6', 'Nxc6', 'bxc6', 'e5', 'Qe7', 'Qe2'] },
    { weight: 1, sans: ['e4', 'e6', 'd4', 'd5', 'e5', 'c5', 'c3', 'Nc6', 'Nf3', 'Qb6'] },
    { weight: 1, sans: ['e4', 'c6', 'd4', 'd5', 'e5', 'Bf5', 'Nf3', 'e6', 'Be2'] },
    { weight: 2, sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Nf3', 'c6', 'e3', 'Nbd7', 'Bd3', 'dxc4', 'Bxc4'] },
    { weight: 1, sans: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'dxc4', 'a4', 'Bf5', 'e3', 'e6'] },
    { weight: 1, sans: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'O-O', 'Bd3', 'd5', 'Nf3', 'c5'] },
    { weight: 1, sans: ['d4', 'd5', 'Nf3', 'Nf6', 'e3', 'e6', 'Bd3', 'c5', 'b3', 'Nc6'] },
    { weight: 1, sans: ['c4', 'e5', 'Nc3', 'Nf6', 'Nf3', 'Nc6', 'g3', 'd5', 'cxd5', 'Nxd5', 'Bg2'] },
    { weight: 2, sans: ['Nf3'] },
    { weight: 1, sans: ['c4'] },
    ],
    black: [
    // Black: Berlin, Petroff, French, Caro, QGD; settle the centre.
    { weight: 3, sans: ['e4', 'e5'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Nxe4', 'd4', 'b5', 'Bb3', 'd5'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nf6'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nf6', 'Nxe5', 'd6', 'Nf3', 'Nxe4'] },
    { weight: 2, sans: ['e4', 'e6'] },
    { weight: 1, sans: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Nf6'] },
    { weight: 2, sans: ['e4', 'c6'] },
    { weight: 1, sans: ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5'] },
    { weight: 1, sans: ['e4', 'd5'] },
    { weight: 1, sans: ['e4', 'd5', 'exd5', 'Nf6'] },
    { weight: 3, sans: ['d4', 'd5'] },
    { weight: 1, sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'O-O', 'Nf3', 'h6'] },
    { weight: 1, sans: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'dxc4', 'a4', 'Bf5'] },
    { weight: 2, sans: ['d4', 'Nf6'] },
    { weight: 1, sans: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'O-O'] },
    { weight: 1, sans: ['c4', 'e5'] },
    { weight: 1, sans: ['c4', 'Nf6'] },
    { weight: 1, sans: ['Nf3', 'd5'] },
    ],
  },

  endgame: {
    white: [
    // White: exchange variations, simplified structures, active kings later.
    { weight: 3, sans: ['d4'] },
    { weight: 2, sans: ['Nf3'] },
    { weight: 2, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6', 'dxc6', 'O-O', 'f6', 'd4', 'exd4', 'Nxd4'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Nf6', 'Nxc6', 'bxc6', 'e5', 'Qe7', 'Qe2'] },
    { weight: 2, sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'cxd5', 'exd5', 'Bg5', 'Be7', 'e3', 'O-O', 'Bd3'] },
    { weight: 2, sans: ['d4', 'd5', 'c4', 'c6', 'cxd5', 'cxd5', 'Nc3', 'Nf6', 'Nf3', 'Nc6', 'Bf4', 'Bf5'] },
    { weight: 1, sans: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'O-O', 'Bd3', 'd5', 'Nf3', 'c5'] },
    { weight: 1, sans: ['c4', 'e5', 'Nc3', 'Nf6', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Bb4'] },
    { weight: 1, sans: ['d4', 'Nf6', 'Nf3', 'e6', 'c4', 'b6', 'g3', 'Bb7', 'Bg2', 'Be7', 'O-O', 'O-O'] },
    { weight: 1, sans: ['d4', 'd5', 'Nf3', 'Nf6', 'c4', 'e6', 'Nc3', 'Be7', 'Bf4', 'O-O', 'e3', 'c5'] },
    { weight: 1, sans: ['c4'] },
    ],
    black: [
    // Black: Petroff, French/Caro exchange, QGD exchange.
    { weight: 3, sans: ['e4', 'e5'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6', 'dxc6', 'O-O', 'f6', 'd4', 'exd4', 'Nxd4'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nf6', 'Nxe5', 'd6', 'Nf3', 'Nxe4'] },
    { weight: 1, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O'] },
    { weight: 2, sans: ['e4', 'e6'] },
    { weight: 1, sans: ['e4', 'e6', 'd4', 'd5', 'exd5', 'exd5'] },
    { weight: 2, sans: ['e4', 'c6'] },
    { weight: 1, sans: ['e4', 'c6', 'd4', 'd5', 'exd5', 'cxd5'] },
    { weight: 1, sans: ['e4', 'd5'] },
    { weight: 1, sans: ['e4', 'd5', 'exd5', 'Nf6'] },
    { weight: 3, sans: ['d4', 'd5'] },
    { weight: 1, sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'cxd5', 'exd5', 'Bg5', 'Be7', 'e3', 'O-O'] },
    { weight: 1, sans: ['d4', 'd5', 'c4', 'c6', 'cxd5', 'cxd5', 'Nc3', 'Nf6', 'Nf3', 'Nc6'] },
    { weight: 2, sans: ['d4', 'Nf6'] },
    { weight: 1, sans: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'O-O'] },
    { weight: 1, sans: ['c4', 'e5'] },
    { weight: 1, sans: ['c4', 'Nf6'] },
    { weight: 1, sans: ['Nf3', 'd5'] },
    ],
  },
};

/** board+turn+castling+en-passant, the same key used by imported books */
function posKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

/**
 * Turn a preset's SAN lines into the `BookMemory` the mimic already reads.
 *
 * ONLY THE BOT'S OWN MOVES ARE STORED. A line as written contains both sides'
 * moves; storing the opponent's too would teach the book that the bot had
 * played them. White lines contribute the moves at plies 1, 3, 5..., Black
 * lines the replies at plies 2, 4, 6... The key is recorded from the position
 * before each stored move, which is exactly the position the mimic looks up
 * when it is the bot's turn.
 *
 * Invalid lines are skipped rather than thrown: a shipped repertoire is data,
 * and one typo must not make the Bots screen fail to open. The gate compiles
 * every line and would catch that typo before release.
 */
export function presetBook(id: PresetId): BookMemory {
  const book: BookMemory = {};
  const addLines = (lines: readonly RepertoireLine[], side: 'w' | 'b') => {
    for (const line of lines) {
      const board = new Chess();
      const weight = Math.max(1, Math.floor(line.weight ?? 1));
      for (let i = 0; i < line.sans.length; i++) {
        const key = posKey(board.fen());
        let move;
        try {
          move = board.move(line.sans[i]);
        } catch {
          break;
        }
        if (!move) break;
        // White moves on even indices (plies 1, 3, 5...), Black on odd.
        const isBotMove = side === 'w' ? i % 2 === 0 : i % 2 === 1;
        if (!isBotMove) continue;
        const slot = (book[key] ??= {});
        slot[move.san] = (slot[move.san] ?? 0) + weight;
      }
    }
  };
  addLines(PRESET_REPERTOIRES[id].white, 'w');
  addLines(PRESET_REPERTOIRES[id].black, 'b');
  return book;
}
