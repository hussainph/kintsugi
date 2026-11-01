// KI-28 spike, dev builds only (see `enabled`): the Mac's CodeMirror editor in a DOM
// component. Open with kintsugi://editor-spike?doc=short|long|huge
// (&ac=1 turns autocorrect/predictions back on, &acc=0 hides the WebView's
// keyboard accessory bar, &toolbar=0 hides the native toolbar, &hud=0 hides
// the metrics line). Not linked from the app; the real phone editor stays in
// doc.tsx.

import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useEffect, useRef, useState } from 'react';
import { Dimensions, Keyboard, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { sample, type SampleName } from '@/components/editor-spike/samples';
import SpikeEditor, { type Metrics, type SpikeEditorRef } from '@/components/editor-spike/SpikeEditor';
import { useTheme } from '@/theme';

// Release builds only include it when built with EXPO_PUBLIC_EDITOR_SPIKE=1,
// to measure cold open without Metro.
const enabled = __DEV__ || process.env.EXPO_PUBLIC_EDITOR_SPIKE === '1';

export default function EditorSpike() {
  return enabled ? <Keyed /> : <Redirect href="/" />;
}

// A new link (&n=2, another doc) mounts a fresh editor and WebView, to time
// opening a second note with the WebView process already running.
function Keyed() {
  const { doc, n } = useLocalSearchParams<{ doc?: string; n?: string }>();
  return <Spike key={`${doc}:${n}`} />;
}

function ToolButton({ label, testID, onPress }: { label: string; testID: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.button} hitSlop={6}>
      <Text style={[styles.buttonText, { color: theme.text }]}>{label}</Text>
    </Pressable>
  );
}

function Spike() {
  const params = useLocalSearchParams<{ doc?: SampleName; acc?: string; toolbar?: string; hud?: string; ac?: string }>();
  const docName: SampleName = params.doc === 'long' || params.doc === 'huge' ? params.doc : 'short';
  const theme = useTheme();
  // The iOS header floats over content; start below it.
  const headerHeight = useHeaderHeight();
  const dark = useColorScheme() === 'dark';
  const editor = useRef<SpikeEditorRef>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [keyboard, setKeyboard] = useState(0);
  const [saved, setSaved] = useState(0);
  // Generated once per document; `sentAt` lets the DOM side time the props.
  const [doc] = useState(() => ({ text: sample(docName), sentAt: Date.now() }));

  // The WebView doesn't shrink for the keyboard on its own, so the caret can
  // end up under it. Resize the editor to the space above the keyboard.
  useEffect(() => {
    const change = Keyboard.addListener('keyboardWillChangeFrame', (e) =>
      setKeyboard(Math.max(0, Dimensions.get('window').height - e.endCoordinates.screenY)),
    );
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboard(0));
    return () => {
      change.remove();
      hide.remove();
    };
  }, []);

  const showToolbar = params.toolbar !== '0' && keyboard > 0;

  return (
    <View style={[styles.screen, { backgroundColor: theme.background, paddingTop: headerHeight, paddingBottom: keyboard }]}>
      <Stack.Screen options={{ title: `Editor spike (${docName})` }} />
      {params.hud !== '0' && (
        <Text testID="spike-metrics" style={[styles.hud, { color: theme.muted }]} numberOfLines={3}>
          {metrics
            ? `${metrics.docChars} chars · ${metrics.lines} lines · ready ${metrics.readyMs}ms · mount ${metrics.mountMs}ms · keys ${metrics.keys} p50 ${metrics.keyP50} p95 ${metrics.keyP95} max ${metrics.keyMax}ms` +
              (metrics.bench ? ` · bench ${metrics.bench.n} p50 ${metrics.bench.p50} p95 ${metrics.bench.p95} max ${metrics.bench.max}ms` : '') +
              (metrics.bridgeMs != null ? ` · save ${metrics.bridgeMs}ms` : '') +
              ` · scroll ${metrics.scrollJank}/${metrics.scrollFrames} slow · top ${metrics.scrollTop} · sel ${metrics.selection} · saved ${saved}`
            : 'loading…'}
        </Text>
      )}
      <SpikeEditor
        ref={editor}
        text={doc.text}
        sentAt={doc.sentAt}
        dark={dark}
        keyboardText={params.ac === '1'}
        onMetrics={async (m) => setMetrics(m)}
        onText={async (text) => {
          setSaved(text.length);
          return Date.now();
        }}
        dom={{
          style: { flex: 1 },
          containerStyle: { flex: 1 },
          scrollEnabled: false,
          bounces: false,
          contentInsetAdjustmentBehavior: 'never',
          hideKeyboardAccessoryView: params.acc === '0',
        }}
      />
      {showToolbar && (
        <View testID="spike-toolbar" style={[styles.toolbar, { borderColor: theme.border, backgroundColor: theme.surface }]}>
          <ToolButton label="Undo" testID="spike-undo" onPress={() => editor.current?.undo()} />
          <ToolButton label="Redo" testID="spike-redo" onPress={() => editor.current?.redo()} />
          <ToolButton label="B" testID="spike-bold" onPress={() => editor.current?.bold()} />
          <ToolButton label="[[" testID="spike-link" onPress={() => editor.current?.link()} />
          <ToolButton label="Bench" testID="spike-bench" onPress={() => editor.current?.bench()} />
          <ToolButton label="Done" testID="spike-done" onPress={() => editor.current?.blur()} />
        </View>
      )}
      {!showToolbar && params.toolbar !== '0' && (
        <View style={[styles.toolbar, { borderColor: theme.border, backgroundColor: theme.surface }]}>
          <ToolButton label="Write" testID="spike-focus" onPress={() => editor.current?.focusEnd()} />
          <ToolButton label="Scroll" testID="spike-scroll" onPress={() => editor.current?.scrollBench()} />
          <ToolButton label="Report" testID="spike-report" onPress={() => editor.current?.report()} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  hud: { fontSize: 11, paddingHorizontal: 12, paddingVertical: 4, fontVariant: ['tabular-nums'] },
  toolbar: { flexDirection: 'row', justifyContent: 'space-around', borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 6 },
  button: { paddingHorizontal: 10, paddingVertical: 6 },
  buttonText: { fontSize: 16, fontWeight: '500' },
});
