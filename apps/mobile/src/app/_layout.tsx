import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

import { PairingProvider } from '@/lib/pairing';

export default function Layout() {
  const scheme = useColorScheme();
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <PairingProvider>
        <Stack screenOptions={{ headerShadowVisible: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="folder" />
          <Stack.Screen name="doc" />
          <Stack.Screen name="pair" options={{ presentation: 'modal', title: 'Pair with your Mac' }} />
        </Stack>
      </PairingProvider>
    </ThemeProvider>
  );
}
