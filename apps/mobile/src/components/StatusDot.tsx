import { View } from 'react-native';

import { useTheme } from '@/theme';

/** As on the desktop: a draft is an open ring, complete is filled. */
export function StatusDot({ status }: { status: string | null }) {
  const theme = useTheme();
  if (!status) return <View style={{ width: 7 }} />;
  const complete = status === 'complete';
  return (
    <View
      accessibilityLabel={status}
      style={{
        width: 7,
        height: 7,
        borderRadius: 4,
        borderWidth: complete ? 0 : 1,
        borderColor: theme.muted,
        backgroundColor: complete ? theme.primary : 'transparent',
      }}
    />
  );
}
