/**
 * ChessForge — native Android port.
 *
 * Mirrors the web app's root layout: safe-area handling and the hidden
 * engine/sound WebViews mounted once for the whole session.
 *
 * THEME. The palette is read from module scope all over the app (see
 * `theme/tokens.ts`), so the stored preference must be applied BEFORE the first
 * render or the app opens dark and then visibly repaints. `expo-sqlite/kv-store`
 * is async, so we gate the first paint on `initTheme()` and show the themed
 * root background in the meantime — which is exactly the dark default, so the
 * splash-to-app transition stays seamless.
 *
 * `key={theme}` on the tree is deliberate: it remounts the shell on a switch,
 * which guarantees even the module-level `StyleSheet.create` sheets (written
 * before this feature and not individually converted) are rebuilt from the new
 * palette. Without it those sheets would keep the old colours.
 */

import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppShell } from '@/components/AppShell';
import { colors, useThemeName } from '@/theme/tokens';
import { initTheme } from '@/lib/theme';

export default function App() {
  const theme = useThemeName();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    initTheme()
      .catch(() => { /* default palette is already active */ })
      .finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, []);

  // The root view is painted from the live palette, so it is already correct
  // on the very first frame (dark by default) and repaints on a switch.
  const rootStyle = [styles.root, { backgroundColor: colors.background }];

  if (!ready) {
    return (
      <SafeAreaProvider>
        <View style={rootStyle} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <View style={rootStyle}>
        {/* light content on dark, dark content on the light theme */}
        <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
        <AppShell key={theme} />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
