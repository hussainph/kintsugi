import { parsePairLink } from '@kintsugi/core/remote';
import * as Clipboard from 'expo-clipboard';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { usePairing } from '@/lib/pairing';
import { startSample } from '@/lib/sample';
import { useTheme } from '@/theme';

/** Before pairing: how to connect to the Mac. */
export function Welcome() {
  const theme = useTheme();
  const [error, setError] = useState<string | null>(null);
  const { pair } = usePairing();

  const paste = async () => {
    const pairing = parsePairLink(await Clipboard.getStringAsync());
    if (!pairing) return setError('No pairing link on the clipboard.');
    setError(null);
    router.push({ pathname: '/pair', params: pairing });
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
    >
      <Stack.Title large>Kintsugi</Stack.Title>
      <Text style={[styles.step, { color: theme.muted }]}>On your Mac, click Connect your phone and scan the code.</Text>
      <Pressable onPress={paste} style={[styles.button, { backgroundColor: theme.primary }]}>
        <Text style={[styles.buttonText, { color: theme.onPrimary }]}>Paste pairing link</Text>
      </Pressable>
      {error && <Text style={[styles.step, { color: theme.danger }]}>{error}</Text>}
      {__DEV__ && (
        // KI-36: try the new editor in Expo Go without a Mac. The notes stay
        // on this phone and go when you unpair (Home → ⋯ → Unpair).
        <Pressable accessibilityRole="button" onPress={() => startSample(pair)} style={[styles.button, styles.secondary, { borderColor: theme.border }]}>
          <Text style={[styles.buttonText, { color: theme.text }]}>Try sample notes</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12 },
  step: { fontSize: 15, lineHeight: 21 },
  button: { alignSelf: 'flex-start', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, marginTop: 4 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  secondary: { borderWidth: 1 },
});
