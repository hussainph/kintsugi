import { STORIES_API, Unpaired } from '@kintsugi/core/remote';
import type { Reason } from '@kintsugi/core/sections';
import { SymbolView } from 'expo-symbols';
import { useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { usePairing } from '@/lib/pairing';
import { feed, useMacApi } from '@/lib/sections-store';
import { useTheme } from '@/theme';

/** A small reasons card anchored to the question mark, never an inline label. */
export function FeedWhy({ id, reasons }: { id: number; reasons?: Reason[] }) {
  const theme = useTheme();
  const api = useMacApi();
  const { client, unpair } = usePairing();
  const anchor = useRef<React.ComponentRef<typeof View>>(null);
  const { width, height } = useWindowDimensions();
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [shown, setShown] = useState<Reason[] | undefined>();
  const [failed, setFailed] = useState(false);
  if (!reasons && api > 0 && api < STORIES_API) return null;

  const open = () => {
    setShown(reasons ?? feed.reasons(id));
    setFailed(false);
    anchor.current?.measureInWindow((x, y, w, h) => setPoint({ x: x + w, y: y + h }));
    if (reasons) return;
    if (!client) {
      setFailed(true);
      return;
    }
    feed.why(client, id).then(setShown).catch((e: unknown) => {
      if (e instanceof Unpaired) unpair();
      else setFailed(true);
    });
  };
  const visible = shown?.filter((r) => r.key !== 'cold');
  return (
    <>
      <View ref={anchor} collapsable={false}>
        <Pressable accessibilityRole="button" accessibilityLabel="Why this?" testID={`feed-why-${id}`} onPress={open} style={styles.button}>
          <SymbolView name="questionmark.circle" size={18} tintColor={theme.muted} />
        </Pressable>
      </View>
      <Modal visible={point !== null} transparent animationType="fade" onRequestClose={() => setPoint(null)}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close reasons" onPress={() => setPoint(null)} style={StyleSheet.absoluteFill} />
        {point && (
          <View accessibilityViewIsModal onAccessibilityEscape={() => setPoint(null)} testID="feed-reasons" style={[styles.card, {
            backgroundColor: theme.surface, borderColor: theme.border,
            width: Math.min(280, width - 32), left: Math.max(16, Math.min(point.x - 280, width - 296)),
            top: Math.max(64, Math.min(point.y + 8, height - 240)),
          }]}>
            {visible?.length ? visible.map((r) => <Text key={r.key} style={[styles.reason, { color: theme.text }]}>{r.label}</Text>) : (
              <Text style={[styles.reason, { color: theme.muted }]}>{shown === undefined && !failed ? 'Loading…' : 'You follow its source.'}</Text>
            )}
          </View>
        )}
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  card: { position: 'absolute', padding: 16, gap: 10, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  reason: { fontSize: 14, lineHeight: 20 },
});
