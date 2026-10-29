import { parsePairLink } from '@kintsugi/core/remote';
import * as Clipboard from 'expo-clipboard';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { fonts, useTheme } from '@/theme';

/** Before pairing: how to connect to the Mac. */
export function Welcome() {
  const theme = useTheme();
  const [error, setError] = useState<string | null>(null);

  const paste = async () => {
    const pairing = parsePairLink(await Clipboard.getStringAsync());
    if (!pairing) return setError('Copy the pairing link on your Mac first: Connect your phone → Copy link.');
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
      <Text style={[styles.lede, { color: theme.text }]}>
        Write and capture ideas into your Kintsugi vault from here, whenever your Mac is awake.
      </Text>
      <Text style={[styles.step, { color: theme.muted }]}>
        1. On your Mac, open Kintsugi and click Connect your phone at the bottom of the sidebar.
      </Text>
      <Text style={[styles.step, { color: theme.muted }]}>
        2. Turn on phone access, then scan the code with your camera. Or click Copy link on the Mac and paste it
        here.
      </Text>
      <Pressable onPress={paste} style={[styles.button, { backgroundColor: theme.primary }]}>
        <Text style={[styles.buttonText, { color: theme.onPrimary }]}>Paste pairing link</Text>
      </Pressable>
      {error && <Text style={[styles.step, { color: theme.danger }]}>{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 16 },
  lede: { fontFamily: fonts.serif, fontSize: 21, lineHeight: 29 },
  step: { fontSize: 15, lineHeight: 21 },
  button: { alignSelf: 'flex-start', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, marginTop: 8 },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
