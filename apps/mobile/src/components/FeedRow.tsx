import type { Place, Reason } from '@kintsugi/core/sections';
import { Link, router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { discussItem, FeedActions, FeedImage, FeedLinkTarget, FeedSources, itemRoute } from '@/components/FeedParts';
import { type LocalItem, type LocalStory } from '@/lib/feed';
import { itemExcerpt } from '@/lib/feed-reader';
import { feed } from '@/lib/sections-store';
import { fonts, useTheme } from '@/theme';

/** The first pick is an editorial hero; the rest are compact, image-optional rows. */
export function FeedRow({ item, story, hero = false, place, reasons, onDismiss }: {
  item: LocalItem;
  story?: LocalStory;
  hero?: boolean;
  place: Place;
  reasons?: Reason[];
  onDismiss: (ids: number[]) => void;
}) {
  const theme = useTheme();
  const lead = story?.lead ?? item;
  const title = story?.title || item.title || itemExcerpt(item)?.slice(0, 80) || 'Untitled';
  const summary = story?.summary != null ? story.summary.paragraphs[0]?.map((s) => s.text).join(' ') : itemExcerpt(lead);
  const href = story ? { pathname: '/feed-story' as const, params: { id: String(story.id), surface: place.surface, position: String(place.position) } } : itemRoute(item.id, place);
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <FeedLinkTarget label={title} testID={story ? `feed-story-${story.id}` : `feed-item-${item.id}`} open={() => router.push(href)} actions={[
        { label: lead.liked ? 'Unlike' : 'Like', run: () => feed.act(lead.id, lead.liked ? 'unlike' : 'like', place) },
        ...(lead.savedPath === null ? [{ label: 'Save', run: () => feed.save(lead.id, place) }, { label: 'Add note', run: () => router.push(itemRoute(lead.id, place, true)) }] : []),
        { label: 'Discuss', run: () => discussItem(lead, place, story?.items) },
        { label: 'Not interested', run: () => onDismiss(story ? story.items.map((i) => i.id) : [item.id]) },
      ]}>
      <Link href={href} asChild>
        <Link.Trigger>
          <Pressable accessibilityRole="button" accessibilityLabel={title} testID={story ? `feed-story-${story.id}` : `feed-item-${item.id}`} style={hero ? styles.hero : styles.body}>
            {hero && <FeedImage uri={story?.image ?? item.image} style={styles.heroImage} />}
            <View style={[styles.words, !hero && styles.rowWords]}>
              <Text style={[hero ? styles.heroTitle : styles.title, { color: theme.text }]} numberOfLines={hero ? 4 : 3}>{title}</Text>
              {hero && summary && <Text style={[styles.summary, { color: theme.muted }]} numberOfLines={3}>{summary}</Text>}
            </View>
            {!hero && <FeedImage uri={story?.image ?? item.image} style={styles.thumbnail} />}
          </Pressable>
        </Link.Trigger>
        <Link.Menu>
          <Link.MenuAction title="Open" icon="arrow.up.right" onPress={() => router.push(href)} />
          <Link.MenuAction title={lead.liked ? 'Unlike' : 'Like'} icon="heart" onPress={() => feed.act(lead.id, lead.liked ? 'unlike' : 'like', place)} />
          <Link.MenuAction title={lead.savedPath !== null ? 'Saved' : 'Save'} icon="bookmark" disabled={lead.savedPath !== null} onPress={() => feed.save(lead.id, place)} />
          <Link.MenuAction title="Add note" icon="pencil" disabled={lead.savedPath !== null} onPress={() => router.push(itemRoute(lead.id, place, true))} />
          <Link.MenuAction title="Discuss" icon="bubble.left" onPress={() => discussItem(lead, place, story?.items)} />
          <Link.MenuAction title="Not interested" icon="hand.thumbsdown" onPress={() => onDismiss(story ? story.items.map((i) => i.id) : [item.id])} />
        </Link.Menu>
      </Link>
      </FeedLinkTarget>
      <View style={styles.footer}><FeedSources item={lead} story={story} /><FeedActions item={lead} place={place} reasons={reasons} whyId={item.id} /></View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, gap: 4 },
  body: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  hero: { gap: 10 },
  words: { gap: 7 },
  rowWords: { flex: 1 },
  title: { fontFamily: fonts.serif, fontSize: 20, lineHeight: 25 },
  heroTitle: { fontFamily: fonts.serif, fontWeight: '600', fontSize: 25, lineHeight: 30 },
  summary: { fontSize: 15, lineHeight: 21, marginTop: 4 },
  heroImage: { width: '100%', height: 200, borderRadius: 13 },
  thumbnail: { width: 76, height: 76, borderRadius: 10 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4 },
});
