import type { ClipSummary } from '@kintsugi/core/clips';
import { version } from '@kintsugi/core/remote';

import type { KV } from './library';

/** Where cached images live: a folder of files on the phone. The real one
 *  is expo-file-system (thumbnail-store.ts); tests use a Map. */
export type ImageStore = {
  /** A URI an <Image> can show, for a file in the store. */
  uri(name: string): string;
  exists(name: string): boolean;
  remove(name: string): void;
  /** Every file in the store, to clear out ones nothing points at. */
  list(): string[];
  /** Downloads to `name`, replacing nothing. Rejects with `NoImage` when the
   *  Mac says the clip has none (404), any other error otherwise. */
  download(url: string, headers: Record<string, string>, name: string): Promise<void>;
};

export type ImageSource = (path: string) => { url: string; headers: Record<string, string> };

/** The Mac answered that the clip has no image it can serve. */
export class NoImage extends Error {}

/** What the phone knows about one clip's image: its file, or that the Mac
 *  has none for it. Keyed by the clip's `image` field, so a new image
 *  (enrichment found a hero image) is fetched again. */
type Entry = { image: string; file: string | null };

const KEY = 'thumb:';
/** A few at once: enough to fill a screen quickly over Tailscale. */
const PARALLEL = 3;

/** The file name for a clip's image: stable, filesystem-safe, and changed
 *  when the image is. */
export function imageFile(path: string, image: string): string {
  const ext = (image.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? 'img').toLowerCase();
  return `${version(`${path}\0${image}`)}.${ext}`;
}

/** The images on the clip cards, kept on the phone so the library looks
 *  the same offline. Cards are fetched once and then only when a clip's
 *  image changes; images of clips gone from the Mac are deleted. */
export class Thumbnails {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private revision = 0;
  private kv: KV;
  private store: ImageStore;

  constructor(kv: KV, store: ImageStore) {
    this.kv = kv;
    this.store = store;
    for (const key of kv.getAllKeysSync()) {
      if (!key.startsWith(KEY)) continue;
      try {
        this.entries.set(key.slice(KEY.length), JSON.parse(kv.getItemSync(key)!) as Entry);
      } catch {}
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** Changes whenever an image arrives, for useSyncExternalStore. */
  getRevision = () => this.revision;

  /** The card's image on this phone, or null (not fetched yet, or none). */
  uri(clip: Pick<ClipSummary, 'path' | 'image'>): string | null {
    const entry = this.entries.get(clip.path);
    if (!clip.image || !entry?.file || entry.image !== clip.image || !this.store.exists(entry.file)) return null;
    return this.store.uri(entry.file);
  }

  /** Fetches the images the phone doesn't have yet and clears out the ones
   *  no clip uses any more. One run at a time; stops at the first failure
   *  that isn't "no image" (the Mac went away), to try again next sync. */
  update(clips: Pick<ClipSummary, 'path' | 'image'>[], source: ImageSource): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run(clips, source).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(clips: Pick<ClipSummary, 'path' | 'image'>[], source: ImageSource) {
    this.prune(clips);
    const wanted = clips.filter((clip) => {
      if (!clip.image) return false;
      const entry = this.entries.get(clip.path);
      if (entry?.image !== clip.image) return true;
      return entry.file !== null && !this.store.exists(entry.file);
    });
    let failure: unknown = null;
    const next = () => (failure ? undefined : wanted.shift());
    const worker = async () => {
      for (let clip = next(); clip; clip = next()) {
        const image = clip.image!;
        const file = imageFile(clip.path, image);
        try {
          if (this.store.exists(file)) this.store.remove(file);
          const { url, headers } = source(clip.path);
          await this.store.download(url, headers, file);
          this.set(clip.path, { image, file });
        } catch (e) {
          if (e instanceof NoImage) this.set(clip.path, { image, file: null });
          else failure ??= e;
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    if (failure) throw failure;
  }

  /** Forgets images of clips that are gone or have a different image now. */
  private prune(clips: Pick<ClipSummary, 'path' | 'image'>[]) {
    const current = new Map(clips.map((clip) => [clip.path, clip.image]));
    for (const [path, entry] of [...this.entries]) {
      if (current.get(path) === entry.image) continue;
      this.entries.delete(path);
      this.kv.removeItemSync(KEY + path);
    }
    const kept = new Set([...this.entries.values()].flatMap((entry) => (entry.file ? [entry.file] : [])));
    for (const name of this.store.list()) if (!kept.has(name)) this.store.remove(name);
  }

  private set(path: string, entry: Entry) {
    this.entries.set(path, entry);
    this.kv.setItemSync(KEY + path, JSON.stringify(entry));
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }
}
