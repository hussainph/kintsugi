import { remote } from '@kintsugi/core/remote';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePairing } from '@/lib/pairing';
import { useTheme } from '@/theme';

/** Opened by `kintsugi://pair?url=…&token=…` from the desktop's QR code, or
 *  by pasting that link. Checks the Mac answers before saving anything. */
export default function Pair() {
  const { url, token } = useLocalSearchParams<{ url?: string; token?: string }>();
  const { pair } = usePairing();
  const theme = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!url || !token) return;
    let live = true;
    remote({ url, token })
      .hello()
      .then(() => {
        if (!live) return;
        pair({ url, token });
        router.dismissTo('/');
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [url, token, pair, attempt]);

  const problem = !url || !token ? "That link doesn't look like a Kintsugi pairing link." : error;

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      {problem ? (
        <>
          <Text style={[styles.message, { color: theme.text }]}>{problem}</Text>
          <Text style={[styles.hint, { color: theme.muted }]}>
            Check that Kintsugi is open on your Mac with phone access on, and that Tailscale is connected on both.
          </Text>
          <Pressable
            onPress={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}             style={[styles.button, { backgroundColor: theme.primary }]}
          >
            <Text style={[styles.buttonText, { color: theme.onPrimary }]}>Try again</Text>
          </Pressable>
        </>
      ) : (
        <>
          <ActivityIndicator />
          <Text style={[styles.hint, { color: theme.muted }]}>Reaching your Mac…</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32 },
  message: { fontSize: 17, textAlign: 'center' },
  hint: { fontSize: 15, textAlign: 'center', lineHeight: 21 },
  button: { borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12 },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
