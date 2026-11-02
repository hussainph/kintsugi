import { clipLabel, clipSite } from '@kintsugi/core/clips';
import { SymbolView } from 'expo-symbols';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { LocalClip } from '@/lib/inspiration';
import { useThumbnail } from '@/lib/thumbnail-store';
import { fonts, useTheme } from '@/theme';

/** One clip in the Inspiration grid. Everything about how a card looks is in
 *  this file, so the shape the owner picks from the Lab's clip-shape
 *  exploration (KI-21: "A→B") can replace it in one place. Today's shape is
 *  the Mac library's card: image-forward when there's an image, the quote
 *  or note otherwise, with the site and title small beneath. */

/** The card's media/text block height; the label beneath adds LABEL. Fixed
 *  per clip so the grid doesn't jump while images arrive. */
export function cardHeight(local: LocalClip, width: number): number {
  const { clip } = local;
  const hash = [...clip.path].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  const body = clip.image
    ? Math.round(Math.min(260, width * [0.78, 1.08, 0.92, 1.24][hash % 4]))
    : Math.min(220, Math.max(120, 64 + Math.ceil((ownText(local) || clip.summary || '').length / 22) * 22));
  return body + LABEL;
}

const LABEL = 54;

/** The own text without its quote marks, as the card shows it. */
const ownText = (local: LocalClip) => (local.text ?? '').replace(/^> ?/gm, '').trim();

export function ClipCard({ local, width, onPress }: { local: LocalClip; width: number; onPress: () => void }) {
  const theme = useTheme();
  const { clip } = local;
  const uri = useThumbnail(clip);
  const own = ownText(local);
  const height = cardHeight(local, width) - LABEL;
  const icon = clip.kind === 'book' ? 'book' : clip.kind === 'document' ? 'doc.text' : clip.kind === 'quote' ? 'quote.opening' : 'arrow.up.right';
  const title = clip.title || (own ? own.split('\n')[0] : clipLabel(clip));
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${clipLabel(clip)}`}
      testID={`clip:${clip.path}`}
      style={({ pressed }) => [{ width, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={[styles.body, { height, backgroundColor: theme.surface }]}>
        {clip.image ? (
          uri ? (
            <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors />
          ) : (
            <View style={styles.placeholder}>
              <SymbolView name="photo" tintColor={theme.faint} size={22} />
            </View>
          )
        ) : own || clip.summary ? (
          <View style={styles.text}>
            {clip.kind === 'quote' && <SymbolView name="quote.opening" tintColor={theme.faint} size={14} />}
            <Text style={[styles.prose, { color: theme.text }]} numberOfLines={Math.max(2, Math.floor((height - 32) / 23))}>
              {own || clip.summary}
            </Text>
          </View>
        ) : (
          <View style={styles.text}>
            <SymbolView name={icon} tintColor={theme.faint} size={18} />
            <Text style={[styles.prose, styles.linkTitle, { color: theme.text }]} numberOfLines={3}>
              {clip.title || clipSite(clip)}
            </Text>
            <Text style={[styles.small, { color: theme.muted }]} numberOfLines={2}>
              {((clip.kind === 'book' || clip.kind === 'document') && clip.author) || clip.url || clip.file?.split('/').pop() || 'Saved for later'}
            </Text>
          </View>
        )}
      </View>
      <View style={styles.label}>
        <Text style={[styles.small, { color: theme.muted }]} numberOfLines={1}>
          {clipSite(clip)}
        </Text>
        <Text style={[styles.title, { color: theme.text }]} numberOfLines={2}>
          {title}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { borderRadius: 12, overflow: 'hidden' },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, justifyContent: 'center', gap: 8, padding: 14 },
  prose: { fontFamily: fonts.serif, fontSize: 16, lineHeight: 23 },
  linkTitle: { fontSize: 18, lineHeight: 23 },
  small: { fontSize: 11, lineHeight: 15 },
  label: { height: LABEL, paddingHorizontal: 2, paddingTop: 7, gap: 1 },
  title: { fontSize: 13, lineHeight: 17 },
});
