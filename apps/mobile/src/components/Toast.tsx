import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/theme';

/** Sends what the owner just did, a moment after he did it. */
export function useSendWhenWaiting(waiting: number, send: () => Promise<void>) {
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => void send(), 400);
    return () => clearTimeout(timer);
  }, [waiting, send]);
}

/** A short note at the bottom with Undo, gone after a few seconds. */
export function Toast({ text, onUndo, onClose }: { text: string; onUndo?: () => void; onClose: () => void }) {
  const theme = useTheme();
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const timer = setTimeout(() => close.current(), 6_000);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <View style={[styles.toast, { backgroundColor: theme.primary }]} accessibilityLiveRegion="polite" testID="toast">
      <Text style={[styles.toastText, { color: theme.onPrimary }]}>{text}</Text>
      {onUndo && (
        <Pressable accessibilityRole="button" onPress={onUndo} hitSlop={8}>
          <Text style={[styles.undo, { color: theme.onPrimary }]}>Undo</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  toast: { position: 'absolute', left: 16, right: 84, bottom: 40, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  toastText: { flex: 1, fontSize: 14, lineHeight: 19 },
  undo: { fontSize: 14, fontWeight: '700' },
});
