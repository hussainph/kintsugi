import type { Chip } from '@kintsugi/core/sections';
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

import { setScreenChips } from './sections-store';

/** Tells Kin's avatar what this screen shows (a document, a clip, a feed
 *  item, an idea) while it is focused, so the chat opens with it attached. */
export function useScreenContext(chips: Chip[] | null) {
  const key = JSON.stringify(chips ?? []);
  useFocusEffect(
    useCallback(() => {
      setScreenChips(JSON.parse(key) as Chip[]);
      return () => setScreenChips([]);
    }, [key]),
  );
}
