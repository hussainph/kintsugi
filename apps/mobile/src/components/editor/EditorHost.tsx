import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, useWindowDimensions, View } from 'react-native';
import { KeyboardEvents, KeyboardStickyView } from 'react-native-keyboard-controller';

import PhoneEditor, { type PhoneEditorRef, type PhoneSource } from '@/components/editor/PhoneEditor';
import { useLibrary } from '@/lib/documents';
import { editorSessions } from '@/lib/editor-session';
import { docTitle } from '@/lib/library';
import { field } from '@kintsugi/core/frontmatter';
import { useTheme } from '@/theme';

import { KintsugiKeyboard } from '../../../modules/keyboard';

const TOOLBAR = [
  { id: 'undo', symbol: 'arrow.uturn.backward', label: 'Undo' },
  { id: 'redo', symbol: 'arrow.uturn.forward', label: 'Redo' },
  { id: '-', label: '' },
  { id: 'link', symbol: '', label: '[[' },
  { id: '-', label: '' },
  { id: 'done', symbol: 'keyboard.chevron.compact.down', label: 'Hide keyboard' },
];

// Without the native module (Expo Go), the same buttons ride on the
// keyboard in React Native, through keyboard-controller's frame-accurate
// tracking. Its height comes off the editor's.
const FALLBACK_HEIGHT = 44;

// Before any document opens, the WebView still starts, so the first one
// opens warm.
const IDLE = { key: '', text: '' };

/** The one editor WebView, mounted in the root layout for the life of the
 *  app and laid over the doc screen's slot when a document is open. Starting
 *  a WebView and parsing the editor bundle took most of the 1.5–7 s opening
 *  time in KI-28; here that happens once, at launch. */
export function EditorHost() {
  const state = useSyncExternalStore(editorSessions.subscribe, editorSessions.getSnapshot);
  const ref = useRef<PhoneEditorRef>(null);
  const theme = useTheme();
  const dark = useColorScheme() === 'dark';
  const window = useWindowDimensions();
  const [keyboard, setKeyboard] = useState(0);
  const sources = useSources();

  useEffect(() => {
    // Until the WebView has loaded, the ref has none of its methods.
    editorSessions.commands = {
      flush: (token) => {
        const flush = ref.current?.flush;
        if (flush) flush(token);
        return !!flush;
      },
      blur: () => ref.current?.blur?.(),
    };
    void KintsugiKeyboard?.setToolbar(TOOLBAR);
    void KintsugiKeyboard?.setFocusRaisesKeyboard(true);
    const action = KintsugiKeyboard?.addListener('onAction', ({ id }) => {
      const editor = ref.current;
      if (id === 'undo') editor?.undo?.();
      else if (id === 'redo') editor?.redo?.();
      else if (id === 'link') editor?.link?.();
      else if (id === 'done') editor?.blur?.();
    });
    // The keyboard's height includes the toolbar above it, and changes when
    // the predictions bar comes and goes.
    const show = KeyboardEvents.addListener('keyboardWillShow', (e) => setKeyboard(e.height));
    const hide = KeyboardEvents.addListener('keyboardWillHide', () => setKeyboard(0));
    return () => {
      editorSessions.commands = null;
      void KintsugiKeyboard?.setToolbar(null);
      void KintsugiKeyboard?.setFocusRaisesKeyboard(false);
      action?.remove();
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    void KintsugiKeyboard?.setEnabled({ undo: state.canUndo, redo: state.canRedo });
  }, [state.canUndo, state.canRedo]);

  const session = state.session ?? IDLE;
  const showing = !!(state.session && state.slot && state.visible);
  const focus = showing && state.session?.focus ? state.session.openedAt : 0;
  // WebKit only raises the keyboard for the page's own focus() when the
  // WebView is already first responder.
  useEffect(() => {
    if (focus) void KintsugiKeyboard?.focusWebView();
  }, [focus]);
  const slot = state.slot ?? { x: 0, y: 0, width: window.width, height: window.height };
  const fallback = !KintsugiKeyboard && showing && keyboard > 0;
  const height = Math.max(0, Math.min(slot.height, window.height - keyboard - (fallback ? FALLBACK_HEIGHT : 0) - slot.y));
  const act = (id: string) => {
    const editor = ref.current;
    if (id === 'undo') editor?.undo?.();
    else if (id === 'redo') editor?.redo?.();
    else if (id === 'link') editor?.link?.();
    else if (id === 'done') editor?.blur?.();
  };

  return (
    <>
      {__DEV__ && (
        // What the editor did, for the UI tests (spikes/editor-uitest); 1 pt, off to the side.
        <Text testID="editor-log" accessibilityLabel={state.log.join(' | ')} style={styles.log}>
          .
        </Text>
      )}
      <View
        pointerEvents={showing ? 'auto' : 'none'}
        style={[
          styles.host,
          { left: slot.x, top: slot.y, width: slot.width, height, backgroundColor: theme.background },
          // Hidden but laid out, so the WebView stays alive and sized.
          !showing && styles.hidden,
        ]}
      >
        <PhoneEditor
          ref={ref}
          docKey={session.key}
          text={session.text}
          external={state.external}
          // Once the screen has landed, as Notes does.
          focus={showing && state.session?.focus ? state.session.openedAt : 0}
          dark={dark}
          sources={sources}
          onText={async (key, text, seen) => editorSessions.wrote(key, text, seen)}
          onFlushed={async (token) => editorSessions.flushed(token)}
          onHistory={async (canUndo, canRedo) => editorSessions.history(canUndo, canRedo)}
          onShown={async (key) => editorSessions.shownKey(key)}
          onOpen={async (path) => router.push({ pathname: '/doc', params: { path } })}
          onLog={__DEV__ ? async (message) => editorSessions.log(message) : undefined}
          dom={{
            style: { flex: 1 },
            containerStyle: { flex: 1 },
            scrollEnabled: false,
            bounces: false,
            contentInsetAdjustmentBehavior: 'never',
            automaticallyAdjustsScrollIndicatorInsets: false,
            // The native toolbar replaces WebKit's ⌃⌄✓ bar; without the
            // module (Expo Go) there's no bar at all.
            hideKeyboardAccessoryView: true,
          }}
        />
      </View>
      {!KintsugiKeyboard && (
        <KeyboardStickyView style={styles.sticky} pointerEvents="box-none">
          {fallback && (
            <View style={[styles.fallback, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              {TOOLBAR.filter((item) => item.id !== '-').map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                  testID={`editor-toolbar-${item.id}`}
                  disabled={(item.id === 'undo' && !state.canUndo) || (item.id === 'redo' && !state.canRedo)}
                  onPress={() => act(item.id)}
                  hitSlop={6}
                  style={styles.fallbackButton}
                >
                  {({ pressed }) => (
                    <Text style={[styles.fallbackText, { color: theme.text, opacity: pressed ? 0.5 : 1 }]}>
                      {FALLBACK_LABELS[item.id] ?? item.label}
                    </Text>
                  )}
                </Pressable>
              ))}
            </View>
          )}
        </KeyboardStickyView>
      )}
    </>
  );
}

const FALLBACK_LABELS: Record<string, string> = { undo: 'Undo', redo: 'Redo', link: '[[', done: 'Done' };

/** Documents for the [[ picker. Only a new array when a title, status or
 *  path changes, not on every keystroke, so it isn't resent to the WebView. */
function useSources(): PhoneSource[] {
  const { docs } = useLibrary();
  const list = docs.map((doc) => ({ path: doc.path, title: docTitle(doc), status: field(doc.text, 'status') }));
  const signature = list.map((s) => `${s.path}\0${s.title}\0${s.status ?? ''}`).join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `list` follows `signature`
  return useMemo(() => list, [signature]);
}

const styles = StyleSheet.create({
  host: { position: 'absolute' },
  hidden: { opacity: 0 },
  sticky: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  fallback: {
    height: FALLBACK_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  fallbackButton: { paddingHorizontal: 14, paddingVertical: 8 },
  fallbackText: { fontSize: 16, fontWeight: '500' },
  log: { position: 'absolute', left: 0, bottom: 0, width: 1, height: 1, fontSize: 1, color: 'transparent' },
});
