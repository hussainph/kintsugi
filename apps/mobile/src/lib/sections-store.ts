import { Offline, type Remote, SECTIONS_API, Unpaired } from '@kintsugi/core/remote';
import type { Chip } from '@kintsugi/core/sections';
import { randomUUID } from 'expo-crypto';
import Storage from 'expo-sqlite/kv-store';
import { useSyncExternalStore } from 'react';

import { library } from './documents';
import { Feed } from './feed';
import { Ideas } from './ideas';
import { Kin } from './kin';

/** The phone's Feed, Ideas and Kin, kept in the app's SQLite key-value store. */
export const feed = new Feed(Storage);
export const ideas = new Ideas(Storage);
export const kin = new Kin(Storage, randomUUID);

export const useFeed = () => useSyncExternalStore(feed.subscribe, feed.getSnapshot);
export const useIdeas = () => useSyncExternalStore(ideas.subscribe, ideas.getSnapshot);
export const useKin = () => useSyncExternalStore(kin.subscribe, kin.getSnapshot);

/** The Mac's phone API version, once it has said (0: not yet). */
let macApi = 0;
const apiListeners = new Set<() => void>();
export function setMacApi(api: number) {
  if (api === macApi) return;
  macApi = api;
  apiListeners.forEach((l) => l());
}
export const useMacApi = () =>
  useSyncExternalStore(
    (l) => {
      apiListeners.add(l);
      return () => apiListeners.delete(l);
    },
    () => macApi,
  );

/** A Mac before API 6 has no Feed, Ideas or Kin for the phone. */
export const OLD_MAC = 'Update Kintsugi on your Mac to see the Feed, Ideas and Kin here.';

/** Asks the Mac its API version when the phone doesn't know it yet. */
async function knownApi(client: Remote): Promise<number> {
  if (!macApi) setMacApi((await client.hello()).api);
  return macApi;
}

/** Brings one section up to date. Offline is not a failure here: each
 *  section says so itself. Throws Unpaired. */
export async function syncSection(client: Remote, section: 'feed' | 'ideas' | 'kin'): Promise<void> {
  try {
    if ((await knownApi(client)) < SECTIONS_API) return;
    if (section === 'feed') await feed.sync(client);
    if (section === 'kin') await kin.sync(client);
    if (section === 'ideas') {
      // An adopted idea is a new draft on the Mac: bring it to the phone.
      if ((await ideas.sync(client)).length) await library.sync(client).catch(() => {});
    }
  } catch (e) {
    if (e instanceof Unpaired) throw e;
    if (!(e instanceof Offline)) console.warn(`${section}: ${String(e)}`);
  }
}

/** Everything waiting goes, and each copy catches up, when the home screen
 *  loads. */
export async function syncSections(client: Remote, api: number) {
  setMacApi(api);
  if (api < SECTIONS_API) return;
  for (const section of ['kin', 'ideas', 'feed'] as const) await syncSection(client, section);
}

// ── What's on screen, for Kin's context chips ─────────────────────────────

let onScreen: Chip[] = [];
/** Screens say what they show while they're focused (see `useScreenContext`). */
export function setScreenChips(chips: Chip[]) {
  onScreen = chips;
}
export const screenChips = () => onScreen;
