import { Unpaired } from '@kintsugi/core/remote';
import type { Surface } from '@kintsugi/core/sections';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useSendWhenWaiting } from '@/components/Toast';
import { ago } from '@/lib/feed';
import { usePairing } from '@/lib/pairing';
import { useScreenContext } from '@/lib/screen-context';
import { feed, syncSection, useFeed } from '@/lib/sections-store';
import { fonts, useTheme } from '@/theme';

/** Reading one Feed item. Opening it is an `open` for ranking; the Mac
 *  fetches the whole article when the feed only had an excerpt, and the
 *  phone keeps it to read again offline. */
export default function FeedItemScreen() {
  const params = useLocalSearchParams<{ id: string; surface?: Surface; position?: string }>();
  const id = Number(params.id);
  const place = { surface: params.surface === 'picked' ? ('picked' as const) : ('newest' as const), position: Number(params.position ?? 0) };
  const theme = useTheme();
  const { client, unpair } = usePairing();
  const snapshot = useFeed();
  const item = snapshot.items.find((i) => i.id === id) ?? snapshot.picks.find((p) => p.id === id)?.item ?? null;
  const [text, setText] = useState<string | null>(() => feed.text(id));
  const [note, setNote] = useState(item?.note ?? '');
  useScreenContext(item ? [{ kind: 'feed', path: String(id), label: item.title ?? 'Feed item' }] : null);

  useEffect(() => {
    if (!client) return;
    feed.read(client, id, place).then(
      (read) => setText(read ?? feed.text(id)),
      (e: unknown) => e instanceof Unpaired && unpair(),
    );
    // Once, when opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, id]);

  const send = useCallback(async () => {
    if (!client) return;
    try {
      await syncSection(client, 'feed');
    } catch (e) {
      if (e instanceof Unpaired) unpair();
    }
  }, [client, unpair]);
  useSendWhenWaiting(snapshot.waiting, send);
  // A note goes once he pauses typing.
  const [typed, setTyped] = useState(0);
  useEffect(() => {
    if (!typed) return;
    const timer = setTimeout(() => void send(), 800);
    return () => clearTimeout(timer);
  }, [typed, send]);

  if (!item) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background }]}>
        <Stack.Title>{''}</Stack.Title>
        <Text style={{ color: theme.muted }}>This item isn’t in the Feed any more.</Text>
      </View>
    );
  }

  const saved = item.savedPath !== null;
  const conflict = snapshot.conflicts[id];
  const offline = snapshot.connection === 'offline';
  const paragraphs = (text ?? item.summary ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const discuss = () => {
    feed.act(id, 'discuss', place);
    router.push({ pathname: '/kin', params: { chips: JSON.stringify([{ kind: 'feed', path: String(id), label: item.title ?? 'Feed item' }]) } });
  };

  return (
    <>
      <Stack.Title>{item.sourceTitle ?? 'Feed'}</Stack.Title>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.content}
      >
        <Text style={[styles.meta, { color: theme.muted }]}>
          {[item.sourceTitle, item.author, ago(item.publishedAt ?? item.sortAt)].filter(Boolean).join(' · ')}
        </Text>
        <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">
          {item.title || 'Untitled'}
        </Text>

        <View style={styles.actions}>
          <Action
            icon={item.liked ? 'heart.fill' : 'heart'}
            label={item.liked ? 'Liked' : 'Like'}
            tint={item.liked ? theme.danger : undefined}
            onPress={() => feed.act(id, item.liked ? 'unlike' : 'like', place)}
          />
          <Action
            icon={saved ? 'checkmark.circle.fill' : 'square.and.arrow.down'}
            label={saved ? (item.savedPath ? 'Saved' : 'Saving…') : 'Save'}
            disabled={saved}
            onPress={() => feed.save(id, place)}
          />
          <Action icon="bubble.left.and.text.bubble.right" label="Discuss" onPress={discuss} />
          {item.url && (
            <Action
              icon="arrow.up.right"
              label="Original"
              onPress={() => {
                feed.act(id, 'openOriginal', place);
                Linking.openURL(item.url!).catch(() => {});
              }}
            />
          )}
        </View>
        {item.waiting && offline && (
          <Text style={[styles.small, { color: theme.muted }]}>Kept on this phone. It goes to your Mac when it’s reachable.</Text>
        )}
        {saved && item.savedPath && <Text style={[styles.small, { color: theme.muted }]}>In Inspiration. Its note is edited there now.</Text>}

        <Text style={[styles.label, { color: theme.faint }]}>Your note</Text>
        {conflict ? (
          <View style={[styles.conflict, { backgroundColor: theme.surface }]}>
            <Text style={[styles.body, { color: theme.text }]}>
              This note was changed on your Mac too. Which should stay?
            </Text>
            <Text style={[styles.small, { color: theme.muted }]}>Mac: {conflict.theirs || '(empty)'}</Text>
            <Text style={[styles.small, { color: theme.muted }]}>This phone: {conflict.mine || '(empty)'}</Text>
            <View style={styles.choices}>
              <Pressable onPress={() => (feed.resolve(id, 'theirs'), setNote(conflict.theirs))} style={[styles.choice, { borderColor: theme.border }]}>
                <Text style={{ color: theme.text, fontWeight: '600' }}>Use the Mac’s</Text>
              </Pressable>
              <Pressable onPress={() => feed.resolve(id, 'mine')} style={[styles.choice, { backgroundColor: theme.primary, borderColor: theme.primary }]}>
                <Text style={{ color: theme.onPrimary, fontWeight: '600' }}>Keep this phone’s</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <TextInput
            value={note}
            editable={!saved}
            onChangeText={(next) => {
              setNote(next);
              feed.note(id, next, place);
              setTyped((n) => n + 1);
            }}
            placeholder={saved ? '' : 'A thought about this…'}
            placeholderTextColor={theme.faint}
            multiline
            accessibilityLabel="Your note"
            testID="feed-note"
            style={[styles.note, { color: theme.text, backgroundColor: theme.surface }]}
          />
        )}

        <View style={[styles.rule, { backgroundColor: theme.border }]} />
        {paragraphs.length ? (
          paragraphs.map((p, i) => (
            <Text key={i} selectable style={[styles.body, { color: theme.text }]}>
              {p}
            </Text>
          ))
        ) : (
          <Text style={[styles.small, { color: theme.muted }]}>
            {offline ? 'The text is on your Mac. It opens here when your Mac is reachable.' : 'Loading…'}
          </Text>
        )}

        <Pressable
          accessibilityRole="button"
          onPress={() => {
            feed.act(id, 'notInterested', place);
            router.back();
          }}
          style={styles.notInterested}
        >
          <Text style={[styles.small, { color: theme.muted }]}>Not interested</Text>
        </Pressable>
      </ScrollView>
    </>
  );
}

function Action({ icon, label, onPress, tint, disabled }: { icon: string; label: string; onPress: () => void; tint?: string; disabled?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.action, { backgroundColor: theme.surface, opacity: pressed ? 0.6 : 1 }]}
    >
      <SymbolView name={icon as never} size={16} tintColor={tint ?? theme.text} />
      <Text style={[styles.actionText, { color: theme.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 160, gap: 12 },
  meta: { fontSize: 13 },
  title: { fontFamily: fonts.serif, fontSize: 28, lineHeight: 34 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 },
  actionText: { fontSize: 14, fontWeight: '500' },
  small: { fontSize: 13, lineHeight: 18 },
  label: { fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 8 },
  note: { fontFamily: fonts.serif, fontSize: 17, lineHeight: 24, borderRadius: 12, padding: 12, minHeight: 70 },
  conflict: { borderRadius: 12, padding: 12, gap: 8 },
  choices: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  choice: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 7 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 8 },
  body: { fontFamily: fonts.serif, fontSize: 18, lineHeight: 28 },
  notInterested: { alignSelf: 'center', paddingVertical: 20 },
});
