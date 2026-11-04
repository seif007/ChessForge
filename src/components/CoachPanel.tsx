'use client';

/**
 * "Explain with Coach" — the interactive coach card on the Analyse screen.
 *
 * Three entry points, all grounded in the engine's own review:
 *  - the move on the board ("why was that a mistake?")
 *  - the current position (start position / a branch)
 *  - the whole game, opening through endgame (the walkthrough)
 *
 * Follow-ups are answered about the position currently on the board. The
 * chess-only gate lives in `Coach.ask` — anything off-topic gets the apology
 * without a model ever being called.
 */

import React, { useState } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { Btn, Card, Spinner } from '@/components/ui/Primitives';
import { CoachAvatar } from '@/components/CoachAvatar';
import { CoachModelManager } from '@/components/CoachModelManager';
import { activeCoach } from '@/lib/coach/session';
import { useCoachSession } from '@/lib/coach/useCoachSession';
import { AppMoveLike, AppReportLike, reviewFromAppMove, walkthroughFromAppReport } from '@/lib/coach/app';
import { colors, fonts, radii, themedStyles } from '@/theme/tokens';

interface Turn {
  q: string;
  a: string;
}

export function CoachPanel({
  fen,
  move,
  report,
}: {
  /** FEN of the position currently shown on the board (or a branch). */
  fen: string;
  /** The move played FROM the shown position, when one is selected. */
  move: AppMoveLike | null;
  /** The reviewed game (feeds the whole-game walkthrough). */
  report: AppReportLike;
}) {
  const [explain, setExplain] = useState<string | null>(null);
  const [explainTopic, setExplainTopic] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [thread, setThread] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const { narrator: tier } = useCoachSession();

  async function run(label: string, topic: string, produce: () => Promise<string>) {
    setBusy(label);
    setExplain(null);
    try {
      const text = await produce();
      setExplain(text);
      setExplainTopic(topic);
    } catch (e) {
      console.warn('[coach] panel failed:', e);
      setExplain('I could not read the review just now. Step through the game again and ask me once more.');
      setExplainTopic(topic);
    } finally {
      setBusy(null);
    }
  }

  const explainMove = () => {
    if (!move) return;
    const isWhite = move.mover === 'w';
    const label = `${Math.floor(move.ply / 2) + 1}${isWhite ? '.' : '...'}${move.san}`;
    void run('Reading the move…', label, () => activeCoach().explainMove(reviewFromAppMove(move)));
  };

  const explainPosition = () =>
    void run('Looking at the position…', 'This position', () => activeCoach().explainPosition(fen));

  const explainGame = () =>
    void run('Reviewing the whole game…', 'The whole game', () =>
      activeCoach().explainGame(walkthroughFromAppReport(report)));

  const ask = () => {
    const q = draft.trim();
    if (q.length === 0) return;
    setDraft('');
    setBusy('Thinking…');
    void (async () => {
      try {
        const history = thread.map((t) => [t.q, t.a] as const);
        // The reviewed move list up to the shown position, so questions about
        // how the game reached this board have real context.
        const at = report.moves.findIndex((m) => m.fenAfter === fen);
        const moves = at >= 0 ? report.moves.slice(0, at + 1).map((m) => m.san) : [];
        const a = await activeCoach().ask(q, fen, history, moves);
        setThread((prev) => [...prev, { q, a }]);
      } catch (e) {
        console.warn('[coach] follow-up failed:', e);
        setThread((prev) => [
          ...prev,
          { q, a: 'I lost that answer somewhere — ask me again and I will keep it short.' },
        ]);
      } finally {
        setBusy(null);
      }
    })();
  };

  return (
    <Card>
      <View style={s.head}>
        <CoachAvatar size={40} />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Coach</Text>
          <Text style={s.tier} numberOfLines={1}>
            {tier} · explains from the engine review + chess knowledge base
          </Text>
        </View>
      </View>

      <Text style={s.intro}>
        Ask why a move was good or bad, what the plan is, which squares or pawns are weak, or what to
        do differently. The coach answers about the position on the board and stays on chess.
      </Text>

      <View style={s.btnRow}>
        <Btn
          label={move ? 'Explain this move' : 'Explain this position'}
          variant="gold"
          small
          disabled={busy !== null}
          onPress={move ? explainMove : explainPosition}
        />
        <Btn
          label="Explain the whole game"
          variant="sky"
          small
          disabled={busy !== null}
          onPress={explainGame}
        />
      </View>

      {busy ? (
        <View style={s.busyRow}>
          <Spinner size={14} />
          <Text style={s.busyText}>{busy}</Text>
        </View>
      ) : null}

      {explain ? (
        <View style={s.reply}>
          {explainTopic ? <Text style={s.replyTopic}>{explainTopic}</Text> : null}
          <Text style={s.replyText}>{explain}</Text>
        </View>
      ) : null}

      {thread.length > 0 ? (
        <View style={s.thread}>
          {thread.map((t, i) => (
            <View key={i} style={{ gap: 4 }}>
              <Text style={s.question}>You: {t.q}</Text>
              <Text style={s.answer}>{t.a}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <View style={s.askRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Ask about this position…"
          placeholderTextColor={colors.mutedForeground}
          style={s.input}
          editable={busy === null}
          onSubmitEditing={ask}
          returnKeyType="send"
          accessibilityLabel="Ask the coach a follow-up"
        />
        <Pressable
          onPress={ask}
          disabled={busy !== null || draft.trim().length === 0}
          accessibilityLabel="Send the question to the coach"
          style={({ pressed }) => [
            s.send,
            (busy !== null || draft.trim().length === 0) ? { opacity: 0.4 } : null,
            pressed ? { opacity: 0.8 } : null,
          ]}
        >
          <Text style={s.sendText}>Ask</Text>
        </Pressable>
      </View>

      <CoachModelManager />
    </Card>
  );
}

const s = themedStyles(() => ({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    fontWeight: '800',
    color: colors.foreground,
  },
  tier: {
    fontSize: 11,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  intro: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.mutedForeground,
    marginTop: 8,
  },
  btnRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  busyText: {
    fontSize: 12,
    color: colors.mutedForeground,
  },
  reply: {
    marginTop: 10,
    padding: 10,
    borderRadius: radii.md,
    backgroundColor: colors.subtleFill,
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.35)',
    gap: 4,
  },
  replyTopic: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.gold,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  replyText: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.foreground,
  },
  thread: {
    marginTop: 10,
    gap: 10,
  },
  question: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.whiteSide,
  },
  answer: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.foreground,
    paddingLeft: 8,
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(212,175,55,0.5)',
  },
  askRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  input: {
    flex: 1,
    minHeight: 40,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.subtleFill,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: colors.foreground,
  },
  send: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
  },
  sendText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primaryForeground,
  },
}));
