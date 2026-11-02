import { Offline, type Remote, Unpaired } from '@kintsugi/core/remote';
import { randomUUID } from 'expo-crypto';
import { router, Stack, useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { WritingList } from '@/components/WritingList';
import { syncInspiration, useInspiration } from '@/lib/clip-library';
import type { Filter } from '@/lib/browse';
import { captureTarget } from '@/lib/capture-input';
import { library, useLibrary } from '@/lib/documents';
import { unsent } from '@/lib/library';
import { capture, heldForMacUpdate, outboxWarning, refreshOutbox, send, useOutbox } from '@/lib/outbox';
import { usePairing } from '@/lib/pairing';
import { syncSections, useFeed, useIdeas } from '@/lib/sections-store';
import { setNewEditor, useNewEditor } from '@/lib/settings';
import { fonts, useTheme } from '@/theme';

/** Open where the owner left off, once per launch. */
let restored = false;

/** The capture button says where the text goes: a URL or a bare ISBN is
 *  inspiration (a book for an ISBN); anything else goes to the inbox. */
function saveLabel(text: string): string {
  const target = captureTarget(text);
  return !target ? 'Save to inbox' : target.kind === 'book' ? 'Save book' : 'Save inspiration';
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export function Home({ client, linked }: { client: Remote; linked?: Filter | null }) {
  const theme = useTheme();
  const { unpair, pairing } = usePairing();
  const outbox = useOutbox();
  const { docs, connection } = useLibrary();
  const [vaultName, setVaultName] = useState(library.vaultName ?? 'Kintsugi');
  const [api, setApi] = useState(0);
  // PDFs and EPUBs wait, still queued, for a Mac that takes files (API 4).
  const held = heldForMacUpdate(outbox, api);
  const waiting = outbox.filter((item) => !item.error && !held.includes(item));
  const rejected = outbox.filter((item) => item.error);
  const [problem, setProblem] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const captureDraft = useRef<{ text: string; id: string } | null>(null);
  const [query, setQuery] = useState('');
  const newEditor = useNewEditor();
  const clipCount = useInspiration().clips.length;
  const feedCount = useFeed().items.length;
  const ideaCount = useIdeas().ideas.filter((i) => !i.dismissed && i.stage !== 'faded').length;

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
      // The clip cards and their images are kept for browsing offline. A
      // failure here (a note edit still waiting) shows in Inspiration.
      await syncInspiration(client, hello.api).catch((e) => {
        if (e instanceof Unpaired) throw e;
      });
      // Kin's messages, Feed actions and Ideas waiting here go, and the
      // copies kept for offline catch up (API 6).
      await syncSections(client, hello.api);
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
      const target = captureTarget(text);
      if (target && captureDraft.current?.text !== text) {
        captureDraft.current = { text, id: randomUUID() };
      }
      if (target) {
        // A URL or a bare ISBN (a book). An uncertain disk-write failure
        // followed by Save again is still the same capture, not a new UUID
        // and a possible duplicate on the Mac.
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

  const edits = docs.filter((d) => unsent(d) && !d.conflict).length;
  const conflicts = docs.filter((d) => d.conflict).length;
  const pending = [
    edits && plural(edits, 'edit', 'edits'),
    waiting.length && plural(waiting.length, 'capture', 'captures'),
  ].filter(Boolean).join(' and ');
  const status =
    connection === 'offline'
      ? `Your Mac is offline${pending ? `. ${pending} waiting` : ''}.`
      : problem ?? (pending ? `Sending ${pending}…` : null);

  return (
    <>
      <Stack.Title large>{vaultName}</Stack.Title>
      <Stack.SearchBar placeholder="Find a document" onChangeText={(e) => setQuery(e.nativeEvent.text)} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="square.and.pencil" accessibilityLabel="New note" onPress={newNote} />
        <Stack.Toolbar.Menu icon="ellipsis.circle">
          <Stack.Toolbar.MenuAction
            icon="character.cursor.ibeam"
            isOn={newEditor}
            onPress={() => setNewEditor(!newEditor)}
          >
            New editor
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="iphone.slash"
            destructive
            onPress={() =>
              Alert.alert('Unpair this phone?', undefined, [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Unpair', style: 'destructive', onPress: unpair },
              ])
            }
          >
            Unpair this phone
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <WritingList
        dir=""
        rootName={vaultName}
        query={query}
        linked={linked}
        refreshing={refreshing}
        onRefresh={refresh}
        empty={connection === 'unknown' ? 'Fetching from your Mac…' : 'No documents yet.'}
        header={
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
                    {saving ? 'Saving…' : saveLabel(note)}
                  </Text>
                </Pressable>
              )}
            </View>
            <View style={[styles.places, { backgroundColor: theme.surface }]}>
              <Place
                icon="dot.radiowaves.up.forward"
                title="Feed"
                count={feedCount}
                label={`Feed, ${plural(feedCount, 'item', 'items')}`}
                testID="open-feed"
                onPress={() => router.push('/feed')}
              />
              <Place
                icon="sparkles"
                title="Inspiration"
                count={clipCount}
                label={`Inspiration, ${plural(clipCount, 'clip', 'clips')}`}
                testID="open-inspiration"
                onPress={() => router.push('/inspiration')}
              />
              <Place
                icon="lightbulb"
                title="Ideas"
                count={ideaCount}
                label={`Ideas, ${plural(ideaCount, 'idea', 'ideas')}`}
                testID="open-ideas"
                onPress={() => router.push('/ideas')}
              />
            </View>
            {api > 0 && api < 2 && (
              <Text style={[styles.status, { color: theme.muted }]}>Update Kintsugi on your Mac to send inspiration clips.</Text>
            )}
            {api >= 2 && held.length > 0 && (
              <Text style={[styles.status, { color: theme.muted }]}>
                Update Kintsugi on your Mac to send files. {held.length === 1 ? 'A PDF or EPUB is' : `${held.length} PDFs or EPUBs are`}{' '}
                waiting on this phone.
              </Text>
            )}
            {rejected.length > 0 && (
              <Text style={[styles.status, { color: theme.danger }]}>
                {rejected.length} capture(s) couldn’t be sent and won’t retry. They’re kept on this phone.
              </Text>
            )}
            {outboxWarning && <Text style={[styles.status, { color: theme.danger }]}>{outboxWarning}</Text>}
            {status && <Text style={[styles.status, { color: theme.muted }]}>{status}</Text>}
            {conflicts > 0 && (
              <Text style={[styles.status, { color: theme.danger }]}>
                {plural(conflicts, 'document', 'documents')} changed on your Mac too. Open {conflicts === 1 ? 'it' : 'them'} to choose.
              </Text>
            )}
          </View>
        }
      />
    </>
  );
}

/** One of the places beside the writing: Feed, Inspiration, Ideas. */
function Place({ icon, title, count, label, testID, onPress }: { icon: string; title: string; count: number; label: string; testID: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.border : 'transparent' }]}
    >
      <SymbolView name={icon as never} size={17} tintColor={theme.muted} />
      <Text style={[styles.rowTitle, { color: theme.text }]}>{title}</Text>
      {count > 0 && <Text style={[styles.rowNote, { color: theme.faint }]}>{count}</Text>}
      <SymbolView name="chevron.right" size={13} tintColor={theme.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  places: { borderRadius: 12, overflow: 'hidden' },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, gap: 10 },
  capture: { borderRadius: 14, padding: 12, gap: 10 },
  captureInput: { fontFamily: fonts.serif, fontSize: 18, lineHeight: 25, minHeight: 50, maxHeight: 200, padding: 0 },
  captureButton: { alignSelf: 'flex-end', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  captureButtonText: { fontSize: 15, fontWeight: '600' },
  status: { fontSize: 14, lineHeight: 19, paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  rowTitle: { flex: 1, fontSize: 17 },
  rowNote: { fontSize: 15 },
});
