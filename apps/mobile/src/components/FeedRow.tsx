import type { Place, Reason } from '@kintsugi/core/sections';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ago, type LocalItem } from '@/lib/feed';
import { feed } from '@/lib/sections-store';
import { fonts, useTheme } from '@/theme';

/** One Feed item in a list: title, source and age, a line of summary, and
 *  the quick actions (like, save, not interested). Tapping reads it. */
export function FeedRow({ item, place, reasons, explore, onDismiss }: {
  item: LocalItem;
  place: Place;
  /** Picked for you's "Why this?" */
  reasons?: Reason[];
  explore?: boolean;
  onDismiss: (id: number) => void;
}) {
  const theme = useTheme();
  const [why, setWhy] = useState(false);
  const saved = item.savedPath !== null;
  const title = item.title || item.summary?.slice(0, 80) || 'Untitled';
  const meta = [item.sourceTitle, item.author, ago(item.publishedAt ?? item.sortAt)].filter(Boolean).join(' · ');
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        testID={`feed-item-${item.id}`}
        onPress={() => router.push({ pathname: '/feed-item', params: { id: String(item.id), surface: place.surface, position: String(place.position) } })}
        style={({ pressed }) => [styles.body, pressed && { opacity: 0.6 }]}
      >
        <Text style={[styles.title, { color: theme.text }]} numberOfLines={3}>
          {title}
        </Text>
        <Text style={[styles.meta, { color: theme.muted }]} numberOfLines={1}>
          {explore ? 'Exploring · ' : ''}
          {meta}
        </Text>
        {item.summary && item.title && (
          <Text style={[styles.summary, { color: theme.muted }]} numberOfLines={2}>
            {item.summary}
          </Text>
        )}
        {item.note && (
          <Text style={[styles.note, { color: theme.text, borderColor: theme.border }]} numberOfLines={2}>
            {item.note}
          </Text>
        )}
      </Pressable>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.liked ? 'Unlike' : 'Like'}
          accessibilityState={{ selected: item.liked }}
          hitSlop={8}
          onPress={() => feed.act(item.id, item.liked ? 'unlike' : 'like', place)}
        >
          <SymbolView name={item.liked ? 'heart.fill' : 'heart'} size={18} tintColor={item.liked ? theme.danger : theme.muted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={saved ? 'Saved to Inspiration' : 'Save to Inspiration'}
          disabled={saved}
          hitSlop={8}
          onPress={() => feed.save(item.id, place)}
        >
          <SymbolView name={saved ? 'checkmark.circle.fill' : 'square.and.arrow.down'} size={18} tintColor={saved ? theme.text : theme.muted} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Not interested" hitSlop={8} onPress={() => onDismiss(item.id)}>
          <SymbolView name="hand.thumbsdown" size={17} tintColor={theme.muted} />
        </Pressable>
        {reasons && reasons.length > 0 && (
          <Pressable accessibilityRole="button" accessibilityLabel="Why this?" hitSlop={8} onPress={() => setWhy(!why)} style={styles.why}>
            <Text style={[styles.whyText, { color: theme.muted }]}>Why this?</Text>
          </Pressable>
        )}
        {item.waiting && <SymbolView name="clock" size={13} tintColor={theme.faint} accessibilityLabel="Waiting for your Mac" />}
      </View>
      {why && reasons && (
        <View style={styles.reasons}>
          {reasons.map((r) => (
            <Text key={r.key} style={[styles.reason, { color: theme.muted }]}>
              · {r.label}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, gap: 10 },
  body: { gap: 4 },
  meta: { fontSize: 13 },
  title: { fontFamily: fonts.serif, fontSize: 19, lineHeight: 25 },
  summary: { fontSize: 14, lineHeight: 19 },
  note: { fontSize: 14, lineHeight: 19, borderLeftWidth: 2, paddingLeft: 8, marginTop: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 22 },
  why: { marginLeft: 'auto' },
  whyText: { fontSize: 13 },
  reasons: { gap: 2 },
  reason: { fontSize: 13, lineHeight: 18 },
});
