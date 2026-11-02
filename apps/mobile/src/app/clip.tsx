import { clipLabel, clipSite, sourceUrl } from '@kintsugi/core/clips';
import { quoteLinkLabel } from '@kintsugi/core/references';
import { Offline, Unpaired } from '@kintsugi/core/remote';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { inspiration, useClip, useInspiration } from '@/lib/clip-library';
import { clipUnsent } from '@/lib/inspiration';
import { usePairing } from '@/lib/pairing';
import { useScreenContext } from '@/lib/screen-context';
import { useThumbnail } from '@/lib/thumbnail-store';
import { fonts, useTheme } from '@/theme';

type Source = { state: 'idle' | 'loading' } | { state: 'shown'; text: string | null } | { state: 'failed'; message: string };

/** One clip, from the phone's copy: its image, where it came from, the
 *  owner's own notes (tap to edit), and the extracted source, fetched from
 *  the Mac only when asked for. */
export default function ClipScreen() {
  const { path } = useLocalSearchParams<{ path: string }>();
  const local = useClip(path);
  useScreenContext(local ? [{ kind: 'clip', path, label: local.clip.title || clipLabel(local.clip) }] : null);
  const { connection } = useInspiration();
  const { client, unpair } = usePairing();
  const theme = useTheme();
  const uri = useThumbnail(local?.clip ?? { path, image: null });
  const [aspect, setAspect] = useState<number | null>(null);
  const [source, setSource] = useState<Source>({ state: 'idle' });

  if (!local) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background }]}>
        <Stack.Title>{''}</Stack.Title>
        <Text style={[styles.muted, { color: theme.muted }]}>
          This clip isn’t on this phone any more. It may have been removed on your Mac.
        </Text>
      </View>
    );
  }

  const { clip } = local;
  const link = sourceUrl(clip.url);
  const passage = sourceUrl(clip.quoteLink);
  const notes = local.text;
  const open = (url: string) => Linking.openURL(url).catch(() => {});

  const showSource = async () => {
    if (!client) return;
    setSource({ state: 'loading' });
    try {
      setSource({ state: 'shown', text: (await client.clipSource(path)).text });
    } catch (e) {
      if (e instanceof Unpaired) return unpair();
      setSource({
        state: 'failed',
        message: e instanceof Offline ? 'The source is kept on your Mac. It opens here when your Mac is reachable.' : String(e),
      });
    }
  };

  return (
    <>
      <Stack.Title>{clip.title || clipLabel(clip)}</Stack.Title>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.content}
      >
        {clip.image && uri && (
          <Image
            source={{ uri }}
            onLoad={(e) => setAspect(e.nativeEvent.source.width / e.nativeEvent.source.height)}
            style={[styles.image, { aspectRatio: aspect ?? 4 / 3, backgroundColor: theme.surface }]}
            resizeMode="contain"
            accessibilityLabel={clip.title ?? 'Saved image'}
          />
        )}

        <View style={styles.heading}>
          <Text style={[styles.small, { color: theme.muted }]}>
            {[clipSite(clip), clip.author].filter(Boolean).join(' · ')}
          </Text>
          <Text style={[styles.title, { color: theme.text }]} selectable>
            {clip.title || clipLabel(clip)}
          </Text>
        </View>

        {(link || passage) && (
          <View style={styles.links}>
            {link && (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="Open the source"
                onPress={() => open(link)}
                style={[styles.linkButton, { backgroundColor: theme.surface }]}
              >
                <SymbolView name="arrow.up.right" size={13} tintColor={theme.text} />
                <Text style={[styles.linkText, { color: theme.text }]} numberOfLines={1}>
                  {hostOf(link)}
                </Text>
              </Pressable>
            )}
            {passage && (
              <Pressable
                accessibilityRole="link"
                onPress={() => open(passage)}
                style={[styles.linkButton, { backgroundColor: theme.surface }]}
              >
                <Text style={[styles.linkText, { color: theme.text }]}>
                  {quoteLinkLabel(passage) === 'source' ? 'Open at the passage' : `Open at ${quoteLinkLabel(passage)}`}
                </Text>
              </Pressable>
            )}
          </View>
        )}

        {clip.summary && (
          <View style={styles.section}>
            <Text style={[styles.label, { color: theme.faint }]}>Summary · machine-made</Text>
            <Text style={[styles.summary, { color: theme.muted }]}>{clip.summary}</Text>
          </View>
        )}

        <View style={styles.section}>
          <Text style={[styles.label, { color: theme.faint }]}>Your notes</Text>
          {local.conflict && (
            <Text style={[styles.small, { color: theme.danger }]}>
              Changed on your Mac and on this phone in the same place. Open your notes to choose which stays.
            </Text>
          )}
          {local.gone && (
            <Text style={[styles.small, { color: theme.danger }]}>
              This clip was removed on your Mac. Your notes are kept here until you discard them.
            </Text>
          )}
          {notes === null ? (
            <Text style={[styles.muted, { color: theme.muted }]}>Update Kintsugi on your Mac to read and edit notes here.</Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit your notes"
              accessibilityValue={{ text: notes.trim() || 'No notes yet' }}
              testID="clip-notes"
              onPress={() => router.push({ pathname: '/clip-notes', params: { path } })}
              style={({ pressed }) => [styles.notes, { backgroundColor: theme.surface, opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={[styles.notesText, { color: notes.trim() ? theme.text : theme.faint }]} numberOfLines={12}>
                {notes.trim() || 'Add a note…'}
              </Text>
            </Pressable>
          )}
          {clipUnsent(local) && !local.conflict && !local.gone && connection === 'offline' && (
            <Text style={[styles.small, { color: theme.muted }]}>Saved on this phone. It goes to your Mac when it’s reachable.</Text>
          )}
          {local.gone && (
            <Pressable onPress={() => { inspiration.discard(path); router.back(); }} style={[styles.linkButton, { borderColor: theme.border, borderWidth: 1 }]}>
              <Text style={[styles.linkText, { color: theme.danger }]}>Discard</Text>
            </Pressable>
          )}
        </View>

        {clip.tags.length > 0 && (
          <Text style={[styles.small, { color: theme.faint }]}>{clip.tags.map((t) => `#${t}`).join('  ')}</Text>
        )}

        {clip.hasSource && (
          <View style={styles.section}>
            <Text style={[styles.label, { color: theme.faint }]}>Source · extracted from the page</Text>
            {source.state === 'shown' ? (
              <Text style={[styles.source, { color: theme.muted }]} selectable>
                {source.text ?? 'There’s no source text for this clip.'}
              </Text>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  disabled={source.state === 'loading'}
                  onPress={showSource}
                  style={[styles.linkButton, { backgroundColor: theme.surface }]}
                >
                  <Text style={[styles.linkText, { color: theme.text }]}>
                    {source.state === 'loading' ? 'Fetching from your Mac…' : 'Show the source'}
                  </Text>
                </Pressable>
                {source.state === 'failed' && <Text style={[styles.small, { color: theme.muted }]}>{source.message}</Text>}
              </>
            )}
          </View>
        )}
      </ScrollView>
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 60, gap: 18 },
  image: { width: '100%', borderRadius: 12 },
  heading: { gap: 4 },
  title: { fontFamily: fonts.serif, fontSize: 26, lineHeight: 32 },
  small: { fontSize: 13, lineHeight: 18 },
  muted: { fontSize: 15, lineHeight: 21, textAlign: 'left' },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  linkButton: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, maxWidth: '100%' },
  linkText: { fontSize: 15, fontWeight: '500' },
  section: { gap: 8 },
  label: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  summary: { fontSize: 15, lineHeight: 21 },
  notes: { borderRadius: 12, padding: 14 },
  notesText: { fontFamily: fonts.serif, fontSize: 17, lineHeight: 25 },
  source: { fontSize: 14, lineHeight: 20 },
});
