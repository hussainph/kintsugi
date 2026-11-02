import { clipLabel } from '@kintsugi/core/clips';
import { Offline, Unpaired } from '@kintsugi/core/remote';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DocEditor } from '@/components/editor/DocEditor';
import { inspiration, useClip, useInspiration } from '@/lib/clip-library';
import { editorSessions } from '@/lib/editor-session';
import { clipUnsent } from '@/lib/inspiration';
import { usePairing } from '@/lib/pairing';
import { useNewEditor } from '@/lib/settings';
import { fonts, useTheme } from '@/theme';

const SAVE_DELAY = 800;

/** The owner's own notes on a clip, written in the same editor as a
 *  document: the shared CodeMirror editor when it's on (Home's menu), else
 *  the plain text field. Saved on this phone at once and sent to the Mac
 *  when it's reachable, version-checked like a document. */
export default function ClipNotesScreen() {
  const { path } = useLocalSearchParams<{ path: string }>();
  // Chosen once per screen, so switching mid-edit can't lose text.
  const [newEditor] = useState(useNewEditor());
  const local = useClip(path);
  const { connection } = useInspiration();
  const { client, unpair } = usePairing();
  const theme = useTheme();
  const headerHeight = useHeaderHeight();
  const [failure, setFailure] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const shown = useRef<string | null>(local?.text ?? null);
  const text = local?.text;
  useEffect(() => {
    if (text !== undefined) shown.current = text;
  }, [text]);

  const push = useCallback(() => {
    clearTimeout(timer.current);
    if (!client) return;
    inspiration.push(client, path).then(
      () => setFailure(null),
      (e: unknown) => {
        if (e instanceof Unpaired) return unpair();
        setFailure(e instanceof Offline ? null : String(e));
      },
    );
  }, [client, path, unpair]);

  const pushNow = useRef(push);
  useEffect(() => {
    pushNow.current = push;
  }, [push]);

  // Send when the app is left or comes back, and on leaving the notes.
  useEffect(() => {
    const settled = () => (newEditor ? editorSessions.flush() : Promise.resolve());
    const sub = AppState.addEventListener('change', () => void settled().then(() => pushNow.current()));
    return () => {
      sub.remove();
      void settled().then(() => pushNow.current());
    };
  }, [newEditor]);

  const write = (next: string, seen?: string) => {
    inspiration.edit(path, next, seen ?? shown.current ?? undefined);
    shown.current = inspiration.get(path)?.text ?? null;
    clearTimeout(timer.current);
    timer.current = setTimeout(push, SAVE_DELAY);
  };

  if (!local || local.text === null) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background }]}>
        <Stack.Title>{''}</Stack.Title>
        <Text style={[styles.note, { color: theme.muted }]}>
          {local ? 'Update Kintsugi on your Mac to edit notes here.' : 'This clip isn’t on this phone any more.'}
        </Text>
      </View>
    );
  }

  const choose = (keep: 'mine' | 'theirs') => {
    if (keep === 'mine') inspiration.keepMine(path);
    else inspiration.useTheirs(path);
    push();
  };

  const note = failure
    ? `Couldn’t send to your Mac. Your notes are kept on this phone. ${failure}`
    : local.gone
      ? 'This clip was removed on your Mac. Your notes are kept on this phone.'
      : clipUnsent(local) && connection === 'offline'
        ? 'Saved on this phone. It goes to your Mac when it’s reachable.'
        : null;

  const notices = (local.conflict || note) && (
    <View style={styles.notices}>
      {local.conflict && (
        <View style={[styles.conflict, { backgroundColor: theme.surface }]}>
          <Text style={[styles.conflictText, { color: theme.text }]}>
            These notes were changed on your Mac and on this phone in the same place. Which version should stay?
          </Text>
          <View style={styles.choices}>
            <Pressable onPress={() => choose('theirs')} style={[styles.choice, { borderColor: theme.border }]}>
              <Text style={[styles.choiceText, { color: theme.text }]}>Use the Mac’s</Text>
            </Pressable>
            <Pressable onPress={() => choose('mine')} style={[styles.choice, { backgroundColor: theme.primary, borderColor: theme.primary }]}>
              <Text style={[styles.choiceText, { color: theme.onPrimary }]}>Keep this phone’s</Text>
            </Pressable>
          </View>
        </View>
      )}
      {note && <Text style={[styles.note, { color: failure || local.gone ? theme.danger : theme.muted }]}>{note}</Text>}
    </View>
  );

  return (
    <>
      <Stack.Title>{local.clip.title || clipLabel(local.clip)}</Stack.Title>
      {newEditor ? (
        <View style={[styles.editorScreen, { backgroundColor: theme.background, paddingTop: headerHeight }]}>
          {notices && <View style={styles.editorNotices}>{notices}</View>}
          <DocEditor docKey={`clip:${path}`} body={local.text} focus={!local.text.trim()} write={write} />
        </View>
      ) : (
        <ScrollView
          automaticallyAdjustKeyboardInsets
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
          style={{ backgroundColor: theme.background }}
          contentContainerStyle={styles.content}
        >
          {notices}
          <TextInput
            value={local.text}
            onChangeText={(next) => write(next)}
            multiline
            scrollEnabled={false}
            autoFocus={!local.text.trim()}
            placeholder="Add a note…"
            placeholderTextColor={theme.faint}
            accessibilityLabel="Your notes"
            style={[styles.body, { color: theme.text }]}
          />
        </ScrollView>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 120, gap: 12 },
  notices: { paddingHorizontal: 0, paddingBottom: 4, gap: 12 },
  note: { fontSize: 14, lineHeight: 19, textAlign: 'center' },
  conflict: { borderRadius: 14, padding: 14, gap: 12 },
  conflictText: { fontSize: 15, lineHeight: 21 },
  choices: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  choice: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
  choiceText: { fontSize: 15, fontWeight: '600' },
  editorScreen: { flex: 1 },
  editorNotices: { paddingHorizontal: 20, paddingTop: 12 },
  body: { fontFamily: fonts.serif, fontSize: 19, lineHeight: 29, padding: 0, minHeight: 300 },
});
