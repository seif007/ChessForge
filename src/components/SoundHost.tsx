'use client';

/**
 * Hidden WebView that hosts the WebAudio sound engine.
 *
 * React Native has no AudioContext, and the web app's sounds are synthesised
 * procedurally rather than loaded from files. Rather than reimplement the DSP
 * with expo-audio (which would change the timbre), we run the original
 * `lib/sounds.ts` logic in a browser context — see `src/engine/sound-host.html`.
 *
 * Android requires an AudioContext to be created/resumed from a user gesture, so
 * `unlockAudio()` should be called from the first tap (AppShell wires it to the
 * tab bar). Until then, playback is silently deferred by the browser.
 */

import { useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewProps } from 'react-native-webview';
// `WebViewErrorEvent` is not re-exported from the package root — see EngineHost.tsx.
import type { WebViewErrorEvent } from 'react-native-webview/lib/WebViewTypes';
import { attachSoundHost, hydrateSoundPref } from '@/lib/sounds';
import { SOUND_HOST_HTML } from '@/engine/assets';

/** See the note in EngineHost.tsx — the default export's props collapse to `never`. */
const TypedWebView = WebView as unknown as React.ComponentType<
  WebViewProps & { ref?: React.Ref<WebView> }
>;

export function SoundHost() {
  const ref = useRef<WebView>(null);

  const html = useMemo(() => SOUND_HOST_HTML, []);

  useEffect(() => {
    void hydrateSoundPref();
    return () => attachSoundHost(null);
  }, []);

  return (
    <View style={styles.hidden} pointerEvents="none">
      <TypedWebView
        ref={ref}
        source={{ html }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        mediaPlaybackRequiresUserAction={false}
        androidLayerType="hardware"
        onLoadEnd={() => attachSoundHost(ref.current)}
        onError={(e: WebViewErrorEvent) => console.warn('SoundHost WebView error', e.nativeEvent)}
      />
    </View>
  );
}

/** Prime the AudioContext inside a user gesture (call from the first tap). */
export function unlockAudio(webview: WebViewHandleLike | null): void {
  try {
    webview?.postMessage(JSON.stringify({ cmd: 'unlock' }));
  } catch {
    /* ignore */
  }
}

interface WebViewHandleLike {
  postMessage: (data: string) => void;
}

const styles = StyleSheet.create({
  hidden: { width: 0, height: 0, opacity: 0, position: 'absolute' },
});
