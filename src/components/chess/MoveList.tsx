'use client';

/**
 * Shared move-list table: numbered move pairs, current-ply highlight,
 * per-move classification badge (brilliant/blunder/book/…), tap-to-jump.
 *
 * React Native port of `components/chess/MoveList.tsx`.
 * Prop signature unchanged (`className` becomes `style`).
 */

import { View, Text, Pressable, ScrollView, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import type { QualityKind } from '@/lib/moveQuality';
import { QUALITY_META } from '@/lib/moveQuality';
import { QualityBadge } from './QualityBadge';
import { colors, fonts, radii, themedStyles } from '@/theme/tokens';

export interface MoveRow {
  san: string;
  ply: number; // 0-based
}

export type MarkerKind = QualityKind | 'repertoire';

interface Props {
  sans: string[]; // full move sequence
  currentPly?: number; // ply BEFORE which is shown (highlight sans[currentPly-1])
  onSelectPly?: (ply: number) => void; // ply = index of tapped move (0-based)
  markers?: Record<number, { kind: MarkerKind; label?: string }>;
  /**
   * The FEN `sans` starts FROM, when that is not the opening position.
   *
   * WHY THIS IS NEEDED - AND IT IS NOT COSMETIC
   * ------------------------------------------
   * The list used to count from one and always put the first move in the White column. That
   * is correct for a game recorded from move 1 and wrong for everything else — and a great deal
   * of this app is not a game from move 1. An endgame lesson starts at, say, move 34, and a
   * puzzle starts at whatever ply the real game was mined from, so those lists claimed the
   * position was move 1 of a game. Worse, when the position has BLACK to move, the first move
   * is Black's, and printing it in the White column does not merely misnumber it: it tells
   * the reader the opposite player made it.
   *
   * The user asked for the last move to be shown "like in lichess" precisely because, without
   * this, there was no reliable way to tell from the list who had just played and who was to
   * move next.
   *
   * Omit it and the behaviour is exactly what it always was, so the screens that do pass a
   * game-from-move-1 list are unaffected.
   */
  startFen?: string;
  style?: StyleProp<ViewStyle>;
}

interface Cell { san: string; ply: number }
interface Row { no: number; white?: Cell; black?: Cell }

export function buildMoveRows(sans: string[], startFen?: string): Row[] {
  const fields = (startFen ?? '').split(' ').filter(Boolean);
  const startSide = fields[1] === 'b' ? 'b' : 'w';
  const startMove = Number(fields[5]) || 1;
  // When the position has Black to move, Black's ply belongs to the move number as printed,
  // so it comes first in that row. One offset gives both the numbering and the colour.
  const offset = startSide === 'b' ? 1 : 0;

  const rows: Row[] = [];
  for (let i = 0; i < sans.length; i++) {
    const no = startMove + Math.floor((i + offset) / 2);
    const isWhite = (i + offset) % 2 === 0;
    let row = rows.find((r) => r.no === no);
    if (!row) {
      row = { no };
      // Keep the rows in order even when the first row is pushed out of sequence.
      rows.push(row);
      rows.sort((a, b) => a.no - b.no);
    }
    if (isWhite) row.white = { san: sans[i], ply: i };
    else row.black = { san: sans[i], ply: i };
  }
  return rows;
}

export function MoveList({ sans, currentPly = 0, onSelectPly, markers = {}, startFen, style }: Props) {
  const rows = buildMoveRows(sans, startFen);
  const isBlackFirst = (startFen ?? '').split(' ')[1] === 'b';

  const renderCell = (m?: { san: string; ply: number }) => {
    if (!m) return <View style={styles.cellFlex} />;
    const isCurrent = currentPly === m.ply + 1;
    const mk = markers[m.ply];
    return (
      <Pressable
        onPress={() => onSelectPly?.(m.ply)}
        disabled={!onSelectPly}
        style={[styles.cell, isCurrent ? styles.cellCurrent : null]}
      >
        <Text
          allowFontScaling={false}
          numberOfLines={1}
          style={[
            styles.cellText,
            isCurrent ? styles.cellTextCurrent : null,
          ]}
        >
          {m.san}
        </Text>
        {mk ? (
          <View style={styles.markerWrap}>
            {mk.kind === 'repertoire' ? (
              <Text allowFontScaling={false} style={styles.repMarker}>
                {'\u25C6'}
              </Text>
            ) : (
              <QualityBadge kind={mk.kind} size={12} />
            )}
          </View>
        ) : null}
      </Pressable>
    );
  };

  return (
    <ScrollView style={style} contentContainerStyle={styles.container} nestedScrollEnabled>
      {rows.length === 0 ? (
        <Text allowFontScaling={false} style={styles.empty}>
          No moves yet.
        </Text>
      ) : null}
      {rows.map((r) => (
        <View key={r.no} style={styles.row}>
          <Text allowFontScaling={false} style={styles.number}>
            {r.no}{isBlackFirst ? '…' : '.'}
          </Text>
          {isBlackFirst ? renderCell(r.black) : renderCell(r.white)}
          {isBlackFirst ? renderCell(r.white) : renderCell(r.black)}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = themedStyles(() => ({
  container: { paddingBottom: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  number: {
    width: 32,
    textAlign: 'right',
    fontSize: 11,
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
  },
  cellFlex: { flex: 1 },
  cell: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: radii.sm,
  },
  cellCurrent: { backgroundColor: 'rgba(212,175,55,0.25)' },
  cellText: {
    flexShrink: 1,
    fontSize: 13,
    fontFamily: fonts.mono,
    color: colors.mutedForeground,
  },
  cellTextCurrent: { color: colors.gold, fontWeight: '600' },
  markerWrap: { flexShrink: 0 },
  repMarker: { fontSize: 10, color: colors.chessforge },
  empty: {
    color: colors.mutedForeground,
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 12,
  },
}));
