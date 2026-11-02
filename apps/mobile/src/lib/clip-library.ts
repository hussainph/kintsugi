import { INSPIRATION_API, type Remote } from '@kintsugi/core/remote';
import Storage from 'expo-sqlite/kv-store';
import { useSyncExternalStore } from 'react';

import { Inspiration, type LocalClip } from './inspiration';
import { thumbnails } from './thumbnail-store';

/** The phone's copy of the Inspiration library, in the app's SQLite key-value store. */
export const inspiration = new Inspiration(Storage);

export function useInspiration() {
  return useSyncExternalStore(inspiration.subscribe, inspiration.getSnapshot);
}

/** Read from the snapshot, not `inspiration.get` (see useDoc). */
export function useClip(path: string): LocalClip | null {
  return useInspiration().clips.find((c) => c.clip.path === path) ?? null;
}

/** Catches the clips up with the Mac, sends waiting note edits, then fetches
 *  any card images the phone doesn't have. Images need API 5; an older Mac
 *  shows cards without them. Throws what the clip sync throws. */
export async function syncInspiration(client: Remote, api?: number) {
  let failure: unknown = null;
  try {
    await inspiration.sync(client);
  } catch (e) {
    // Notes that couldn't be sent wait; the cards are still current.
    if (!(e instanceof AggregateError)) throw e;
    failure = e;
  }
  const known = api ?? (await client.hello()).api;
  if (known >= INSPIRATION_API) {
    // Images are a nicety: one that fails comes on the next sync.
    void thumbnails.update(inspiration.getSnapshot().clips.map((c) => c.clip), client.clipImage).catch(() => {});
  }
  if (failure) throw failure;
}
