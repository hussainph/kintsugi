import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { appearance, useAppearance } from '@/lib/appearance-store';
import { type AppearanceMode, stepSize, TEXT_SIZES } from '@/lib/appearance';
import { appearanceStyle as tokens, fonts, useTheme } from '@/theme';

const MODES: { mode: AppearanceMode; label: string }[] = [
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'system', label: 'System' },
];

type Props = { onDone: () => void; expanded: boolean; onContentHeight?: (height: number) => void };

/** The sheet's native controls. Changes apply now; dismissal never rolls back. */
export function AppearancePanel({ onDone, expanded, onContentHeight }: Props) {
  const theme = useTheme();
  const { mode, textSize } = useAppearance();
  const { fontScale, width } = useWindowDimensions();
  const stacked = fontScale > 1.2 || width < 350;
  const percent = `${Math.round(textSize * 100)}%`;
  return (
    <View style={[styles.panel, { backgroundColor: theme.surface }]} testID="appearance-panel">
      <View style={styles.header}>
        <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>Appearance</Text>
        <Pressable accessibilityRole="button" onPress={onDone} style={styles.done}>
          <Text style={[styles.title, { color: theme.text }]}>Done</Text>
        </Pressable>
      </View>
      <ScrollView
        scrollEnabled={expanded}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={styles.content}
        onContentSizeChange={(_width, height) => onContentHeight?.(height)}
        testID="appearance-scroll"
      >
        <View accessibilityRole="radiogroup" accessibilityLabel="Appearance" style={[styles.segment, fontScale > 1.2 && styles.segmentStacked, { backgroundColor: theme.border }]}>
          {MODES.map((option) => (
            <Pressable
              key={option.mode}
              accessibilityRole="radio"
              accessibilityState={{ checked: mode === option.mode }}
              aria-checked={mode === option.mode}
              testID={`appearance-${option.mode}`}
              onPress={() => appearance.setMode(option.mode)}
              style={[styles.segmentHit, fontScale > 1.2 && styles.segmentHitStacked]}
            >
              <View style={[styles.segmentItem, { backgroundColor: mode === option.mode ? theme.selected : 'transparent' }]}>
                <Text style={[styles.label, { color: theme.text }, mode === option.mode && styles.selected]}>{option.label}</Text>
              </View>
            </Pressable>
          ))}
        </View>
        <View style={[styles.preview, { backgroundColor: theme.background, borderColor: theme.border }]} testID="appearance-preview">
          <Text style={[styles.previewTitle, { color: theme.text, fontSize: tokens.previewTitle.fontSize * textSize, lineHeight: tokens.previewTitle.lineHeight * textSize }]}>
            Kintsugi and gold {/* copy-lint-allow: verbatim Paper writing sample */}
          </Text>
          {/* copy-lint-allow: the Paper design's live writing sample, not helper copy */}
          <Text style={[styles.previewBody, { color: theme.text, fontSize: tokens.previewBody.fontSize * textSize, lineHeight: tokens.previewBody.lineHeight * textSize }]}>
            The first time I saw a kintsugi bowl I thought the gold was decoration. {/* copy-lint-allow: verbatim Paper writing sample */}
          </Text>
        </View>
        <View style={[styles.controls, { backgroundColor: theme.background }]}>
          <View style={[styles.row, stacked && styles.stacked]}>
            <Text style={[styles.label, { color: theme.text }]}>Text size</Text>
            <View style={styles.stepper}>
              {([-1, 1] as const).map((direction) => {
                const disabled = direction === -1 ? textSize <= TEXT_SIZES[0] : textSize >= TEXT_SIZES[TEXT_SIZES.length - 1];
                return (
                  <View key={direction} style={styles.stepPart}>
                    {direction === 1 && <Text accessibilityLiveRegion="polite" style={[styles.percent, { color: theme.text }]}>{percent}</Text>}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={direction === -1 ? 'Smaller text' : 'Larger text'}
                      accessibilityState={{ disabled }}
                      disabled={disabled}
                      onPress={() => appearance.setTextSize(stepSize(textSize, direction))}
                      style={styles.stepButton}
                    >
                      <Text style={[styles.stepText, { color: disabled ? theme.faint : theme.text }]}>{direction === -1 ? '−' : '+'}</Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          </View>
          <View style={[styles.row, styles.fontRow, { borderColor: theme.border }, stacked && styles.stacked]}>
            <Text style={[styles.label, { color: theme.text }]}>Editor font</Text>
            <Text style={[styles.font, { color: theme.muted }]}>New York</Text>
          </View>
        </View>
        <View style={styles.reserved} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: tokens.gap, paddingHorizontal: tokens.inset, paddingTop: tokens.gap },
  title: { ...tokens.label, fontWeight: '600', flexShrink: 1 },
  done: { minHeight: tokens.hit, minWidth: tokens.hit, justifyContent: 'center', alignItems: 'center' },
  content: { padding: tokens.inset, gap: tokens.gap, paddingBottom: tokens.inset + tokens.reserved },
  label: { ...tokens.label, flexShrink: 1 },
  selected: { fontWeight: '600' },
  segment: { flexDirection: 'row', borderRadius: tokens.segmentRadius },
  segmentStacked: { flexDirection: 'column' },
  segmentHit: { flex: 1, minHeight: tokens.hit, padding: tokens.segmentInset },
  segmentHitStacked: { flex: 0 },
  segmentItem: { flex: 1, borderRadius: tokens.segmentItemRadius, justifyContent: 'center', alignItems: 'center', paddingVertical: tokens.segmentInset },
  preview: { padding: tokens.inset, gap: tokens.gap / 2, borderRadius: tokens.radius, borderWidth: StyleSheet.hairlineWidth },
  previewTitle: { fontFamily: fonts.serif, fontWeight: '700' },
  previewBody: { fontFamily: fonts.serif },
  controls: { borderRadius: tokens.radius },
  row: { minHeight: tokens.row, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: tokens.gap / 2, paddingHorizontal: tokens.inset, paddingVertical: (tokens.row - tokens.hit) / 2 },
  stacked: { flexDirection: 'column', alignItems: 'flex-start', paddingVertical: tokens.gap / 2 },
  stepper: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end' },
  stepPart: { flexDirection: 'row', alignItems: 'center' },
  stepButton: { minWidth: tokens.hit, minHeight: tokens.hit, alignItems: 'center', justifyContent: 'center' },
  stepText: tokens.step,
  percent: { ...tokens.percent, minWidth: 48, textAlign: 'center', fontVariant: ['tabular-nums'] },
  fontRow: { borderTopWidth: StyleSheet.hairlineWidth },
  font: tokens.value,
  reserved: { height: tokens.reserved },
});
