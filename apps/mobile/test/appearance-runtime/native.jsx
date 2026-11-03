// RN-web does not implement Dynamic Type. This test-only adapter models the
// native Text font scaling and useWindowDimensions.fontScale at 200%. The
// controls, style definitions, preferences and DOM editor are production code.
import React from 'react';
import { StyleSheet, Text as WebText, useWindowDimensions as useWebDimensions } from 'react-native-web';
export * from 'react-native-web';

const fontScale = Number(new URLSearchParams(location.search).get('fontScale') ?? 1);
export function useWindowDimensions() {
  return { ...useWebDimensions(), fontScale };
}
export const Text = React.forwardRef(function Text({ style, allowFontScaling = true, ...props }, ref) {
  const flat = StyleSheet.flatten(style) ?? {};
  return <WebText ref={ref} {...props} style={[style, allowFontScaling && {
    ...(flat.fontSize ? { fontSize: flat.fontSize * fontScale } : {}),
    ...(flat.lineHeight ? { lineHeight: flat.lineHeight * fontScale } : {}),
  }]} />;
});
