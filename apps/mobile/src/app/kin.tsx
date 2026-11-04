import { SECTIONS_API, Unpaired } from '@kintsugi/core/remote';
import type { Chip, Job } from '@kintsugi/core/sections';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KinMark, markKinSeen } from '@/components/KinAvatar';
import { ago } from '@/lib/feed';
import { activeJobs, kinStatus, type Listed, listed, outgoingIn, type Shown, shown, type Target } from '@/lib/kin';
import { type Anchor, type Thread, THREADS_API } from '@/lib/kin-api';
import { usePairing } from '@/lib/pairing';
import { kin, OLD_KIN, OLD_MAC, syncSection, useKin, useMacApi } from '@/lib/sections-store';
import { fonts, type Theme, useTheme } from '@/theme';

/** How often the screen asks the Mac while Kin is answering, and otherwise. */
const BUSY_POLL = 1_500;
const IDLE_POLL = 6_000;

const chipIcon: Record<string, string> = { doc: 'doc.text', clip: 'sparkles', feed: 'dot.radiowaves.up.forward', idea: 'lightbulb' };

const parseChips = (raw?: string): Chip[] => {
  try {
    return raw ? (JSON.parse(raw) as Chip[]) : [];
  } catch {
    return [];
  }
};

/** Kin's threads. Kin runs on the Mac: the list and the threads he opened
 *  are kept to read offline, and messages written here wait on the phone
 *  (saying so) while the Mac can't be reached. `chips` is what was on
 *  screen: threads about it come first, and a new thread starts with it
 *  attached. `new` opens a new thread straight away. */
export default function KinScreen() {
  const params = useLocalSearchParams<{ chips?: string; new?: string }>();
  const theme = useTheme();
  const { client, unpair } = usePairing();
  const snapshot = useKin();
  const api = useMacApi();
  const here = useMemo(() => parseChips(params.chips), [params.chips]);
  const [open, setOpen] = useState<Target | null>(() => (params.new ? kin.draft() : null));
  // A draft becomes the Mac's thread once its first message lands.
  const target = useMemo(() => open && kin.resolve(open), [open, snapshot.made]); // eslint-disable-line react-hooks/exhaustive-deps
  const [chips, setChips] = useState<Chip[]>(() => (params.new ? here : []));
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Thread[] | null>(null);
  const found = query.trim() ? results : null;

  const sync = useCallback(async () => {
    if (!client) return;
    try {
      await syncSection(client, 'kin', target ?? undefined);
    } catch (e) {
      if (e instanceof Unpaired) unpair();
    }
  }, [client, unpair, target]);

  // Ask now, then again while the screen is open: often while Kin answers.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await sync();
      if (!stopped) timer = setTimeout(tick, kin.busy(target ?? undefined) ? BUSY_POLL : IDLE_POLL);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sync, target]);

  // Search: the Mac looks through every message; offline, the phone's copy.
  useEffect(() => {
    if (!query.trim()) return;
    let current = true;
    const timer = setTimeout(() => {
      kin
        .search(client, query)
        .then((threads) => current && setResults(threads))
        .catch((e) => e instanceof Unpaired && unpair());
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, client, unpair]);

  const latest = snapshot.threads.reduce((max, t) => (t.updated > max ? t.updated : max), '');
  useEffect(() => {
    if (latest) markKinSeen(latest);
  }, [latest]);

  const startThread = () => {
    setChips(here);
    setOpen(kin.draft());
  };
  const openRow = (row: Listed) => {
    setChips([]);
    setOpen(row.kind === 'thread' ? { thread: row.thread.id } : row.target);
  };
  const back = () => {
    setOpen(null);
    setChips([]);
  };

  const oldMac = api > 0 && api < SECTIONS_API ? OLD_MAC : api > 0 && api < THREADS_API ? OLD_KIN : null;
  const thread = target && 'thread' in target ? (snapshot.views[target.thread]?.thread ?? snapshot.threads.find((t) => t.id === target.thread)) : undefined;

  return (
    <>
      <Stack.Screen
        options={{
          title: target ? (thread?.title ?? 'New thread') : 'Kin',
          presentation: 'modal',
          headerLeft: target
            ? () => (
                <Pressable accessibilityRole="button" accessibilityLabel="Back to threads" onPress={back} hitSlop={10}>
                  <SymbolView name="chevron.left" size={18} tintColor={theme.text} />
                </Pressable>
              )
            : undefined,
          headerRight: () => (
            <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={10}>
              <Text style={[styles.done, { color: theme.text }]}>Done</Text>
            </Pressable>
          ),
        }}
      />
      {open && target ? (
        // Keyed by what he opened, so a draft becoming its thread keeps the composer.
        <ThreadScreen key={'thread' in open ? open.thread : open.draft} target={target} thread={thread} chips={chips} setChips={setChips} oldMac={oldMac} sync={sync} />
      ) : (
        <ThreadList here={here} found={found} query={query} setQuery={setQuery} oldMac={oldMac} onNew={startThread} onOpen={openRow} />
      )}
    </>
  );
}

function ThreadList(props: {
  here: Chip[];
  found: Thread[] | null;
  query: string;
  setQuery: (q: string) => void;
  oldMac: string | null;
  onNew: () => void;
  onOpen: (row: Listed) => void;
}) {
  const theme = useTheme();
  const snapshot = useKin();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const [showJobs, setShowJobs] = useState(false);
  const rows = listed(snapshot, props.found ?? snapshot.threads, props.here).filter((r) => !props.found || r.kind === 'thread');
  const status = props.oldMac ?? kinStatus(snapshot);
  const offline = snapshot.connection === 'offline';
  const jobs = activeJobs(snapshot.jobs);
  return (
    <View style={[styles.screen, { backgroundColor: theme.background, paddingTop: headerHeight }]}>
      {status && <Banner status={status} offline={offline} theme={theme} />}
      <View style={styles.toolbar}>
        <TextInput
          value={props.query}
          onChangeText={props.setQuery}
          placeholder="Search threads"
          placeholderTextColor={theme.faint}
          accessibilityLabel="Search threads"
          clearButtonMode="while-editing"
          returnKeyType="search"
          style={[styles.search, { color: theme.text, backgroundColor: theme.surface }]}
        />
        <Pressable accessibilityRole="button" testID="kin-new-thread" onPress={props.onNew} style={[styles.newThread, { backgroundColor: theme.primary }]}>
          <SymbolView name="square.and.pencil" size={15} tintColor={theme.onPrimary} />
          <Text style={[styles.newThreadText, { color: theme.onPrimary }]}>New thread</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
        {rows.length === 0 &&
          (props.found ? (
            <Text style={[styles.emptyText, { color: theme.muted }]}>No threads match.</Text>
          ) : (
            <View style={styles.empty}>
              <KinMark size={56} />
            </View>
          ))}
        {rows.map((row) => (
          <Row key={row.kind === 'thread' ? row.thread.id : 'draft' in row.target ? row.target.draft : row.target.thread} row={row} running={row.kind === 'thread' && snapshot.running.includes(row.thread.id)} offline={offline} theme={theme} onPress={() => props.onOpen(row)} />
        ))}
        {jobs.length > 0 && (
          <View style={[styles.jobs, { borderColor: theme.border }]}>
            <Pressable accessibilityRole="button" onPress={() => setShowJobs(!showJobs)} style={styles.jobsHeader}>
              <Text style={[styles.label, { color: theme.muted }]}>Kin’s jobs</Text>
              <SymbolView name={showJobs ? 'chevron.up' : 'chevron.down'} size={12} tintColor={theme.muted} />
            </Pressable>
            {showJobs && jobs.map((job) => <JobRow key={job.id} job={job} theme={theme} />)}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

/** What a thread is about, in a line: the passage, or the item's name. */
function about(anchor?: Anchor): string | null {
  if (!anchor) return null;
  if (anchor.kind === 'paragraph' && anchor.quote?.exact) return anchor.quote.exact;
  return anchor.label ?? anchor.path;
}

function Row({ row, running, offline, theme, onPress }: { row: Listed; running: boolean; offline: boolean; theme: Theme; onPress: () => void }) {
  if (row.kind === 'draft') {
    return (
      <Pressable accessibilityRole="button" onPress={onPress} style={[styles.row, { borderColor: theme.border }]}>
        <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.text }]}>
          {row.title}
        </Text>
        {row.chips[0] && (
          <Text numberOfLines={1} style={[styles.rowAbout, { color: theme.muted }]}>
            {row.chips[0].label ?? row.chips[0].path}
          </Text>
        )}
        <Text style={[styles.meta, { color: theme.faint }]}>{offline ? 'Waiting for your Mac' : 'Sending…'}</Text>
      </Pressable>
    );
  }
  const { thread } = row;
  const subject = about(thread.anchor);
  const when = ago(Date.parse(thread.updated) / 1000);
  return (
    <Pressable accessibilityRole="button" testID="kin-thread" onPress={onPress} style={[styles.row, { borderColor: theme.border }]}>
      <View style={styles.rowTop}>
        <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.text }]}>
          {thread.title}
        </Text>
        <Text style={[styles.meta, { color: theme.faint }]}>{running ? 'Replying…' : when}</Text>
      </View>
      {subject && (
        <Text numberOfLines={2} style={[styles.rowAbout, { color: theme.muted }, thread.anchor?.kind === 'paragraph' && styles.quoted]}>
          {subject}
        </Text>
      )}
      {(thread.hit ?? thread.preview) ? (
        <Text numberOfLines={2} style={[styles.rowPreview, { color: theme.muted }]}>
          {thread.hit ?? thread.preview}
        </Text>
      ) : null}
    </Pressable>
  );
}

function Banner({ status, offline, theme }: { status: string; offline: boolean; theme: Theme }) {
  return (
    <View testID="kin-status" style={[styles.banner, { backgroundColor: offline ? theme.surface : 'transparent' }]}>
      {offline && <SymbolView name="desktopcomputer" size={15} tintColor={theme.muted} />}
      <Text style={[styles.bannerText, { color: theme.muted }]}>{status}</Text>
    </View>
  );
}

/** One thread: its messages, and a composer that replies in it (or, in a
 *  new thread, starts it with the chips attached). */
function ThreadScreen(props: {
  target: Target;
  thread?: Thread;
  chips: Chip[];
  setChips: (chips: Chip[]) => void;
  oldMac: string | null;
  sync: () => Promise<void>;
}) {
  const { target, thread, chips, setChips } = props;
  const theme = useTheme();
  const { client } = usePairing();
  const snapshot = useKin();
  const [text, setText] = useState('');
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  // The composer sits on the keyboard: a spacer under it grows with the
  // keyboard (less the home indicator's room the composer already leaves).
  const keyboard = useReanimatedKeyboardAnimation();
  const spacer = useAnimatedStyle(() => ({ height: Math.max(0, -keyboard.height.value - insets.bottom) }));
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  const items = useMemo(() => shown(snapshot, target), [snapshot, target]);
  const view = 'thread' in target ? snapshot.views[target.thread] : undefined;
  const running = Boolean(view?.running) || ('thread' in target && snapshot.running.includes(target.thread));
  // Chips go with the message that starts a new thread.
  const starting = 'draft' in target && outgoingIn(snapshot, target).length === 0;

  const send = () => {
    const message = text.trim();
    if (!message) return;
    kin.write(message, starting ? chips : [], target);
    setText('');
    setChips([]);
    void props.sync();
  };

  const status = props.oldMac ?? kinStatus(snapshot, target);
  const offline = snapshot.connection === 'offline';
  const passage = thread?.anchor?.kind === 'paragraph' ? thread.anchor.quote?.exact : undefined;
  const subject = passage ? null : about(thread?.anchor);

  return (
    <View style={[styles.screen, { backgroundColor: theme.background, paddingTop: headerHeight }]}>
      {status && <Banner status={status} offline={offline} theme={theme} />}
      <ScrollView
        ref={scroll}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        onLayout={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        {passage && (
          <View style={[styles.passage, { borderColor: theme.border }]}>
            <Text selectable style={[styles.passageText, { color: theme.muted }]}>
              {passage}
            </Text>
            {thread?.anchor?.orphaned && <Text style={[styles.meta, { color: theme.faint }]}>This passage changed</Text>}
          </View>
        )}
        {subject && <Text style={[styles.subject, { color: theme.faint }]}>{subject}</Text>}
        {items.length === 0 && !passage && (
          <View style={styles.empty}>
            <KinMark size={56} />
          </View>
        )}
        {items.map((item) => (
          <Message key={item.kind === 'entry' ? `e${item.entry.seq}` : `o${item.message.id}`} item={item} theme={theme} />
        ))}
        {running && !offline && <Text style={[styles.typing, { color: theme.kinInk }]}>Kin is replying…</Text>}
      </ScrollView>
      <View style={[styles.composer, { borderColor: theme.border, backgroundColor: theme.background, paddingBottom: Math.max(insets.bottom, 12) }]}>
        {starting && chips.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {chips.map((chip) => (
              <Pressable
                key={`${chip.kind}:${chip.path}`}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${chip.label ?? chip.path}`}
                onPress={() => setChips(chips.filter((c) => c !== chip))}
                style={[styles.chip, { backgroundColor: theme.surface }]}
              >
                <SymbolView name={(chipIcon[chip.kind] ?? 'doc') as never} size={12} tintColor={theme.muted} />
                <Text numberOfLines={1} style={[styles.chipText, { color: theme.text }]}>
                  {chip.label ?? chip.path}
                </Text>
                <SymbolView name="xmark" size={10} tintColor={theme.faint} />
              </Pressable>
            ))}
          </ScrollView>
        )}
        <View style={styles.inputRow}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Ask Kin…"
            placeholderTextColor={theme.faint}
            multiline
            autoFocus={'draft' in target}
            accessibilityLabel="Message to Kin"
            testID="kin-message"
            style={[styles.input, { color: theme.text, backgroundColor: theme.surface }]}
          />
          {running && !text.trim() && 'thread' in target ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop Kin"
              onPress={() => client && kin.stop(client, target.thread).catch(() => {})}
              style={[styles.send, { backgroundColor: theme.surface }]}
            >
              <SymbolView name="stop.fill" size={14} tintColor={theme.text} />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              disabled={!text.trim()}
              onPress={send}
              style={[styles.send, { backgroundColor: text.trim() ? theme.primary : theme.surface }]}
            >
              <SymbolView name="arrow.up" size={16} tintColor={text.trim() ? theme.onPrimary : theme.faint} />
            </Pressable>
          )}
        </View>
      </View>
      <Animated.View style={spacer} />
    </View>
  );
}

function Message({ item, theme }: { item: Shown; theme: Theme }) {
  if (item.kind === 'outgoing') {
    const { message } = item;
    return (
      <View style={styles.ownerRow}>
        <View style={[styles.owner, { backgroundColor: theme.surface, opacity: message.error ? 1 : 0.7 }]}>
          <Chips chips={message.chips} theme={theme} />
          <Text style={[styles.ownerText, { color: theme.text }]}>{message.text}</Text>
        </View>
        {message.error ? (
          <View style={styles.refused}>
            <Text style={[styles.meta, { color: theme.danger }]}>Not sent: {message.error}</Text>
            <Pressable accessibilityRole="button" onPress={() => kin.retry(message.id)}>
              <Text style={[styles.metaAction, { color: theme.text }]}>Try again</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => kin.discard(message.id)}>
              <Text style={[styles.metaAction, { color: theme.danger }]}>Discard</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={[styles.meta, { color: theme.faint }]}>{item.offline ? 'Waiting for your Mac' : 'Sending…'}</Text>
        )}
      </View>
    );
  }
  const { entry } = item;
  return (
    <>
      {entry.role === 'owner' ? (
        <View style={styles.ownerRow}>
          <View style={[styles.owner, { backgroundColor: theme.surface }]}>
            <Chips chips={entry.chips ?? []} theme={theme} />
            <Text selectable style={[styles.ownerText, { color: theme.text }]}>{entry.text}</Text>
          </View>
        </View>
      ) : (
        <View style={styles.kinRow} accessible accessibilityLabel={`Kin: ${entry.text}`}>
          <View style={[styles.rule, { backgroundColor: theme.kin }]} />
          <View style={styles.kinBody}>
            <Text selectable style={[styles.kinText, { color: theme.text }]}>
              {entry.role === 'helper' && <Text style={[styles.helper, { color: theme.kinInk }]}>From a helper: </Text>}
              {entry.text || (entry.error ? '' : '…')}
            </Text>
            {entry.interrupted && <Text style={[styles.meta, { color: theme.faint }]}>Interrupted</Text>}
            {entry.error && <Text style={[styles.meta, { color: theme.danger }]}>{entry.error}</Text>}
          </View>
        </View>
      )}
    </>
  );
}

function Chips({ chips, theme }: { chips: { kind: string; path: string; label?: string }[]; theme: Theme }) {
  if (!chips.length) return null;
  return (
    <View style={styles.inlineChips}>
      {chips.map((chip) => (
        <Text key={`${chip.kind}:${chip.path}`} numberOfLines={1} style={[styles.inlineChip, { color: theme.muted, borderColor: theme.border }]}>
          {chip.label ?? chip.path}
        </Text>
      ))}
    </View>
  );
}

const jobLabel: Record<Job['status'], string> = {
  queued: 'Queued',
  running: 'Working',
  waiting: 'Waiting (monthly cap)',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function JobRow({ job, theme }: { job: Job; theme: Theme }) {
  const what = job.kind === 'ideas' ? 'Finding ideas' : job.kind === 'ideas-refine' ? 'Refining an idea' : job.kind === 'review' ? 'Reviewing a draft' : job.kind;
  return (
    <View style={styles.job}>
      <Text style={[styles.jobTitle, { color: theme.text }]}>{what}</Text>
      <Text style={[styles.meta, { color: job.status === 'failed' ? theme.danger : theme.muted }]}>
        {jobLabel[job.status]}
        {job.error ? ` · ${job.error}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  done: { fontSize: 17, fontWeight: '600' },
  banner: { flexDirection: 'row', gap: 8, alignItems: 'center', marginHorizontal: 16, marginTop: 10, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  bannerText: { flex: 1, fontSize: 14, lineHeight: 19 },
  list: { flex: 1 },
  listContent: { padding: 16, gap: 14, paddingBottom: 24 },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { fontSize: 15, textAlign: 'center', paddingTop: 40 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 10 },
  search: { flex: 1, fontSize: 16, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  newThread: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  newThreadText: { fontSize: 15, fontWeight: '600' },
  row: { gap: 4, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  rowTitle: { flex: 1, fontSize: 16, fontWeight: '600' },
  rowAbout: { fontSize: 14, lineHeight: 19 },
  quoted: { fontFamily: fonts.serif, fontStyle: 'italic' },
  rowPreview: { fontSize: 14, lineHeight: 19 },
  passage: { borderLeftWidth: 2, paddingLeft: 12, gap: 4 },
  passageText: { fontFamily: fonts.serif, fontSize: 16, lineHeight: 23, fontStyle: 'italic' },
  subject: { fontSize: 13, textAlign: 'center' },
  ownerRow: { alignItems: 'flex-end', gap: 4 },
  owner: { maxWidth: '85%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  ownerText: { fontSize: 16, lineHeight: 22 },
  kinRow: { flexDirection: 'row', gap: 10, paddingRight: 24 },
  rule: { width: 2, borderRadius: 1 },
  kinBody: { flex: 1, gap: 4 },
  kinText: { fontFamily: fonts.serif, fontSize: 17, lineHeight: 25 },
  helper: { fontWeight: '600' },
  meta: { fontSize: 12 },
  metaAction: { fontSize: 12, fontWeight: '600' },
  refused: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  typing: { fontSize: 14, fontStyle: 'italic' },
  inlineChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  inlineChip: { fontSize: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, maxWidth: 220 },
  jobs: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 8 },
  jobsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: 15, fontWeight: '600' },
  job: { gap: 2 },
  jobTitle: { fontSize: 15 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  chips: { gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, maxWidth: 260 },
  chipText: { fontSize: 13, flexShrink: 1 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { flex: 1, fontSize: 16, lineHeight: 21, borderRadius: 18, paddingHorizontal: 14, paddingTop: 9, paddingBottom: 9, maxHeight: 140 },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});
