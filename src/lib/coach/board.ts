/**
 * The coach's minimal board model — a TypeScript port of the Kotlin prototype's
 * `coach/board/Board.kt` (core representation only; move generation is NOT
 * ported because the app already plays chess through chess.js).
 *
 * Squares: 0..63, sq = rank * 8 + file  (a1 = 0, h1 = 7, a8 = 56, h8 = 63)
 * Pieces:  type 1..6 (P N B R Q K), colour in bit 3. White = 1..6, Black = 9..14, 0 = empty.
 */

export const EMPTY = 0;
export const WHITE = 0;
export const BLACK = 1;

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const piece = (type: number, color: number): number => type | (color << 3);
export const typeOf = (p: number): number => p & 7;
export const colorOf = (p: number): number => p >> 3;

export const fileOf = (sq: number): number => sq & 7;
export const rankOf = (sq: number): number => sq >> 3;
export const sqOf = (file: number, rank: number): number => rank * 8 + file;

export const fileChar = (sq: number): string => String.fromCharCode(97 + fileOf(sq));
export const rankChar = (sq: number): string => String.fromCharCode(49 + rankOf(sq));
export const sqName = (sq: number): string => fileChar(sq) + rankChar(sq);

export function sqFromName(name: string): number {
  return name.charCodeAt(0) - 97 + 8 * (name.charCodeAt(1) - 49);
}

/** true if the square is light-coloured (a1 is dark) */
export const isLightSquare = (sq: number): boolean => ((fileOf(sq) + rankOf(sq)) & 1) === 1;

// castling right bits
export const CASTLE_WK = 1;
export const CASTLE_WQ = 2;
export const CASTLE_BK = 4;
export const CASTLE_BQ = 8;

// frequently used squares
export const A1 = sqOf(0, 0);
export const C1 = sqOf(2, 0);
export const D1 = sqOf(3, 0);
export const E1 = sqOf(4, 0);
export const G1 = sqOf(6, 0);
export const H1 = sqOf(7, 0);
export const A8 = sqOf(0, 7);
export const C8 = sqOf(2, 7);
export const D8 = sqOf(3, 7);
export const E8 = sqOf(4, 7);
export const G8 = sqOf(6, 7);
export const H8 = sqOf(7, 7);

/** Everything the positional analyzer needs from a position. */
export interface CoachBoard {
  pieces: number[]; // 64 entries, EMPTY for empty
  stm: number;
  castling: number;
  ep: number;
  halfmove: number;
  fullmove: number;
}

const FEN_TYPES = ' PNBRQK';

function fromFenChar(c: string): number {
  const t = FEN_TYPES.indexOf(c.toUpperCase());
  if (t <= 0) throw new Error(`bad fen piece '${c}'`);
  return piece(t, c === c.toUpperCase() ? WHITE : BLACK);
}

export function boardFromFen(fen: string): CoachBoard {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) throw new Error(`bad fen '${fen}'`);
  const pieces = new Array<number>(64).fill(EMPTY);
  const rows = parts[0].split('/');
  if (rows.length !== 8) throw new Error(`bad fen placement '${fen}'`);
  for (let r = 0; r < 8; r++) {
    const row = rows[7 - r]; // rows[0] is rank 8
    let f = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') f += ch.charCodeAt(0) - 48;
      else {
        pieces[sqOf(f, r)] = fromFenChar(ch);
        f += 1;
      }
    }
    if (f !== 8) throw new Error(`bad fen row '${row}'`);
  }
  let castling = 0;
  if (parts[2] !== '-') {
    for (const c of parts[2]) {
      if (c === 'K') castling |= CASTLE_WK;
      else if (c === 'Q') castling |= CASTLE_WQ;
      else if (c === 'k') castling |= CASTLE_BK;
      else if (c === 'q') castling |= CASTLE_BQ;
    }
  }
  return {
    pieces,
    stm: parts[1] === 'w' ? WHITE : BLACK,
    castling,
    ep: parts[3] === '-' ? -1 : sqFromName(parts[3]),
    halfmove: parts.length > 4 ? Number.parseInt(parts[4], 10) || 0 : 0,
    fullmove: parts.length > 5 ? Number.parseInt(parts[5], 10) || 1 : 1,
  };
}

export function kingSquareOf(b: CoachBoard, color: number): number {
  const kp = piece(KING, color);
  for (let sq = 0; sq < 64; sq++) if (b.pieces[sq] === kp) return sq;
  return -1;
}

export function pieceName(type: number): string {
  switch (type) {
    case PAWN: return 'pawn';
    case KNIGHT: return 'knight';
    case BISHOP: return 'bishop';
    case ROOK: return 'rook';
    case QUEEN: return 'queen';
    case KING: return 'king';
    default: return 'piece';
  }
}
