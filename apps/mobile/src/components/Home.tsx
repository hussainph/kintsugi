import { Offline, type Remote, Unpaired } from '@kintsugi/core/remote';
import { displayName, type Doc, type Entry } from '@kintsugi/core/vault';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, AppState, Pressable, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';

import { StatusDot } from '@/components/StatusDot';
import { capture, send, useOutbox } from '@/lib/outbox';
import { usePairing } from '@/lib/pairing';
import { fonts, useTheme } from '@/theme';

type Connection = { state: 'connecting' | 'online' | 'offline' } | { state: 'error'; message: string };

type Section = { title: string; data: Doc[] };

/** One section per folder that has documents, the vault root first. */
function sections(entries: Entry[], vaultName: string): Section[] {
  const out: Section[] = [];
  const walk = (items: Entry[], title: string) => {
    const docs = items.filter((e): e is Doc => e.kind === 'doc');
    if (docs.length) out.push({ title, data: docs });
    for (const item of items) if (item.kind === 'folder') walk(item.children, item.path);
  };
  walk(entries, vaultName);
  return out;
}

export function Home({ client }: { client: Remote }) {
  const theme = useTheme();
  const { unpair } = usePairing();
  const waiting = useOutbox();
  const [tree, setTree] = useState<Entry[]>([]);
  const [vaultName, setVaultName] = useState('Kintsugi');
  const [connection, setConnection] = useState<Connection>({ state: 'connecting' });
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof Unpaired) {
        Alert.alert('Pair again', e.message);
        return unpair();
      }
      setConnection(e instanceof Offline ? { state: 'offline' } : { state: 'error', message: String(e) });
    },
    [unpair],
  );

  const load = useCallback(async () => {
    try {
      const [hello, next] = await Promise.all([client.hello(), client.tree()]);
      setVaultName(hello.vault);
      setTree(next);
      setConnection({ state: 'online' });
      // Anything captured while the Mac was away goes now.
      await send(client);
      setTree(await client.tree());
    } catch (e) {
      fail(e);
    }
  }, [client, fail]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => state === 'active' && load());
    return () => sub.remove();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const save = () => {
    const text = note.trim();
    if (!text) return;
    capture(text);
    setNote('');
    send(client)
      .then(() => client.tree().then(setTree))
      .catch(fail);
  };

  const list = useMemo(() => {
    const all = sections(tree, vaultName);
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all
      .map((s) => ({ ...s, data: s.data.filter((d) => displayName(d).toLowerCase().includes(q)) }))
      .filter((s) => s.data.length);
  }, [tree, vaultName, query]);

  const status =
    connection.state === 'offline'
      ? waiting.length
        ? `Your Mac is offline. ${waiting.length === 1 ? '1 note is' : `${waiting.length} notes are`} waiting to go.`
        : 'Your Mac is offline. Captures will wait here until it’s back.'
      : connection.state === 'error'
        ? connection.message
        : waiting.length
          ? `Sending ${waiting.length === 1 ? '1 note' : `${waiting.length} notes`}…`
          : null;

  return (
    <>
      <Stack.Title large>{vaultName}</Stack.Title>
      <Stack.SearchBar placeholder="Find a document" onChangeText={(e) => setQuery(e.nativeEvent.text)} />
      <Stack.Toolbar placement="right">
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
                placeholder="Capture an idea…"
                placeholderTextColor={theme.faint}
                multiline
                style={[styles.captureInput, { color: theme.text }]}
              />
              {note.trim() !== '' && (
                <Pressable onPress={save} style={[styles.captureButton, { backgroundColor: theme.primary }]}>
                  <Text style={[styles.captureButtonText, { color: theme.onPrimary }]}>Save to inbox</Text>
                </Pressable>
              )}
            </View>
            {status && <Text style={[styles.status, { color: theme.muted }]}>{status}</Text>}
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
            <StatusDot status={item.status} />
            <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.text }]}>
              {displayName(item)}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          connection.state === 'online' ? (
            <Text style={[styles.status, { color: theme.muted }]}>
              {query ? 'Nothing matches.' : 'No documents yet. Capture something above.'}
            </Text>
          ) : undefined
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
});
