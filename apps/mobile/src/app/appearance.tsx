import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppearancePanel } from '@/components/AppearancePanel';
import { appearanceDetents } from '@/lib/appearance';
import { useTheme } from '@/theme';

export default function AppearanceScreen() {
  const theme = useTheme();
  const { height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { detents, initial } = appearanceDetents(height, fontScale);
  const [expanded, setExpanded] = useState(initial > 0 || detents.length === 1);
  const [contentHeight, setContentHeight] = useState(0);
  // The sample grows with the text size. Keep it visible without scrolling
  // at the first detent; accessibility can always use the full-height one.
  const compact = Math.min(1, Math.max(520, contentHeight + 60 * Math.max(1, fontScale) + insets.bottom + 20) / height);
  const allowed = compact < 1 ? [compact, 1] : [1];
  return (
    <View style={{ flex: 1, backgroundColor: theme.surface, paddingBottom: insets.bottom }}>
      <Stack.Screen
        options={{ sheetAllowedDetents: allowed, sheetInitialDetentIndex: initial > 0 ? allowed.length - 1 : 0 }}
        listeners={{ sheetDetentChange: (event) => setExpanded(event.data.index > 0 || allowed.length === 1) }}
      />
      <AppearancePanel expanded={expanded || allowed.length === 1} onDone={() => router.back()} onContentHeight={setContentHeight} />
    </View>
  );
}
