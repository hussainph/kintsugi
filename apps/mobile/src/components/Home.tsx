import { field } from '@kintsugi/core/frontmatter';
import { Offline, type Remote, Unpaired } from '@kintsugi/core/remote';
import { randomUUID } from 'expo-crypto';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Pressable, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';

import { StatusDot } from '@/components/StatusDot';
import { captureURL } from '@/lib/capture-input';
import { library, useLibrary } from '@/lib/documents';
import { docTitle, type LocalDoc, unsent } from '@/lib/library';
import { capture, outboxWarning, refreshOutbox, send, useOutbox } from '@/lib/outbox';
import { usePairing } from '@/lib/pairing';
import { fonts, useTheme } from '@/theme';

type Row = LocalDoc & { title: string };
type Section = { title: string; data: Row[] };

/** One section per folder that has documents, the vault root first. */
function sections(docs: LocalDoc[], vaultName: string): Section[] {
  const folders = new Map<string, Row[]>();
  for (const doc of docs) {
    const folder = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : '';
    folders.set(folder, [...(folders.get(folder) ?? []), { ...doc, title: docTitle(doc) }]);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  return [...folders]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : byName(a, b)))
    .map(([folder, rows]) => ({
      title: folder || vaultName,
      data: rows.sort((a, b) => byName(a.path.split('/').pop()!, b.path.split('/').pop()!)),
    }));
}

/** Open where the owner left off, once per launch. */
let restored = false;

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export function Home({ client }: { client: Remote }) {
  const theme = useTheme();
  const { unpair, pairing } = usePairing();
  const outbox = useOutbox();
  const waiting = outbox.filter((item) => !item.error);
  const rejected = outbox.filter((item) => item.error);
  const { docs, connection } = useLibrary();
  const [vaultName, setVaultName] = useState(library.vaultName ?? 'Kintsugi');
  const [api, setApi] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const captureDraft = useRef<{ text: string; id: string } | null>(null);
  const [query, setQuery] = useState('');

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof Unpaired) {
        Alert.alert('Pair again', e.message);
        return unpair();
      }
      setProblem(e instanceof Offline ? null : e instanceof Error ? e.message : String(e));
    },
    [unpair],
  );

  const load = useCallback(async () => {
    try {
      await refreshOutbox();
      // The phone's copy catches up, and edits made away from the Mac go.
      // First, so an unreachable Mac shows as offline straight away.
      await library.sync(client);
      const hello = await client.hello();
      setVaultName(hello.vault);
      library.vaultName = hello.vault;
      setApi(hello.api);
      // Anything captured while the Mac was away goes now.
      if (pairing) await send(client, hello.api);
      setProblem(null);
    } catch (e) {
      fail(e);
    }
  }, [client, fail, pairing]);

  useEffect(() => {
    if (restored) return;
    restored = true;
    const last = library.last;
    if (last) router.push({ pathname: '/doc', params: { path: last } });
  }, []);

  const newNote = () => router.push({ pathname: '/doc', params: { path: library.create() } });

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => state === 'active' && load());
    // Also retry while the app stays open, including expired upload claims.
    const timer = setInterval(() => AppState.currentState === 'active' && load(), 30_000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const save = async () => {
    const text = note.trim();
    if (!text || saving || !pairing) return;
    setSaving(true);
    try {
      if (captureURL(text) && captureDraft.current?.text !== text) {
        captureDraft.current = { text, id: randomUUID() };
      }
      if (captureURL(text)) {
        // An uncertain disk-write failure followed by Save again is still the
        // same URL capture, not a new UUID and a possible duplicate on the Mac.
        await capture(text, captureDraft.current?.text === text ? captureDraft.current.id : undefined);
        captureDraft.current = null;
        setNote('');
        send(client, api).catch(fail);
      } else {
        // A note is just a document: it is in the list at once, and goes to
        // the Mac's inbox when it's reachable.
        library.create(text);
        setNote('');
        library.sync(client).catch(fail);
      }
    } catch (error) {
      Alert.alert('Couldn’t save on this phone', String(error));
    } finally {
      setSaving(false);
    }
  };

  const list = useMemo(() => {
    const all = sections(docs, vaultName);
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all
      .map((s) => ({ ...s, data: s.data.filter((d) => d.title.toLowerCase().includes(q)) }))
      .filter((s) => s.data.length);
  }, [docs, vaultName, query]);

  const edits = docs.filter((d) => unsent(d) && !d.conflict).length;
  const conflicts = docs.filter((d) => d.conflict).length;
  const pending = [
    edits && plural(edits, 'edit', 'edits'),
    waiting.length && plural(waiting.length, 'capture', 'captures'),
  ].filter(Boolean).join(' and ');
  const status =
    connection === 'offline'
      ? `Your Mac is offline. Your writing is on this phone${pending ? `; ${pending} will go when it’s back` : ''}.`
      : problem ?? (pending ? `Sending ${pending}…` : null);

  return (
    <>
      <Stack.Title large>{vaultName}</Stack.Title>
      <Stack.SearchBar placeholder="Find a document" onChangeText={(e) => setQuery(e.nativeEvent.text)} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="square.and.pencil" accessibilityLabel="New note" onPress={newNote} />
        <Stack.Toolbar.Menu icon="ellipsis.circle">
          <Stack.Toolbar.MenuAction
            icon="iphone.slash"
            destructive
            onPress={() =>
              Alert.alert('Unpair this phone?', 'You can pair again from Kintsugi on your Mac.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Unpair', style: 'destructive', onPress: unpair },
              ])
            }
          >
            Unpair this phone
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <SectionList
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: theme.background }}
        sections={list}
        keyExtractor={(doc) => doc.path}
        refreshing={refreshing}
        onRefresh={refresh}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={[styles.capture, { backgroundColor: theme.surface }]}>
              <TextInput
                value={note}
                onChangeText={setNote}
                editable={!saving}
                placeholder="Capture an idea…"
                placeholderTextColor={theme.faint}
                multiline
                style={[styles.captureInput, { color: theme.text }]}
              />
              {note.trim() !== '' && (
                <Pressable disabled={saving} onPress={save} style={[styles.captureButton, { backgroundColor: theme.primary }]}>
                  <Text style={[styles.captureButtonText, { color: theme.onPrimary }]}>
                    {saving ? 'Saving…' : captureURL(note) ? 'Save inspiration' : 'Save to inbox'}
                  </Text>
                </Pressable>
              )}
            </View>
            {api > 0 && api < 2 && (
              <Text style={[styles.status, { color: theme.muted }]}>Update Kintsugi on your Mac to send inspiration clips.</Text>
            )}
            {rejected.length > 0 && (
              <Text style={[styles.status, { color: theme.danger }]}>
                {rejected.length} capture(s) couldn’t be sent. Their contents are kept on this phone; they won’t retry automatically.
              </Text>
            )}
            {outboxWarning && <Text style={[styles.status, { color: theme.danger }]}>{outboxWarning}</Text>}
            {status && <Text style={[styles.status, { color: theme.muted }]}>{status}</Text>}
            {conflicts > 0 && (
              <Text style={[styles.status, { color: theme.danger }]}>
                {plural(conflicts, 'document was', 'documents were')} changed on your Mac and here in the same place. Open{' '}
                {conflicts === 1 ? 'it' : 'them'} to choose which version stays.
              </Text>
            )}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionTitle, { color: theme.muted }]}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push({ pathname: '/doc', params: { path: item.path } })}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
          >
            <StatusDot status={field(item.text, 'status')} />
            <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.text }]}>
              {item.title}
            </Text>
            {item.conflict ? (
              <Text style={[styles.rowNote, { color: theme.danger }]}>Choose</Text>
            ) : unsent(item) ? (
              <Text style={[styles.rowNote, { color: theme.faint }]}>Not sent</Text>
            ) : null}
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={[styles.status, { color: theme.muted }]}>
            {query
              ? 'Nothing matches.'
              : connection === 'unknown'
                ? 'Fetching your writing from your Mac…'
                : 'No documents yet. Start a note above.'}
          </Text>
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, gap: 10 },
  capture: { borderRadius: 14, padding: 12, gap: 10 },
  captureInput: { fontFamily: fonts.serif, fontSize: 18, lineHeight: 25, minHeight: 50, maxHeight: 200, padding: 0 },
  captureButton: { alignSelf: 'flex-end', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  captureButtonText: { fontSize: 15, fontWeight: '600' },
  status: { fontSize: 14, lineHeight: 19, paddingHorizontal: 4 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  rowTitle: { flex: 1, fontSize: 17 },
  rowNote: { fontSize: 13 },
});
