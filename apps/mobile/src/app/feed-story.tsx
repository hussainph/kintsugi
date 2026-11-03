import { STORIES_API, Unpaired } from '@kintsugi/core/remote';
import type { Place, Surface } from '@kintsugi/core/sections';
import { Link, router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { bySource, discussItem, FeedActions, FeedImage, FeedLinkTarget, FeedSources, itemRoute, openOriginal, SourceIcon } from '@/components/FeedParts';
import { Toast, useSendWhenWaiting } from '@/components/Toast';
import { summaryStateLine, type LocalItem } from '@/lib/feed';
import { usePairing } from '@/lib/pairing';
import { useScreenContext } from '@/lib/screen-context';
import { feed, syncSection, useFeed, useMacApi } from '@/lib/sections-store';
import { fonts, useTheme } from '@/theme';

/** Kin's cited summary, then one compact strip of the original articles. */
export default function FeedStoryScreen() {
  const params = useLocalSearchParams<{ id: string; surface?: Surface; position?: string }>();
  const id = Number(params.id);
  const place: Place = { surface: params.surface === 'picked' ? 'picked' : 'newest', position: Number(params.position ?? 0) };
  const theme = useTheme();
  const { client, unpair } = usePairing();
  const api = useMacApi();
  const snapshot = useFeed();
  const story = feed.story(id);
  const [hidden, setHidden] = useState<number[] | null>(null);
  useScreenContext(story ? story.items.map((i) => ({ kind: 'feed', path: String(i.id), label: i.title ?? 'Feed item' })) : null);

  const send = useCallback(async () => {
    if (!client) return;
    try { await syncSection(client, 'feed'); } catch (e) { if (e instanceof Unpaired) unpair(); }
  }, [client, unpair]);
  useSendWhenWaiting(snapshot.waiting, send);
  useEffect(() => { void send(); }, [send]);
  useEffect(() => {
    if (!client || api < STORIES_API) return;
    feed.readStory(client, id).then((s) => {
      // Opening a story is an open on its lead; its sources stay individual items.
      if (s) return feed.read(client, s.lead.id, place);
    }).catch((e: unknown) => { if (e instanceof Unpaired) unpair(); });
    // Only when this story opens, not when a local action updates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, id, api]);
  // A pending summary is completed on the Mac; pick it up without reopening.
  const pending = story?.summaryState === 'pending';
  useFocusEffect(useCallback(() => {
    if (!pending || !client || api < STORIES_API || snapshot.connection === 'offline') return;
    const timer = setInterval(() => { void feed.readStory(client, id).catch((e: unknown) => { if (e instanceof Unpaired) unpair(); }); }, 4_000);
    return () => clearInterval(timer);
  }, [pending, client, id, api, snapshot.connection, unpair]));

  if (!story) return (
    <View style={[styles.center, { backgroundColor: theme.background }]}>
      <Stack.Title>{''}</Stack.Title>
      <Text style={{ color: theme.muted }}>{snapshot.connection === 'offline' ? 'This story isn’t on this phone.' : snapshot.problem ? 'This story isn’t in the Feed any more.' : 'Loading…'}</Text>
    </View>
  );
  const pick = snapshot.picks.find((p) => p.story?.id === id);
  const ready = story.summaryState === 'ready' && story.summary;
  // Tiles keep each source's articles together; citation numbers follow them.
  const articles = bySource(story.items, story.sources);
  const dismiss = (ids: number[]) => { feed.dismiss(ids, false, place); setHidden(ids); };
  return (
    <>
      <Stack.Title>{''}</Stack.Title>
      <Stack.Screen.BackButton displayMode="minimal" />
      <Stack.Toolbar placement="right" asChild>
        <View style={StyleSheet.flatten([styles.pill, { backgroundColor: theme.surface }])}><FeedActions item={story.lead} place={place} reasons={pick?.reasons} whyId={pick?.id ?? story.lead.id} related={story.items} discuss /></View>
      </Stack.Toolbar>
      <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: theme.background }} contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>{story.title}</Text>
        <FeedSources item={story.lead} story={story} count />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip} contentContainerStyle={styles.tiles}>
          {articles.map((item) => <SourceTile key={item.id} item={item} place={place} onDismiss={() => dismiss([item.id])} />)}
        </ScrollView>
        {(snapshot.connection === 'offline' || snapshot.problem) && <Text style={[styles.state, { color: theme.muted }]}>{snapshot.connection === 'offline' ? 'Your Mac is offline.' : snapshot.problem}</Text>}
        {ready ? story.summary!.paragraphs.map((paragraph, p) => (
          <Text key={p} selectable style={[styles.body, { color: theme.text }]}>
            {paragraph.map((sentence, s) => (
              <Text key={s}>{sentence.text}{sentence.cites.map((cite) => {
                const article = story.items.find((i) => i.id === cite);
                if (!article) return null;
                return <Text key={cite} accessibilityRole="link" accessibilityLabel={`Read ${article.sourceTitle ?? 'source'}: ${article.title ?? 'article'}`} onPress={() => router.push(itemRoute(cite, place))} style={[styles.cite, { color: theme.kinInk, backgroundColor: theme.surface }]}> {articles.indexOf(article) + 1} </Text>;
              })}{' '}</Text>
            ))}
          </Text>
        )) : (
          <>
            {story.lead.summary && <Text selectable style={[styles.body, { color: theme.text }]}>{story.lead.summary}</Text>}
            <Text style={[styles.state, { color: theme.muted }]}>{summaryStateLine(story.summaryState)}</Text>
          </>
        )}
      </ScrollView>
      {hidden && <Toast key={hidden.join(',')} text="Hidden from your Feed." onUndo={() => { feed.dismiss(hidden, true); setHidden(null); }} onClose={() => setHidden(null)} />}
    </>
  );
}

function SourceTile({ item, place, onDismiss }: { item: LocalItem; place: Place; onDismiss: () => void }) {
  const theme = useTheme();
  return (
    <FeedLinkTarget label={`${item.sourceTitle ?? 'Source'}. ${item.title ?? 'Untitled'}`} testID={`story-source-${item.id}`} open={() => router.push(itemRoute(item.id, place))} actions={[
      ...(item.url ? [{ label: 'Open', run: () => openOriginal(item, place) }] : []),
      { label: item.liked ? 'Unlike' : 'Like', run: () => feed.act(item.id, item.liked ? 'unlike' : 'like', place) },
      ...(item.savedPath === null ? [{ label: 'Save', run: () => feed.save(item.id, place) }, { label: 'Add note', run: () => router.push(itemRoute(item.id, place, true)) }] : []),
      { label: 'Discuss', run: () => discussItem(item, place) },
      { label: 'Not interested', run: onDismiss },
    ]}>
    <Link href={itemRoute(item.id, place)} asChild>
      <Link.Trigger>
        <Pressable accessibilityRole="button" accessibilityLabel={item.title ?? 'Read article'} testID={`story-source-${item.id}`} style={StyleSheet.flatten([styles.tile, { backgroundColor: theme.surface }])}>
          <View style={styles.tileWords}>
            <View style={styles.source}><SourceIcon title={item.sourceTitle} site={item.sourceSite} size={16} /><Text numberOfLines={1} style={[styles.sourceName, { color: theme.muted }]}>{item.sourceTitle}</Text></View>
            <Text numberOfLines={3} style={[styles.tileTitle, { color: theme.text }]}>{item.title ?? 'Untitled'}</Text>
          </View>
          <FeedImage uri={item.image} style={styles.tileImage} />
        </Pressable>
      </Link.Trigger>
      <Link.Menu>
        <Link.MenuAction title="Open" icon="arrow.up.right" disabled={!item.url} onPress={() => openOriginal(item, place)} />
        <Link.MenuAction title={item.liked ? 'Unlike' : 'Like'} icon="heart" onPress={() => feed.act(item.id, item.liked ? 'unlike' : 'like', place)} />
        <Link.MenuAction title={item.savedPath !== null ? 'Saved' : 'Save'} icon="bookmark" disabled={item.savedPath !== null} onPress={() => feed.save(item.id, place)} />
        <Link.MenuAction title="Add note" icon="pencil" disabled={item.savedPath !== null} onPress={() => router.push(itemRoute(item.id, place, true))} />
        <Link.MenuAction title="Discuss" icon="bubble.left" onPress={() => discussItem(item, place)} />
        <Link.MenuAction title="Not interested" icon="hand.thumbsdown" onPress={onDismiss} />
      </Link.Menu>
    </Link>
    </FeedLinkTarget>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 160, gap: 16 },
  title: { fontFamily: fonts.serif, fontWeight: '600', fontSize: 28, lineHeight: 34 },
  body: { fontFamily: fonts.serif, fontSize: 18, lineHeight: 28 },
  state: { fontSize: 13, lineHeight: 19 },
  cite: { fontSize: 12, fontWeight: '500' },
  pill: { flexDirection: 'row', borderRadius: 24, paddingHorizontal: 4 },
  strip: { marginHorizontal: -16, marginTop: 8 },
  tiles: { paddingHorizontal: 16, gap: 8 },
  tile: { width: 236, minHeight: 106, padding: 12, borderRadius: 10, flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  tileWords: { flex: 1, gap: 6 },
  source: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sourceName: { fontSize: 12, lineHeight: 16, flexShrink: 1 },
  tileTitle: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  tileImage: { width: 48, height: 48, borderRadius: 6 },
});
