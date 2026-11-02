import type { ClipSummary } from '@kintsugi/core/clips';
import { merge3 } from '@kintsugi/core/merge';
import { HttpError, Offline, type PhoneClip, type Remote, Unpaired, type Versioned } from '@kintsugi/core/remote';

import type { Connection, KV } from './library';

/** One clip as the phone keeps it, so the library can be browsed, searched
 *  and annotated offline. Like a document (see library.ts), the owner's own
 *  text is kept twice: `base` is what the Mac last had (at `version`), and
 *  `text` is the phone's. They differ while an edit waits to be sent. The
 *  extracted source never comes to the phone; it is fetched when asked for. */
export type LocalClip = {
  /** The Mac's summary: title, link, image, tags… */
  clip: ClipSummary & { hasSource?: boolean };
  /** The owner's own text on this phone; null when the Mac is too old to
   *  send it (before API 5), so it can't be edited here. */
  text: string | null;
  /** The Mac's own text when this phone last agreed with it. */
  base: string | null;
  /** The Mac's version of `base`. */
  version: string | null;
  /** The Mac's text, when it and the phone's edit collide. */
  conflict?: Versioned;
  /** The clip was removed on the Mac while an edit to it waited here. */
  gone?: boolean;
};

export type ClipClient = Pick<Remote, 'inspiration' | 'clips' | 'writeClipNote'>;

const CLIP = 'clip:';

export const clipUnsent = (clip: LocalClip) => clip.text !== null && clip.text !== clip.base;

/** Newest first, then by path, as the Mac lists them. */
const order = (a: LocalClip, b: LocalClip) =>
  b.clip.captured.localeCompare(a.clip.captured) || (a.clip.path < b.clip.path ? -1 : a.clip.path > b.clip.path ? 1 : 0);

export class Inspiration {
  private clips = new Map<string, LocalClip>();
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private snapshot: { clips: LocalClip[]; connection: Connection } = { clips: [], connection: 'unknown' };
  private kv: KV;

  constructor(kv: KV) {
    this.kv = kv;
    for (const key of kv.getAllKeysSync()) {
      if (!key.startsWith(CLIP)) continue;
      try {
        const clip = JSON.parse(kv.getItemSync(key)!) as LocalClip;
        this.clips.set(clip.clip.path, clip);
      } catch {
        // An unreadable entry is skipped rather than hiding the library.
      }
    }
    this.publish('unknown');
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  get(path: string): LocalClip | null {
    return this.clips.get(path) ?? null;
  }

  /** The owner's notes changed here. `seen` is the text the editor showed
   *  when they typed, so a sync that landed since is folded in, not undone. */
  edit(path: string, text: string, seen?: string) {
    const local = this.clips.get(path);
    if (!local || local.text === null || local.text === text) return;
    if (seen !== undefined && seen !== local.text) {
      const merged = merge3(seen, text, local.text);
      if (merged.clean) return this.put({ ...local, text: merged.text });
      if (local.conflict || local.base === null || local.version === null || local.base === text) return this.put({ ...local, text });
      return this.put({ ...local, text, conflict: { text: local.base, version: local.version } });
    }
    this.put({ ...local, text });
  }

  keepMine(path: string) {
    const local = this.clips.get(path);
    if (!local?.conflict) return;
    const { conflict, ...rest } = local;
    this.put({ ...rest, base: conflict.text, version: conflict.version });
  }

  useTheirs(path: string) {
    const local = this.clips.get(path);
    if (!local?.conflict) return;
    const { conflict, ...rest } = local;
    this.put({ ...rest, text: conflict.text, base: conflict.text, version: conflict.version });
  }

  /** A clip removed on the Mac, with an edit only here: let it go. */
  discard(path: string) {
    if (this.clips.get(path)?.gone) this.remove(path);
  }

  /** Brings the copy up to date with the Mac and sends waiting note edits.
   *  Throws Offline or Unpaired; other failures leave edits waiting. */
  sync(client: ClipClient): Promise<void> {
    return this.serial(async () => {
      let remote: (PhoneClip | ClipSummary)[];
      try {
        remote = await client.inspiration();
      } catch (e) {
        // A Mac before API 5 lists summaries only: cards, but no notes.
        if (!(e instanceof HttpError && e.status === 404)) throw this.failed(e);
        try {
          remote = await client.clips();
        } catch (e2) {
          throw this.failed(e2);
        }
      }
      this.publish('online');
      const theirs = new Map(remote.map((c) => [c.path, c]));
      for (const [path, local] of [...this.clips]) {
        if (theirs.has(path)) continue;
        if (clipUnsent(local)) this.put({ ...local, gone: true }, false);
        else this.remove(path, false);
      }
      for (const mac of remote) {
        const { text, version, ...clip } = { text: null, version: null, ...mac } as PhoneClip | (ClipSummary & { text: null; version: null });
        const local = this.clips.get(mac.path);
        if (!local || text === null || local.text === null || !clipUnsent(local)) {
          this.put({ clip, text, base: text, version }, false);
        } else if (local.conflict) {
          this.put({ ...local, clip, gone: undefined, ...(version !== local.conflict.version ? { conflict: { text, version } } : {}) }, false);
        } else if (version !== local.version) {
          this.resolve({ ...local, clip, gone: undefined }, { text, version }, false);
        } else {
          this.put({ ...local, clip, gone: undefined }, false);
        }
      }
      this.publish();
      const failures: unknown[] = [];
      for (const local of [...this.clips.values()]) {
        if (!clipUnsent(local) || local.conflict || local.gone) continue;
        try {
          await this.send(client, local.clip.path);
        } catch (e) {
          if (e instanceof Offline || e instanceof Unpaired) throw this.failed(e);
          failures.push(e);
        }
      }
      if (failures.length) throw new AggregateError(failures, `Some notes are still waiting. ${String(failures[0])}`);
    });
  }

  /** Sends one clip's waiting note edit, if it has one. */
  push(client: ClipClient, path: string): Promise<void> {
    return this.serial(async () => {
      try {
        await this.send(client, path);
      } catch (e) {
        throw this.failed(e);
      }
    });
  }

  private async send(client: ClipClient, path: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const local = this.clips.get(path);
      if (!local || !clipUnsent(local) || local.conflict || local.gone || local.version === null) return;
      const sent = local.text!;
      let result;
      try {
        result = await client.writeClipNote(path, sent, local.version);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) {
          const now = this.clips.get(path);
          if (now) this.put({ ...now, gone: true });
          return;
        }
        throw e;
      }
      this.publish('online');
      const now = this.clips.get(path);
      if (!now) return;
      if (result.result === 'saved') {
        const { text, version, ...clip } = result.clip;
        // The Mac may tidy the text (trimmed blank lines); typing that went
        // on while this was in flight stays unsent.
        this.put({ ...now, clip, text: now.text === sent ? text : now.text, base: text, version });
        return;
      }
      if (!this.resolve(now, result.current)) return;
    }
  }

  /** Folds the Mac's text into an unsent edit. Returns false on a collision. */
  private resolve(local: LocalClip, mac: Versioned, notify = true): boolean {
    const { conflict: _, ...rest } = local;
    if (mac.text === local.text) {
      this.put({ ...rest, base: mac.text, version: mac.version }, notify);
      return true;
    }
    const merged = local.base === null || local.text === null ? null : merge3(local.base, local.text, mac.text);
    if (merged?.clean) {
      this.put({ ...rest, text: merged.text, base: mac.text, version: mac.version }, notify);
      return true;
    }
    this.put({ ...local, conflict: mac }, notify);
    return false;
  }

  private failed(e: unknown) {
    if (e instanceof Offline) this.publish('offline');
    return e;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private put(local: LocalClip, notify = true) {
    const clean = Object.fromEntries(Object.entries(local).filter(([, v]) => v !== undefined)) as LocalClip;
    this.kv.setItemSync(CLIP + clean.clip.path, JSON.stringify(clean));
    this.clips.set(clean.clip.path, clean);
    if (notify) this.publish();
  }

  private remove(path: string, notify = true) {
    this.kv.removeItemSync(CLIP + path);
    this.clips.delete(path);
    if (notify) this.publish();
  }

  private publish(connection = this.snapshot.connection) {
    this.snapshot = { clips: [...this.clips.values()].sort(order), connection };
    this.listeners.forEach((listener) => listener());
  }
}

/** The clips matching a search, in library order. Every word must appear
 *  (case-insensitively) somewhere in the clip: its title, summary, tags,
 *  site, author, link or the owner's own text. The extracted source isn't on
 *  the phone, so it isn't searched here. */
export function searchClips(clips: LocalClip[], query: string): LocalClip[] {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return clips;
  return clips.filter((local) => {
    const { clip } = local;
    const hay = [clip.title, clip.summary, clip.site, clip.author, clip.url, clip.kind, local.text, ...clip.tags.map((t) => `#${t}`)]
      .filter(Boolean)
      .join('\n')
      .toLocaleLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}
