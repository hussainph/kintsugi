import { Offline, Unpaired } from '@kintsugi/core/remote';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { cardHeight, ClipCard } from '@/components/ClipCard';
import { syncInspiration, useInspiration } from '@/lib/clip-library';
import { type LocalClip, searchClips } from '@/lib/inspiration';
import { usePairing } from '@/lib/pairing';
import { useTheme } from '@/theme';

const GAP = 12;
const PADDING = 16;

/** The Inspiration library on the phone: a grid of clip cards from the
 *  phone's own copy, so it browses and searches offline, catching up with
 *  the Mac whenever it's reachable. */
export default function InspirationScreen() {
  const theme = useTheme();
  const { client, unpair } = usePairing();
  const { clips, connection } = useInspiration();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { width } = useWindowDimensions();

  const load = useCallback(async () => {
    if (!client) return;
    try {
      await syncInspiration(client);
      setProblem(null);
    } catch (e) {
      if (e instanceof Unpaired) return unpair();
      setProblem(e instanceof Offline ? null : e instanceof Error ? e.message : String(e));
    }
  }, [client, unpair]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const found = useMemo(() => searchClips(clips, query), [clips, query]);
  // Two columns on a phone; more when it's unfolded or on an iPad.
  const count = Math.max(2, Math.floor((width - PADDING * 2 + GAP) / (180 + GAP)));
  const cardWidth = (width - PADDING * 2 - GAP * (count - 1)) / count;
  const columns = useMemo(() => masonry(found, count, cardWidth), [found, count, cardWidth]);

  const status = connection === 'offline' ? 'Your Mac is offline.' : problem;

  return (
    <>
      <Stack.Title large>Inspiration</Stack.Title>
      <Stack.SearchBar placeholder="Find a clip" onChangeText={(e) => setQuery(e.nativeEvent.text)} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
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
        {found.length === 0 ? (
          <Text style={[styles.empty, { color: theme.muted }]}>
            {query.trim()
              ? 'No clips match.'
              : connection === 'unknown'
                ? 'Fetching from your Mac…'
                : 'Nothing saved yet. Share a link to Kintsugi to add one.'}
          </Text>
        ) : (
          <View style={styles.grid}>
            {columns.map((column, i) => (
              <View key={i} style={[styles.column, { width: cardWidth }]}>
                {column.map((local) => (
                  <ClipCard
                    key={local.clip.path}
                    local={local}
                    width={cardWidth}
                    onPress={() => router.push({ pathname: '/clip', params: { path: local.clip.path } })}
                  />
                ))}
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </>
  );
}

/** Newest first, each card into the shortest column, as the Mac lays them out. */
function masonry(clips: LocalClip[], count: number, width: number): LocalClip[][] {
  const columns: LocalClip[][] = Array.from({ length: count }, () => []);
  const heights = Array<number>(count).fill(0);
  for (const clip of clips) {
    const shortest = heights.indexOf(Math.min(...heights));
    columns[shortest].push(clip);
    heights[shortest] += cardHeight(clip, width) + GAP;
  }
  return columns;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: PADDING, paddingTop: 8, paddingBottom: 40, gap: 12 },
  grid: { flexDirection: 'row', gap: GAP, alignItems: 'flex-start' },
  column: { gap: GAP },
  status: { fontSize: 14, lineHeight: 19, paddingHorizontal: 4 },
  empty: { fontSize: 14, lineHeight: 19, paddingHorizontal: 4, paddingTop: 16 },
});
