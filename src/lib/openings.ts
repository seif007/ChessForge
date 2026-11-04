/**
 * Openings registry — the app is multi-opening. Each entry is a full
 * repertoire (chapters → studies → trees). Every screen (Openings hub,
 * Analysis repertoire check, Stats) picks entries up automatically.
 * The Sicilian, Indian Defenses, King's Indian Defense, Caro-Kann, French,
 * Scandinavian, Slav, Semi-Slav and Grünfeld entries train Black; the Queen's Gambit, English Opening, King's Indian
 * Attack, London System, Colle System, Italian Opening, Ruy Lopez and Scotch
 * entries train White.
 */
import repertoire from '@/data/repertoire.json';
import queensGambit from '@/data/queens-gambit.json';
import indianDefense from '@/data/indian-defense.json';
import kingsIndianDefense from '@/data/kings-indian-defense.json';
import englishOpening from '@/data/english-opening.json';
import kingsIndianAttack from '@/data/kings-indian-attack.json';
import londonSystem from '@/data/london-system.json';
import colleSystem from '@/data/colle-system.json';
import italianOpening from '@/data/italian-opening.json';
import ruyLopez from '@/data/ruy-lopez.json';
import caroKannDefense from '@/data/caro-kann-defense.json';
import frenchDefense from '@/data/french-defense.json';
import scotchOpening from '@/data/scotch-opening.json';
import catalanOpening from '@/data/catalan.json';
import grunfeldDefense from '@/data/grunfeld-defense.json';
import queensGambitAccepted from '@/data/queens-gambit-accepted.json';
import semiSlavDefense from '@/data/semi-slav.json';
import scandinavianDefense from '@/data/scandinavian-defense.json';
import slavDefense from '@/data/slav-defense.json';
import philidorDefense from '@/data/philidor-defense.json';
/*
 * THE ELEVEN OPENINGS BUILT FROM THE LICHESS NAMED-LINE BOOK.
 *
 * These did not exist in the app at all. They were generated mechanically rather
 * than hand-authored, because hand-authoring them is thousands of plies of prose.
 * The standard they meet:
 *
 *   - every ply before the FILLER comment is a move the book NAMES in that exact
 *     position (the most popular continuation that has not been used yet), and
 *   - every ply from the FILLER on is Stockfish's own principal variation, and
 *   - every BRANCH move is a named book move too, extended the same way.
 *
 * So nothing here is invented, which is the failure mode we were repairing.
 * `.tmp-audit/verify_new.py` is the gate: it replays every line and asserts the
 * book/engine split per ply. It reads the same `book.json` the generator does.
 *
 * The only thing missing relative to the hand-built files is the prose: the
 * `commentAfter` strings are empty until the FILLER. The trees, the legal move
 * lists and the training behaviour are identical.
 */
import nimzoIndian from '@/data/nimzo-indian.json';
import queensIndian from '@/data/queens-indian.json';
import dutchDefense from '@/data/dutch-defense.json';
import kingsGambit from '@/data/kings-gambit.json';
import benoni from '@/data/benoni.json';
import alekhineDefense from '@/data/alekhine-defense.json';
import petrovDefense from '@/data/petrov-defense.json';
import fourKnights from '@/data/four-knights.json';
import viennaGame from '@/data/vienna-game.json';
import pircDefense from '@/data/pirc-defense.json';
import bogoIndian from '@/data/bogo-indian.json';
import type { Repertoire, RepStudy } from '@/lib/repertoire';
import type { RepCoverage } from '@/lib/repertoire';
import birdsOpening from '@/data/birds-opening.json';
import bishopsOpening from '@/data/bishops-opening.json';
import blackmarDiemerGambit from '@/data/blackmar-diemer-gambit.json';
import modernDefense from '@/data/modern-defense.json';
import nimzowitschDefense from '@/data/nimzowitsch-defense.json';
import polishOpening from '@/data/polish-opening.json';
import pterodactylDefense from '@/data/pterodactyl-defense.json';
import retiOpening from '@/data/reti-opening.json';
import tarraschDefense from '@/data/tarrasch-defense.json';
import vanGeetOpening from '@/data/van-geet-opening.json';
import zukertortOpening from '@/data/zukertort-opening.json';
import {
  allStudies, bestCoverage, buildCoverageTrie, buildPositionIndex, lookupCoverage,
  positionKey, studyCoverage, type CoverageNode, type PositionEntry,
} from '@/lib/repertoire';

export interface OpeningEntry {
  id: string;
  name: string;
  side: 'white' | 'black';
  tagline: string;
  available: boolean;
  repertoire: Repertoire | null;
  accent: string; // tailwind text color class for the card
}

const SICILIAN = repertoire as unknown as Repertoire;
const PHILIDOR_DEFENSE = philidorDefense as unknown as Repertoire;
const QUEENS_GAMBIT = queensGambit as unknown as Repertoire;
const INDIAN_DEFENSE = indianDefense as unknown as Repertoire;
const KINGS_INDIAN_DEFENSE = kingsIndianDefense as unknown as Repertoire;
const ENGLISH_OPENING = englishOpening as unknown as Repertoire;
const KINGS_INDIAN_ATTACK = kingsIndianAttack as unknown as Repertoire;
const LONDON_SYSTEM = londonSystem as unknown as Repertoire;
const COLLE_SYSTEM = colleSystem as unknown as Repertoire;
const ITALIAN_OPENING = italianOpening as unknown as Repertoire;
const RUY_LOPEZ = ruyLopez as unknown as Repertoire;
const CARO_KANN_DEFENSE = caroKannDefense as unknown as Repertoire;
const FRENCH_DEFENSE = frenchDefense as unknown as Repertoire;
const SCOTCH_OPENING = scotchOpening as unknown as Repertoire;

/*
 * THE PROMOTED QUEEN'S GAMBIT FAMILIES, AND THE GRÜNFELD.
 *
 * These five were CHAPTERS inside other repertoires — the QGA Accepted, the Slav, the
 * Semi-Slav and the Catalan were chapters 5-8 of the Queen's Gambit, and the Grünfeld
 * was chapter 6 of the Indian Defenses. They are now openings in their own right, and
 * the chapters they came from are still in place, so the Queen's Gambit keeps its own
 * copy exactly as it was.
 *
 * The trees are not retyped: `.bench/opening.split.mjs` took the chapter objects
 * verbatim and changed only the three fields that had to change — the study `id`
 * (because `studyIndexAll()` builds ONE flat index across all openings, so a shared
 * id would make one opening silently shadow another), the `chapter` string, and the
 * `mainPlies` / `lineCount` / `stats` counts, which are recomputed with the app's own
 * `collectStudyLines`. Every line of every promoted study is replayed and checked
 * against its stored `fenAfter`.
 *
 * WHY PROMOTING RATHER THAN DUPLICATING MATTERS
 * ---------------------------------------------
 * The alternative was to point these entries at the parent's chapters, so there is one
 * copy in memory. That is tidier and it is wrong here: the user asked for these to be
 * their own openings, which means they will be edited independently from now on, the
 * way the Italian and the Ruy already are. A shared reference would make the next
 * content update to the Catalan silently rewrite the Queen's Gambit too.
 */
const CATALAN = catalanOpening as unknown as Repertoire;
const GRUNFELD = grunfeldDefense as unknown as Repertoire;
const QGA = queensGambitAccepted as unknown as Repertoire;
const SEMI_SLAV = semiSlavDefense as unknown as Repertoire;
const SLAV = slavDefense as unknown as Repertoire;
const SCANDINAVIAN = scandinavianDefense as unknown as Repertoire;

// The eleven book-built openings (see the import block above for provenance).
const NIMZO_INDIAN = nimzoIndian as unknown as Repertoire;
const QUEENS_INDIAN = queensIndian as unknown as Repertoire;
const DUTCH_DEFENSE = dutchDefense as unknown as Repertoire;
const KINGS_GAMBIT = kingsGambit as unknown as Repertoire;
const BENONI = benoni as unknown as Repertoire;
const ALEKHINE_DEFENSE = alekhineDefense as unknown as Repertoire;
const PETROV_DEFENSE = petrovDefense as unknown as Repertoire;
const FOUR_KNIGHTS = fourKnights as unknown as Repertoire;
const VIENNA_GAME = viennaGame as unknown as Repertoire;
const PIRC_DEFENSE = pircDefense as unknown as Repertoire;
const BOGO_INDIAN = bogoIndian as unknown as Repertoire;
const BIRDS_OPENING = birdsOpening as unknown as Repertoire;
const BISHOPS_OPENING = bishopsOpening as unknown as Repertoire;
const BLACKMAR_DIEMER_GAMBIT = blackmarDiemerGambit as unknown as Repertoire;
const MODERN_DEFENSE = modernDefense as unknown as Repertoire;
const NIMZOWITSCH_DEFENSE = nimzowitschDefense as unknown as Repertoire;
const POLISH_OPENING = polishOpening as unknown as Repertoire;
const PTERODACTYL_DEFENSE = pterodactylDefense as unknown as Repertoire;
const RETI_OPENING = retiOpening as unknown as Repertoire;
const TARRASCH_DEFENSE = tarraschDefense as unknown as Repertoire;
const VAN_GEET_OPENING = vanGeetOpening as unknown as Repertoire;
const ZUKERTORT_OPENING = zukertortOpening as unknown as Repertoire;

export const OPENINGS: OpeningEntry[] = [
  {
    id: 'sicilian',
    name: 'Sicilian Defense',
    side: 'black',
    tagline: `Your main weapon as Black — ${SICILIAN.stats.chapters} chapters, ${SICILIAN.stats.studies} studies, ${SICILIAN.stats.lines} trainable lines`,
    available: true,
    repertoire: SICILIAN,
    accent: 'text-gold',
  },
  {
    id: 'queens-gambit',
    name: "Queen's Gambit",
    side: 'white',
    tagline: `Your main weapon as White after 1.d4 — ${QUEENS_GAMBIT.stats.chapters} chapters, ${QUEENS_GAMBIT.stats.studies} studies, ${QUEENS_GAMBIT.stats.lines} trainable lines, incl. the full Catalan`,
    available: true,
    repertoire: QUEENS_GAMBIT,
    accent: 'text-chessforge',
  },
  {
    id: 'indian-defense',
    name: 'Indian Defenses',
    side: 'black',
    tagline: `Your complete Black repertoire vs 1.d4 — ${INDIAN_DEFENSE.stats.chapters} chapters, ${INDIAN_DEFENSE.stats.studies} studies, ${INDIAN_DEFENSE.stats.lines} trainable lines`,
    available: true,
    repertoire: INDIAN_DEFENSE,
    accent: 'text-emerald-300',
  },
  {
    id: 'kings-indian-defense',
    name: "King's Indian Defense",
    side: 'black',
    tagline: `Your sharpest Black answer to 1.d4 — ${KINGS_INDIAN_DEFENSE.stats.chapters} chapters, ${KINGS_INDIAN_DEFENSE.stats.studies} studies, ${KINGS_INDIAN_DEFENSE.stats.lines} trainable lines, from the classical tabiya and the ...f5 storm to the Samisch, the Four Pawns and the Bayonet`,
    available: true,
    repertoire: KINGS_INDIAN_DEFENSE,
    accent: 'text-teal-300',
  },
  {
    id: 'english-opening',
    name: 'English Opening',
    side: 'white',
    tagline: `Your flexible White weapon after 1.c4 — ${ENGLISH_OPENING.stats.chapters} chapters, ${ENGLISH_OPENING.stats.studies} studies, ${ENGLISH_OPENING.stats.lines} trainable lines, from the Reversed Sicilian to the Hedgehog`,
    available: true,
    repertoire: ENGLISH_OPENING,
    accent: 'text-sky-300',
  },
  {
    id: 'kings-indian-attack',
    name: "King's Indian Attack",
    side: 'white',
    tagline: `Your universal White system after 1.e4 — ${KINGS_INDIAN_ATTACK.stats.chapters} chapters, ${KINGS_INDIAN_ATTACK.stats.studies} studies, ${KINGS_INDIAN_ATTACK.stats.lines} trainable lines, from the French and Sicilian setups to the full kingside attack`,
    available: true,
    repertoire: KINGS_INDIAN_ATTACK,
    accent: 'text-amber-300',
  },
  {
    id: 'london-system',
    name: 'London System',
    side: 'white',
    tagline: `Your solid White system after 1.d4 and 2.Bf4 — ${LONDON_SYSTEM.stats.chapters} chapters, ${LONDON_SYSTEM.stats.studies} studies, ${LONDON_SYSTEM.stats.lines} trainable lines, from the classical ...d5 tabiya to the full kingside attack`,
    available: true,
    repertoire: LONDON_SYSTEM,
    accent: 'text-rose-300',
  },
  {
    id: 'colle-system',
    name: 'Colle System',
    side: 'white',
    tagline: `Your classical White system after 1.d4, 2.Nf3 and 3.e3 — ${COLLE_SYSTEM.stats.chapters} chapters, ${COLLE_SYSTEM.stats.studies} studies, ${COLLE_SYSTEM.stats.lines} trainable lines, from the Colle pyramid and the e3-e4 break to the Re3-g3 rook lift`,
    available: true,
    repertoire: COLLE_SYSTEM,
    accent: 'text-violet-300',
  },
  {
    id: 'italian-opening',
    name: 'Italian Opening',
    side: 'white',
    tagline: `Your classical White weapon after 1.e4 and 3.Bc4 — ${ITALIAN_OPENING.stats.chapters} chapters, ${ITALIAN_OPENING.stats.studies} studies, ${ITALIAN_OPENING.stats.lines} trainable lines, from the Giuoco Pianissimo and the Two Knights to the Evans Gambit`,
    available: true,
    repertoire: ITALIAN_OPENING,
    accent: 'text-orange-300',
  },
  {
    id: 'ruy-lopez',
    name: 'Ruy Lopez',
    side: 'white',
    tagline: `Your main weapon as White after 1.e4 e5 2.Nf3 Nc6 3.Bb5 — ${RUY_LOPEZ.stats.chapters} chapters, ${RUY_LOPEZ.stats.studies} studies, ${RUY_LOPEZ.stats.lines} trainable lines, from the Closed Spanish and the Marshall to the Exchange and Berlin`,
    available: true,
    repertoire: RUY_LOPEZ,
    accent: 'text-red-300',
  },
  {
    id: 'caro-kann-defense',
    name: 'Caro-Kann Defense',
    side: 'black',
    tagline: `Your most solid Black answer to 1.e4 — ${CARO_KANN_DEFENSE.stats.chapters} chapters, ${CARO_KANN_DEFENSE.stats.studies} studies, ${CARO_KANN_DEFENSE.stats.lines} trainable lines, from the Classical and the Advance to the Panov-Botvinnik, the Two Knights and the Fantasy`,
    available: true,
    repertoire: CARO_KANN_DEFENSE,
    accent: 'text-cyan-300',
  },
  {
    id: 'french-defense',
    name: 'French Defense',
    side: 'black',
    tagline: `Your most committed Black answer to 1.e4 — ${FRENCH_DEFENSE.stats.chapters} chapters, ${FRENCH_DEFENSE.stats.studies} studies, ${FRENCH_DEFENSE.stats.lines} trainable lines, from the Winawer and the Classical to the Tarrasch, the Milner-Barry Gambit and the Rubinstein`,
    available: true,
    repertoire: FRENCH_DEFENSE,
    accent: 'text-lime-300',
  },
  {
    id: 'scotch-opening',
    name: 'Scotch Opening',
    side: 'white',
    tagline: `Your sharpest White weapon after 1.e4 e5 2.Nf3 Nc6 3.d4 — ${SCOTCH_OPENING.stats.chapters} chapters, ${SCOTCH_OPENING.stats.studies} studies, ${SCOTCH_OPENING.stats.lines} trainable lines, from the Mieses and the Classical 4...Bc5 to the endgame structures and the traps compendium`,
    available: true,
    repertoire: SCOTCH_OPENING,
    accent: 'text-amber-300',
  },
  {
    id: 'catalan',
    name: 'Catalan Opening',
    side: 'white',
    tagline: `1.d4 Nf6 2.c4 e6 3.g3 - the opening that borrowed the Queen's Gambit's pawn and the Closed Sicilian's cramp. ${CATALAN.stats.studies} studies, ${CATALAN.stats.lines} trainable lines, from the Open Catalan tabiya to the Closed and the early g4 systems`,
    available: true,
    repertoire: CATALAN,
    accent: 'text-chessforge',
  },
  {
    id: 'grunfeld-defense',
    name: 'Grünfeld Defense',
    side: 'black',
    tagline: `1.d4 Nf6 2.c4 g6 3.Nc3 d5 - the dynamic counter to the Catalan, giving up the centre for a kingside attack. ${GRUNFELD.stats.studies} studies, ${GRUNFELD.stats.lines} trainable lines, from the Exchange and Russian systems to the Fianchetto and the Spassky variations`,
    available: true,
    repertoire: GRUNFELD,
    accent: 'text-chessforge',
  },
  {
    id: 'queens-gambit-accepted',
    name: "Queen's Gambit Accepted",
    side: 'white',
    tagline: `1.d4 d5 2.c4 dxc4 - you give the pawn back and get a lead in development and an open file. ${QGA.stats.studies} studies, ${QGA.stats.lines} trainable lines, from the Classical and the Defensive systems to the sharp accepting variations`,
    available: true,
    repertoire: QGA,
    accent: 'text-chessforge',
  },
  {
    id: 'slav-defense',
    name: 'Slav Defense',
    side: 'black',
    tagline: `1.d4 d5 2.c4 c6 - the most popular answer to the Queen's Gambit, holding the tension with a half-open c-file. ${SLAV.stats.studies} studies, ${SLAV.stats.lines} trainable lines, from the Semi-Slav structures and the Chebanenko to the ...b4 and the pure Slav endgame plans`,
    available: true,
    repertoire: SLAV,
    accent: 'text-chessforge',
  },
  {
    id: 'scandinavian-defense',
    name: 'Scandinavian Defense',
    side: 'black',
    tagline: `The gambit that has to be proved wrong - ${SCANDINAVIAN.stats.chapters} chapters, ${SCANDINAVIAN.stats.studies} studies, ${SCANDINAVIAN.stats.lines} trainable lines, from the Modern mainline after 4...Nf6 to the 3...Nf6 transposition where White declines the gambit and keeps the extra pawn`,
    available: true,
    repertoire: SCANDINAVIAN,
    accent: 'text-orange-300',
  },
  {
    id: 'semi-slav',
    name: 'Semi-Slav Defense',
    side: 'black',
    tagline: `1.d4 d5 2.c4 c6 3.Nf3 Nf6 4.Nc3 e6 - the Meran, Botvinnik and Moscow structures, and the sharpest reply to 1.d4 that does not fianchetto. ${SEMI_SLAV.stats.studies} studies, ${SEMI_SLAV.stats.lines} trainable lines`,
    available: true,
    repertoire: SEMI_SLAV,
    accent: 'text-chessforge',
  },
  {
    id: 'philidor-defense',
    name: 'Philidor Defense',
    side: 'black',
    tagline: `${PHILIDOR_DEFENSE.stats.chapters} chapters, ${PHILIDOR_DEFENSE.stats.studies} studies, ${PHILIDOR_DEFENSE.stats.lines} trainable lines, the soundest answer to 1.e4 - a solid d6/e5 wall, no attack at all, and a position that repeats until White runs out of patience`,
    available: true,
    repertoire: PHILIDOR_DEFENSE,
    accent: 'text-teal-300',
  },
  {
    id: 'nimzo-indian',
    name: 'Nimzo-Indian Defense',
    side: 'black',
    tagline: `1.d4 Nf6 2.c4 e6 3.Nc3 Bb4 - Black fights for e4 with a piece and accepts a doubled c-pawn when he must. ${NIMZO_INDIAN.stats.chapters} chapters, ${NIMZO_INDIAN.stats.studies} studies, ${NIMZO_INDIAN.stats.lines} trainable lines, from the Classical 4.Qc2 to the Rubinstein and the f3 systems`,
    available: true,
    repertoire: NIMZO_INDIAN,
    accent: 'text-indigo-300',
  },
  {
    id: 'queens-indian',
    name: "Queen's Indian Defense",
    side: 'black',
    tagline: `1.d4 Nf6 2.c4 e6 3.Nf3 b6 - the bishop goes to b7 and the long diagonal is contested on every move. ${QUEENS_INDIAN.stats.chapters} chapters, ${QUEENS_INDIAN.stats.studies} studies, ${QUEENS_INDIAN.stats.lines} trainable lines, the quiet and structurally sound partner to the Nimzo`,
    available: true,
    repertoire: QUEENS_INDIAN,
    accent: 'text-emerald-300',
  },
  {
    id: 'bogo-indian',
    name: 'Bogo-Indian Defense',
    side: 'black',
    tagline: `1.d4 Nf6 2.c4 e6 3.Nf3 Bb4+ - a check that forces White to block with a piece rather than a pawn. ${BOGO_INDIAN.stats.chapters} chapters, ${BOGO_INDIAN.stats.studies} studies, ${BOGO_INDIAN.stats.lines} trainable lines, where the bishop pair is traded for structure and the c-file`,
    available: true,
    repertoire: BOGO_INDIAN,
    accent: 'text-cyan-300',
  },
  {
    id: 'benoni',
    name: 'Benoni Defense',
    side: 'black',
    tagline: `1.d4 Nf6 2.c4 c5 3.d5 e6 - Black hands White the centre and the space, then attacks d5 with everything he has. ${BENONI.stats.chapters} chapters, ${BENONI.stats.studies} studies, ${BENONI.stats.lines} trainable lines, from the Modern main line to the Czech Benoni`,
    available: true,
    repertoire: BENONI,
    accent: 'text-lime-300',
  },
  {
    id: 'dutch-defense',
    name: 'Dutch Defense',
    side: 'black',
    tagline: `1.d4 f5 - Black refuses symmetry and plays for the kingside from move one. ${DUTCH_DEFENSE.stats.chapters} chapters, ${DUTCH_DEFENSE.stats.studies} studies, ${DUTCH_DEFENSE.stats.lines} trainable lines, the Leningrad and Classical set-ups with the Stonewall idea in reserve`,
    available: true,
    repertoire: DUTCH_DEFENSE,
    accent: 'text-orange-300',
  },
  {
    id: 'alekhine-defense',
    name: 'Alekhine Defense',
    side: 'black',
    tagline: `1.e4 Nf6 - the knight invites White to chase it, and Black trades a wrecked pawn structure for active pieces. ${ALEKHINE_DEFENSE.stats.chapters} chapters, ${ALEKHINE_DEFENSE.stats.studies} studies, ${ALEKHINE_DEFENSE.stats.lines} trainable lines, the Four Pawns Attack and the Modern with ...dxe5`,
    available: true,
    repertoire: ALEKHINE_DEFENSE,
    accent: 'text-violet-300',
  },
  {
    id: 'pirc-defense',
    name: 'Pirc Defense',
    side: 'black',
    tagline: `1.e4 d6 2.d4 Nf6 3.Nc3 g6 - let White build the centre, then attack it with pieces. ${PIRC_DEFENSE.stats.chapters} chapters, ${PIRC_DEFENSE.stats.studies} studies, ${PIRC_DEFENSE.stats.lines} trainable lines, the Austrian Attack and the Classical, plus the ...c5 and ...e5 breaks`,
    available: true,
    repertoire: PIRC_DEFENSE,
    accent: 'text-rose-300',
  },
  {
    id: 'petrov-defense',
    name: 'Petrov Defense',
    side: 'black',
    tagline: `1.e4 e5 2.Nf3 Nf6 - Black answers the attack on e5 by attacking e4, the most symmetrical and most solid reply there is. ${PETROV_DEFENSE.stats.chapters} chapters, ${PETROV_DEFENSE.stats.studies} studies, ${PETROV_DEFENSE.stats.lines} trainable lines, the Classical and the Steinitz, where symmetry breaks and the knight goes to c3`,
    available: true,
    repertoire: PETROV_DEFENSE,
    accent: 'text-sky-300',
  },
  {
    id: 'four-knights',
    name: 'Four Knights Game',
    side: 'black',
    tagline: `1.e4 e5 2.Nf3 Nc6 3.Nc3 Nf6 - both sides develop knights before anything else. ${FOUR_KNIGHTS.stats.chapters} chapters, ${FOUR_KNIGHTS.stats.studies} studies, ${FOUR_KNIGHTS.stats.lines} trainable lines, the Spanish Four Knights and the quiet Rubinstein, where the first real decision is whether to take on e4`,
    available: true,
    repertoire: FOUR_KNIGHTS,
    accent: 'text-teal-300',
  },
  {
    id: 'vienna-game',
    name: 'Vienna Game',
    side: 'white',
    tagline: `1.e4 e5 2.Nc3 - a move order that keeps every option open and punishes carelessness with f4. ${VIENNA_GAME.stats.chapters} chapters, ${VIENNA_GAME.stats.studies} studies, ${VIENNA_GAME.stats.lines} trainable lines, the Vienna Gambit after 2...Nf6 3.f4 and the quieter 3.Bc4 and 3.g3`,
    available: true,
    repertoire: VIENNA_GAME,
    accent: 'text-amber-300',
  },
  {
    id: 'kings-gambit',
    name: "King's Gambit",
    side: 'white',
    tagline: `1.e4 e5 2.f4 - the oldest gambit in chess and still the sharpest: a pawn for the centre and the f-file. ${KINGS_GAMBIT.stats.chapters} chapters, ${KINGS_GAMBIT.stats.studies} studies, ${KINGS_GAMBIT.stats.lines} trainable lines, the Kieseritzky and the Modern Defense of the gambit pawn`,
    available: true,
    repertoire: KINGS_GAMBIT,
    accent: 'text-red-300',
  },
  {
    id: 'birds-opening',
    name: 'Bird\'s Opening',
    side: 'white',
    tagline: `f4 d5`,
    available: true,
    repertoire: BIRDS_OPENING,
    accent: 'text-gold',
  },
  {
    id: 'bishops-opening',
    name: 'Bishop\'s Opening',
    side: 'white',
    tagline: `e4 e5 Bc4`,
    available: true,
    repertoire: BISHOPS_OPENING,
    accent: 'text-chessforge',
  },
  {
    id: 'blackmar-diemer-gambit',
    name: 'Blackmar-Diemer Gambit',
    side: 'white',
    tagline: `d4 d5 e4`,
    available: true,
    repertoire: BLACKMAR_DIEMER_GAMBIT,
    accent: 'text-emerald-300',
  },
  {
    id: 'modern-defense',
    name: 'Modern Defense',
    side: 'black',
    tagline: `e4 g6`,
    available: true,
    repertoire: MODERN_DEFENSE,
    accent: 'text-teal-300',
  },
  {
    id: 'nimzowitsch-defense',
    name: 'Nimzowitsch Defense',
    side: 'black',
    tagline: `e4 Nc6`,
    available: true,
    repertoire: NIMZOWITSCH_DEFENSE,
    accent: 'text-sky-300',
  },
  {
    id: 'polish-opening',
    name: 'Polish Opening',
    side: 'white',
    tagline: `d4 b5`,
    available: true,
    repertoire: POLISH_OPENING,
    accent: 'text-amber-300',
  },
  {
    id: 'pterodactyl-defense',
    name: 'Pterodactyl Defense',
    side: 'black',
    tagline: `e4 g6 d4 Bg7 Nc3 c5`,
    available: true,
    repertoire: PTERODACTYL_DEFENSE,
    accent: 'text-rose-300',
  },
  {
    id: 'reti-opening',
    name: 'Réti Opening',
    side: 'white',
    tagline: `Nf3 d5 c4`,
    available: true,
    repertoire: RETI_OPENING,
    accent: 'text-orange-300',
  },
  {
    id: 'tarrasch-defense',
    name: 'Tarrasch Defense',
    side: 'black',
    tagline: `d4 d5 c4 e6 Nc3 c5`,
    available: true,
    repertoire: TARRASCH_DEFENSE,
    accent: 'text-red-300',
  },
  {
    id: 'van-geet-opening',
    name: 'Van Geet Opening',
    side: 'white',
    tagline: `Nc3 b5`,
    available: true,
    repertoire: VAN_GEET_OPENING,
    accent: 'text-cyan-300',
  },
  {
    id: 'zukertort-opening',
    name: 'Zukertort Opening',
    side: 'white',
    tagline: `Nf3 Nf6`,
    available: true,
    repertoire: ZUKERTORT_OPENING,
    accent: 'text-lime-300',
  },
];

export function availableRepertoires(): Repertoire[] {
  return OPENINGS.filter((o) => o.available && o.repertoire).map((o) => o.repertoire as Repertoire);
}

/**
 * The registry with the `available && repertoire` filter already applied.
 *
 * Every screen repeats `OPENINGS.filter(o => o.available && o.repertoire)` and
 * then walks all the chapters and studies. Built once, lazily, and shared.
 */
export const AVAILABLE_OPENINGS: OpeningEntry[] = OPENINGS.filter((o) => o.available && o.repertoire);

export interface StudyRef {
  study: RepStudy;
  entry: OpeningEntry;
  chapterKey: string;   // `${entry.id}::${chapter.title}` — the picker's key
  userColor: 'w' | 'b'; // the side this study trains
}

/**
 * Flat index of every study in the library, built once on first use.
 *
 * The Train customize sheet used to do FOUR independent full-library walks per
 * open (the tree memo, plus the open-openings and open-chapters state
 * initializers, plus a count traversal). Those walks are pure structure — they
 * never read training progress — so they are hoisted here where they happen
 * once for the process lifetime instead of once per sheet open.
 */
let studyIndex: StudyRef[] | null = null;

export function studyIndexAll(): StudyRef[] {
  if (studyIndex) return studyIndex;
  const out: StudyRef[] = [];
  for (const entry of AVAILABLE_OPENINGS) {
    const rep = entry.repertoire as Repertoire;
    const userColor: 'w' | 'b' = entry.side === 'white' ? 'w' : 'b';
    for (const ch of rep.chapters) {
      for (const study of ch.studies) {
        out.push({ study, entry, chapterKey: `${entry.id}::${ch.title}`, userColor });
      }
    }
  }
  studyIndex = out;
  return out;
}

/** Find a study in the flat index (cheaper than re-walking the chapters). */
export function findStudyRef(studyId: string): StudyRef | null {
  return studyIndexAll().find((r) => r.study.id === studyId) ?? null;
}

/**
 * Find a study across ALL registered repertoires and return it together with
 * its opening entry (the entry carries the side the user trains).
 */
export function findStudyWithOpening(studyId: string): { study: RepStudy; entry: OpeningEntry } | null {
  for (const entry of OPENINGS) {
    if (!entry.repertoire) continue;
    const study = entry.repertoire.chapters.flatMap((c) => c.studies).find((s) => s.id === studyId);
    if (study) return { study, entry };
  }
  return null;
}

/** True when the given study belongs to a White repertoire (user plays White). */
export function studyUserColor(studyId: string): 'w' | 'b' {
  const hit = findStudyWithOpening(studyId);
  if (!hit) return 'b';
  return hit.entry.side === 'white' ? 'w' : 'b';
}

export interface GameCoverage {
  opening: OpeningEntry;
  coverage: RepCoverage;
}

// ---------------------------------------------------------------------------
// The book index
// ---------------------------------------------------------------------------
//
// "Your openings" asks the library a question for every user move of every game
// — roughly 3,800 times per derivation, twice per screen open. Answering that by
// walking all 692 studies each time cost 2.3-2.5 s of pure JS per derivation
// (measured), which on a phone is tens of seconds of blocked main thread: the
// user taps an opening, the board appears, and then nothing responds to a touch.
//
// The trie in `repertoire.ts` makes the lookup O(plies) instead of
// O(studies x plies). It is built LAZILY, once, on the first question — nothing
// that only lists openings pays for it.
//
// `ownerOfStudy` is the second half of the answer: the trie says how deep the
// library follows and which studies got there, and the map turns the winning
// study back into the opening entry the callers want.

let coverageTrie: CoverageNode | null = null;
let ownerOfStudy: Map<RepStudy, OpeningEntry> | null = null;

function ensureCoverageIndex(): void {
  if (coverageTrie && ownerOfStudy) return;
  // Same order the old exhaustive scan used — opening, then chapter, then study
  // — because the trie resolves a tie by "first study added wins" and that has
  // to reproduce the old answer exactly.
  const flat: RepStudy[] = [];
  const owners = new Map<RepStudy, OpeningEntry>();
  for (const entry of OPENINGS) {
    if (!entry.available || !entry.repertoire) continue;
    for (const study of allStudies(entry.repertoire)) {
      flat.push(study);
      owners.set(study, entry);
    }
  }
  coverageTrie = buildCoverageTrie(flat);
  ownerOfStudy = owners;
}

/**
 * The slow reference implementation, kept as the fallback the fast path is
 * checked against (see `bestCoverageAcrossOpenings`).
 *
 * It is not dead code: the trie answers "which study follows this line
 * furthest", and the two only agree if the trie's notion of a study's line set
 * is the same as `matchTree`'s. If they ever disagree the fast path detects it
 * (the matched ply of the chosen study will not be the depth the walk reached)
 * and falls back here, so a book-content change can never silently change which
 * study teaches a line.
 */
function exhaustiveCoverageAcrossOpenings(sans: string[]): GameCoverage | null {
  let best: GameCoverage | null = null;
  for (const entry of OPENINGS) {
    if (!entry.available || !entry.repertoire) continue;
    const cov = bestCoverage(entry.repertoire, sans);
    if (cov && cov.matchedPly > 0 && (!best || cov.matchedPly > best.coverage.matchedPly)) {
      best = { opening: entry, coverage: cov };
    }
  }
  return best;
}

/**
 * WHAT DOES OUR BOOK ACTUALLY PLAY HERE — for the side to move.
 *
 * "ARE WE IN BOOK" WAS BEING ANSWERED WITH A 1-PLY COINCIDENCE
 * --------------------------------------------------------------
 * `bestCoverageAcrossOpenings` returns ONE study: the one whose line follows the
 * game furthest, ties broken by registry order. For a game opening `1.e4` EVERY
 * book matches exactly one ply, so the winner is simply whichever entry comes
 * first in the registry — the Sicilian — and its `expectedNext` is read as though
 * it were the answer for whoever is to move.
 *
 * Two things are wrong with that, and both showed up on the device:
 *
 *   1. **The wrong book.** With `1.e4` and Black to move, the winner was the
 *      Sicilian, so the user was offered `c5` — while the books that actually
 *      train Black also offer `c6` (Caro-Kann) and `e6` (French). The screen said
 *      "We have this" and "from our book" about a position where the only Black
 *      books we ship disagree about the move.
 *   2. **The wrong side.** A White book's reply was read as though it were the
 *      Black user's move. `bookMoveAt`'s own comment describes exactly this trap
 *      and then works around it instead of fixing it.
 *
 * So the answer comes from the index instead, which knows every study that passes
 * through a position: the replies are the node's children, and each child's
 * studies say WHICH openings — and therefore which colour — offer it.
 *
 * This is the only place "is this our opening" is answered, and it is answered
 * from the union of what we actually ship, filtered by the side to move. A
 * position where no book for that colour has a move is honestly out of book, and
 * the UI says so rather than inventing an attribution.
 */
export interface BookHere {
  /** How far the library follows the line from the start. */
  depth: number;
  /** Every SAN a book for `side` offers here, in registry order. */
  replies: string[];
  /** The opening entries that offer at least one of those replies. */
  entries: OpeningEntry[];
  /** The single entry to credit, or null when none of them has a move here. */
  entry: OpeningEntry | null;
}

export function bookHere(sans: string[], openingId?: string | null): BookHere | null {
  if (sans.length === 0) return null;
  /*
   * THE MOVER IS DERIVED, NOT PASSED.
   * ---------------------------------
   * A book is a tree of WHOLE LINES, so a White book's tree contains Black's moves
   * as well as White's. "Which side does this book advise" is therefore not
   * enough to know whether an edge at this node is advice for the mover — the
   * first version of this function took the side as an argument, and a caller who
   * asked about the wrong side got the OPPONENT's moves back with a confident
   * label. `bookHere(['d4'], 'w')` returned `d5 Nf6 g6` — all Black moves — because
   * after 1.d4 it is Black to move and those edges come from White books' lines.
   *
   * The side to move is a fact about the position: White moves on even plies. So
   * it is read from `sans.length` and there is no argument to get wrong.
   */
  const side: 'w' | 'b' = sans.length % 2 === 0 ? 'w' : 'b';
  ensureCoverageIndex();
  const hit = lookupCoverage(coverageTrie as CoverageNode, sans);
  if (!hit) return null;

  const replies: string[] = [];
  const entries: OpeningEntry[] = [];
  const seenEntry = new Set<OpeningEntry>();
  for (const [san, child] of hit.node.children) {
    for (const study of child.studies) {
      const e = ownerOfStudy?.get(study);
      // Only a book that trains the MOVER can advise the mover here.
      if (!e || (e.side === 'white' ? 'w' : 'b') !== side) continue;
      /*
       * ONLY THE OPENING BEING TAUGHT, WHEN THE CALLER KNOWS WHICH ONE.
       *
       * This is the general fix for the wrong suggestion, and it was not a lookup miss: the
       * answer was ALWAYS from some book, just never from the right one. `replies` was built
       * from every opening at this position, so `replies[0]` was whichever SAN the trie
       * happened to insert first — the registry order of the studies, which has nothing to do
       * with the opening the user is playing. At `1.d4 d5` that is a position shared by the
       * London System, the Queen's Gambit, the Slav, the Catalan and four more, so the
       * Queen's Gambit card was told to play `e4`.
       *
       * Scoping to the opening is what makes the sentence "our book move" true. It is optional
       * because a caller that genuinely does not know the opening still wants every reply.
       */
      if (openingId && e.id !== openingId) continue;
      replies.push(san);
      if (!seenEntry.has(e)) { seenEntry.add(e); entries.push(e); }
      break;   // one study from that entry is enough to credit it
    }
  }
  return { depth: hit.depth, replies, entries, entry: entries[0] ?? null };
}

/**
 * WHICH OPENING IS THIS LINE, decided by how far each book follows it.
 *
 * WHY THE OLD ANSWER WAS NOT GENERAL
 * -----------------------------------
 * Everything that needed to name an opening asked `bestCoverageAcrossOpenings`, which returns
 * ONE study — the one whose tree follows the line furthest, with ties broken by REGISTRY ORDER.
 * That tie-break is the bug. `1.d4 d5` is two plies that both the London System and the
 * Queen's Gambit Declined contain, so both score `matchedPly = 2` and the registry decided:
 * `queens-gambit` is second in the list and `london-system` is seventh, so anything identified
 * at that prefix came back Queen's Gambit. The family's name, its card, the book used to finish
 * its line and the move recommended inside it were then all Queen's Gambit — including, for a
 * London System user, `c4`.
 *
 * Fixing the London symptom by passing an opening id somewhere did nothing, because the id
 * itself was the thing that was wrong.
 *
 * THE RULE
 * --------
 * Score every available opening by the deepest ply ITS OWN books follow this line, and take the
 * winner. Depth is the evidence: the London System book follows `d4 d5 Nf3 Nf6 Bf4` and the
 * Queen's Gambit's stops at `d4 d5`, so a London line is a London line no matter what order
 * the registry happens to be in. Where two openings tie on the longest prefix, the rest of the
 * line breaks it — a total across the other prefixes is more evidence, not less.
 */
/**
 * How many of `openingId`'s own studies pass through this line?
 *
 * THIS IS THE TIE-BREAKER THAT ACTUALLY SEPARATES TRANSPOSITIONS.
 * ----------------------------------------------------------
 * Depth alone does not. The Slav and the Queen's Gambit Declined are both reachable from
 * `d4 d5`, and our QG book contains a Slav line as one of its branches, so both books follow
 * a `d4 d5 c4 c6 Nf3 Nf6` line for its whole length and score identically. The registry order
 * then decides, and the parent opening wins every time: the Grunfeld came back as the Indian
 * Defense, the Slav and the Semi-Slav as the Queen's Gambit, the Catalan likewise.
 *
 * What separates them is not depth but TYPICALITY. This line is what the Slav book is FOR, so
 * many Slav studies contain it; it is an occasional branch of a much broader Queen's Gambit
 * book, so few QG studies do. The opening for which the line is most characteristic is the
 * opening the user is playing.
 */
export function openingStudyCountAt(sans: string[], openingId: string): number {
  if (sans.length === 0) return 0;
  ensureCoverageIndex();
  const hit = lookupCoverage(coverageTrie as CoverageNode, sans);
  if (!hit) return 0;
  const owner = ownerOfStudy as Map<RepStudy, OpeningEntry>;
  let n = 0;
  for (const st of hit.node.studies) if (owner.get(st)?.id === openingId) n++;
  return n;
}

/** How many studies an opening has at all. Cached: the registry is static at runtime. */
let openingStudyTotals: Map<string, number> | null = null;
function studyTotalOf(openingId: string): number {
  if (!openingStudyTotals) {
    openingStudyTotals = new Map();
    for (const entry of OPENINGS) {
      let n = 0;
      for (const ch of entry.repertoire?.chapters ?? []) n += (ch.studies ?? []).length;
      openingStudyTotals.set(entry.id, n);
    }
  }
  return openingStudyTotals.get(openingId) ?? 0;
}

/**
 * How much of an opening IS this line: studies through the node, over studies in total.
 *
 * NORMALISED, AND THE NORMALISATION IS THE WHOLE POINT
 * --------------------------------------------------
 * Comparing the raw count is exactly backwards for transpositions, and the measurement says so
 * plainly. A broad parent book is large, so even though this line is one of its rare branches
 * it still owns more studies at the node than the small book that is entirely about it:
 *
 *     line                     through node   total studies   share
 *     Grunfeld (9 studies)           3               9          0.33
 *     Indian Defense (88)            4              88          0.05
 *     Benoni (4 studies)             2               4          0.50
 *     Indian Defense (88)            8              88          0.09
 *
 * Dividing by the opening's own size makes the measure scale-free, so it no longer rewards
 * whichever book happens to be biggest. The Grunfeld wins 0.33 against 0.05 on a count of 3
 * against 4, which is the answer a chess player would give and the answer the registry order
 * could never produce.
 */
export function openingTypicality(sans: string[], openingId: string): number {
  const total = studyTotalOf(openingId);
  if (total === 0) return 0;
  return openingStudyCountAt(sans, openingId) / total;
}

export function bestOpeningForLine(
  prefixes: readonly (readonly string[])[],
): { id: string; depth: number } | null {
  const usable = prefixes.filter((p) => p.length > 0);
  if (usable.length === 0) return null;
  // The longest prefix is the most discriminating single piece of evidence, so it decides and
  // the others only break ties.
  let longest = usable[0];
  for (const p of usable) if (p.length > longest.length) longest = p;
  const key = longest as string[];

  /*
   * TWO PHASES, because depth has to be known before it can be tied.
   *
   * One pass cannot do it: the winner of the first opening examined is not necessarily the
   * winner overall, and a comparison that prefers "typicality" before knowing the maximum depth
   * would let a broad opening that contains many studies of a shallower line beat the
   * specialised opening that follows it all the way. So: find the deepest first, then break
   * that tie among the openings that achieved it.
   */
  let bestDepth = 0;
  const candidates: { id: string; total: number }[] = [];
  for (const entry of OPENINGS) {
    if (!entry.available || !entry.repertoire) continue;
    const hit = bestCoverageAcrossOpenings(key, entry.id);
    const depth = hit ? hit.coverage.matchedPly : 0;
    if (depth === 0) continue;
    if (depth > bestDepth) {
      bestDepth = depth;
      candidates.length = 0;
      candidates.push({ id: entry.id, total: 0 });
    } else if (depth === bestDepth) {
      candidates.push({ id: entry.id, total: 0 });
    }
  }
  if (candidates.length === 0) return null;

  // Among the openings that follow the line furthest, the one for which the line is most
  // TYPICAL wins. The raw count is the wrong measure and measurably so; see `openingTypicality`.
  let winner = candidates[0];
  for (const c of candidates) {
    const typical = openingTypicality(key, c.id);
    const winnerTypical = openingTypicality(key, winner.id);
    if (typical > winnerTypical) { winner = c; continue; }
    if (typical < winnerTypical) continue;
    // Still tied: the rest of the line is more evidence than any single one of them.
    let total = 0;
    for (const p of usable) {
      const h = bestCoverageAcrossOpenings(p as string[], c.id);
      if (h) total += h.coverage.matchedPly;
    }
    if (total > winner.total) winner = c;
  }
  return { id: winner.id, depth: bestDepth };
}

/**
 * Match a game against every available repertoire and keep the best hit.
 * Opening-aware: the Sicilian and the Queen's Gambit, automatically extended
 * when new repertoires are registered.
 *
 * THE FAST PATH IS NOT AN APPROXIMATION
 * -------------------------------------
 * The trie only supplies the WINNING STUDY - `studies[0]` at the deepest node
 * is the first study in scan order that the library follows that far, which is
 * precisely the study the exhaustive scan would have kept. Everything the caller
 * actually reads (`matchedPly`, `expectedNext`, `study`) then comes from
 * `studyCoverage` on that one study, i.e. from the same `matchTree` walk as
 * before. One study is walked instead of 692, and the answer is identical.
 *
 * `.bench/bookindex.diff.test.mjs` proves that on the real corpus: every prefix
 * of every game, old implementation against new, compared field by field.
 */
export function bestCoverageAcrossOpenings(sans: string[], openingId?: string | null): GameCoverage | null {
  if (sans.length === 0) return null;

  /*
   * MEMOISED, BECAUSE "YOUR OPENINGS" CALLS THIS THOUSANDS OF TIMES.
   *
   * The builder walks every user move of every one of the user's games - 160 games in the
   * measured case, about 20 positions each - and asks this question at every one. The
   * answer depends only on `sans`, and the repertoires are static imports that cannot
   * change while the process runs, so every repeat call was recomputing an answer it
   * already had.
   *
   * Worse, a disagreement between the trie and the tree walk sends the call to
   * `exhaustiveCoverageAcrossOpenings`, which walks ALL 42 repertoires' full trees. A few
   * percent of calls taking that path turns one screen into millions of tree walks, and
   * that is the 6.4 seconds measured on the device.
   *
   * The key is the SAN sequence joined, so prefixes of different lengths are different
   * entries - which is what makes the memo correct rather than merely fast. It is bounded
   * so a long session cannot grow it without limit, and the oldest half is dropped rather
   * than the newest: the builder's access pattern is a burst of prefixes per game, so the
   * recent half is the half worth keeping.
   */
  // The opening is part of the question, not a filter applied afterwards: the same move
  // list has a different answer per book, so it belongs in the key.
  const memoKey = (openingId ? `o:${openingId}|` : '') + sans.join(' ');
  const memoHit = coverageMemo.get(memoKey);
  if (memoHit !== undefined) return memoHit;

  const answer = computeBestCoverage(sans, openingId);
  if (coverageMemo.size >= COVERAGE_MEMO_MAX) {
    const drop = [...coverageMemo.keys()].slice(0, Math.floor(COVERAGE_MEMO_MAX / 2));
    for (const k of drop) coverageMemo.delete(k);
  }
  coverageMemo.set(memoKey, answer);
  return answer;
}

const coverageMemo = new Map<string, GameCoverage | null>();
const COVERAGE_MEMO_MAX = 20_000;

/**
 * THE UNSCOPED PATH IS DELIBERATELY UNTOUCHED.
 *
 * `computeBestCoverage` without an `openingId` is the function `.bench/bookindex.diff.test.mjs`
 * proves equal to the exhaustive reference, and its answer is "whichever study follows this
 * line furthest, ties broken by registry order". That tie-break is correct for the question it
 * was built to answer - "what does any of our books do here" - and wrong for "what does THIS
 * opening do here". So the scoped answer is computed separately rather than by adding a filter
 * to the shared one, and a regression in the proven path shows up as a failing diff test
 * instead of quietly changing every opening name in the app.
 */
function computeBestCoverage(sans: string[], openingId?: string | null): GameCoverage | null {
  ensureCoverageIndex();
  const hit = lookupCoverage(coverageTrie as CoverageNode, sans);
  if (!hit) return null;
  const owner = ownerOfStudy as Map<RepStudy, OpeningEntry>;

  if (openingId) {
    /*
     * ONLY THIS OPENING'S STUDIES ARE ELIGIBLE.
     *
     * WHY THIS IS NEEDED - THE DEVICE REPORT
     * ---------------------------------------
     * The London System and the Queen's Gambit Declined share their first two plies: `1.d4 d5`.
     * A line of two plies is all either book needs to match, so both score `matchedPly = 2`
     * and the tie is broken by registry order. The family was named London, and the book
     * chosen to finish its line was the Queen's Gambit's - so the move offered in the London
     * System card was `c4`, a Queen's Gambit move. The user noticed: *"that move is a queens
     * gambit move not london"*.
     *
     * Depth alone cannot break the tie, because at a shared prefix the depths are equal by
     * construction. The opening is the only thing that distinguishes them, so it has to be
     * part of the lookup.
     *
     * Every study passing through this node is a candidate, and the best one for THIS opening
     * is the one whose own tree follows the line furthest - which is not necessarily the
     * node's first study, because the trie stores studies in scan order across all openings.
     */
    let best: { study: RepStudy; matched: number; cov: ReturnType<typeof studyCoverage> } | null = null;
    for (const study of hit.node.studies) {
      if (owner.get(study)?.id !== openingId) continue;
      const cov = studyCoverage(study, sans);
      if (cov.matched === 0) continue;
      if (!best || cov.matched > best.matched) best = { study, matched: cov.matched, cov };
    }
    if (!best) return null;   // this opening genuinely does not teach this line
    const opening = owner.get(best.study);
    if (!opening) return null;
    return {
      opening,
      coverage: { study: best.study, matchedPly: best.cov.matched, expectedNext: best.cov.expected },
    };
  }

  const study = hit.node.studies[0];
  if (!study) return null;
  const opening = owner.get(study);
  if (!opening) return null;

  const cov = studyCoverage(study, sans);
  // The trie said `hit.depth`; the tree walk of the chosen study must agree, or
  // the index and the trees disagree about what this book contains and the
  // exhaustive answer is the only one we can trust.
  if (cov.matched !== hit.depth) return exhaustiveCoverageAcrossOpenings(sans);

  return { opening, coverage: { study, matchedPly: cov.matched, expectedNext: cov.expected } };
}

// ---------------------------------------------------------------------------
// CONTINUING A LINE BY POSITION
// ---------------------------------------------------------------------------
//
// The move-order index above cannot answer the question this screen actually asks, which is
// "where does OUR line go from HERE?". See the long note on `buildPositionIndex` in
// `repertoire.ts` for the measurement; the short version is that a SAN trie matches the reported
// Najdorf for two plies and can never match again, however the game is played from there.
//
// This is the transposition-aware answer: look the POSITION up, and return the rest of one of
// our lines from there. It is consulted only after the move-order lookups have failed, so it can
// only ever add continuations that were not available before — it cannot change which study an
// opening is identified as, or which book teaches a line the index already covers.

const positionIndexes = new Map<string, Map<string, PositionEntry[]>>();

/**
 * The position index for ONE opening, built on first use and cached for the session.
 *
 * Keyed by `openingId` and never built library-wide, for the reason given on `COVERAGE_MAX_PLY`:
 * the previous full-depth trie cost 8 seconds and 37 MB of synchronous work on the UI thread the
 * first time "Your openings" was opened. One opening is a few thousand positions and is built
 * once, for the opening the user is already looking at.
 *
 * An unknown or unavailable `openingId` returns null rather than falling back to every opening.
 * A cross-opening answer is precisely the bug where a London System line was finished with the
 * Queen's Gambit's book and the user noticed; "I could not find it here" is a much better
 * failure than "I found it in the wrong book".
 */
function positionIndexFor(openingId: string): Map<string, PositionEntry[]> | null {
  const cached = positionIndexes.get(openingId);
  if (cached) return cached;

  const entry = OPENINGS.find((o) => o.id === openingId);
  if (!entry || !entry.available || !entry.repertoire) return null;

  const index = buildPositionIndex(allStudies(entry.repertoire));
  positionIndexes.set(openingId, index);
  return index;
}

/**
 * Our book's continuation of the position `fen` describes, or null when we do not teach it.
 *
 * `openingId` is not optional here. This is the fix for a bug whose whole character was that a
 * book was chosen for the wrong opening, and an unscoped position lookup would reintroduce it
 * through a different door: `1.d4 d5` is one position reached by many openings, and the registry
 * order would decide which one teaches the rest of the line.
 *
 * WHERE SEVERAL OF OUR LINES REACH THE SAME POSITION, the one with the most moves left is
 * chosen — the most to learn from — and ties go to whichever was indexed first, which is
 * opening order, then chapter, then study, the same order the SAN trie's "first study added
 * wins" already uses.
 *
 * The moves returned are the remainder of one of our lines from that position, so they are legal
 * there by construction. The caller still replays them before using them, which costs nothing
 * and is the only way to be sure.
 */
export function bookContinuationFromPosition(
  fen: string,
  openingId?: string | null,
): { studyTitle: string; moves: string[] } | null {
  if (!openingId) return null;
  const index = positionIndexFor(openingId);
  if (!index) return null;

  const bucket = index.get(positionKey(fen));
  if (!bucket || bucket.length === 0) return null;

  let best = bucket[0];
  let bestRemaining = best.sans.length - best.ply;
  for (let i = 1; i < bucket.length; i++) {
    const remaining = bucket[i].sans.length - bucket[i].ply;
    if (remaining > bestRemaining) { best = bucket[i]; bestRemaining = remaining; }
  }
  if (bestRemaining <= 0) return null;

  return { studyTitle: best.study.title, moves: best.sans.slice(best.ply) };
}
