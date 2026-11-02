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
import { activeJobs, kinStatus, type Shown, shown } from '@/lib/kin';
import { usePairing } from '@/lib/pairing';
import { kin, OLD_MAC, syncSection, useKin, useMacApi } from '@/lib/sections-store';
import { fonts, type Theme, useTheme } from '@/theme';

/** How often the chat asks the Mac while Kin is answering, and otherwise. */
const BUSY_POLL = 1_500;
const IDLE_POLL = 6_000;

const chipIcon: Record<string, string> = { doc: 'doc.text', clip: 'sparkles', feed: 'dot.radiowaves.up.forward', idea: 'lightbulb' };

/** Kin's one conversation. Kin runs on the Mac: messages written here go
 *  there, with what was on screen attached as chips, and wait on the phone
 *  (saying so) while the Mac can't be reached. */
export default function KinScreen() {
  const params = useLocalSearchParams<{ chips?: string }>();
  const theme = useTheme();
  const { client, unpair } = usePairing();
  const snapshot = useKin();
  const api = useMacApi();
  const [chips, setChips] = useState<Chip[]>(() => {
    try {
      return params.chips ? (JSON.parse(params.chips) as Chip[]) : [];
    } catch {
      return [];
    }
  });
  const [text, setText] = useState('');
  const [showJobs, setShowJobs] = useState(false);
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  // The composer sits on the keyboard: a spacer under it grows with the
  // keyboard (less the home indicator's room the composer already leaves).
  const keyboard = useReanimatedKeyboardAnimation();
  const spacer = useAnimatedStyle(() => ({ height: Math.max(0, -keyboard.height.value - insets.bottom) }));
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  const sync = useCallback(async () => {
    if (!client) return;
    try {
      await syncSection(client, 'kin');
    } catch (e) {
      if (e instanceof Unpaired) unpair();
    }
  }, [client, unpair]);

  // Ask now, then again while the chat is open: often while Kin answers.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await sync();
      if (!stopped) timer = setTimeout(tick, kin.busy ? BUSY_POLL : IDLE_POLL);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sync]);

  const items = useMemo(() => shown(snapshot), [snapshot]);
  const last = snapshot.entries.at(-1);
  useEffect(() => {
    if (last) markKinSeen(last.seq);
  }, [last]);

  const send = () => {
    const message = text.trim();
    if (!message) return;
    kin.write(message, chips);
    setText('');
    setChips([]);
    void sync();
  };

  const status = api > 0 && api < SECTIONS_API ? OLD_MAC : kinStatus(snapshot);
  const jobs = activeJobs(snapshot.jobs);
  const offline = snapshot.connection === 'offline';

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Kin',
          presentation: 'modal',
          headerRight: () => (
            <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={10}>
              <Text style={[styles.done, { color: theme.text }]}>Done</Text>
            </Pressable>
          ),
        }}
      />
      <View style={[styles.screen, { backgroundColor: theme.background, paddingTop: headerHeight }]}>
        {status && (
          <View testID="kin-status" style={[styles.banner, { backgroundColor: offline ? theme.surface : 'transparent' }]}>
            {offline && <SymbolView name="desktopcomputer" size={15} tintColor={theme.muted} />}
            <Text style={[styles.bannerText, { color: theme.muted }]}>{status}</Text>
          </View>
        )}
        <ScrollView
          ref={scroll}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
          onLayout={() => scroll.current?.scrollToEnd({ animated: false })}
        >
          {items.length === 0 && (
            <View style={styles.empty}>
              <KinMark size={56} />
              <Text style={[styles.emptyText, { color: theme.muted }]}>
                Ask Kin about anything you’re reading or writing. Kin finds and connects things, and never writes your text for you.
              </Text>
            </View>
          )}
          {items.map((item) => (
            <Message key={item.kind === 'entry' ? `e${item.entry.seq}` : `o${item.message.id}`} item={item} theme={theme} />
          ))}
          {snapshot.running && !offline && <Text style={[styles.typing, { color: theme.kinInk }]}>Kin is replying…</Text>}
          {jobs.length > 0 && (
            <View style={[styles.jobs, { borderColor: theme.border }]}>
              <Pressable accessibilityRole="button" onPress={() => setShowJobs(!showJobs)} style={styles.jobsHeader}>
                <Text style={[styles.label, { color: theme.muted }]}>Kin’s jobs on your Mac</Text>
                <SymbolView name={showJobs ? 'chevron.up' : 'chevron.down'} size={12} tintColor={theme.muted} />
              </Pressable>
              {showJobs && jobs.map((job) => <JobRow key={job.id} job={job} theme={theme} />)}
            </View>
          )}
        </ScrollView>
        <View style={[styles.composer, { borderColor: theme.border, backgroundColor: theme.background, paddingBottom: Math.max(insets.bottom, 12) }]}>
          {chips.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {chips.map((chip) => (
                <Pressable
                  key={`${chip.kind}:${chip.path}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${chip.label ?? chip.path} from the context`}
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
              placeholder={offline ? 'Write to Kin; it goes when your Mac is back…' : 'Ask Kin…'}
              placeholderTextColor={theme.faint}
              multiline
              accessibilityLabel="Message to Kin"
              testID="kin-message"
              style={[styles.input, { color: theme.text, backgroundColor: theme.surface }]}
            />
            {snapshot.running && !text.trim() ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Stop Kin" onPress={() => client && kin.stop(client).catch(() => {})} style={[styles.send, { backgroundColor: theme.surface }]}>
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
    </>
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
  const { entry, thread } = item;
  return (
    <>
      {thread && <Text style={[styles.thread, { color: theme.faint }]}>{thread}</Text>}
      {entry.role === 'owner' ? (
        <View style={styles.ownerRow}>
          <View style={[styles.owner, { backgroundColor: theme.surface }]}>
            <Chips chips={entry.chips ?? []} theme={theme} />
            <Text selectable style={[styles.ownerText, { color: theme.text }]}>{entry.text}</Text>
          </View>
          {entry.comment && <Text style={[styles.meta, { color: theme.faint }]}>In a paragraph’s comments</Text>}
        </View>
      ) : (
        <View style={styles.kinRow} accessible accessibilityLabel={`Kin: ${entry.text}`}>
          <View style={[styles.rule, { backgroundColor: theme.kin }]} />
          <View style={styles.kinBody}>
            <Text selectable style={[styles.kinText, { color: theme.text }]}>
              {entry.role === 'helper' && <Text style={[styles.helper, { color: theme.kinInk }]}>From a helper: </Text>}
              {entry.text || (entry.error ? '' : '…')}
            </Text>
            {entry.comment && <Text style={[styles.meta, { color: theme.faint }]}>In a paragraph’s comments</Text>}
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
  empty: { alignItems: 'center', gap: 14, paddingTop: 60, paddingHorizontal: 24 },
  emptyText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  thread: { fontSize: 13, textAlign: 'center', marginTop: 6 },
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
