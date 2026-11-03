import type { FeedItem, Place, Reason, StorySource } from '@kintsugi/core/sections';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState, type ReactNode } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View, type StyleProp, type ImageStyle } from 'react-native';

import { FeedWhy } from '@/components/FeedWhy';
import { ago, type LocalItem, type LocalStory } from '@/lib/feed';
import { feed } from '@/lib/sections-store';
import { useTheme } from '@/theme';

export const itemRoute = (id: number, place: Place, note = false) => ({
  pathname: '/feed-item' as const,
  params: { id: String(id), surface: place.surface, position: String(place.position), ...(note ? { note: '1' } : {}) },
});

export function discussItem(item: FeedItem, place: Place, related: FeedItem[] = [item]) {
  feed.act(item.id, 'discuss', place);
  router.push({ pathname: '/kin', params: { chips: JSON.stringify(related.map((i) => ({ kind: 'feed', path: String(i.id), label: i.title ?? 'Feed item' }))) } });
}

export function openOriginal(item: FeedItem, place: Place) {
  if (!item.url) return;
  feed.act(item.id, 'openOriginal', place);
  void Linking.openURL(item.url).catch(() => {});
}

/** Expo Router's native menu wrapper drops its trigger from the iOS 27
 * accessibility tree. Keep one explicit target outside it, with the same
 * actions available to VoiceOver, without adding visible tile controls. */
export function FeedLinkTarget({ label, testID, open, actions, children }: {
  label: string; testID: string; open: () => void;
  actions: { label: string; run: () => void }[]; children: ReactNode;
}) {
  return (
    <View accessible accessibilityRole="button" accessibilityLabel={label} testID={testID}
      onAccessibilityTap={open}
      accessibilityActions={[{ name: 'activate' }, ...actions.map((a, i) => ({ name: `action-${i}`, label: a.label }))]}
      onAccessibilityAction={(event) => {
        const name = event.nativeEvent.actionName;
        if (name === 'activate') open();
        else actions[Number(name.replace('action-', ''))]?.run();
      }}>
      {children}
    </View>
  );
}

/** No placeholder, including when an article's picture fails to load. */
export function FeedImage({ uri, style }: { uri: string | null; style: StyleProp<ImageStyle> }) {
  const [failed, setFailed] = useState<string | null>(null);
  return uri && failed !== uri ? <Image source={{ uri }} resizeMode="cover" style={style} onError={() => setFailed(uri)} /> : null;
}

export function SourceIcon({ title, site, size = 18 }: { title: string | null; site?: string | null; size?: number }) {
  const theme = useTheme();
  const [failed, setFailed] = useState(false);
  let icon: string | null = null;
  try {
    const url = new URL(site ?? '');
    if (url.protocol === 'https:' || url.protocol === 'http:') icon = `${url.origin}/favicon.ico`;
  } catch {}
  return (
    <View accessibilityElementsHidden style={[styles.icon, { width: size, height: size, borderRadius: size, backgroundColor: theme.primary, borderColor: theme.background }]}>
      {icon && !failed ? <Image source={{ uri: icon }} style={{ width: size, height: size }} onError={() => setFailed(true)} /> : (
        <Text style={{ fontSize: size * 0.55, fontWeight: '600', color: theme.onPrimary }}>{(title ?? '?').slice(0, 1)}</Text>
      )}
    </View>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "7 articles from 3 sources": counts are articles, names are sources. */
export function storyCount(sources: Pick<StorySource, 'items'>[]): string {
  const articles = sources.reduce((n, s) => n + (s.items ?? 1), 0);
  return `${plural(articles, 'article')} from ${plural(sources.length, 'source')}`;
}

/** A story's articles with each source's together, most covered first. */
export function bySource<T extends { sourceId: number }>(items: T[], sources: { id: number }[]): T[] {
  const order = new Map(sources.map((s, i) => [s.id, i]));
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (order.get(a.item.sourceId) ?? 99) - (order.get(b.item.sourceId) ?? 99) || a.i - b.i)
    .map(({ item }) => item);
}

/** Who covered it: one or two sources by name, else the count; the story page always counts. */
export function FeedSources({ item, story, count = false }: { item: FeedItem; story?: LocalStory; count?: boolean }) {
  const theme = useTheme();
  const sources: Pick<StorySource, 'id' | 'title' | 'site' | 'items'>[] = story?.sources ?? [{ id: item.sourceId, title: item.sourceTitle, site: item.sourceSite ?? null, items: 1 }];
  const label = story && (count || sources.length > 2) ? storyCount(sources) : sources.map((s) => s.title).filter(Boolean).join(', ');
  return (
    <View style={styles.sources}>
      <View style={styles.stack}>
        {sources.slice(0, 3).map((s, i) => <View key={s.id} style={{ marginLeft: i ? -5 : 0 }}><SourceIcon title={s.title} site={s.site} /></View>)}
      </View>
      <Text style={[styles.meta, { color: theme.muted }]} numberOfLines={1}>{[label, ago(story?.sortAt ?? item.publishedAt ?? item.sortAt)].filter(Boolean).join(' · ')}</Text>
    </View>
  );
}

/** The same icon actions in a card and in the story's header pill. */
export function FeedActions({ item, place, reasons, discuss = false, whyId = item.id, related }: { item: LocalItem; place: Place; reasons?: Reason[]; discuss?: boolean; whyId?: number; related?: FeedItem[] }) {
  const theme = useTheme();
  const saved = item.savedPath !== null;
  return (
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel={item.liked ? 'Unlike' : 'Like'} accessibilityState={{ selected: item.liked }} onPress={() => feed.act(item.id, item.liked ? 'unlike' : 'like', place)} style={styles.button}>
        <SymbolView name={item.liked ? 'heart.fill' : 'heart'} size={19} tintColor={item.liked ? theme.danger : theme.muted} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={saved ? 'Saved' : 'Save'} disabled={saved} onPress={() => feed.save(item.id, place)} style={styles.button}>
        <SymbolView name={saved ? 'bookmark.fill' : 'bookmark'} size={18} tintColor={saved ? theme.text : theme.muted} />
      </Pressable>
      {discuss && <Pressable accessibilityRole="button" accessibilityLabel="Discuss" onPress={() => discussItem(item, place, related)} style={styles.button}><SymbolView name="bubble.left" size={18} tintColor={theme.muted} /></Pressable>}
      <FeedWhy id={whyId} reasons={reasons} />
      {item.waiting && <SymbolView name="clock" size={12} tintColor={theme.faint} accessibilityLabel="Waiting for your Mac" />}
    </View>
  );
}

const styles = StyleSheet.create({
  sources: { flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7 },
  stack: { flexDirection: 'row' },
  icon: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: 1 },
  meta: { flexShrink: 1, fontSize: 12, lineHeight: 18 },
  actions: { flexDirection: 'row', alignItems: 'center' },
  button: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
});
