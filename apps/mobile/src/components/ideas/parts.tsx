/**
 * The pieces every Ideas layout on the phone shares: an idea's detail
 * (observed apart from the hunch, the quoted evidence, "how I got here"),
 * its actions, and the short status line. The layout itself lives in one
 * file (Ledger.tsx today), as on the Mac.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { evidence, type IdeasSnapshot, type LocalIdea } from '@/lib/ideas';
import { fonts, type Theme, useTheme } from '@/theme';

/** What a layout needs: the list and what he can do with it. */
export type IdeasModel = {
  snapshot: IdeasSnapshot;
  groups: { today: LocalIdea[]; earlier: LocalIdea[]; faded: LocalIdea[] };
  open: string | null;
  toggle: (id: string) => void;
  adopt: (idea: LocalIdea) => void;
  discuss: (idea: LocalIdea) => void;
  dismiss: (idea: LocalIdea, undo?: boolean) => void;
  more: () => void;
  /** Opens a document or clip from the phone's copy. */
  openDraft: (path: string) => void;
};

/** Adopted, adopting, refining: a few muted words. */
export function Status({ idea }: { idea: LocalIdea }) {
  const theme = useTheme();
  const text = idea.adopted ? 'Adopted' : idea.adopting ? 'Adopting when your Mac is back' : idea.refining ? 'Kin is refining' : null;
  return text ? <Text style={[styles.status, { color: idea.adopted ? theme.kinInk : theme.muted }]}>{text}</Text> : null;
}

export function Detail({ idea, model }: { idea: LocalIdea; model: IdeasModel }) {
  const theme = useTheme();
  const [how, setHow] = useState(false);
  return (
    <View style={styles.detail}>
      {idea.observed.length > 0 && (
        <View style={styles.block}>
          <Text style={[styles.label, { color: theme.text }]}>What Kin noticed</Text>
          {idea.observed.map((o, i) => (
            <Text key={i} style={[styles.text, { color: theme.text }]}>
              {o}
            </Text>
          ))}
        </View>
      )}
      <View style={styles.block}>
        <Text style={[styles.label, { color: theme.kinInk }]}>Kin’s hunch</Text>
        <Text style={[styles.hunch, { color: theme.text }]}>{idea.hunch}</Text>
      </View>
      <View style={styles.block}>
        <Text style={[styles.label, { color: theme.text }]}>Evidence</Text>
        {evidence(idea).map((q) => (
          <Quote key={q.source} quote={q} theme={theme} onOpen={q.source.startsWith('feed:') ? undefined : () => model.openDraft(q.source)} />
        ))}
      </View>
      {idea.steps.length > 0 && (
        <View style={styles.block}>
          <Pressable accessibilityRole="button" onPress={() => setHow(!how)}>
            <Text style={[styles.link, { color: theme.muted }]}>{how ? 'Hide how Kin found this' : 'How Kin found this'}</Text>
          </Pressable>
          {how &&
            idea.steps.map((s, i) => (
              <Text key={i} style={[styles.small, { color: theme.muted }]}>
                {i + 1}. {s.did}
                {s.found ? ` → ${s.found}` : ''}
              </Text>
            ))}
        </View>
      )}
      {idea.reasons.filter((r) => !r.removed).length > 0 && (
        <View style={styles.block}>
          <Text style={[styles.label, { color: theme.text }]}>Why this?</Text>
          {idea.reasons
            .filter((r) => !r.removed)
            .map((r) => (
              <Text key={r.id} style={[styles.small, { color: theme.muted }]}>
                · {r.text}
              </Text>
            ))}
        </View>
      )}
      <Actions idea={idea} model={model} />
    </View>
  );
}

function Quote({ quote, theme, onOpen }: { quote: { source: string; text: string; title: string }; theme: Theme; onOpen?: () => void }) {
  return (
    <Pressable disabled={!onOpen} onPress={onOpen} style={[styles.quote, { borderColor: theme.kin }]}>
      <Text style={[styles.quoteText, { color: theme.text }]}>“{quote.text}”</Text>
      <Text style={[styles.small, { color: theme.muted }]}>{quote.title}</Text>
    </Pressable>
  );
}

export function Actions({ idea, model }: { idea: LocalIdea; model: IdeasModel }) {
  const theme = useTheme();
  const draft = idea.adopted?.path ?? model.snapshot.adopted[idea.id];
  return (
    <View style={styles.actions}>
      {draft ? (
        <Button label="Open the draft" primary theme={theme} onPress={() => model.openDraft(draft)} />
      ) : (
        <Button label={idea.adopting ? 'Adopting…' : 'Adopt'} primary disabled={idea.adopting} theme={theme} onPress={() => model.adopt(idea)} />
      )}
      <Button label="Discuss" theme={theme} onPress={() => model.discuss(idea)} />
      {!idea.adopted && <Button label="Dismiss" theme={theme} onPress={() => model.dismiss(idea)} />}
    </View>
  );
}

/** A just-dismissed idea keeps its place, with Undo. */
export function DismissedRow({ idea, model }: { idea: LocalIdea; model: IdeasModel }) {
  const theme = useTheme();
  return (
    <View style={styles.dismissed}>
      <Text style={[styles.small, { color: theme.muted, flex: 1 }]} numberOfLines={1}>
        Dismissed: {idea.title}
      </Text>
      <Pressable accessibilityRole="button" onPress={() => model.dismiss(idea, true)} hitSlop={8}>
        <Text style={[styles.link, { color: theme.text }]}>Undo</Text>
      </Pressable>
    </View>
  );
}

export function Button({ label, onPress, primary, disabled, theme }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean; theme: Theme }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: primary ? theme.primary : theme.surface, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={[styles.buttonText, { color: primary ? theme.onPrimary : theme.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  status: { fontSize: 13 },
  detail: { gap: 16, paddingBottom: 8 },
  block: { gap: 6 },
  label: { fontSize: 15, fontWeight: '600' },
  text: { fontSize: 15, lineHeight: 21 },
  hunch: { fontFamily: fonts.serif, fontSize: 17, lineHeight: 25 },
  quote: { borderLeftWidth: 2, paddingLeft: 10, gap: 2, paddingVertical: 2 },
  quoteText: { fontFamily: fonts.serif, fontSize: 16, lineHeight: 23 },
  small: { fontSize: 13, lineHeight: 18 },
  link: { fontSize: 14, fontWeight: '500' },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  button: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 9 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  dismissed: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
});
