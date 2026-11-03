import Storage from 'expo-sqlite/kv-store';
import { useSyncExternalStore } from 'react';
import { Appearance, Platform, useColorScheme } from 'react-native';

import { AppearancePreferences, resolveScheme } from './appearance';

export const appearance = new AppearancePreferences(Storage);

// Apply before the first screen mounts, including native menus and alerts.
function applyNativeMode() {
  const { mode } = appearance.getSnapshot();
  // react-native-web does not implement app-level overrides. Its system
  // subscription still follows matchMedia; useResolvedScheme resolves our UI.
  if (Platform.OS !== 'web') Appearance.setColorScheme(mode === 'system' ? 'auto' : mode);
}
applyNativeMode();
appearance.subscribe(applyNativeMode);

export function useAppearance() {
  return useSyncExternalStore(appearance.subscribe, appearance.getSnapshot, appearance.getSnapshot);
}

export function useResolvedScheme() {
  const { mode } = useAppearance();
  return resolveScheme(mode, useColorScheme());
}
