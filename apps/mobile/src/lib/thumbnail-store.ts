import { Directory, File, Paths } from 'expo-file-system';
import Storage from 'expo-sqlite/kv-store';
import { useSyncExternalStore } from 'react';

import { type ImageStore, NoImage, Thumbnails } from './thumbnails';

/** In Documents rather than Caches: iOS may empty Caches under storage
 *  pressure, and the cards should look the same offline. */
const folder = new Directory(Paths.document, 'clip-images');

const store: ImageStore = {
  uri: (name) => new File(folder, name).uri,
  exists: (name) => new File(folder, name).exists,
  remove: (name) => {
    try {
      new File(folder, name).delete();
    } catch {}
  },
  list: () => (folder.exists ? folder.list().flatMap((item) => (item instanceof File ? [item.name] : [])) : []),
  async download(url, headers, name) {
    folder.create({ idempotent: true, intermediates: true });
    try {
      await File.downloadFileAsync(url, new File(folder, name), { headers, idempotent: true });
    } catch (e) {
      // expo-file-system reports the status only in its message.
      if (/status 404\b|HTTP 404\b/.test(String(e))) throw new NoImage();
      throw e;
    }
  },
};

/** The card images kept on this phone. */
export const thumbnails = new Thumbnails(Storage, store);

/** A card's image URI, re-rendering when it arrives. */
export function useThumbnail(clip: { path: string; image: string | null }): string | null {
  useSyncExternalStore(thumbnails.subscribe, thumbnails.getRevision);
  return thumbnails.uri(clip);
}
