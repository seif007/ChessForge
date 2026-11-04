'use client';

/**
 * One ChessForge Arena game.
 *
 * The screen is both the live board and the replay viewer. A live game writes
 * its move list and clocks to the tournament after every move, so leaving the
 * screen is "save for later", not "lose the game". A finished game opens the
 * same board in review mode with step controls and an Analyse hand-off.
 *
 * Bot-vs-bot games auto-play here, which is why this screen (like BotPlayScreen)
 * is in the engine host roster.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Clipboard, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Chess } from 'chess.js';

import { ChessForgeBoard } from '@/components/chess/ChessForgeBoard';
import { KingMark } from '@/components/chess/KingMark';
import { Btn, Card, Chip, IconBtn, Spinner } from '@/components/ui/Primitives';
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconFlag,
  IconRotateCcw,
  IconTrophy,
  IconUndo,
} from '@/components/ui/Icons';
import { colors, fonts, radii, themedStyles } from '@/theme/tokens';
import { getEngine } from '@/lib/engine';
import { weightsFromMimicry } from '@/lib/bots/mimic';
import { botMoveFor, botShouldResign, humanThinkDelayMs } from '@/lib/bots/play';
import { kingSquare } from '@/lib/bots/postgame';
import { playGameEnd, playMoveSound } from '@/lib/sounds';
import { useAppStore } from '@/lib/store';
import {
  arenaPgn,
  outcomeFromChess,
  replayArenaGame,
  startingClocks,
  timeoutOutcome,
} from '@/lib/arena/game';
import type { ArenaOutcome } from '@/lib/arena/game';
import { resultLabel } from '@/lib/arena/labels';
import { loadTournament, saveTournamentGameResult, saveTournamentGameState } from '@/lib/arena/store';
import { formatClock } from '@/lib/arena/timeControl';
import type { ArenaGame, ArenaMove, ArenaTournament } from '@/lib/arena/types';

function nameOf(t: ArenaTournament | null, id: string | null): string {
  if (!t || !id) return 'Bye';
  return t.participants.find((p) => p.id === id)?.name ?? 'Player';
}

/**
 * How much better than level the bot must think it is before it declines a draw.
 *
 * 60cp is "a shade better than equal", not "winning". A bot that declined at 0
 * would refuse every draw; one that accepted up to +2.00 would hand over won
 * games. This is the same order of magnitude as the app's own book ceiling.
 */
const DRAW_ACCEPT_CP = 60;

/**
 * The earliest ply at which a bot will even consider a draw.
 *
 * THE REPORT: *"the bots shouldnt accept draw from beginning of the game (just
 * a few moves)"*. Ten moves a side is the point where a draw offer stops being
 * a way to skip the game and starts being a statement about the position.
 */
const DRAW_MIN_PLIES = 20;

function ClockBox({
  name,
  seconds,
  active,
  untimed,
}: {
  name: string;
  seconds: number | null;
  active: boolean;
  untimed: boolean;
}) {
  return (
    <View style={[styles.clockBox, active ? styles.clockActive : null]}>
      <Text style={styles.clockName} numberOfLines={1}>{name}</Text>
      <Text style={[styles.clockTime, active ? styles.clockTimeActive : null]}>
        {untimed || seconds === null ? '∞' : formatClock(seconds)}
      </Text>
    </View>
  );
}

export function ArenaGameScreen({
  tournamentId,
  gameId,
  onExit,
  onAnalyse,
}: {
  tournamentId: string;
  gameId: string;
  onExit: () => void;
  onAnalyse: (pgn: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [tournament, setTournament] = useState<ArenaTournament | null>(null);
  const [info, setInfo] = useState<ArenaGame | null>(null);
  const [missing, setMissing] = useState(false);
  const [fen, setFen] = useState('start');
  const [moves, setMoves] = useState<ArenaMove[]>([]);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [clocks, setClocks] = useState<{ white: number; black: number } | null>(null);
  const [clockHistory, setClockHistory] = useState<ArenaGame['clockHistory']>([]);
  const [thinking, setThinking] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [lastReason, setLastReason] = useState<string | null>(null);
  const [result, setResult] = useState<ArenaOutcome | null>(null);
  const [gameDone, setGameDone] = useState(false);
  const [pgn, setPgn] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reviewPly, setReviewPly] = useState(0);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [ratingChange, setRatingChange] = useState<{ before: number; after: number; delta: number } | null>(null);
  const [paused, setPaused] = useState(false);
  const celebrate = useAppStore((s) => s.celebrate);

  const chessRef = useRef(new Chess());
  const tournamentRef = useRef<ArenaTournament | null>(null);
  const infoRef = useRef<ArenaGame | null>(null);
  const movesRef = useRef<ArenaMove[]>([]);
  const clocksRef = useRef<{ white: number; black: number } | null>(null);
  const clockHistoryRef = useRef<ArenaGame['clockHistory']>([]);
  const thinkingRef = useRef(false);
  const finishedRef = useRef(false);
  const resultRef = useRef<ArenaOutcome | null>(null);
  /** Fires the end-of-game sting once per ending, not on every review tick. */
  const endSoundRef = useRef(false);

  tournamentRef.current = tournament;
  infoRef.current = info;

  useEffect(() => {
    let on = true;
    void (async () => {
      const t = await loadTournament(tournamentId);
      const g = t?.games.find((x) => x.id === gameId);
      if (!on) return;
      if (!t || !g) {
        setMissing(true);
        return;
      }
      const replay = replayArenaGame(g.moves);
      const humanSide: 'white' | 'black' | null =
        g.whiteId === 'you' ? 'white' : g.blackId === 'you' ? 'black' : null;
      /*
       * An Armageddon has unequal clocks, and a resumed game has its own saved
       * clocks. Both come before the tournament's default start.
       */
      const initialClocks = g.clocks
        ?? g.clockStart
        ?? (t.timeControl.untimed ? null : startingClocks(t.timeControl.initialSeconds));
      const initialHistory = g.clockHistory ?? (initialClocks ? [{ ply: 0, ...initialClocks }] : []);
      const initialResult: ArenaOutcome | null = g.status === 'done' && g.result && g.result !== 'bye'
        ? { result: g.result, winnerId: g.winnerId ?? null, reason: g.reason ?? 'finished' }
        : null;

      setTournament(t);
      setInfo(g);
      setMoves(g.moves);
      setFen(replay.fen());
      setLastMove(g.moves.length > 0 ? { from: g.moves[g.moves.length - 1].from, to: g.moves[g.moves.length - 1].to } : null);
      setClocks(initialClocks);
      setClockHistory(initialHistory);
      setPgn(g.pgn ?? null);
      setResult(initialResult);
      setGameDone(g.status === 'done');
      setReviewPly(g.moves.length);
      setOrientation(humanSide ?? 'white');
      chessRef.current = replay;
      movesRef.current = g.moves;
      clocksRef.current = initialClocks;
      clockHistoryRef.current = initialHistory;
      finishedRef.current = g.status === 'done';
    })();
    return () => {
      on = false;
    };
  }, [gameId, tournamentId]);

  const humanColor = useMemo<'white' | 'black' | null>(() => {
    if (!info) return null;
    if (info.whiteId === 'you') return 'white';
    if (info.blackId === 'you') return 'black';
    return null;
  }, [info]);

  const turn: 'w' | 'b' = fen.split(' ')[1] === 'b' ? 'b' : 'w';
  const live = !gameDone && !result;
  const humanTurn = live && !!humanColor && ((turn === 'w' && humanColor === 'white') || (turn === 'b' && humanColor === 'black'));
  const untimed = !!tournament?.timeControl.untimed;
  const activeColor: 'white' | 'black' = turn === 'w' ? 'white' : 'black';

  const persist = useCallback(
    (nextMoves: ArenaMove[], nextClocks: { white: number; black: number } | null, nextHistory: ArenaGame['clockHistory']) => {
      if (!infoRef.current || finishedRef.current) return;
      void saveTournamentGameState(tournamentId, gameId, {
        moves: nextMoves,
        clocks: nextClocks ?? undefined,
        clockHistory: nextHistory,
      }).catch(() => {
        // A failed intermediate save is recoverable on the next move; the game
        // itself is still in memory.
      });
    },
    [gameId, tournamentId],
  );

  /**
   * The result save is separate from the in-memory finish so a storage failure
   * can be retried from the result card. `recordGameResult` is idempotent for a
   * game already marked done, so a retry after an ambiguous failure is safe.
   */
  const saveResult = useCallback((outcome: ArenaOutcome) => {
    const t = tournamentRef.current;
    const g = infoRef.current;
    if (!t || !g) return;
    resultRef.current = outcome;
    const finalMoves = movesRef.current;
    const finalClocks = clocksRef.current ?? undefined;
    const finalHistory = clockHistoryRef.current;
    const finalPgn = arenaPgn(t, { ...g, moves: finalMoves }, outcome.result);
    setPgn(finalPgn);
    void saveTournamentGameResult(t.id, g.id, outcome.result, {
      pgn: finalPgn,
      moves: finalMoves,
      clocks: finalClocks,
      clockHistory: finalHistory,
      reason: outcome.reason,
      winnerId: outcome.winnerId,
    }).then(async () => {
      /*
       * SHOW THE RATING THE GAME MOVED. The Elo is applied and stored inside
       * `recordGameResult`; reading the saved game back is the only way to show
       * the figure the profile will hold — and it is what makes "my rating
       * changed" visible at the moment it changes.
       */
      const fresh = await loadTournament(t.id);
      const mine = fresh?.games.find((x) => x.id === g.id)?.ratingChanges?.find((c) => c.participantId === 'you');
      if (mine) setRatingChange({ before: mine.before, after: mine.after, delta: mine.delta });
    }).catch((e: unknown) => {
      setEngineError(e instanceof Error ? e.message : 'Could not save the result.');
    });
  }, []);

  const finish = useCallback(
    (outcome: ArenaOutcome) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      /*
       * A DRAWN KNOCKOUT GAME IS NOT DECIDED HERE. The store plays out the legs
       * and appends an Armageddon (Black advances on a draw); the board says the
       * match is level and the tie-break is next, instead of quietly crowning
       * somebody on a rating.
       */
      const finalOutcome = outcome;
      setResult(finalOutcome);
      setGameDone(true);
      // A game finished on this screen opens its review at the final position,
      // not at the starting position.
      setReviewPly(movesRef.current.length);
      saveResult(finalOutcome);
    },
    [saveResult],
  );

  const retryResultSave = useCallback(() => {
    if (!result) return;
    setEngineError(null);
    saveResult(result);
  }, [result, saveResult]);

  const applyMove = useCallback(
    (from: string, to: string, promotion?: string): boolean => {
      if (finishedRef.current || !infoRef.current) return false;
      const chess = chessRef.current;
      let mv;
      try {
        mv = chess.move({ from, to, promotion: promotion ?? 'q' });
      } catch {
        return false;
      }
      const color: 'white' | 'black' = mv.color === 'w' ? 'white' : 'black';
      const nextMoves: ArenaMove[] = [
        ...movesRef.current,
        { san: mv.san, from: mv.from, to: mv.to, color, promotion: mv.promotion || undefined },
      ];
      movesRef.current = nextMoves;
      setMoves(nextMoves);
      setLastMove({ from: mv.from, to: mv.to });
      playMoveSound(mv);
      setFen(chess.fen());

      const tc = tournamentRef.current?.timeControl;
      let nextClocks = clocksRef.current;
      if (nextClocks && tc && !tc.untimed) {
        // An Armageddon has no increment: the clock is the tie-break's currency.
        const inc = infoRef.current?.armageddon ? 0 : tc.incrementSeconds;
        nextClocks = { ...nextClocks, [color]: nextClocks[color] + inc };
        clocksRef.current = nextClocks;
        setClocks(nextClocks);
      }
      const nextHistory = nextClocks
        ? [...(clockHistoryRef.current ?? []), { ply: nextMoves.length, ...nextClocks }]
        : clockHistoryRef.current;
      clockHistoryRef.current = nextHistory;
      setClockHistory(nextHistory);

      const currentInfo = infoRef.current;
      if (!currentInfo.blackId) return false;
      const outcome = outcomeFromChess(chess, currentInfo.whiteId, currentInfo.blackId);
      if (outcome) finish(outcome);
      else persist(nextMoves, nextClocks, nextHistory);
      return true;
    },
    [finish, persist],
  );
  const applyMoveRef = useRef(applyMove);
  applyMoveRef.current = applyMove;

  const botMove = useCallback(async () => {
    const t = tournamentRef.current;
    const g = infoRef.current;
    if (!t || !g || finishedRef.current || thinkingRef.current) return;
    const chess = chessRef.current;
    const side = chess.turn();
    const participantId = side === 'w' ? g.whiteId : g.blackId;
    const participant = t.participants.find((p) => p.id === participantId);
    const profile = participant?.bot;
    if (!profile) return;

    thinkingRef.current = true;
    setThinking(true);
    setEngineError(null);
    try {
      const askedFen = chess.fen();
      const startedAt = Date.now();
      const res = await botMoveFor(
        (f, o) => getEngine().analyse(f, o),
        askedFen,
        profile,
        weightsFromMimicry(0.78),
        { movetime: humanColor ? 1100 : 900, elo: profile.playElo ?? null },
      );
      if (!res) {
        setEngineError('The engine had no move for this position.');
        return;
      }
      // A visible human beat; forced replies stay quick. See `humanThinkDelayMs`.
      const remaining = humanThinkDelayMs(askedFen) - (Date.now() - startedAt);
      if (remaining > 0) await new Promise<void>((r) => setTimeout(r, remaining));
      if (finishedRef.current || chess.fen() !== askedFen) return;
      if (botShouldResign(res.evalTop)) {
        const winnerId = side === 'w' ? g.blackId : g.whiteId;
        finish({
          result: side === 'w' ? '0-1' : '1-0',
          winnerId,
          reason: `${participant.name} resigned`,
        });
        return;
      }
      setLastReason(res.decision.reason);
      const applied = applyMoveRef.current(
        res.decision.uci.slice(0, 2),
        res.decision.uci.slice(2, 4),
        res.decision.uci.length > 4 ? res.decision.uci[4] : undefined,
      );
      if (!applied) setEngineError('The engine returned an illegal move for this position.');
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : 'Engine error');
    } finally {
      thinkingRef.current = false;
      setThinking(false);
    }
  }, [finish, humanColor]);

  useEffect(() => {
    if (!live || paused || humanTurn || thinking || engineError) return;
    if (!info || !tournament) return;
    const sideId = turn === 'w' ? info.whiteId : info.blackId;
    const participant = tournament.participants.find((p) => p.id === sideId);
    if (!participant?.bot) return;
    void botMove();
  }, [botMove, engineError, humanTurn, info, live, paused, thinking, tournament, turn]);

  useEffect(() => {
    // A stalled engine must not also cost the player the game on the clock.
    // Retry clears the error and this effect starts again.
    if (!live || paused || untimed || engineError) return;
    if (!clocksRef.current) return;
    const id = setInterval(() => {
      const current = clocksRef.current;
      if (!current || finishedRef.current) return;
      const side = chessRef.current.turn() === 'w' ? 'white' : 'black';
      const next = { ...current, [side]: Math.max(0, current[side] - 0.25) };
      clocksRef.current = next;
      setClocks(next);
      if (next[side] <= 0) {
        const g = infoRef.current;
        if (g?.blackId) finish(timeoutOutcome(side, chessRef.current, g.whiteId, g.blackId));
      }
    }, 250);
    return () => clearInterval(id);
    // `tournament` is the load signal: clocks are filled when it arrives, and
    // without this dependency a timed game opened from storage never started
    // its clock. Clock state itself must not be a dependency or every tick
    // would tear down and rebuild the interval.
  }, [engineError, finish, live, paused, tournament, untimed]);

  const leave = useCallback(() => {
    if (live && !finishedRef.current) {
      persist(movesRef.current, clocksRef.current, clockHistoryRef.current);
    }
    onExit();
  }, [live, onExit, persist]);

  // A hardware back / shell close still preserves the clock and move list.
  useEffect(() => {
    return () => {
      if (!finishedRef.current && infoRef.current) {
        void saveTournamentGameState(tournamentId, gameId, {
          moves: movesRef.current,
          clocks: clocksRef.current ?? undefined,
          clockHistory: clockHistoryRef.current,
        });
        return;
      }
      /*
       * A result write may still be in flight when the screen closes, or it may
       * have failed after the result card appeared. Queue one idempotent retry
       * with the final move list so a completed game cannot be left on disk as
       * an in-progress snapshot.
       */
      const outcome = resultRef.current;
      const t = tournamentRef.current;
      const g = infoRef.current;
      if (!outcome || !t || !g) return;
      const finalMoves = movesRef.current;
      const finalPgn = g.pgn ?? arenaPgn(t, { ...g, moves: finalMoves }, outcome.result);
      void saveTournamentGameResult(t.id, g.id, outcome.result, {
        pgn: finalPgn,
        moves: finalMoves,
        clocks: clocksRef.current ?? undefined,
        clockHistory: clockHistoryRef.current,
        reason: outcome.reason,
        winnerId: outcome.winnerId,
      }).catch(() => {
        // The result card already exposes a retry while the screen is open.
      });
    };
  }, [gameId, tournamentId]);

  const resign = useCallback(() => {
    if (!live || !humanColor || !info) return;
    Alert.alert('Resign this game?', 'The result is recorded in the tournament immediately.', [
      { text: 'Keep playing', style: 'cancel' },
      {
        text: 'Resign',
        style: 'destructive',
        onPress: () => {
          const winnerId = humanColor === 'white' ? info.blackId : info.whiteId;
          finish({
            result: humanColor === 'white' ? '0-1' : '1-0',
            winnerId,
            reason: 'You resigned',
          });
        },
      },
    ]);
  }, [finish, humanColor, info, live]);

const adoptDraw = useCallback((reason: string) => {
    const t = tournamentRef.current;
    const g = infoRef.current;
    if (!live || !g) return;
    /*
     * A DRAW IN AN ARMAGEDDON IS NOT A DRAW: Black has the draw odds, so the
     * game ends with Black advancing. Any other knockout draw leaves the match
     * level and the store appends the Armageddon that will decide it.
     */
    if (g.armageddon) {
      finish({ result: '1/2-1/2', winnerId: g.blackId, reason: 'Armageddon drawn — Black advances' });
      return;
    }
    const finalReason = t?.format === 'knockout'
      ? `${reason} — an Armageddon tiebreak will decide the match`
      : reason;
    finish({ result: '1/2-1/2', winnerId: null, reason: finalReason });
  }, [finish, live]);

  /**
   * THE OPPONENT DECIDES WHETHER TO ACCEPT A DRAW.
   *
   * A draw offer is not a button that ends the game; it is a proposal. Three
   * rules govern the bot's answer:
   *
   *   - AN ARMAGEDDON IS NEVER DRAWN. Black's draw odds and White's longer clock
   *     are the whole format; accepting turns the tie-break into a coin toss.
   *   - NOTHING EARLY. Before `DRAW_MIN_PLIES` the offer is a way to skip the
   *     game, not a statement about the position (the owner's rule).
   *   - THEN BY EVALUATION. The bot accepts when its own score (from the side to
   *     move, which is you) is at or below `DRAW_ACCEPT_CP`, and declines when it
   *     believes it is better.
   */
  const offerDraw = useCallback(async () => {
    const t = tournamentRef.current;
    const g = infoRef.current;
    if (!live || !humanColor || !g || !t || !humanTurn) return;
    const opponentId = humanColor === 'white' ? g.blackId : g.whiteId;
    const opponent = t.participants.find((p) => p.id === opponentId);
    if (g.armageddon) {
      Alert.alert(
        `${opponent?.name ?? 'The opponent'} declines the draw`,
        'An Armageddon tie-break cannot be drawn — Black advances on a draw, so the game has to be played out.',
      );
      return;
    }
    if (movesRef.current.length < DRAW_MIN_PLIES) {
      Alert.alert(
        `${opponent?.name ?? 'The opponent'} declines the draw`,
        'Too early to agree a draw — play a few more moves first.',
      );
      return;
    }
    if (!opponent?.bot) {
      adoptDraw('Draw agreed');
      return;
    }
    let accepted = true;
    try {
      const ev = await getEngine().analyse(chessRef.current.fen(), {
        movetime: 450,
        elo: opponent.bot.playElo ?? null,
      });
      // The search is from the side to move (you), so the bot's own score is the
      // negation. A mate score folds onto the same scale and dwarfs the threshold.
      const humanCp = ev.mateIn != null
        ? (ev.mateIn > 0 ? 10000 : -10000)
        : (ev.scoreCp ?? 0);
      accepted = -humanCp <= DRAW_ACCEPT_CP;
    } catch {
      accepted = true;
    }
    if (finishedRef.current) return;
    if (!accepted) {
      Alert.alert(
        `${opponent.name} declines the draw`,
        'They think they are better placed here. Play on.',
      );
      return;
    }
    adoptDraw('Draw agreed');
  }, [adoptDraw, humanColor, humanTurn, live]);

  /**
   * UNDO, in the same shape as a game against a bot.
   *
   * It removes the last full move — your move and the reply — so it is only
   * offered on your turn, when the last ply belongs to the opponent. Rebuilding
   * the board from the remaining move list keeps chess.js the single source of
   * truth; a raw `undo()` on the live game would leave the clocks, the saved
   * state and the board describing different positions.
   */
  const undo = useCallback(() => {
    if (!live || !humanColor || !humanTurn || thinkingRef.current) return;
    if (movesRef.current.length < 2) return;
    const next = movesRef.current.slice(0, -2);
    const replay = replayArenaGame(next);
    chessRef.current = replay;
    movesRef.current = next;
    setMoves(next);
    setFen(replay.fen());
    setLastMove(next.length > 0
      ? { from: next[next.length - 1].from, to: next[next.length - 1].to }
      : null);
    setLastReason(null);
    persist(next, clocksRef.current, clockHistoryRef.current);
  }, [humanColor, humanTurn, live, persist]);

  const reviewFen = useMemo(
    () => replayArenaGame(moves.slice(0, reviewPly)).fen(),
    [moves, reviewPly],
  );
  const boardFen = gameDone ? reviewFen : fen;
  const boardLastMove = gameDone
    ? reviewPly > 0
      ? { from: moves[reviewPly - 1].from, to: moves[reviewPly - 1].to }
      : null
    : lastMove;

  const winnerColor: 'white' | 'black' | null = useMemo(() => {
    if (!result?.winnerId || !info) return null;
    if (result.winnerId === info.whiteId) return 'white';
    if (result.winnerId === info.blackId) return 'black';
    return null;
  }, [info, result]);

  /*
   * THE ENDING'S OWN SOUND. A checkmate already played its sting through the
   * mating move, so only the other endings — resignation, agreement, timeout,
   * stalemate — are spoken here. Once per ending.
   */
  useEffect(() => {
    if (!result) {
      endSoundRef.current = false;
      return;
    }
    if (endSoundRef.current) return;
    endSoundRef.current = true;
    if (chessRef.current.isCheckmate()) {
      if (humanColor && winnerColor === humanColor) celebrate('gamewin', 'Checkmate — you won your tournament game.');
      return;
    }
    if (humanColor) {
      playGameEnd(result.winnerId == null ? 'draw' : winnerColor === humanColor ? 'win' : 'loss');
      if (result.winnerId != null && winnerColor === humanColor) {
        celebrate('gamewin', 'You won your tournament game.');
      }
    } else {
      // Spectating a bot game: there is no "you" to lose, so report the result.
      playGameEnd(result.winnerId == null ? 'draw' : 'win');
    }
  }, [celebrate, humanColor, result, winnerColor]);

  const kingOverlays = useMemo(() => {
    const out: Record<string, ReactNode> = {};
    if (!gameDone || !winnerColor || reviewPly !== moves.length) return out;
    const win = kingSquare(boardFen, winnerColor === 'white' ? 'w' : 'b');
    const loss = kingSquare(boardFen, winnerColor === 'white' ? 'b' : 'w');
    if (win) out[win] = <KingMark kind="win" />;
    if (loss) out[loss] = <KingMark kind="loss" />;
    return out;
  }, [boardFen, gameDone, moves.length, reviewPly, winnerColor]);

  const exportPgn = useMemo(() => {
    if (pgn) return pgn;
    if (!tournament || !info || !result) return null;
    return arenaPgn(tournament, info, result.result);
  }, [info, pgn, result, tournament]);
  const copyPgn = useCallback(() => {
    if (!exportPgn) return;
    try {
      Clipboard.setString(exportPgn);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      Alert.alert('Could not copy the PGN', 'The PGN is selectable below, so you can copy it by hand.');
    }
  }, [exportPgn]);
  const sharePgn = useCallback(() => {
    if (!exportPgn) return;
    void Share.share({ message: exportPgn, title: 'ChessForge PGN' });
  }, [exportPgn]);

  const title = info ? `${nameOf(tournament, info.whiteId)} vs ${nameOf(tournament, info.blackId)}` : 'Arena game';
  const statusText = result
    ? result.winnerId
      ? `${nameOf(tournament, result.winnerId)} wins`
      : 'Draw'
    : gameDone
      ? 'Game finished'
      : thinking
        ? 'Bot is thinking…'
        : humanTurn
          ? 'Your move'
          : 'Watching…';
  const reviewAtEnd = reviewPly === moves.length;

  if (missing) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>This game could not be loaded.</Text>
        <Btn label="Back to tournament" variant="ghost" onPress={onExit} />
      </View>
    );
  }

  if (!tournament || !info) {
    return <View style={styles.center}><Spinner /></View>;
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <IconBtn label="Back to tournament" onPress={leave}>
          <IconChevronLeft size={22} color={colors.foreground} />
        </IconBtn>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <Text style={styles.subtitle}>
            {tournament.name} · round {info.round} · board {info.board}
          </Text>
        </View>
        <IconBtn label="Flip board" onPress={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}>
          <IconRotateCcw size={18} color={colors.mutedForeground} />
        </IconBtn>
      </View>

      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.clockRow}>
          <ClockBox
            name={`${nameOf(tournament, info.whiteId)}${info.whiteId === 'you' ? ' · you' : ''}`}
            seconds={clocks?.white ?? null}
            active={live && activeColor === 'white'}
            untimed={untimed}
          />
          <ClockBox
            name={`${nameOf(tournament, info.blackId)}${info.blackId === 'you' ? ' · you' : ''}`}
            seconds={clocks?.black ?? null}
            active={live && activeColor === 'black'}
            untimed={untimed}
          />
        </View>

        <View style={styles.boardWrap}>
          <ChessForgeBoard
            fen={boardFen}
            orientation={orientation}
            interactive={live && humanTurn && !paused}
            onMove={applyMove}
            lastMove={boardLastMove}
            squareOverlays={kingOverlays}
          />
        </View>

        {result ? (
          <Card style={styles.resultCard}>
            <View style={styles.resultHead}>
              <View style={styles.resultIcon}>
                <IconTrophy size={20} color={colors.gold} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.resultTitle}>{statusText}</Text>
                <Text style={styles.resultReason}>{result.reason}</Text>
                {ratingChange ? (
                  <Text style={styles.ratingChange}>
                    Your ChessForge rating: {ratingChange.before} → {ratingChange.after}
                    {' '}({ratingChange.delta >= 0 ? '+' : ''}{ratingChange.delta})
                  </Text>
                ) : null}
                {engineError ? <Text style={styles.error}>{engineError}</Text> : null}
              </View>
              <Chip text={resultLabel(result.result)} color={colors.gold} />
            </View>
            {engineError ? (
              <Btn
                label="Retry saving result"
                variant="ghost"
                small
                onPress={retryResultSave}
                style={{ alignSelf: 'flex-start' }}
              />
            ) : null}
            {gameDone ? (
              <View style={styles.reviewControls}>
                <IconBtn label="Start of game" onPress={() => setReviewPly(0)}>
                  <IconChevronsLeft size={18} color={colors.foreground} />
                </IconBtn>
                <IconBtn label="Previous move" onPress={() => setReviewPly((n) => Math.max(0, n - 1))}>
                  <IconChevronLeft size={18} color={colors.foreground} />
                </IconBtn>
                <Text style={styles.reviewPly}>
                  {reviewPly}/{moves.length}
                </Text>
                <IconBtn label="Next move" onPress={() => setReviewPly((n) => Math.min(moves.length, n + 1))}>
                  <IconChevronRight size={18} color={colors.foreground} />
                </IconBtn>
                <IconBtn label="End of game" onPress={() => setReviewPly(moves.length)}>
                  <IconChevronsRight size={18} color={colors.foreground} />
                </IconBtn>
              </View>
            ) : null}
            <View style={styles.actionRow}>
              <Btn label="Back to tournament" variant="ghost" small onPress={leave} style={{ flex: 1 }} />
              <Btn
                label="Analyse game"
                variant="gold"
                small
                onPress={() => onAnalyse(exportPgn ?? '')}
              />
            </View>
            <View style={styles.actionRow}>
              <Btn
                label={copied ? 'PGN copied' : 'Copy PGN'}
                variant="ghost"
                small
                onPress={copyPgn}
                style={{ flex: 1 }}
              />
              <Btn label="Share PGN" variant="ghost" small onPress={sharePgn} style={{ flex: 1 }} />
            </View>
            {exportPgn ? (
              <Text selectable style={styles.pgnText}>{exportPgn}</Text>
            ) : null}
          </Card>
        ) : (
          <Card style={styles.statusCard}>
            <View style={styles.statusHead}>
              {thinking ? <Spinner size={15} /> : <View style={[styles.statusDot, humanTurn ? styles.statusDotYou : null]} />}
              <Text style={styles.statusText}>{statusText}</Text>
              {live && !humanColor ? (
                <Btn
                  label={paused ? 'Resume' : 'Pause'}
                  variant="ghost"
                  small
                  onPress={() => setPaused((p) => !p)}
                />
              ) : null}
            </View>
            {lastReason ? <Text style={styles.reason}>{lastReason}</Text> : null}
            {info.armageddon ? (
              <Text style={styles.armageddonNote}>
                Armageddon tie-break — Black advances on a draw, and White has the longer clock.
              </Text>
            ) : null}
            {tournament.format === 'knockout' && (tournament.knockoutLegs ?? 1) === 2 && !info.armageddon ? (
              <Text style={styles.note}>
                Match leg {info.leg ?? 1} of 2 — the same pairing is played once with each colour.
              </Text>
            ) : null}
            {engineError ? (
              <>
                <Text style={styles.error}>{engineError}</Text>
                <Btn
                  label="Retry engine"
                  variant="ghost"
                  small
                  onPress={() => {
                    setEngineError(null);
                    setLastReason(null);
                  }}
                  style={{ alignSelf: 'flex-start' }}
                />
              </>
            ) : null}
            {humanColor ? (
              /*
               * THE SAME SHAPES AS A GAME AGAINST A BOT: a flag resigns, the
               * circular arrow undoes, and the draw wears the ½ players know.
               * Undo is only offered on your turn — the last ply is then the
               * opponent's, so removing two returns the board to your previous
               * decision. The draw is a PROPOSAL: the bot answers it.
               */
              <View style={styles.actionRow}>
                <IconBtn
                  label="Undo last move"
                  onPress={undo}
                  disabled={!live || !humanTurn || moves.length < 2 || thinking}
                >
                  <IconUndo size={16} color={colors.foreground} />
                </IconBtn>
                <IconBtn label="Resign" onPress={resign} disabled={!live || thinking}>
                  <IconFlag size={16} color={colors.bad} />
                </IconBtn>
                <IconBtn
                  label="Offer draw"
                  onPress={() => void offerDraw()}
                  disabled={!live || !humanTurn || thinking}
                >
                  <Text style={styles.drawGlyph}>½</Text>
                </IconBtn>
              </View>
            ) : null}
            <Text style={styles.note}>
              Leaving the board saves the game. Resume it from the tournament when you are ready.
            </Text>
          </Card>
        )}

        <Card style={styles.movesCard}>
          <View style={styles.movesHead}>
            <Text style={styles.movesTitle}>Moves</Text>
            <Text style={styles.noteSm}>{moves.length} plies</Text>
          </View>
          {moves.length === 0 ? (
            <Text style={styles.note}>No moves yet.</Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.moveTokens}>
              {moves.map((m, i) => {
                const isReview = gameDone && i === reviewPly - 1;
                return (
                  <Pressable
                    key={`${i}-${m.san}`}
                    onPress={() => gameDone && setReviewPly(i + 1)}
                    style={({ pressed }) => [styles.moveToken, isReview ? styles.moveTokenOn : null, pressed ? styles.pressed : null]}
                  >
                    <Text style={[styles.moveNo]}>{m.color === 'white' ? `${Math.floor(i / 2) + 1}.` : ''}</Text>
                    <Text style={[styles.moveSan, isReview ? styles.moveSanOn : null]}>{m.san}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
          {gameDone && !reviewAtEnd ? (
            <Text style={styles.noteSm}>Reviewing move {reviewPly} of {moves.length}. Tap a move to jump.</Text>
          ) : null}
        </Card>

        {!gameDone ? (
          <Text style={styles.footnote}>
            {untimed ? 'Untimed game' : `${tournament.timeControl.label} · increment applied after every move`} ·{' '}
            {tournament.rated ? 'ChessForge rated' : 'Unrated'}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = themedStyles(() => ({
  root: { flex: 1 },
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontFamily: fonts.sansBold, fontSize: 15, color: colors.foreground },
  subtitle: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground },
  content: { padding: 12, gap: 9 },
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
  clockActive: { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.08)' },
  clockName: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground },
  clockTime: { fontFamily: fonts.mono, fontSize: 20, color: colors.foreground },
  clockTimeActive: { color: colors.gold },
  boardWrap: { alignSelf: 'center', width: '100%' },
  resultCard: { gap: 8, borderColor: 'rgba(212,175,55,0.4)', backgroundColor: 'rgba(212,175,55,0.06)' },
  resultHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  resultIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(212,175,55,0.15)',
  },
  resultTitle: { fontFamily: fonts.sansBold, fontSize: 15, color: colors.foreground },
  resultReason: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  ratingChange: { fontFamily: fonts.sansMedium, fontSize: 10, color: colors.gold },
  armageddonNote: {
    fontFamily: fonts.sansMedium,
    fontSize: 10,
    color: colors.gold,
    lineHeight: 14,
  },
  drawGlyph: { fontFamily: fonts.sansBold, fontSize: 18, color: colors.foreground, lineHeight: 20 },
  reviewControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  reviewPly: { minWidth: 44, textAlign: 'center', fontFamily: fonts.mono, fontSize: 11, color: colors.mutedForeground },
  statusCard: { gap: 7 },
  statusHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.mutedForeground },
  statusDotYou: { backgroundColor: colors.primary },
  statusText: { flex: 1, fontFamily: fonts.sansSemiBold, fontSize: 12, color: colors.foreground },
  reason: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground, lineHeight: 14 },
  error: { fontFamily: fonts.sans, fontSize: 10, color: colors.destructive, lineHeight: 14 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  pgnText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.mutedForeground,
    lineHeight: 13,
    paddingTop: 2,
  },
  note: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground, lineHeight: 14 },
  noteSm: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground },
  movesCard: { gap: 6 },
  movesHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  movesTitle: { fontFamily: fonts.sansSemiBold, fontSize: 12, color: colors.foreground },
  moveTokens: { flexDirection: 'row', flexWrap: 'nowrap', gap: 2, paddingVertical: 2 },
  moveToken: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 2,
    paddingHorizontal: 4,
    paddingVertical: 3,
    borderRadius: radii.sm,
  },
  moveTokenOn: { backgroundColor: 'rgba(212,175,55,0.16)' },
  moveNo: { fontFamily: fonts.mono, fontSize: 8, color: colors.mutedForeground },
  moveSan: { fontFamily: fonts.mono, fontSize: 11, color: colors.foreground },
  moveSanOn: { color: colors.gold, fontFamily: fonts.sansBold },
  pressed: { opacity: 0.75 },
  emptyText: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground, textAlign: 'center' },
  footnote: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground, textAlign: 'center' },
}));
