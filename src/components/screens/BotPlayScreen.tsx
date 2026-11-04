'use client';

/**
 * Playing a bot — the board, the tuning, and why the bot moved.
 *
 * The screen keeps ONE `Chess` instance for the live game and derives everything
 * on screen from its FEN; the bot's turn is driven by an effect watching that
 * FEN, so the move it makes and the move drawn are never out of step.
 *
 * Two ideas from the web version are kept exactly as they were, because they
 * are the whole feature:
 *
 *   MIMICRY STRENGTH — one dial from "pure engine" to "maximum mimicry". It
 *   slides the α/β/γ weights; advanced mode exposes the three dials directly,
 *   so the user can trade engine strength against how much the player's own
 *   personality is allowed to matter.
 *
 *   WHY — every bot move arrives with the sentence explaining it ("captures —
 *   this player trades at a higher rate than most"). A bot that cannot say why
 *   it moved is a weak engine with a name attached; this is what makes the
 *   opponent legible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Clipboard, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { Chess } from 'chess.js';

import { ChessForgeBoard } from '@/components/chess/ChessForgeBoard';
import { KingMark } from '@/components/chess/KingMark';
import { CoachGameChat } from '@/components/CoachGameChat';
import type { CoachChatLine } from '@/components/CoachGameChat';
import { Btn, Card, IconBtn, Segmented } from '@/components/ui/Primitives';
import {
  IconChevronLeft, IconChevronRight, IconChevronsLeft, IconChevronsRight,
  IconFlag, IconLightbulb, IconUndo,
} from '@/components/ui/Icons';
import { colors, fonts, radii, themedStyles } from '@/theme/tokens';
import { getEngine } from '@/lib/engine';
import { targetSquares } from '@/lib/hint';
import { botDisplayName } from '@/lib/bots/display';
import { normalizeWeights, weightsFromMimicry } from '@/lib/bots/mimic';
import { botMoveFor, botShouldResign, humanThinkDelayMs } from '@/lib/bots/play';
import { playGameEnd, playMoveSound } from '@/lib/sounds';
import { useAppStore } from '@/lib/store';
import { coachMoveFor, coachProfile } from '@/lib/bots/coachBot';
import { buildBotPgn, kingSquare, pgnDate, resultToken } from '@/lib/bots/postgame';
import { loadBot } from '@/lib/bots/store';
import { recordCasualGame, type CasualRatingChange } from '@/lib/arena/store';
import { startingClocks } from '@/lib/arena/game';
import { TIME_CONTROLS, formatClock, timeControlById, timeControlLabel } from '@/lib/arena/timeControl';
import type { ArenaTimeCategory } from '@/lib/arena/types';
import type { BotProfile, MimicWeights } from '@/lib/bots/types';
import { activeCoach } from '@/lib/coach/session';

type UserColor = 'white' | 'black';

export function BotPlayScreen({ botId, coachElo, onExit, onAnalyse }: {
  botId: string;
  /**
   * When set, the opponent is the coach at this engine level instead of a
   * stored player bot. The coaching chat and hint explanations ride alongside.
   */
  coachElo?: number | null;
  onExit: () => void;
  /**
   * Hand the finished game's PGN to the Analysis page — the "Game review" button.
   *
   * The analysis page is a tab, and this screen is an overlay, so the PGN travels through the
   * shell rather than through a prop of a common parent; the shell clears it once consumed.
   */
  onAnalyse?: (pgn: string) => void;
}) {
  const [profile, setProfile] = useState<BotProfile | null>(
    () => (coachElo != null ? coachProfile(coachElo) : null),
  );
  const [missing, setMissing] = useState(false);
  const coachMode = coachElo != null;

  useEffect(() => {
    if (coachElo != null) {
      setProfile(coachProfile(coachElo));
      setMissing(false);
      return;
    }
    let on = true;
    void loadBot(botId).then((p) => {
      if (!on) return;
      if (p) setProfile(p);
      else setMissing(true);
    });
    return () => {
      on = false;
    };
  }, [botId, coachElo]);

  const gameRef = useRef(new Chess());
  const [fen, setFen] = useState(gameRef.current.fen());
  /**
   * Every move of the game, with the squares only the record can carry.
   *
   * `from`/`to` were added for the post-game review — stepping through the finished game
   * highlights the move being shown, and a SAN on its own cannot say where it went.
   */
  const [history, setHistory] = useState<
    { san: string; color: 'w' | 'b'; from: string; to: string }[]
  >([]);
  const [userColor, setUserColor] = useState<UserColor>('white');
  const [thinking, setThinking] = useState(false);
  const [lastBot, setLastBot] = useState<{ san: string; reason: string } | null>(null);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const thinkingRef = useRef(false);

  /**
   * HOW THE GAME ENDED EARLY — resignations.
   *
   * Checkmate and draws are read off the board; the two resignations cannot
   * be, so they are a small explicit result. `winner` is a colour of the
   * USER's, matching `userColor`, so the sentence under the board can say
   * "you win" without translating sides twice.
   */
  const [manualResult, setManualResult] = useState<{ winner: UserColor; reason: string } | null>(
    null,
  );
  const [hint, setHint] = useState<{ from: string; to: string[]; san?: string } | null>(null);
  const [hintBusy, setHintBusy] = useState(false);
  const hintBusyRef = useRef(false);

  /**
   * The in-game coach conversation. The screen owns it so the lightbulb in the
   * action row and the chat's own Hint button feed the same thread.
   */
  const [coachLines, setCoachLines] = useState<CoachChatLine[]>([]);
  const [coachBusy, setCoachBusy] = useState(false);
  const coachBusyRef = useRef(false);
  const coachSeq = useRef(0);
  const coachHistoryRef = useRef<[string, string][]>([]);

  /**
   * POST-GAME REVIEW — the ply the board shows when stepping through the finished game.
   *
   * `null` is "live": the real, final position. Any number is the count of plies replayed from
   * move 1. The game itself is never touched while reviewing — the replay is a throwaway `Chess`
   * walked from the start — so stepping back and forth cannot corrupt the result, and leaving
   * the review puts the final position back for free.
   */
  const [reviewAt, setReviewAt] = useState<number | null>(null);
  /** "PGN copied" is shown on the button for a moment, then the label comes back. */
  const [copied, setCopied] = useState(false);

  const [mimicry, setMimicry] = useState(0.6);
  const [tuning, setTuning] = useState<'simple' | 'advanced'>('simple');
  const [weights, setWeights] = useState<MimicWeights | null>(null);

  /*
   * CASUAL GAME OPTIONS.
   *
   * The owner asked for the same choice a tournament offers: rated or not, and
   * which time control. A rated game here moves the SAME ChessForge Elo a rated
   * Arena game does (see `recordCasualGame`), so the profile number is one
   * number and not a tournament-only fiction. Untimed is a valid rated control.
   */
  const [rated, setRated] = useState(false);
  const [timeId, setTimeId] = useState('untimed');
  const [clocks, setClocks] = useState<{ white: number; black: number } | null>(null);
  const [timedOutWinner, setTimedOutWinner] = useState<UserColor | null>(null);
  const [ratingChange, setRatingChange] = useState<CasualRatingChange | null>(null);
  const ratedAppliedRef = useRef(false);
  const clockRef = useRef<{ white: number; black: number } | null>(null);

  const timeControl = timeControlById(timeId);
  const timed = !timeControl.untimed && timeControl.initialSeconds > 0;
  const settingsRef = useRef({ rated, timeId });
  settingsRef.current = { rated, timeId };

  const advancedWeights = weights ?? weightsFromMimicry(mimicry);
  const activeWeights = useMemo(
    () => (tuning === 'advanced' && weights ? normalizeWeights(weights) : weightsFromMimicry(mimicry)),
    [tuning, weights, mimicry],
  );

  const profileRef = useRef<BotProfile | null>(null);
  profileRef.current = profile;
  const weightsRef = useRef(activeWeights);
  weightsRef.current = activeWeights;
  // `botMove` runs from a callback that must not re-bind per render, so the
  // colour it reads when announcing a resignation comes from a live ref.
  const userColorRef = useRef(userColor);
  userColorRef.current = userColor;

  const game = gameRef.current;
  const gameOver = useMemo(() => game.isGameOver(), [fen, game]);
  const resigned = manualResult !== null;
  const timedOut = timedOutWinner !== null;
  const over = gameOver || resigned || timedOut;
  /** Live "the game is over" for async callbacks that outlive the render. */
  const overRef = useRef(false);
  overRef.current = over;
  const userChar = userColor === 'white' ? 'w' : 'b';
  const userTurn = game.turn() === userChar && !over && !thinking;
  const displayName = profile
    ? botDisplayName({ name: profile.name, source: profile.source, key: profile.meta.key })
    : 'Bot';

  /* ------------------------------------------------------ end of the game */

  /**
   * WHO WON, in board terms.
   *
   * Checkmate is read off the position — the side to move is the side with no move — and a
   * resignation comes from the explicit result. `null` means nobody won: a draw. The kings get
   * no marks and the PGN carries `1/2-1/2`.
   */
  const winnerColor: 'white' | 'black' | null = useMemo(() => {
    if (!over) return null;
    if (manualResult) return manualResult.winner;
    if (timedOutWinner) return timedOutWinner;
    if (game.isCheckmate()) return game.turn() === 'w' ? 'black' : 'white';
    return null;
  }, [over, manualResult, timedOutWinner, game, fen]);

  /**
   * THE END OF THE GAME HAS A SOUND OF ITS OWN.
   *
   * A checkmate already spoke through its mating move (`playMoveSound` gives it
   * the checkmate sting), so this only covers the endings that happen without a
   * mating move — resignation, agreement, stalemate, repetition. Fired once per
   * ending, keyed on a ref, because `over` stays true across re-renders and a
   * naively wired effect would replay it on every tick of the review.
   */
  const endSoundRef = useRef(false);
  const celebrate = useAppStore((s) => s.celebrate);
  useEffect(() => {
    if (!over) {
      endSoundRef.current = false;
      return;
    }
    if (endSoundRef.current) return;
    endSoundRef.current = true;
    if (gameRef.current.isCheckmate()) {
      // The mating move already played the checkmate sting. A win banner is
      // still the moment the user asked to see, so it is not tied to the sound.
      if (winnerColor != null && winnerColor === userColor) celebrate('gamewin', `Checkmate — you beat ${displayName}.`);
      return;
    }
    const outcome = winnerColor == null ? 'draw' : winnerColor === userColor ? 'win' : 'loss';
    playGameEnd(outcome);
    if (outcome === 'win') celebrate('gamewin', `You beat ${displayName}.`);
  }, [celebrate, displayName, over, userColor, winnerColor]);

  /*
   * THE CLOCK.
   *
   * Ticks the side to move, quarter-second at a time, and flags the game when a
   * clock reaches zero. A separate state read would restart the interval on
   * every tick, so the live numbers live in `clockRef` and the state is only the
   * render mirror.
   */
  const hasClocks = clocks !== null;
  useEffect(() => {
    if (over || !timed || !hasClocks) return;
    const id = setInterval(() => {
      const current = clockRef.current;
      if (!current || gameRef.current.isGameOver()) return;
      const side = gameRef.current.turn() === 'w' ? 'white' : 'black';
      const next = { ...current, [side]: Math.max(0, current[side] - 0.25) };
      clockRef.current = next;
      setClocks(next);
      if (next[side] <= 0) setTimedOutWinner(side === 'white' ? 'black' : 'white');
    }, 250);
    return () => clearInterval(id);
  }, [hasClocks, over, timed]);

  /*
   * A RATED RESULT MOVES THE USER'S CHESSFORGE RATING — ONCE.
   *
   * The same pools, Elo and history as a rated Arena game (see
   * `recordCasualGame`), so the profile number is one number whichever way the
   * game was played. Guarded by a ref because `over` stays true while the result
   * overlay is open.
   */
  useEffect(() => {
    if (!over || !rated || ratedAppliedRef.current || !profile) return;
    ratedAppliedRef.current = true;
    const category: ArenaTimeCategory = timeControlById(settingsRef.current.timeId).category;
    const humanScore: 0 | 0.5 | 1 = winnerColor == null ? 0.5 : winnerColor === userColor ? 1 : 0;
    void recordCasualGame({
      botId: profile.id,
      botProfile: { playElo: profile.playElo, rating: profile.rating },
      category,
      humanScore,
    })
      .then((change) => { if (change) setRatingChange(change); })
      .catch(() => undefined);
  }, [over, profile, rated, userColor, winnerColor]);

  /**
   * The position the review is standing on, replayed from the start on demand.
   *
   * Replaying rather than storing FENs keeps chess.js the single source of truth for what a
   * position IS, and the loop breaks on the first move the parser refuses instead of throwing:
   * a half-walked review is still a position, and it is the one the user asked for.
   */
  const reviewFen = useMemo(() => {
    if (reviewAt == null) return null;
    const c = new Chess();
    for (let i = 0; i < reviewAt; i++) {
      try {
        c.move(history[i].san);
      } catch {
        break;
      }
    }
    return c.fen();
  }, [reviewAt, history]);

  /** The move the review is standing on, for the board's last-move highlight. */
  const reviewLastMove = useMemo(() => {
    if (reviewAt == null || reviewAt === 0) return null;
    const m = history[reviewAt - 1];
    return m ? { from: m.from, to: m.to } : null;
  }, [reviewAt, history]);

  /**
   * THE CROWN AND THE CROSS, on the kings themselves.
   *
   * THE REPORT: *"add something to the king piece indicating win or lose"*. The badge goes on
   * the king's square of the FINAL position only — while stepping through the game the kings
   * are just kings, because at move 12 nobody had won anything yet.
   */
  const kingOverlays = useMemo(() => {
    const out: Record<string, ReactNode> = {};
    if (!over || winnerColor == null || reviewAt != null) return out;
    const win = kingSquare(fen, winnerColor === 'white' ? 'w' : 'b');
    const loss = kingSquare(fen, winnerColor === 'white' ? 'b' : 'w');
    if (win) out[win] = <KingMark kind="win" />;
    if (loss) out[loss] = <KingMark kind="loss" />;
    return out;
  }, [over, winnerColor, fen, reviewAt]);

  /**
   * The finished game as a PGN, ready to copy into any analysis tool.
   *
   * Built only once the game is over — before that there is no result to tag and no final move
   * list to write.
   */
  const pgn = useMemo(() => {
    if (!over) return '';
    const me = 'You';
    const bot = profile?.name ?? 'Bot';
    return buildBotPgn({
      moves: history,
      white: userColor === 'white' ? me : bot,
      black: userColor === 'white' ? bot : me,
      result: resultToken(winnerColor),
      date: pgnDate(),
    });
  }, [over, history, userColor, profile, winnerColor]);

  /**
   * ONE TAP, IN THE CLIPBOARD.
   *
   * `Clipboard` is deprecated in React Native core but still shipped (0.86), and it is the one
   * working path to the system clipboard this build has — the app cannot add
   * `@react-native-clipboard/clipboard` while the package registry is unreachable. The catch is
   * not decoration: the PGN card under the board is `selectable`, so even if the native module
   * ever went away the text can still be taken by long-press.
   */
  const copyPgn = useCallback(() => {
    try {
      Clipboard.setString(pgn);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* the selectable card is the fallback */
    }
  }, [pgn]);

  const syncBoard = useCallback(() => {
    setFen(gameRef.current.fen());
    setHistory(
      gameRef.current
        .history({ verbose: true })
        .map((m) => ({ san: m.san, color: m.color, from: m.from, to: m.to })),
    );
  }, []);

  /* -------------------------------------------------------------- the coach */

  const pushCoachLine = useCallback((who: 'you' | 'coach', text: string) => {
    const id = ++coachSeq.current;
    setCoachLines((lines) => [...lines, { id, who, text }]);
  }, []);

  /**
   * Ask the live coach about the position on the board right now.
   *
   * `hintSan` is used by the hint path: the engine has already chosen that move,
   * so the answer explains a move that is legal here instead of guessing one.
   * Everything else (position facts, the grounding guard, the chess-only gate)
   * stays inside `activeCoach()`.
   */
  const askCoach = useCallback(async (question: string, hintSan?: string) => {
    if (coachBusyRef.current) return;
    coachBusyRef.current = true;
    setCoachBusy(true);
    pushCoachLine('you', question);
    const gameAt = gameRef.current;
    try {
      const coach = activeCoach();
      const fen = gameAt.fen();
      /*
       * The FEN says what is on the board; the move list says how it got
       * there. The coach uses both, so "why did I play that?" is answered
       * against this game rather than a generic position.
       */
      const answer = hintSan
        ? await coach.explainHint(fen, hintSan)
        : await coach.ask(question, fen, coachHistoryRef.current, gameAt.history());
      // A rematch replaces the game under an answer that was asked about the
      // old one; that answer must not appear in the new game's chat.
      if (gameRef.current !== gameAt) return;
      const pair: [string, string] = [question, answer];
      coachHistoryRef.current = [...coachHistoryRef.current, pair].slice(-6);
      pushCoachLine('coach', answer);
    } catch (e) {
      console.warn('[coach] in-game answer failed:', e);
      pushCoachLine('coach', 'Sorry — I lost that thought. Ask me again.');
    } finally {
      coachBusyRef.current = false;
      setCoachBusy(false);
    }
  }, [pushCoachLine]);

  /* ------------------------------------------------------------ bot's move */

  /**
   * Add the increment to the clock of the side that just moved.
   *
   * Kept as a ref-backed update so the 250ms ticker and a move landing in the
   * same tick cannot overwrite each other's clock.
   */
  const bumpClock = useCallback((color: 'white' | 'black') => {
    const tc = timeControlById(settingsRef.current.timeId);
    if (tc.untimed || tc.initialSeconds <= 0 || tc.incrementSeconds <= 0) return;
    const current = clockRef.current;
    if (!current) return;
    const next = { ...current, [color]: current[color] + tc.incrementSeconds };
    clockRef.current = next;
    setClocks(next);
  }, []);

  const botMove = useCallback(async () => {
    const p = profileRef.current;
    if (!p || thinkingRef.current) return;
    thinkingRef.current = true;
    setThinking(true);
    setEngineError(null);
    try {
      const engine = getEngine();
      const fenBefore = gameRef.current.fen();
      const startedAt = Date.now();
      const result = coachElo != null
        ? await coachMoveFor((f, o) => engine.analyse(f, o), fenBefore, coachElo)
        : await botMoveFor(
          (f, o) => engine.analyse(f, o),
          fenBefore,
          p,
          weightsRef.current,
          { elo: p.playElo ?? null },
        );
      if (!result) {
        setEngineError('The engine had no move for this position.');
        return;
      }
      /*
       * A HUMAN BEAT, NOT JUST A SEARCH. The engine often answers in a fraction
       * of a second; the bot then appears to have the reply pre-loaded. Sleep
       * whatever is left of a human-sized think, which is short for forced
       * moves and longer when there is a real choice (see `humanThinkDelayMs`).
       */
      const remaining = humanThinkDelayMs(fenBefore) - (Date.now() - startedAt);
      if (remaining > 0) await new Promise<void>((r) => setTimeout(r, remaining));
      // The clock may have flagged the game while the search was running, or
      // the user may have resigned. A move after the result is decided would
      // contradict the result card.
      if (overRef.current) return;
      /*
       * THE BOT CAN RESIGN. Its own engine has just scored the position with
       * it to move, so a deeply negative score or a short forced mate against
       * it is not an estimate — it is the opponent conceding. Games end the
       * moment one side is beaten instead of being walked to mate.
       */
      if (botShouldResign(result.evalTop)) {
        setLastBot(null);
        setManualResult({
          winner: userColorRef.current,
          reason: `${botDisplayName({ name: p.name, source: p.source, key: p.meta.key })} resigned`,
        });
        return;
      }
      const uci = result.decision.uci;
      const mv = gameRef.current.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      setLastMove({ from: mv.from, to: mv.to });
      playMoveSound(mv);
      bumpClock(mv.color === 'w' ? 'white' : 'black');
      setLastBot({ san: result.decision.san, reason: result.decision.reason });
      setHistory(
        gameRef.current
          .history({ verbose: true })
          .map((m) => ({ san: m.san, color: m.color, from: m.from, to: m.to })),
      );
      setFen(gameRef.current.fen());
    } catch (e) {
      setEngineError((e as Error).message ?? 'Engine error');
    } finally {
      thinkingRef.current = false;
      setThinking(false);
    }
  }, [bumpClock, coachElo]);

  useEffect(() => {
    if (!profile || manualResult) return;
    const botChar = userColor === 'white' ? 'b' : 'w';
    if (gameRef.current.turn() !== botChar) return;
    if (gameRef.current.isGameOver()) return;
    if (thinkingRef.current) return;
    void botMove();
  }, [fen, userColor, profile, botMove, manualResult]);

  /* ------------------------------------------------------------ your move */

  const applyUserMove = useCallback(
    (from: string, to: string, promotion?: string): boolean => {
      const legal = gameRef.current
        .moves({ verbose: true })
        .find((m) => m.from === from && m.to === to);
      if (!legal) return false;
      try {
        const mv = gameRef.current.move({ from, to, promotion: promotion ?? 'q' });
        playMoveSound(mv);
        bumpClock(mv.color === 'w' ? 'white' : 'black');
        setLastMove({ from: mv.from, to: mv.to });
        setLastBot(null);
        setHint(null); // the position moved on; an old hint would be a lie
        syncBoard();
        return true;
      } catch {
        return false;
      }
    },
    [bumpClock, syncBoard],
  );

  const undo = useCallback(() => {
    if (thinkingRef.current) return;
    if (manualResult) return;
    if (gameRef.current.turn() !== (userColor === 'white' ? 'w' : 'b')) return;
    if (gameRef.current.history().length < 2) return;
    gameRef.current.undo();
    gameRef.current.undo();
    const hist = gameRef.current.history({ verbose: true });
    const last = hist[hist.length - 1];
    setLastMove(last ? { from: last.from, to: last.to } : null);
    setLastBot(null);
    setHint(null);
    syncBoard();
  }, [manualResult, syncBoard, userColor]);

  const newGame = useCallback(
    (color: UserColor) => {
      gameRef.current = new Chess();
      setUserColor(color);
      setLastMove(null);
      setLastBot(null);
      setEngineError(null);
      setHistory([]);
      setFen(gameRef.current.fen());
      setManualResult(null);
      setHint(null);
      setReviewAt(null);
      setCopied(false);
      setCoachLines([]);
      coachHistoryRef.current = [];
      coachBusyRef.current = false;
      setCoachBusy(false);
      thinkingRef.current = false;
      setThinking(false);
      // A new game gets a fresh clock, a fresh result and no carried rating
      // change — the previous game's delta must not appear on this one.
      const tc = timeControlById(settingsRef.current.timeId);
      const start = tc.untimed || tc.initialSeconds <= 0 ? null : startingClocks(tc.initialSeconds);
      clockRef.current = start;
      setClocks(start);
      setTimedOutWinner(null);
      setRatingChange(null);
      ratedAppliedRef.current = false;
    },
    [],
  );

  /**
   * Choosing a time control before the game starts.
   *
   * The clock is rebuilt at the starting time, because a control chosen in the
   * lobby is a promise about the next game, not a retune of the current one.
   * The settings card is only rendered before the first move, so this cannot
   * silently reset a game in progress.
   */
  const chooseTime = useCallback((id: string) => {
    setTimeId(id);
    const tc = timeControlById(id);
    const start = tc.untimed || tc.initialSeconds <= 0 ? null : startingClocks(tc.initialSeconds);
    clockRef.current = start;
    setClocks(start);
    setTimedOutWinner(null);
    setRatingChange(null);
    ratedAppliedRef.current = false;
  }, []);

  /* ------------------------------------------------------------- resigning */

  const resign = useCallback(() => {
    if (gameOver || thinking || manualResult) return;
    const botWins = userColor === 'white' ? 'black' : 'white';
    Alert.alert(
      'Resign this game?',
      'It counts as a loss — the bot wins and the game ends here.',
      [
        { text: 'Keep playing', style: 'cancel' },
        {
          text: 'Resign',
          style: 'destructive',
          onPress: () => setManualResult({ winner: botWins, reason: 'You resigned' }),
        },
      ],
    );
  }, [gameOver, manualResult, thinking, userColor]);

  /* ----------------------------------------------------------------- hint */

  /** Ask the engine once and turn its UCI move into the board hint + SAN. */
  const computeHint = useCallback(async (): Promise<{
    from: string;
    to: string;
    san: string;
  } | null> => {
    if (hintBusyRef.current || !profileRef.current) return null;
    const at = gameRef.current;
    if (at.turn() !== (userColorRef.current === 'white' ? 'w' : 'b')) return null;
    if (at.isGameOver() || manualResult) return null;
    const askedFen = at.fen();
    hintBusyRef.current = true;
    setHintBusy(true);
    setEngineError(null);
    try {
      const ev = await getEngine().analyse(askedFen, { movetime: 900, elo: null, multipv: 1 });
      const uci = ev.bestMoveUci;
      if (!uci) {
        setEngineError('No hint available for this position.');
        return null;
      }
      // The user could have moved while the engine was thinking; a hint for
      // a position that is gone is worse than no hint.
      if (gameRef.current.fen() !== askedFen) return null;
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      let san = '';
      try {
        const board = new Chess(askedFen);
        san = board.move({
          from,
          to,
          promotion: uci.length > 4 ? uci[4] : undefined,
        }).san;
      } catch {
        /* the rings still work without SAN */
      }
      setHint({ from, to: [], san });
      return { from, to, san };
    } catch (e) {
      setEngineError((e as Error).message ?? 'Engine error');
      return null;
    } finally {
      hintBusyRef.current = false;
      setHintBusy(false);
    }
  }, [manualResult]);

  /**
   * A hint in the same shape as the trainer's: the first press rings the
   * piece the engine would play, the second dots every square it can reach.
   * The destination — the answer — is never named on the first press, and a
   * third press puts the hint away.
   *
   * In coach mode the first press also asks the coach why that move works,
   * which is the "helps us when we click on hint" part of the opponent.
   */
  const showHint = useCallback(async () => {
    if (hintBusyRef.current || !profileRef.current) return;
    const at = gameRef.current;
    if (at.turn() !== (userColorRef.current === 'white' ? 'w' : 'b')) return;
    if (at.isGameOver() || manualResult) return;
    if (hint) {
      if (hint.to.length > 0) setHint(null);
      else setHint({ ...hint, to: targetSquares(at.fen(), [hint.from]) });
      return;
    }
    const fresh = await computeHint();
    if (fresh && fresh.san && coachElo != null) {
      await askCoach('Hint, please.', fresh.san);
    }
  }, [askCoach, coachElo, computeHint, hint, manualResult]);

  /** The chat's Hint button: reuse the rings already on the board when there are some. */
  const coachHint = useCallback(async () => {
    if (hintBusyRef.current || coachBusyRef.current) return;
    const at = gameRef.current;
    if (at.turn() !== (userColorRef.current === 'white' ? 'w' : 'b')) return;
    if (at.isGameOver() || manualResult) return;
    let san = hint?.san ?? '';
    if (!san) {
      const fresh = await computeHint();
      san = fresh?.san ?? '';
    }
    if (san) await askCoach('Hint, please.', san);
  }, [askCoach, computeHint, hint, manualResult]);

  /* ---------------------------------------------------------------- status */

  let status: string;
  if (!profile) status = '';
  else if (manualResult)
    status = `${manualResult.reason} — ${
      manualResult.winner === userColor ? 'you win!' : `${displayName} wins`
    }`;
  else if (timedOutWinner)
    status = `${timedOutWinner === userColor ? 'You win' : `${displayName} wins`} on time — the other clock ran out`;
  else if (game.isCheckmate()) {
    const winner = game.turn() === 'w' ? 'black' : 'white';
    status = `Checkmate — ${winner === userColor ? 'you win!' : `${displayName} wins`}`;
  } else if (game.isDraw()) {
    status = game.isStalemate()
      ? 'Draw — stalemate'
      : game.isThreefoldRepetition()
        ? 'Draw — repetition'
        : 'Draw';
  } else if (game.isCheck()) {
    status = `${game.turn() === 'w' ? 'White' : 'Black'} to move — check!`;
  } else {
    status = userTurn ? 'Your move' : thinking ? `${displayName} is thinking…` : 'Your move';
  }

  if (missing) {
    return (
      <View style={styles.root}>
        <View style={styles.header}>
          <IconBtn label="Back to bots" onPress={onExit}>
            <IconChevronLeft size={20} color={colors.foreground} />
          </IconBtn>
          <Text style={styles.headerTitle}>Bot</Text>
        </View>
        <Card>
          <Text style={styles.body}>This bot is no longer in your list.</Text>
        </Card>
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={styles.root}>
        <View style={styles.header}>
          <IconBtn label="Back to bots" onPress={onExit}>
            <IconChevronLeft size={20} color={colors.foreground} />
          </IconBtn>
          <Text style={styles.headerTitle}>Loading bot…</Text>
        </View>
      </View>
    );
  }

  const rows = Math.ceil(history.length / 2);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <IconBtn label="Back to bots" onPress={onExit}>
          <IconChevronLeft size={20} color={colors.foreground} />
        </IconBtn>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={styles.headerMeta} numberOfLines={1}>
            {profile.rating} · {profile.ratingLabel}
          </Text>
        </View>
        <Text style={[styles.status, thinking && styles.statusThinking]} numberOfLines={1}>
          {status}
        </Text>
      </View>

      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {timed && clocks ? (
          <View style={styles.clockRow}>
            {(['white', 'black'] as const).map((side) => {
              const you = userColor === side;
              const active = !over && gameRef.current.turn() === (side === 'white' ? 'w' : 'b');
              return (
                <View key={side} style={[styles.clockBox, active ? styles.clockBoxActive : null]}>
                  <Text style={styles.clockName} numberOfLines={1}>
                    {you ? 'You' : displayName}
                  </Text>
                  <Text style={[styles.clockTime, active ? styles.clockTimeActive : null]}>
                    {formatClock(clocks[side])}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : null}

        <View style={styles.boardWrap}>
          <ChessForgeBoard
            fen={reviewFen ?? fen}
            orientation={userColor}
            interactive={reviewAt == null && userTurn}
            onMove={applyUserMove}
            lastMove={reviewAt == null ? lastMove : reviewLastMove}
            hintFrom={reviewAt == null && hint ? [hint.from] : []}
            hintTo={reviewAt == null ? hint?.to ?? [] : []}
            squareOverlays={kingOverlays}
          />
          {over && reviewAt == null ? (
            <View style={styles.overlay}>
              <Card style={styles.overlayCard}>
                <Text style={styles.overlayTitle}>{status}</Text>
                {ratingChange ? (
                  <Text style={styles.ratingChange}>
                    ChessForge {ratingChange.category}: {ratingChange.humanBefore} → {ratingChange.humanAfter}
                    {' '}({ratingChange.humanDelta >= 0 ? '+' : ''}{ratingChange.humanDelta})
                  </Text>
                ) : null}
                <View style={styles.overlayActions}>
                  <Btn label="Rematch" small onPress={() => newGame(userColor)} />
                  <Btn
                    label="Switch sides"
                    variant="ghost"
                    small
                    onPress={() => newGame(userColor === 'white' ? 'black' : 'white')}
                  />
                </View>
                {/*
                  * THE FOUR THINGS THE END OF A GAME OWES THE USER, together on the board:
                  * take the game to the analysis page, step through what happened, play it again,
                  * and carry it away as a PGN. The overlay steps aside while the review is running
                  * — the board is the whole point of the review and the card was covering it.
                  *
                  * "Game review" goes to the Analyse TAB with the PGN already in the box (depth and
                  * one tap left to the user). That is the route the user asked for by name —
                  * *"it should take me to the analyse page where i can find the pgn of my game
                  * copied there and i can choose the depth then click on analyse"* — and the
                  * fallback keeps the in-place review working if a caller ever omits the handler.
                  */}
                <View style={styles.overlayActions}>
                  <Btn
                    label="Game review"
                    small
                    onPress={() => (onAnalyse ? onAnalyse(pgn) : setReviewAt(history.length))}
                  />
                  <Btn
                    label="Step through"
                    variant="ghost"
                    small
                    onPress={() => setReviewAt(history.length)}
                  />
                </View>
                <View style={styles.overlayActions}>
                  <Btn
                    label={copied ? 'PGN copied' : 'Copy PGN'}
                    variant="ghost"
                    small
                    onPress={copyPgn}
                  />
                </View>
              </Card>
            </View>
          ) : null}
        </View>

        {/*
          * THE PRE-GAME CARD. Shown only before the first move, because these
          * are promises about the NEXT game: changing the control mid-game would
          * either be ignored or rewrite a game in progress. Rated and untimed
          * are both allowed — see `recordCasualGame`.
          */}
        {history.length === 0 && !over ? (
          <Card style={styles.setupCard}>
            <View style={styles.setupHead}>
              <Text style={styles.setupTitle}>Game settings</Text>
              {ratingChange ? (
                <Text style={styles.setupDelta}>
                  {ratingChange.humanDelta >= 0 ? '+' : ''}{ratingChange.humanDelta}
                </Text>
              ) : null}
            </View>
            <Segmented
              options={[
                { id: 'unrated', label: 'Unrated' },
                { id: 'rated', label: 'Rated' },
              ]}
              value={rated ? 'rated' : 'unrated'}
              onChange={(v: string) => setRated(v === 'rated')}
            />
            <Text style={styles.setupLabel}>Time control</Text>
            <View style={styles.timeWrap}>
              {TIME_CONTROLS.map((t) => {
                const on = t.id === timeId;
                return (
                  <Pressable
                    key={t.id}
                    onPress={() => chooseTime(t.id)}
                    style={({ pressed }) => [
                      styles.timeChip,
                      on ? styles.timeChipOn : null,
                      pressed ? styles.pressed : null,
                    ]}
                  >
                    <Text style={[styles.timeChipText, on ? styles.timeChipTextOn : null]}>
                      {timeControlLabel(t)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.setupNote}>
              {rated
                ? `Rated: the result changes your ChessForge ${timeControl.untimed ? 'Classical' : timeControl.category} rating (currently shown under ChessForge ratings).`
                : 'Unrated: the result is saved but no rating moves.'}
            </Text>
          </Card>
        ) : null}

        {over && reviewAt != null ? (
          <Card style={styles.reviewCard}>
            <View style={styles.reviewNav}>
              <IconBtn
                label="Start of the game"
                onPress={() => setReviewAt(0)}
                disabled={reviewAt === 0}
              >
                <IconChevronsLeft size={18} color={colors.foreground} />
              </IconBtn>
              <IconBtn
                label="Previous move"
                onPress={() => setReviewAt(Math.max(0, reviewAt - 1))}
                disabled={reviewAt === 0}
              >
                <IconChevronLeft size={18} color={colors.foreground} />
              </IconBtn>
              <View style={styles.reviewWhere}>
                <Text style={styles.reviewMove} numberOfLines={1}>
                  {reviewAt === 0
                    ? 'Starting position'
                    : `${Math.ceil(reviewAt / 2)}${reviewAt % 2 === 1 ? '.' : '…'} ${
                        history[reviewAt - 1]?.san ?? ''
                      }`}
                </Text>
                <Text style={styles.reviewCount}>
                  {reviewAt} / {history.length} plies
                </Text>
              </View>
              <IconBtn
                label="Next move"
                onPress={() => setReviewAt(Math.min(history.length, reviewAt + 1))}
                disabled={reviewAt >= history.length}
              >
                <IconChevronRight size={18} color={colors.foreground} />
              </IconBtn>
              <IconBtn
                label="End of the game"
                onPress={() => setReviewAt(history.length)}
                disabled={reviewAt >= history.length}
              >
                <IconChevronsRight size={18} color={colors.foreground} />
              </IconBtn>
            </View>
            <View style={styles.reviewActions}>
              <Btn label="Back to result" small variant="ghost" onPress={() => setReviewAt(null)} />
              <Btn
                label={copied ? 'PGN copied' : 'Copy PGN'}
                small
                variant="ghost"
                onPress={copyPgn}
              />
              <Btn
                label="Share"
                small
                variant="ghost"
                onPress={() => void Share.share({ message: pgn, title: 'ChessForge PGN' })}
              />
            </View>
          </Card>
        ) : null}

        {over ? (
          <Card style={styles.reviewCard}>
            <Text style={styles.tuningTitle}>PGN — copy it into any analysis tool</Text>
            {/*
              * Selectable as well as copyable: the button above puts it in the clipboard in one
              * tap, and the text itself can be selected when the user wants only part of it.
              */}
            <Text selectable style={styles.pgnText}>
              {pgn}
            </Text>
          </Card>
        ) : null}

        {history.length === 0 ? (
          <Text style={styles.hint}>
            You play the {userColor} pieces — tap one, then a highlighted square. Drag works too.
          </Text>
        ) : null}

        <View style={styles.controls}>
          <Btn label="New game" variant="ghost" small onPress={() => newGame(userColor)} />
          <Btn
            label={`Play as ${userColor === 'white' ? 'Black' : 'White'}`}
            variant="ghost"
            small
            onPress={() => newGame(userColor === 'white' ? 'black' : 'white')}
          />
          <IconBtn
            onPress={undo}
            disabled={!userTurn || history.length < 2}
            label="Undo"
          >
            <IconUndo size={16} color={colors.foreground} />
          </IconBtn>
          {/*
            * THE HINT AND RESIGN SHAPES.
            *
            * The hint wears the same gold bulb the puzzles use, and resigning
            * wears the conventional flag — the two shapes players already know
            * for these two actions. The accessibility labels keep both
            * speakable, and the disabled states dim instead of vanishing.
            */}
          <IconBtn
            onPress={() => void showHint()}
            disabled={!userTurn || hintBusy}
            label="Show hint"
          >
            <IconLightbulb size={16} color={colors.gold} />
          </IconBtn>
          <IconBtn onPress={resign} disabled={over || thinking} label="Resign">
            <IconFlag size={16} color={colors.bad} />
          </IconBtn>
          <Btn label="Change bot" variant="ghost" small onPress={onExit} />
        </View>

        {coachMode ? (
          <>
            {lastBot ? (
              <Text style={styles.reason}>
                ♞ {lastBot.san} — {lastBot.reason}
              </Text>
            ) : null}
            {engineError ? (
              <Text style={styles.engineError}>Engine issue: {engineError}</Text>
            ) : null}
            <CoachGameChat
              lines={coachLines}
              busy={coachBusy}
              canHint={userTurn && !hintBusy}
              onAsk={(question) => void askCoach(question)}
              onHint={() => void coachHint()}
            />
          </>
        ) : (
        <Card style={styles.tuningCard}>
          <View style={styles.tuningHead}>
            <Text style={styles.tuningTitle}>Bot tuning</Text>
            <View style={styles.tuningToggle}>
              <Btn
                label="Simple"
                variant={tuning === 'simple' ? 'primary' : 'ghost'}
                small
                onPress={() => setTuning('simple')}
              />
              <Btn
                label="Advanced α·β·γ"
                variant={tuning === 'advanced' ? 'primary' : 'ghost'}
                small
                onPress={() => {
                  if (!weights) setWeights(weightsFromMimicry(mimicry));
                  setTuning('advanced');
                }}
              />
            </View>
          </View>

          {tuning === 'simple' ? (
            <>
              <View style={styles.sliderHead}>
                <Text style={styles.sliderLabel}>Mimicry strength</Text>
                <Text style={styles.sliderValue}>{Math.round(mimicry * 100)}%</Text>
              </View>
              <RangeSlider value={mimicry} onChange={setMimicry} label="Mimicry strength" />
              <View style={styles.sliderEnds}>
                <Text style={styles.noteSm}>Pure engine</Text>
                <Text style={styles.noteSm}>Maximum mimicry</Text>
              </View>
            </>
          ) : (
            <>
              {(
                [
                  { key: 'alpha', sym: 'α', label: 'Engine strength', hint: 'plays the objectively best moves' },
                  { key: 'beta', sym: 'β', label: 'Human plausibility', hint: 'moves a human would consider' },
                  { key: 'gamma', sym: 'γ', label: 'Player personality', hint: 'this player’s book & habits' },
                ] as const
              ).map((row) => (
                <View key={row.key} style={styles.advRow}>
                  <View style={styles.sliderHead}>
                    <Text style={styles.sliderLabel}>
                      <Text style={styles.advSym}>{row.sym}</Text> {row.label} — {row.hint}
                    </Text>
                    <Text style={styles.sliderValue}>
                      {Math.round(activeWeights[row.key] * 100)}%
                    </Text>
                  </View>
                  <RangeSlider
                    value={advancedWeights[row.key]}
                    onChange={(v) => setWeights({ ...advancedWeights, [row.key]: v })}
                    label={`${row.sym} ${row.label}`}
                  />
                </View>
              ))}
              <View style={styles.formulaRow}>
                <Text style={styles.formula}>S(m) = α·E(m) + β·H(m) + γ·P(m)</Text>
                <Text style={styles.noteSm}>
                  share = {Math.round(activeWeights.alpha * 100)}/
                  {Math.round(activeWeights.beta * 100)}/
                  {Math.round(activeWeights.gamma * 100)}
                </Text>
              </View>
            </>
          )}

          {lastBot ? (
            <Text style={styles.reason}>
              ♞ {lastBot.san} — {lastBot.reason}
            </Text>
          ) : null}
          {engineError ? <Text style={styles.engineError}>Engine issue: {engineError}</Text> : null}
        </Card>
        )}

        {history.length > 0 ? (
          <Card>
            <Text style={styles.tuningTitle}>Moves</Text>
            <View style={styles.moveGrid}>
              {Array.from({ length: rows }, (_, i) => {
                const w = history[i * 2];
                const b = history[i * 2 + 1];
                return (
                  <View key={i} style={styles.moveRow}>
                    <Text style={styles.moveNo}>{i + 1}.</Text>
                    <Text style={styles.moveSan}>{w?.san ?? ''}</Text>
                    <Text style={styles.moveSanB}>{b?.san ?? ''}</Text>
                  </View>
                );
              })}
            </View>
          </Card>
        ) : null}
      </ScrollView>
    </View>
  );
}

/* ------------------------------------------------------------------- slider */

/**
 * A range slider in forty lines.
 *
 * React Native ships no slider and the app has no slider dependency, so this is
 * a track that reads its own width and turns a touch's x into a value. It
 * snaps to 5% steps, which is the granularity the mimicry dial is meaningful
 * at anyway.
 */
function RangeSlider({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const [width, setWidth] = useState(0);
  const set = (x: number) => {
    if (width <= 0) return;
    const v = Math.max(0, Math.min(1, x / width));
    onChange(Math.round(v * 20) / 20);
  };
  return (
    <View
      style={styles.sliderTrack}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(e) => set(e.nativeEvent.locationX)}
      onResponderMove={(e) => set(e.nativeEvent.locationX)}
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
    >
      <View style={[styles.sliderFill, { width: `${value * 100}%` }]} />
      <View style={[styles.sliderKnob, { left: `${value * 100}%` }]} />
    </View>
  );
}

/* ------------------------------------------------------------------- styles */

const styles = themedStyles(() => ({
  root: { flex: 1 },
  fill: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerText: { flexShrink: 1 },
  headerTitle: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  headerMeta: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  status: {
    marginLeft: 'auto',
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    color: colors.mutedForeground,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    backgroundColor: colors.card,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: '55%',
  },
  statusThinking: { color: colors.gold, borderColor: colors.gold },
  content: { paddingHorizontal: 12, paddingBottom: 28, gap: 10 },
  boardWrap: { position: 'relative' },
  overlay: {
    ...({ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radii.lg,
  },
  overlayCard: { alignItems: 'center', gap: 10, paddingHorizontal: 22 },
  overlayTitle: { fontFamily: fonts.sansSemiBold, fontSize: 15, color: colors.foreground, textAlign: 'center' },
  overlayActions: { flexDirection: 'row', gap: 8 },
  ratingChange: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    color: colors.gold,
    textAlign: 'center',
  },
  /* Clock + pre-game settings, matching the Arena game screen's vocabulary. */
  clockRow: { flexDirection: 'row', gap: 7 },
  clockBox: {
    flex: 1,
    gap: 1,
    padding: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
  },
  clockBoxActive: { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.08)' },
  clockName: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground },
  clockTime: { fontFamily: fonts.mono, fontSize: 20, color: colors.foreground },
  clockTimeActive: { color: colors.gold },
  setupCard: { gap: 8 },
  setupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  setupTitle: { fontFamily: fonts.sansSemiBold, fontSize: 12, color: colors.foreground },
  setupDelta: { fontFamily: fonts.sansBold, fontSize: 12, color: colors.gold },
  setupLabel: { fontFamily: fonts.sansMedium, fontSize: 10, color: colors.mutedForeground },
  setupNote: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground, lineHeight: 13 },
  timeWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  timeChip: {
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    backgroundColor: colors.card,
  },
  timeChipOn: { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.10)' },
  timeChipText: { fontFamily: fonts.sans, fontSize: 10, color: colors.foreground },
  timeChipTextOn: { color: colors.gold, fontFamily: fonts.sansMedium },
  pressed: { opacity: 0.75 },
  reviewCard: { gap: 8 },
  reviewNav: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reviewWhere: { flex: 1, alignItems: 'center' },
  reviewMove: { fontFamily: fonts.sansSemiBold, fontSize: 13, color: colors.foreground },
  reviewCount: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  reviewActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pgnText: { fontFamily: fonts.sans, fontSize: 10.5, color: colors.foreground, lineHeight: 15 },
  hint: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground, textAlign: 'center' },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tuningCard: { gap: 8 },
  tuningHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  tuningTitle: { fontFamily: fonts.sansSemiBold, fontSize: 13, color: colors.foreground },
  tuningToggle: { flexDirection: 'row', gap: 4 },
  sliderHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  sliderLabel: { flexShrink: 1, fontFamily: fonts.sansMedium, fontSize: 12, color: colors.foreground },
  sliderValue: { fontFamily: fonts.sansSemiBold, fontSize: 12, color: colors.gold },
  sliderTrack: {
    height: 30,
    justifyContent: 'center',
    marginTop: 2,
  },
  sliderFill: {
    position: 'absolute',
    left: 0,
    height: 5,
    borderRadius: 999,
    backgroundColor: colors.gold,
  },
  sliderKnob: {
    position: 'absolute',
    width: 16,
    height: 16,
    marginLeft: -8,
    borderRadius: 8,
    backgroundColor: colors.foreground,
  },
  sliderEnds: { flexDirection: 'row', justifyContent: 'space-between' },
  noteSm: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  advRow: { gap: 2, marginTop: 4 },
  advSym: { fontFamily: fonts.sansBold, color: colors.gold },
  formulaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 6,
    marginTop: 4,
  },
  formula: { fontFamily: fonts.mono, fontSize: 10, color: colors.mutedForeground },
  reason: { fontFamily: fonts.sans, fontSize: 12, color: colors.foreground, lineHeight: 17 },
  engineError: { fontFamily: fonts.sans, fontSize: 12, color: colors.destructive },
  moveGrid: { marginTop: 6 },
  moveRow: { flexDirection: 'row', gap: 10 },
  moveNo: { width: 26, fontFamily: fonts.mono, fontSize: 11, color: colors.mutedForeground, textAlign: 'right' },
  moveSan: { flex: 1, fontFamily: fonts.mono, fontSize: 11, color: colors.foreground },
  moveSanB: { flex: 1, fontFamily: fonts.mono, fontSize: 11, color: colors.mutedForeground },
  body: { fontFamily: fonts.sans, fontSize: 13, color: colors.foreground },
}));
