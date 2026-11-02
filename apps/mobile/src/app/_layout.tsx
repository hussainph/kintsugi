import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme, View } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { EditorHost } from '@/components/editor/EditorHost';
import { KinAvatar } from '@/components/KinAvatar';
import { PairingProvider } from '@/lib/pairing';
import { useNewEditor } from '@/lib/settings';

export default function Layout() {
  const scheme = useColorScheme();
  const newEditor = useNewEditor();
  return (
    <KeyboardProvider>
      <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        <PairingProvider>
          <View style={{ flex: 1 }}>
            <Stack screenOptions={{ headerShadowVisible: false }}>
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
