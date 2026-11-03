/**
 * The pieces every Ideas layout on the phone shares: an idea's detail (the
 * idea and its takeaways, with inline citations), its actions, and the
 * short status line. The layout itself lives in one file (Ledger.tsx
 * today), as on the Mac.
 */
import { cite, uncited } from '@kintsugi/core/citations';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { IdeasSnapshot, LocalIdea } from '@/lib/ideas';
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

/** Kin's text with its `[n]` markers; a tap shows that quote below. */
function Cited({ text, idea, extra = [], shown, onCite }: { text: string; idea: LocalIdea; extra?: number[]; shown: number | null; onCite: (q: number) => void }) {
  const theme = useTheme();
  const mark = (q: number, key: string) => (
    <Text
      key={key}
      accessibilityRole="button"
      accessibilityLabel={`Quote ${q + 1}: ${idea.quotes[q].title}`}
      onPress={() => onCite(q)}
      style={[styles.cite, { color: theme.kinInk, backgroundColor: shown === q ? theme.surface : undefined }]}
    >
      {` [${q + 1}]`}
    </Text>
  );
  return (
    <>
      {cite(text, idea.quotes.length).map((p, i) => ('text' in p ? p.text : mark(p.quote, `c${i}`)))}
      {extra.map((q) => mark(q, `x${q}`))}
    </>
  );
}

/** The idea, a few takeaways, the actions; a citation opens its quote in place. */
export function Detail({ idea, model }: { idea: LocalIdea; model: IdeasModel }) {
  const theme = useTheme();
  const [shown, setShown] = useState<number | null>(null);
  const onCite = (q: number) => setShown(shown === q ? null : q);
  const quote = shown == null ? null : idea.quotes[shown];
  return (
    <View style={styles.detail}>
      <Text style={[styles.hunch, { color: theme.text, borderColor: theme.kin }]}>
        <Cited text={idea.hunch} idea={idea} extra={uncited(idea)} shown={shown} onCite={onCite} />
      </Text>
      {idea.observed.length > 0 && (
        <View style={styles.block}>
          {idea.observed.map((o, i) => (
            <Text key={i} style={[styles.text, { color: theme.text }]}>
              {'· '}
              <Cited text={o} idea={idea} shown={shown} onCite={onCite} />
            </Text>
          ))}
        </View>
      )}
      {quote && (
        <Quote quote={quote} theme={theme} onOpen={quote.source.startsWith('feed:') ? undefined : () => model.openDraft(quote.source)} />
      )}
      <Actions idea={idea} model={model} />
    </View>
  );
}

function Quote({ quote, theme, onOpen }: { quote: { source: string; text: string; title: string; origin: string }; theme: Theme; onOpen?: () => void }) {
  return (
    <Pressable disabled={!onOpen} onPress={onOpen} style={[styles.quote, { backgroundColor: theme.surface }]}>
      <Text style={[styles.quoteText, { color: theme.text }]}>“{quote.text}”</Text>
      <Text style={[styles.small, { color: theme.muted }]}>
        {quote.title} · {quote.origin}
      </Text>
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
  text: { fontSize: 15, lineHeight: 21 },
  hunch: { fontFamily: fonts.serif, fontSize: 17, lineHeight: 25, borderLeftWidth: 2, paddingLeft: 12 },
  cite: { fontSize: 12 },
  quote: { borderRadius: 10, padding: 12, gap: 4 },
  quoteText: { fontFamily: fonts.serif, fontSize: 16, lineHeight: 23 },
  small: { fontSize: 13, lineHeight: 18 },
  link: { fontSize: 14, fontWeight: '500' },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  button: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 9 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  dismissed: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
});
