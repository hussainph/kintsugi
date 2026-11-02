import { field, joinFrontmatter, setField, splitFrontmatter } from '@kintsugi/core/frontmatter';
import { Offline, Unpaired } from '@kintsugi/core/remote';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DocEditor } from '@/components/editor/DocEditor';
import { library, useDoc, useLibrary } from '@/lib/documents';
import { editorSessions } from '@/lib/editor-session';
import { docTitle, unsent } from '@/lib/library';
import { usePairing } from '@/lib/pairing';
import { useNewEditor } from '@/lib/settings';
import { fonts, useTheme } from '@/theme';

const SAVE_DELAY = 800;

/** One document, from the phone's own copy, so it opens and saves with or
 *  without the Mac. Edits are sent when it's reachable. The phone edits the
 *  writing only; the frontmatter rides along, apart from the status toggle. */
export default function DocScreen() {
  const params = useLocalSearchParams<{ path: string }>();
  // KI-36: the shared CodeMirror editor, while it's tried out (Home's menu).
  // Chosen once per screen, so switching mid-document can't lose text.
  const [newEditor] = useState(useNewEditor());
  // A note started here is renamed after its first line once it's sent.
  const [path, setPath] = useState(params.path);
  const doc = useDoc(path);
  const { connection } = useLibrary();
  const { client, unpair } = usePairing();
  const theme = useTheme();
  // The header floats over the screen; the editor starts below it.
  const headerHeight = useHeaderHeight();
  const moved = doc ? null : library.movedTo(path);
  if (moved) setPath(moved);
  // The editor shows the phone's copy directly, so a merge or the Mac's
  // update appears as soon as it lands.
  const parts = doc && splitFrontmatter(doc.text);
  const [failure, setFailure] = useState<string | null>(null);
  const current = useRef(path);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    current.current = path;
  }, [path]);

  // The text the editor holds: set when this screen writes, and once an
  // update from elsewhere has rendered.
  const shown = useRef<string | null>(doc?.text ?? null);
  const text = doc?.text;
  useEffect(() => {
    if (text !== undefined) shown.current = text;
  }, [text]);

  const push = useCallback(() => {
    clearTimeout(timer.current);
    if (!client) return;
    library.push(client, current.current).then(
      () => setFailure(null),
      (e: unknown) => {
        if (e instanceof Unpaired) return unpair();
        setFailure(e instanceof Offline ? null : String(e));
      },
    );
  }, [client, unpair]);

  const pushNow = useRef(push);
  useEffect(() => {
    pushNow.current = push;
  }, [push]);

  // The app opens here next time unless the owner goes back; send when the
  // app is left or comes back, and on leaving the document.
  useEffect(() => {
    library.open = current.current;
    library.last = current.current;
    // The shared editor hands its text over debounced; take what's waiting first.
    const settled = () => (newEditor ? editorSessions.flush() : Promise.resolve());
    const sub = AppState.addEventListener('change', () => void settled().then(() => pushNow.current()));
    return () => {
      sub.remove();
      void settled().then(() => {
        library.open = null;
        library.last = null;
        library.discardIfEmpty(current.current);
        pushNow.current();
      });
    };
  }, [newEditor]);

  const edit = (next: { head: string; body: string }, now = false) => {
    // Fast typing outruns rendering, so what the editor holds is the last
    // text it wrote or was shown, not this render's. A merge or the Mac's
    // update that landed since then is kept, with the keystroke folded in.
    library.edit(current.current, joinFrontmatter(next.head, next.body), shown.current ?? undefined);
    shown.current = library.get(current.current)?.text ?? null;
    clearTimeout(timer.current);
    if (now) push();
    else timer.current = setTimeout(push, SAVE_DELAY);
  };

  // From the shared editor: the writing without frontmatter, and the writing
  // it started from. The frontmatter is today's, so only the writing merges.
  const write = (body: string, seenBody: string) => {
    const head = splitFrontmatter(library.get(current.current)?.text ?? '').head;
    library.edit(current.current, joinFrontmatter(head, body), joinFrontmatter(head, seenBody));
    clearTimeout(timer.current);
    timer.current = setTimeout(push, SAVE_DELAY);
  };

  if (!doc || !parts) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background }]}>
        <Stack.Title>{''}</Stack.Title>
        <Text style={[styles.note, { color: theme.muted }]}>
          This document isn’t on this phone any more. It may have been moved or deleted on your Mac.
        </Text>
      </View>
    );
  }

  const full = joinFrontmatter(parts.head, parts.body);
  const status = field(full, 'status');
  const toggleStatus = () => {
    const change = setField(full, 'status', status === 'complete' ? 'draft' : 'complete');
    edit(splitFrontmatter(full.slice(0, change.from) + change.insert + full.slice(change.to)), true);
  };
  const choose = (keep: 'mine' | 'theirs') => {
    if (keep === 'mine') library.keepMine(path);
    else library.useTheirs(path);
    push();
  };

  const note = failure
    ? `Couldn’t send to your Mac. Your edits are kept on this phone. ${failure}`
    : unsent(doc) && connection === 'offline'
      ? 'Saved on this phone. It goes to your Mac when it’s reachable.'
      : null;

  return (
    <>
      <Stack.Title>{docTitle(doc)}</Stack.Title>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={status === 'complete' ? 'checkmark.circle.fill' : 'circle'}
          accessibilityLabel={status === 'complete' ? 'Complete. Mark as draft' : 'Draft. Mark as complete'}
          onPress={toggleStatus}
        />
      </Stack.Toolbar>
      {newEditor ? (
        <View style={[styles.editorScreen, { backgroundColor: theme.background, paddingTop: headerHeight }]}>
          {(doc.conflict || note) && (
            <View style={styles.editorNotes}>
              {doc.conflict && (
                <View style={[styles.conflict, { backgroundColor: theme.surface }]}>
                  <Text style={[styles.conflictText, { color: theme.text }]}>
                    This was changed on your Mac and on this phone in the same place. Which version should stay?
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
              {note && <Text style={[styles.note, { color: failure ? theme.danger : theme.muted }]}>{note}</Text>}
            </View>
          )}
          <DocEditor docKey={params.path} body={parts.body} focus={!!doc.fresh} write={write} />
        </View>
      ) : (
        <ScrollView
          automaticallyAdjustKeyboardInsets
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
          style={{ backgroundColor: theme.background }}
          contentContainerStyle={styles.content}
        >
          {doc.conflict && (
            <View style={[styles.conflict, { backgroundColor: theme.surface }]}>
              <Text style={[styles.conflictText, { color: theme.text }]}>
                This was changed on your Mac and on this phone in the same place. Which version should stay?
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
          {note && <Text style={[styles.note, { color: failure ? theme.danger : theme.muted }]}>{note}</Text>}
          <TextInput
            value={parts.body}
            onChangeText={(text) => edit({ head: parts.head, body: text })}
            multiline
            scrollEnabled={false}
            autoFocus={!!doc.fresh && !parts.body}
            placeholder="Start writing…"
            placeholderTextColor={theme.faint}
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
  note: { fontSize: 14, lineHeight: 19, textAlign: 'center' },
  conflict: { borderRadius: 14, padding: 14, gap: 12 },
  conflictText: { fontSize: 15, lineHeight: 21 },
  choices: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  choice: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
  choiceText: { fontSize: 15, fontWeight: '600' },
  editorScreen: { flex: 1 },
  editorNotes: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4, gap: 12 },
  body: { fontFamily: fonts.serif, fontSize: 19, lineHeight: 29, padding: 0, minHeight: 300 },
});
