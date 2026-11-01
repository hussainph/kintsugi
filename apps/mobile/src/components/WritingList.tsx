import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { type ReactElement, useEffect, useMemo } from 'react';
import { Pressable, ScrollView, SectionList, StyleSheet, Text, View } from 'react-native';

import { StatusDot } from '@/components/StatusDot';
import {
  type Filter,
  type FolderRow,
  filtering,
  folderView,
  matchingSections,
  row,
  type Row,
  type Status,
  tagsUnder,
} from '@/lib/browse';
import { filters, useFilter, useLibrary } from '@/lib/documents';
import { unsent } from '@/lib/library';
import { type Theme, useTheme } from '@/theme';

type Item = ({ kind: 'folder' } & FolderRow) | ({ kind: 'doc' } & Row);
type ListSection = { key: string; title: string | null; data: Item[] };

const STATUSES: { status: Status; label: string }[] = [
  { status: 'draft', label: 'Drafts' },
  { status: 'complete', label: 'Complete' },
];

/** The writing in one folder (`''` is the vault), as a notes app lists it:
 *  its folders, then its documents. Searching, or choosing a status or tags,
 *  lists every match under the folder instead, grouped by where it lives. */
export function WritingList({
  dir,
  rootName,
  query,
  header,
  refreshing,
  onRefresh,
  empty,
  linked,
}: {
  dir: string;
  rootName: string;
  query: string;
  header?: ReactElement;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** What an empty folder says when nothing is filtered or searched. */
  empty: string;
  /** A filter chosen by the link that opened this list. */
  linked?: Filter | null;
}) {
  const theme = useTheme();
  const { docs } = useLibrary();
  const filter = useFilter();
  const link = linked ? JSON.stringify(linked) : null;
  useEffect(() => {
    if (link) filters.set(JSON.parse(link) as Filter);
  }, [link]);
  const rows = useMemo(() => docs.map(row), [docs]);
  const tags = useMemo(() => tagsUnder(rows, dir, filter.tags), [rows, dir, filter.tags]);
  const narrowed = filtering(filter) || query.trim() !== '';

  const sections = useMemo((): ListSection[] => {
    if (narrowed) {
      return matchingSections(rows, dir, filter, query.trim(), rootName).map((s) => ({
        key: s.folder,
        title: s.title,
        data: s.data.map((d) => ({ kind: 'doc' as const, ...d })),
      }));
    }
    const view = folderView(rows, dir);
    const items: Item[] = [
      ...view.folders.map((f) => ({ kind: 'folder' as const, ...f })),
      ...view.docs.map((d) => ({ kind: 'doc' as const, ...d })),
    ];
    return items.length ? [{ key: dir, title: null, data: items }] : [];
  }, [narrowed, rows, dir, filter, query, rootName]);

  const chips = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chips}
      accessibilityLabel="Filters"
      keyboardShouldPersistTaps="handled"
    >
      {STATUSES.map(({ status, label }) => (
        <Chip key={status} theme={theme} label={label} on={filter.status === status} onPress={() => filters.toggleStatus(status)} />
      ))}
      {tags.length > 0 && <View style={[styles.divider, { backgroundColor: theme.border }]} />}
      {tags.map((tag) => (
        <Chip key={tag} theme={theme} label={`#${tag}`} on={filter.tags.includes(tag)} onPress={() => filters.toggleTag(tag)} />
      ))}
      {filtering(filter) && <Chip theme={theme} label="Clear" plain onPress={() => filters.clear()} />}
    </ScrollView>
  );

  return (
    <SectionList
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: theme.background }}
      sections={sections}
      keyExtractor={(item) => `${item.kind}:${item.path}`}
      refreshing={refreshing}
      onRefresh={onRefresh}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={
        <>
          {header}
          {docs.length > 0 && chips}
        </>
      }
      renderSectionHeader={({ section }) =>
        section.title ? <Text style={[styles.sectionTitle, { color: theme.muted }]}>{section.title}</Text> : null
      }
      renderItem={({ item }) =>
        item.kind === 'folder' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, folder, ${item.count} documents`}
            onPress={() => router.push({ pathname: '/folder', params: { path: item.path } })}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
          >
            <SymbolView name="folder" size={18} tintColor={theme.muted} style={styles.icon} />
            <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.text }]}>
              {item.name}
            </Text>
            <Text style={[styles.rowNote, { color: theme.faint }]}>{item.count}</Text>
            <SymbolView name="chevron.right" size={13} tintColor={theme.faint} />
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={[item.title, item.status, ...item.tags.map((t) => `#${t}`)].filter(Boolean).join(', ')}
            onPress={() => router.push({ pathname: '/doc', params: { path: item.path } })}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
          >
            <View style={styles.icon}>
              <StatusDot status={item.status} />
            </View>
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.text }]}>
                {item.title}
              </Text>
              {item.tags.length > 0 && (
                <Text numberOfLines={1} style={[styles.rowTags, { color: theme.faint }]}>
                  {item.tags.map((t) => `#${t}`).join('  ')}
                </Text>
              )}
            </View>
            {item.conflict ? (
              <Text style={[styles.rowNote, { color: theme.danger }]}>Choose</Text>
            ) : unsent(item) ? (
              <Text style={[styles.rowNote, { color: theme.faint }]}>Not sent</Text>
            ) : null}
          </Pressable>
        )
      }
      ListEmptyComponent={
        <Text style={[styles.empty, { color: theme.muted }]}>
          {filtering(filter) ? 'Nothing here matches these filters.' : query.trim() ? 'Nothing matches.' : empty}
        </Text>
      }
    />
  );
}

function Chip({ label, on, plain, onPress, theme }: { label: string; on?: boolean; plain?: boolean; onPress: () => void; theme: Theme }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      onPress={onPress}
      style={[styles.chip, { backgroundColor: on ? theme.primary : plain ? 'transparent' : theme.surface }]}
    >
      <Text style={[styles.chipText, { color: on ? theme.onPrimary : theme.muted }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chips: { gap: 8, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4, alignItems: 'center' },
  chip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 14, fontWeight: '500' },
  divider: { width: StyleSheet.hairlineWidth, height: 18 },
  sectionTitle: { fontSize: 13, fontWeight: '600', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  icon: { width: 20, alignItems: 'center' },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { flex: 1, fontSize: 17 },
  rowTags: { fontSize: 13 },
  rowNote: { fontSize: 13 },
  empty: { fontSize: 14, lineHeight: 19, paddingHorizontal: 20, paddingTop: 16 },
});
