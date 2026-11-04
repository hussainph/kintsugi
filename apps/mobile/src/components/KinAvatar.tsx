import { router, usePathname } from 'expo-router';
import { useEffect, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePairing } from '@/lib/pairing';
import { screenChips, useKin } from '@/lib/sections-store';
import { useTheme } from '@/theme';

/** Kin's placeholder mark, as on the Mac: a dark bowl with one gold seam.
 *  KI-23 and KI-41 design the real one; swap it here. */
export function KinMark({ size = 44 }: { size?: number }) {
  const theme = useTheme();
  const u = size / 40;
  const seam = (left: number, top: number, length: number, angle: number) => (
    <View
      style={{
        position: 'absolute',
        left: left * u,
        top: top * u,
        width: 2.4 * u,
        height: length * u,
        borderRadius: 1.2 * u,
        backgroundColor: theme.kin,
        transform: [{ rotate: `${angle}deg` }],
      }}
    />
  );
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: theme.primary, overflow: 'hidden' }}>
      {seam(13, 8, 10, -37)}
      {seam(14.5, 16.5, 6, 31)}
      {seam(16.5, 20.5, 8.5, -54)}
      {seam(19, 26.5, 7, 16)}
      <View style={{ position: 'absolute', left: 24.2 * u, top: 14.2 * u, width: 3.6 * u, height: 3.6 * u, borderRadius: 1.8 * u, backgroundColor: theme.background }} />
    </View>
  );
}

/** Where the avatar doesn't float: Kin's own chat, and pairing. */
const HIDDEN = ['/kin', '/pair'];

/** One avatar on every screen, bottom right, opening Kin's one chat with
 *  whatever the screen shows attached as context chips. A gold dot means
 *  Kin replied, or messages wait here for the Mac. */
export function KinAvatar() {
  const { client } = usePairing();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { outgoing, entries } = useKin();
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setTyping(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setTyping(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  if (!client || typing || HIDDEN.includes(pathname)) return null;
  const last = entries.at(-1);
  const dot = outgoing.length > 0 || (last != null && last.role !== 'owner' && last.seq > seenThrough);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={outgoing.length ? `Kin, ${outgoing.length} waiting` : 'Kin'}
      testID="kin-avatar"
      onPress={() => router.push({ pathname: '/kin', params: { chips: JSON.stringify(screenChips()) } })}
      style={({ pressed }) => [styles.avatar, { bottom: insets.bottom + 76, opacity: pressed ? 0.8 : 1 }]}
    >
      <KinMark />
      {dot && <View style={[styles.dot, { backgroundColor: theme.kin, borderColor: theme.background }]} />}
    </Pressable>
  );
}

/** The newest entry he has seen in the chat. */
let seenThrough = 0;
export function markKinSeen(seq: number) {
  seenThrough = Math.max(seenThrough, seq);
}

const styles = StyleSheet.create({
  avatar: {
    position: 'absolute',
    right: 18,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    borderRadius: 22,
  },
  dot: { position: 'absolute', top: -1, right: -1, width: 13, height: 13, borderRadius: 7, borderWidth: 2 },
});
