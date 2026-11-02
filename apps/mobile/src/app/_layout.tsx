import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme, View } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { EditorHost } from '@/components/editor/EditorHost';
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
              <Stack.Screen name="pair" options={{ presentation: 'modal', title: 'Pair with your Mac' }} />
            </Stack>
            {/* The one editor WebView, over the doc screen (KI-36). */}
            {newEditor && <EditorHost />}
          </View>
        </PairingProvider>
      </ThemeProvider>
    </KeyboardProvider>
  );
}
