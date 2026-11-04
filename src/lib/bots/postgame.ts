/**
 * Bots — what the end of a game owes the user.
 *
 * THE REPORT: *"when the game is over i want you to show which one win and wich one lose
 * (add something to the king piece indicating win or lose) and the user should be able
 * to see the game from start to end with arrows to advance to next moce and the app provide a pgn
 * which he can copy to analyse the game."*
 *
 * Three jobs, all of them about the game that has FINISHED, and all of them pure:
 *
 *   1. WHO WON — the token a PGN carries (`resultToken`) and the colours the king marks need.
 *      Kept here rather than inline in the screen so the truth table is testable: checkmate is
 *      the side-to-move NOT having a move; a resignation is the explicit result; anything else
 *      that ended is a draw.
 *   2. WHERE THE KINGS ARE — `kingSquare` reads the FEN and returns the square, because the board
 *      paints the win/loss mark on the king by square name.
 *   3. THE PGN — `buildBotPgn` writes the headers and the movetext the user copies out to
 *      analyse the game somewhere else.
 */

export type BotGameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

/**
 * The PGN result token for a finished game.
 *
 * `null` means there is no winner — a draw — which is the only remaining way a game can be
 * finished once checkmate and the two resignations are accounted for. The `'*'` token (game not
 * over) is never produced here; the screen only asks after `over` is true.
 */
export function resultToken(winner: 'white' | 'black' | null): BotGameResult {
  if (winner === 'white') return '1-0';
  if (winner === 'black') return '0-1';
  return '1/2-1/2';
}

/** `YYYY.MM.DD`, the PGN date format. */
export function pgnDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/**
 * The square the king of `color` stands on, from the board field of a FEN, or null if there is
 * none (a FEN that is not a full board, or a game that somehow has no king — neither happens in
 * play, but the function must not throw on bad input).
 */
export function kingSquare(fen: string, color: 'w' | 'b'): string | null {
  const rows = fen.split(' ')[0]?.split('/') ?? [];
  if (rows.length !== 8) return null;
  const target = color === 'w' ? 'K' : 'k';
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') {
        file += ch.charCodeAt(0) - 48;
        continue;
      }
      if (ch === target) return `${String.fromCharCode(97 + file)}${8 - r}`;
      file += 1;
    }
  }
  return null;
}

/** Header values cannot carry the characters PGN reserves. */
function headerSafe(value: string): string {
  return value.replace(/["\\\r\n]/g, '').trim();
}

const PGN_WRAP = 80;

/**
 * The finished game as a PGN string: seven-tag roster, then the movetext wrapped at 80 columns,
 * then the result token.
 *
 * Wrapping matters here and is not cosmetic — a long game on one line is exactly the thing some
 * analysis tools mangle when it is pasted back in, and the user's copy is going INTO a tool.
 *
 * `moves` is the screen's history: SAN plus the colour that played it. Move numbers come from the
 * colour, so a game that ends after White's move reads `4. Qxf7# 1-0` and one that ends after
 * Black's reads `… 2. g4 Qh4# 0-1` — the same thing every other PGN writer emits.
 */
export function buildBotPgn(opts: {
  moves: readonly { san: string; color: 'w' | 'b' }[];
  white: string;
  black: string;
  result: BotGameResult;
  /** `YYYY.MM.DD` — see `pgnDate`. */
  date: string;
  event?: string;
}): string {
  const headers: [string, string][] = [
    ['Event', opts.event ?? 'ChessForge bot game'],
    ['Site', 'ChessForge'],
    ['Date', opts.date],
    ['White', headerSafe(opts.white) || 'White'],
    ['Black', headerSafe(opts.black) || 'Black'],
    ['Result', opts.result],
  ];

  const tokens: string[] = [];
  opts.moves.forEach((m, i) => {
    if (m.color === 'w') tokens.push(`${Math.floor(i / 2) + 1}.`);
    tokens.push(m.san);
  });
  tokens.push(opts.result);

  const lines: string[] = [];
  let line = '';
  for (const t of tokens) {
    if (line.length > 0 && line.length + 1 + t.length > PGN_WRAP) {
      lines.push(line);
      line = '';
    }
    line = line.length > 0 ? `${line} ${t}` : t;
  }
  if (line.length > 0) lines.push(line);

  const roster = headers.map(([k, v]) => `[${k} "${v}"]`).join('\n');
  return `${roster}\n\n${lines.join('\n')}\n`;
}
