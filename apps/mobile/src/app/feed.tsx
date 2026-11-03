import { SECTIONS_API, Unpaired } from '@kintsugi/core/remote';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { FeedRow } from '@/components/FeedRow';
import { Toast, useSendWhenWaiting } from '@/components/Toast';
import type { LocalEntry } from '@/lib/feed';
import { usePairing } from '@/lib/pairing';
import { feed, OLD_MAC, syncSection, useFeed, useMacApi } from '@/lib/sections-store';
import { useTheme } from '@/theme';

const PICKS_SHOWN = 4;

/** The Feed on the phone: Picked for you, then everything newest first,
 *  from the phone's copy. Likes, notes, saves and Not interested go to the
 *  Mac (or wait for it), where ranking learns from them as from the Mac's own. */
export default function FeedScreen() {
  const theme = useTheme();
  const { client, unpair } = usePairing();
  const snapshot = useFeed();
  const api = useMacApi();
  const [refreshing, setRefreshing] = useState(false);
  const [more, setMore] = useState(false);
  const [hidden, setHidden] = useState<number[] | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      await syncSection(client, 'feed');
    } catch (e) {
      if (e instanceof Unpaired) unpair();
    }
  }, [client, unpair]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useSendWhenWaiting(snapshot.waiting, load);

  const picks = useMemo(() => snapshot.picks.slice(0, more ? undefined : PICKS_SHOWN), [snapshot.picks, more]);
  const newest = useMemo(() => {
    const pickIds = new Set(snapshot.picks.flatMap((p) => p.story ? p.story.items.map((i) => i.id) : [p.id]));
    return snapshot.entries.filter((e) => e.kind === 'story' ? !e.story.items.some((i) => pickIds.has(i.id)) : !pickIds.has(e.item.id));
  }, [snapshot]);

  // What was shown, for ranking (each once per launch).
  useEffect(() => {
    feed.saw([
      ...picks.map((p, position) => ({ id: p.id, position, surface: 'picked' as const })),
      ...newest.slice(0, 20).map((e, position) => ({ id: e.kind === 'story' ? e.story.lead.id : e.item.id, position, surface: 'newest' as const })),
    ]);
  }, [picks, newest]);

  const dismiss = (ids: number[], surface: 'picked' | 'newest', position: number) => {
    if (ids.length > 1) feed.dismiss(ids, false, { surface, position });
    else feed.act(ids[0], 'notInterested', { surface, position });
    setHidden(ids);
  };

  const status =
    api > 0 && api < SECTIONS_API
      ? OLD_MAC
      : snapshot.connection === 'offline'
        ? `Your Mac is offline${snapshot.waiting ? `. ${snapshot.waiting === 1 ? 'One action' : `${snapshot.waiting} actions`} waiting` : ''}.`
        : snapshot.problem;

  return (
    <>
      <Stack.Title large>Feed</Stack.Title>
      <Stack.Screen.BackButton displayMode="minimal" />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        {status && <Text style={[styles.status, { color: theme.muted }]}>{status}</Text>}
        {snapshot.picks.length > 0 && (
          <View>
            <Text style={[styles.heading, { color: theme.text }]}>Picked for you</Text>
            {picks.map((p, position) => (
              <FeedRow
                key={p.id}
                item={p.item}
                story={p.story}
                hero={position === 0}
                place={{ surface: 'picked', position }}
                reasons={p.reasons}
                onDismiss={(ids) => dismiss(ids, 'picked', position)}
              />
            ))}
            {snapshot.picks.length > PICKS_SHOWN && (
              <Pressable accessibilityRole="button" onPress={() => setMore(!more)} style={styles.more}>
                <Text style={[styles.moreText, { color: theme.muted }]}>{more ? 'Show fewer' : 'Show more'}</Text>
              </Pressable>
            )}
          </View>
        )}
        {newest.length > 0 && snapshot.picks.length > 0 && <Text style={[styles.heading, styles.newest, { color: theme.text }]}>Newest</Text>}
        {newest.length === 0 && snapshot.picks.length === 0 ? (
          <Text style={[styles.status, { color: theme.muted }]}>
            {snapshot.connection === 'unknown' ? 'Fetching from your Mac…' : 'Nothing new. Follow sources on your Mac.'}
          </Text>
        ) : (
          newest.map((entry: LocalEntry, position) => (
            <FeedRow key={entry.kind === 'story' ? `story-${entry.story.id}` : `item-${entry.item.id}`}
              item={entry.kind === 'story' ? entry.story.lead : entry.item} story={entry.kind === 'story' ? entry.story : undefined}
              hero={snapshot.picks.length === 0 && position === 0} place={{ surface: 'newest', position }} onDismiss={(ids) => dismiss(ids, 'newest', position)} />
          ))
        )}
      </ScrollView>
      {hidden !== null && (
        <Toast key={hidden.join(',')} text="Hidden from your Feed." onUndo={() => {
          if (hidden.length > 1) feed.dismiss(hidden, true);
          else feed.act(hidden[0], 'undoNotInterested');
          setHidden(null);
        }} onClose={() => setHidden(null)} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 160, gap: 6 },
  status: { fontSize: 14, lineHeight: 19, paddingHorizontal: 4, paddingVertical: 4 },
  heading: { fontSize: 17, fontWeight: '600' },
  newest: { marginTop: 18, paddingHorizontal: 4 },
  more: { paddingVertical: 12, alignItems: 'center' },
  moreText: { fontSize: 14 },
});
