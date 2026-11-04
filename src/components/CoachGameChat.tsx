'use client';

/**
 * The coach's side of a game — a running conversation, not a report.
 *
 * The chat is deliberately thin: every answer comes from `activeCoach()`, which
 * already owns the position facts, the grounding guard and the chess-only gate.
 * Nothing here can make the coach talk about anything but chess, and the hint
 * button hands the engine's move to the coach so it explains a move that is
 * actually legal in the position on the board.
 */

import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { CoachAvatar } from '@/components/CoachAvatar';
import { Btn, Card, Spinner } from '@/components/ui/Primitives';
import { colors, fonts, radii, themedStyles } from '@/theme/tokens';

export interface CoachChatLine {
  id: number;
  who: 'you' | 'coach';
  text: string;
}

const QUICK_ASKS = [
  'What is the plan here?',
  'Where are the weak squares?',
  'Explain this position.',
];

export function CoachGameChat({
  lines,
  busy,
  canHint,
  onAsk,
  onHint,
}: {
  lines: readonly CoachChatLine[];
  /** A coach answer or a hint explanation is in flight. */
  busy: boolean;
  /** The user is on move, so a hint exists to explain. */
  canHint: boolean;
  onAsk: (question: string) => void;
  onHint: () => void;
}) {
  const [draft, setDraft] = useState('');

  const send = () => {
    const q = draft.trim();
    if (!q || busy) return;
    setDraft('');
    onAsk(q);
  };

  // A game can run hundreds of plies; the chat card is a conversation, not a
  // transcript. The full history still goes to the coach as context.
  const visible = lines.slice(-8);

  return (
    <Card style={s.card}>
      <View style={s.head}>
        <CoachAvatar size={38} />
        <View style={s.headText}>
          <Text style={s.title}>Coach</Text>
        </View>
        <Btn
          label="Hint"
          variant="gold"
          small
          onPress={onHint}
          disabled={!canHint || busy}
        />
      </View>

      {visible.length === 0 ? (
        <Text style={s.intro}>
          Ask me about the position, your plan or a tactic. I watch the game with you — and I only
          talk chess.
        </Text>
      ) : (
        <View style={s.thread}>
          {visible.map((line) => (
            line.who === 'you' ? (
              <Text key={line.id} style={s.question}>You: {line.text}</Text>
            ) : (
              <Text key={line.id} style={s.answer}>{line.text}</Text>
            )
          ))}
        </View>
      )}

      {busy ? (
        <View style={s.thinking}>
          <Spinner size={13} />
          <Text style={s.thinkingText}>Coach is thinking…</Text>
        </View>
      ) : null}

      <View style={s.chips}>
        {QUICK_ASKS.map((q) => (
          <Pressable
            key={q}
            onPress={() => {
              if (!busy) onAsk(q);
            }}
            disabled={busy}
            accessibilityLabel={`Ask the coach: ${q}`}
            style={({ pressed }) => [
              s.chip,
              busy ? s.dim : null,
              pressed ? s.pressed : null,
            ]}
          >
            <Text style={s.chipText}>{q}</Text>
          </Pressable>
        ))}
      </View>

      <View style={s.askRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Ask about chess or this position…"
          placeholderTextColor={colors.mutedForeground}
          style={s.input}
          editable={!busy}
          onSubmitEditing={send}
          returnKeyType="send"
          accessibilityLabel="Ask the coach about this game"
        />
        <Pressable
          onPress={send}
          disabled={busy || draft.trim().length === 0}
          accessibilityLabel="Send the question to the coach"
          style={({ pressed }) => [
            s.send,
            busy || draft.trim().length === 0 ? s.dim : null,
            pressed ? s.pressed : null,
          ]}
        >
          <Text style={s.sendText}>Ask</Text>
        </Pressable>
      </View>
    </Card>
  );
}

const s = themedStyles(() => ({
  card: { gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headText: { flex: 1, gap: 1 },
  title: { fontFamily: fonts.sansBold, fontSize: 15, color: colors.foreground },
  intro: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, color: colors.mutedForeground },
  thread: { gap: 8 },
  question: { fontFamily: fonts.sansSemiBold, fontSize: 12, color: colors.foreground },
  answer: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    color: colors.foreground,
    paddingLeft: 8,
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(212,175,55,0.5)',
  },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  thinkingText: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    backgroundColor: colors.subtleFill,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  chipText: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  askRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1,
    minHeight: 38,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.subtleFill,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.foreground,
  },
  send: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
  },
  sendText: { fontFamily: fonts.sansSemiBold, fontSize: 13, color: colors.primaryForeground },
  dim: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
}));
