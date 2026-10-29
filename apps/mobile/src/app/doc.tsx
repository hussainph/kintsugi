import { field, joinFrontmatter, setField, splitFrontmatter } from '@kintsugi/core/frontmatter';
import { Offline, Unpaired, type Versioned } from '@kintsugi/core/remote';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { drafts } from '@/lib/drafts';
import { usePairing } from '@/lib/pairing';
import { fonts, useTheme } from '@/theme';

const SAVE_DELAY = 800;

type Save = 'saved' | 'editing' | 'offline' | 'error';

/** One document. The phone edits the writing only; the frontmatter rides
 *  along untouched, apart from the status toggle. */
export default function DocScreen() {
  const { path } = useLocalSearchParams<{ path: string }>();
  const { client, unpair } = usePairing();
  const theme = useTheme();
  // An unsent edit from last time wins over the Mac's copy; saving it checks
  // the version, so a newer copy on the Mac still gets a say.
  const [draft] = useState(() => drafts.get(path));
  const [opened] = useState(() => (draft ? splitFrontmatter(draft.text) : null));
  const [head, setHead] = useState<string | null>(opened?.head ?? null);
  const [body, setBody] = useState(opened?.body ?? '');
  const [save, setSave] = useState<Save>(draft ? 'editing' : 'saved');
  const [error, setError] = useState<string | null>(null);

  // The latest values, for saves that fire from timers and app-state changes.
  const latest = useRef({ head: opened?.head ?? '', body: opened?.body ?? '', base: draft?.base ?? '', dirty: !!draft });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // `flush` retries itself after a conflict, so it reaches itself through a ref.
  const retry = useRef<(overwrite: string) => void>(() => {});

  const adopt = useCallback((doc: Versioned) => {
    const parts = splitFrontmatter(doc.text);
    latest.current = { ...parts, base: doc.version, dirty: false };
    setHead(parts.head);
    setBody(parts.body);
    setSave('saved');
  }, []);

  const flush = useCallback(
    async (overwrite?: string) => {
      clearTimeout(timer.current);
      const { head, body, base, dirty } = latest.current;
      if (!client || (!dirty && !overwrite)) return;
      const text = joinFrontmatter(head, body);
      try {
        const result = await client.write(path, text, overwrite ?? base);
        if (result.result === 'saved') {
          // Typing may have continued while this was in flight.
          const changed = joinFrontmatter(latest.current.head, latest.current.body) !== text;
          latest.current = { ...latest.current, base: result.version, dirty: changed };
          if (changed) {
            drafts.set(path, { text: joinFrontmatter(latest.current.head, latest.current.body), base: result.version });
          } else {
            drafts.clear(path);
          }
          setSave(changed ? 'editing' : 'saved');
          return;
        }
        const current = result.current;
        Alert.alert('Changed on your Mac', 'This document was edited on your Mac since the phone last saw it.', [
          {
            text: 'Use the Mac’s version',
            onPress: () => {
              drafts.clear(path);
              adopt(current);
            },
          },
          { text: 'Keep mine', style: 'destructive', onPress: () => retry.current(current.version) },
        ]);
      } catch (e) {
        if (e instanceof Unpaired) return unpair();
        setSave(e instanceof Offline ? 'offline' : 'error');
      }
    },
    [client, path, adopt, unpair],
  );

  const edit = (next: { head?: string; body?: string }, now = false) => {
    latest.current = { ...latest.current, ...next, dirty: true };
    if (next.head !== undefined) setHead(next.head);
    if (next.body !== undefined) setBody(next.body);
    drafts.set(path, { text: joinFrontmatter(latest.current.head, latest.current.body), base: latest.current.base });
    setSave('editing');
    clearTimeout(timer.current);
    if (now) flush();
    else timer.current = setTimeout(() => flush(), SAVE_DELAY);
  };

  useEffect(() => {
    retry.current = (overwrite) => flush(overwrite);
  }, [flush]);

  useEffect(() => {
    if (!client) return;
    if (draft) {
      // Send it the way any edit is sent: from the save timer.
      timer.current = setTimeout(() => flush(), 0);
      return;
    }
    client
      .read(path)
      .then(adopt)
      .catch((e: unknown) => {
        if (e instanceof Unpaired) return unpair();
        setError(e instanceof Offline ? 'Your Mac is offline, so this document can’t be opened right now.' : String(e));
      });
  }, [client, path, draft, adopt, flush, unpair]);

  // Try again when the app comes back, and save before leaving the screen.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => state === 'active' && flush());
    return () => {
      sub.remove();
      flush();
    };
  }, [flush]);

  const full = head === null ? '' : joinFrontmatter(head, body);
  const title = field(full, 'title') ?? path.split('/').pop()?.replace(/\.mdx?$/, '') ?? '';
  const status = field(full, 'status');

  const toggleStatus = () => {
    const change = setField(full, 'status', status === 'complete' ? 'draft' : 'complete');
    const next = full.slice(0, change.from) + change.insert + full.slice(change.to);
    edit(splitFrontmatter(next), true);
  };

  const note = {
    saved: null,
    editing: null,
    offline: 'Not saved yet: your Mac is offline. Your edits are kept on this phone.',
    error: 'Couldn’t save. Your edits are kept on this phone.',
  }[save];

  return (
    <>
      <Stack.Title>{title}</Stack.Title>
      {head !== null && (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon={status === 'complete' ? 'checkmark.circle.fill' : 'circle'}
            accessibilityLabel={status === 'complete' ? 'Complete. Mark as draft' : 'Draft. Mark as complete'}
            onPress={toggleStatus}
          />
        </Stack.Toolbar>
      )}
      {head === null ? (
        <View style={[styles.center, { backgroundColor: theme.background }]}>
          {error ? <Text style={[styles.note, { color: theme.muted }]}>{error}</Text> : <ActivityIndicator />}
        </View>
      ) : (
        <ScrollView
          automaticallyAdjustKeyboardInsets
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
          style={{ backgroundColor: theme.background }}
          contentContainerStyle={styles.content}
        >
          {note && <Text style={[styles.note, { color: save === 'error' ? theme.danger : theme.muted }]}>{note}</Text>}
          <TextInput
            value={body}
            onChangeText={(text) => edit({ body: text })}
            multiline
            scrollEnabled={false}
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
  body: { fontFamily: fonts.serif, fontSize: 19, lineHeight: 29, padding: 0, minHeight: 300 },
});
