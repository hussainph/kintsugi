import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useWindowDimensions, View } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { EditorHost } from '@/components/editor/EditorHost';
import { KinAvatar } from '@/components/KinAvatar';
import { PairingProvider } from '@/lib/pairing';
import { useNewEditor } from '@/lib/settings';
import { appearanceDetents } from '@/lib/appearance';
import { useResolvedScheme } from '@/lib/appearance-store';
import { useTheme } from '@/theme';

export default function Layout() {
  const scheme = useResolvedScheme();
  const theme = useTheme();
  const { height, fontScale } = useWindowDimensions();
  const sheet = appearanceDetents(height, fontScale);
  const newEditor = useNewEditor();
  return (
    <KeyboardProvider>
      <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        <PairingProvider>
          <View style={{ flex: 1 }}>
            <Stack screenOptions={{ headerShadowVisible: false, contentStyle: { backgroundColor: theme.background }, statusBarStyle: scheme === 'dark' ? 'light' : 'dark' }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="folder" />
              <Stack.Screen name="doc" />
              <Stack.Screen name="inspiration" />
              <Stack.Screen name="clip" />
              <Stack.Screen name="clip-notes" />
              <Stack.Screen name="feed" />
              <Stack.Screen name="feed-item" />
              <Stack.Screen name="ideas" />
              <Stack.Screen name="kin" options={{ presentation: 'modal', title: 'Kin' }} />
              <Stack.Screen name="pair" options={{ presentation: 'modal', title: 'Pair with your Mac' }} />
              <Stack.Screen name="appearance" options={{ presentation: 'formSheet', headerShown: false, sheetGrabberVisible: true, sheetCornerRadius: 28, sheetAllowedDetents: sheet.detents, sheetInitialDetentIndex: sheet.initial, sheetExpandsWhenScrolledToEdge: true, contentStyle: { backgroundColor: theme.surface } }} />
            </Stack>
            {/* The one editor WebView, over the doc screen (KI-36). */}
            {newEditor && <EditorHost />}
            {/* Kin, on every screen (KI-42). */}
            <KinAvatar />
          </View>
        </PairingProvider>
      </ThemeProvider>
    </KeyboardProvider>
  );
}
