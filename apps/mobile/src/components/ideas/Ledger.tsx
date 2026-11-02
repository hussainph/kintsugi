/**
 * KI-22's A · Ledger on the phone, as on the Mac: one quiet column. Today's
 * ideas are numbered, each a serif title and one muted line; a row opens in
 * place so the rest of the batch stays in view.
 *
 * This is the only layout-specific file of Ideas on the phone. To try Desk
 * or Letter, write a sibling that renders the same `IdeasModel` with the
 * pieces in `parts.tsx`, and swap it in `app/ideas.tsx`.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { KinMark } from '@/components/KinAvatar';
import type { LocalIdea } from '@/lib/ideas';
import { fonts, useTheme } from '@/theme';

import { Button, Detail, DismissedRow, type IdeasModel, Status } from './parts';

/** Fading, as on the Mac: whole for three days, thinner to day seven. */
const opacity = (idea: LocalIdea) =>
  idea.adopted || idea.age < 3 ? 1 : idea.age >= 7 ? 0.45 : 1 - ((idea.age - 2) / 5) * 0.55;

function Row({ idea, model, n }: { idea: LocalIdea; model: IdeasModel; n: number }) {
  const theme = useTheme();
  if (idea.dismissed) return <DismissedRow idea={idea} model={model} />;
  const open = model.open === idea.id;
  return (
    <View style={{ opacity: open ? 1 : opacity(idea) }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={idea.title}
        accessibilityState={{ expanded: open }}
        testID={`idea-${idea.id}`}
        onPress={() => model.toggle(idea.id)}
        style={styles.row}
      >
        <Text style={[styles.n, { color: theme.faint }]}>{n}</Text>
        <View style={styles.rowBody}>
          <Text style={[styles.title, { color: theme.text }]}>{idea.title}</Text>
          {!open && (
            <Text style={[styles.snippet, { color: theme.muted }]} numberOfLines={1}>
              {idea.snippet}
            </Text>
          )}
          <Status idea={idea} />
        </View>
      </Pressable>
      {open && (
        <View style={styles.open}>
          <Detail idea={idea} model={model} />
        </View>
      )}
    </View>
  );
}

function List({ ideas, model, from, label }: { ideas: LocalIdea[]; model: IdeasModel; from: number; label: string }) {
  const theme = useTheme();
  return (
    <View accessibilityLabel={label} style={[styles.list, { borderColor: theme.border }]}>
      {ideas.map((idea, i) => (
        <View key={idea.id} style={i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.border }}>
          <Row idea={idea} model={model} n={from + i + 1} />
        </View>
      ))}
    </View>
  );
}

export function Ledger({ model, status }: { model: IdeasModel; status: string | null }) {
  const theme = useTheme();
  const { today, earlier, faded } = model.groups;
  const { snapshot } = model;
  const live = today.filter((i) => !i.dismissed).length;
  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <View style={styles.kinLine}>
          <KinMark size={18} />
          <Text style={[styles.headerText, { color: theme.muted }]}>
            {live ? `${live === 1 ? 'One idea' : `${live} ideas`} from Kin today` : 'Nothing new from Kin today'}
            {snapshot.today ? ` · ${snapshot.today}` : ''}
          </Text>
        </View>
        <Text style={[styles.headerText, { color: theme.muted }]}>Ignore any of them. Unused ideas fade after a week.</Text>
        {status && <Text style={[styles.headerText, { color: theme.muted }]}>{status}</Text>}
      </View>

      {snapshot.ideas.length === 0 && !snapshot.making && (
        <View style={[styles.empty, { borderColor: theme.border }]}>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>No ideas yet.</Text>
          <Text style={[styles.headerText, { color: theme.muted, textAlign: 'center' }]}>
            Kin offers a few each day, grounded in your writing and what you’ve saved.
          </Text>
        </View>
      )}
      {today.length > 0 && <List ideas={today} model={model} from={0} label="Today" />}
      {earlier.length > 0 && (
        <>
          <Text style={[styles.label, { color: theme.faint }]}>{today.length ? 'Earlier' : 'This week'}</Text>
          <List ideas={earlier} model={model} from={today.length} label="Earlier" />
        </>
      )}
      {faded.length > 0 && (
        <>
          <Text style={[styles.label, { color: theme.faint }]}>Faded this week</Text>
          {faded.map((idea) => (
            <Text key={idea.id} style={[styles.faded, { color: theme.faint }]} numberOfLines={1}>
              {idea.title}
            </Text>
          ))}
        </>
      )}
      <View style={styles.more}>
        {snapshot.making ? (
          <Text style={[styles.headerText, { color: theme.kinInk }]}>
            {snapshot.connection === 'offline' ? 'Kin will look for more when your Mac is back.' : 'Kin is looking for ideas on your Mac…'}
          </Text>
        ) : (
          <Button label="Ask for more" theme={theme} onPress={model.more} />
        )}
        {snapshot.failed && <Text style={[styles.headerText, { color: theme.danger }]}>{snapshot.failed}</Text>}
        {snapshot.capReached && (
          <Text style={[styles.headerText, { color: theme.muted }]}>This month’s AI budget is spent; new ideas wait for next month.</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 160, gap: 14 },
  header: { gap: 6, marginBottom: 6 },
  kinLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerText: { fontSize: 14, lineHeight: 19 },
  empty: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 32, alignItems: 'center', gap: 8 },
  emptyTitle: { fontFamily: fonts.serif, fontSize: 20 },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', gap: 10, paddingVertical: 14 },
  n: { width: 18, fontSize: 12, paddingTop: 4, fontVariant: ['tabular-nums'] },
  rowBody: { flex: 1, gap: 3 },
  title: { fontFamily: fonts.serif, fontSize: 18, lineHeight: 24 },
  snippet: { fontSize: 14 },
  open: { paddingLeft: 28, paddingBottom: 20 },
  label: { fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 16 },
  faded: { fontSize: 14, paddingVertical: 2 },
  more: { gap: 8, alignItems: 'flex-start', marginTop: 8 },
});
