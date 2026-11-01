import { body, field, setField } from '@kintsugi/core/frontmatter';
import { merge3 } from '@kintsugi/core/merge';
import { type Document, HttpError, Offline, type Remote, Unpaired, type Versioned, version } from '@kintsugi/core/remote';

/** The phone's own copy of the writing, so anything can be opened, edited or
 *  started offline. Each document keeps the text the Mac last had (`base`,
 *  at `version`) next to the phone's text; they differ while an edit waits
 *  to be sent. Sending checks the version, and when the Mac moved on the
 *  two edits are merged against `base`. Only a true collision stops, as
 *  `conflict`, until the owner picks a version. */
export type LocalDoc = {
  path: string;
  /** The text on this phone. */
  text: string;
  /** The Mac's text when this phone last agreed with it; null for a note
   *  started here, or for an edit from before the phone kept a copy. */
  base: string | null;
  /** The Mac's version of `base`; null for a note started on this phone. */
  version: string | null;
  /** The Mac's copy, when it and the phone's edits collide. */
  conflict?: Versioned;
  /** The note was started on this phone and hasn't been sent yet. */
  fresh?: boolean;
  /** The last write on its way to the Mac, kept in case its reply is lost. */
  sent?: { path: string; text: string };
};

/** The few calls of expo-sqlite's kv-store this needs, so tests can use a Map. */
export type KV = {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
  removeItemSync(key: string): void;
  getAllKeysSync(): string[];
};

export type Client = Pick<Remote, 'library' | 'read' | 'write'>;
export type Connection = 'unknown' | 'online' | 'offline';

const DOC = 'doc:';
const LEGACY_DRAFT = 'draft:';
const LAST = 'library:last';
const VAULT = 'library:vault';
const INBOX = 'inbox';
const EMPTY = version('');

export const unsent = (doc: LocalDoc) => doc.text !== doc.base || doc.version === null;

/** How a document is listed: its title, else its first line, else its file name. */
export function docTitle(doc: Pick<LocalDoc, 'path' | 'text'>): string {
  return (
    field(doc.text, 'title') ??
    (captureTitle(body(doc.text)) || (doc.path.split('/').pop() ?? doc.path).replace(/\.mdx?$/, ''))
  );
}

export class Library {
  private docs = new Map<string, LocalDoc>();
  private moved = new Map<string, string>();
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private snapshot: { docs: LocalDoc[]; connection: Connection } = { docs: [], connection: 'unknown' };
  /** Notes being edited aren't named and sent until their first line is done. */
  open: string | null = null;

  private kv: KV;
  private now: () => Date;

  constructor(kv: KV, now = () => new Date()) {
    this.kv = kv;
    this.now = now;
    for (const key of kv.getAllKeysSync()) {
      try {
        if (key.startsWith(DOC)) {
          const doc = JSON.parse(kv.getItemSync(key)!) as LocalDoc;
          this.docs.set(doc.path, doc);
        }
      } catch {
        // An unreadable entry is skipped rather than blocking every document.
      }
    }
    // Edits saved per document before the phone kept a full copy: their
    // base text is unknown, so they send cleanly or ask.
    for (const key of kv.getAllKeysSync()) {
      if (!key.startsWith(LEGACY_DRAFT)) continue;
      const path = key.slice(LEGACY_DRAFT.length);
      try {
        const draft = JSON.parse(kv.getItemSync(key)!) as { text: string; base: string };
        if (!this.docs.has(path)) this.put({ path, text: draft.text, base: null, version: draft.base || null }, false);
      } catch {}
      kv.removeItemSync(key);
    }
    this.publish('unknown');
  }

  // ---- reading -----------------------------------------------------------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  get(path: string): LocalDoc | null {
    return this.docs.get(path) ?? null;
  }
  /** A document, following a note started here to its new name. */
  private find(path: string): LocalDoc | null {
    return this.docs.get(path) ?? this.docs.get(this.movedTo(path) ?? '') ?? null;
  }

  /** Where a note started on this phone went when it was named. */
  movedTo(path: string): string | null {
    const seen = new Set([path]);
    let next = this.moved.get(path) ?? null;
    while (next && !this.docs.has(next) && this.moved.has(next) && !seen.has(next)) {
      seen.add(next);
      next = this.moved.get(next)!;
    }
    return next;
  }

  /** The document the owner was in, to open the app where they left off. */
  get last(): string | null {
    const path = this.kv.getItemSync(LAST);
    return path && this.docs.has(path) ? path : null;
  }
  set last(path: string | null) {
    if (path) this.kv.setItemSync(LAST, path);
    else this.kv.removeItemSync(LAST);
  }
  get vaultName(): string | null {
    return this.kv.getItemSync(VAULT);
  }
  set vaultName(name: string) {
    this.kv.setItemSync(VAULT, name);
  }

  // ---- editing (always local, always instant) ----------------------------

  /** `seen` is the text the editor showed when the owner typed: if a merge
   *  or the Mac's update landed since, the keystroke is folded into it rather
   *  than undoing it. A keystroke that collides with it is kept, and the
   *  Mac's copy waits beside it as a conflict until the owner picks one. */
  edit(path: string, text: string, seen?: string) {
    const doc = this.find(path);
    if (!doc || doc.text === text) return;
    if (seen !== undefined && seen !== doc.text) {
      const merged = merge3(seen, text, doc.text);
      if (merged.clean) this.put({ ...doc, text: merged.text });
      else if (doc.conflict || doc.base === null || doc.version === null || doc.base === text) this.put({ ...doc, text });
      else this.put({ ...doc, text, conflict: { text: doc.base, version: doc.version } });
      return;
    }
    this.put({ ...doc, text });
  }

  /** Starts a note in the inbox; returns its path. `text` is its writing. */
  create(text = ''): string {
    const stamp = localStamp(this.now());
    const path = this.unique(`${INBOX}/note-${stamp.replace(/[T:]/g, '-')}`);
    const head = `---\nstatus: draft\ncaptured: ${quoted(stamp)}\n---\n\n`;
    this.put({ path, text: head + (text.trim() ? text.trim() + '\n' : ''), base: null, version: null, fresh: true });
    return path;
  }

  /** A note started here and left empty isn't worth keeping. */
  discardIfEmpty(path: string) {
    const doc = this.find(path);
    if (doc?.fresh && !body(doc.text).trim()) this.remove(doc.path);
  }

  /** The owner chose the phone's text over the Mac's: it is sent as is. */
  keepMine(path: string) {
    const doc = this.find(path);
    if (!doc?.conflict) return;
    const { conflict, ...rest } = doc;
    this.put({ ...rest, base: conflict.text, version: conflict.version });
  }

  /** The owner chose the Mac's text: the phone's edits are dropped. */
  useTheirs(path: string) {
    const doc = this.find(path);
    if (!doc?.conflict) return;
    const { conflict, ...rest } = doc;
    this.put({ ...rest, text: conflict.text, base: conflict.text, version: conflict.version });
  }

  // ---- syncing -----------------------------------------------------------

  /** Brings the whole copy up to date with the Mac and sends every waiting
   *  edit. Throws Offline or Unpaired; other failures leave edits waiting. */
  sync(client: Client): Promise<void> {
    return this.serial(async () => {
      let remote: Document[];
      try {
        remote = await client.library();
      } catch (e) {
        throw this.failed(e);
      }
      this.publish('online');
      const theirs = new Map(remote.map((d) => [d.path, d]));
      const failures: unknown[] = [];
      for (const path of [...this.docs.keys()]) {
        // Read afresh: typing and earlier sends change documents meanwhile.
        const doc = this.docs.get(path);
        if (!doc) continue;
        const mac = theirs.get(doc.path);
        try {
          if (doc.conflict) {
            if (mac && mac.version !== doc.conflict.version && this.resolve(doc, mac)) await this.send(client, doc.path);
          } else if (doc.fresh) {
            await this.send(client, doc.path);
          } else if (!unsent(doc)) {
            if (!mac) this.remove(doc.path); // Removed or renamed on the Mac.
            else if (mac.version !== doc.version) this.put({ ...doc, text: mac.text, base: mac.text, version: mac.version });
          } else if (mac && mac.version !== doc.version) {
            if (this.resolve(doc, mac)) await this.send(client, doc.path);
          } else {
            // Unchanged on the Mac, new here, or removed there while edited
            // here: the edits are sent, so no writing is lost.
            await this.send(client, doc.path);
          }
        } catch (e) {
          if (e instanceof Offline || e instanceof Unpaired) throw this.failed(e);
          failures.push(e);
        }
      }
      const landing = new Set([...this.docs.values()].flatMap((d) => (d.fresh && d.sent ? [d.sent.path] : [])));
      for (const mac of remote) {
        if (!this.docs.has(mac.path) && !landing.has(mac.path)) this.put({ path: mac.path, text: mac.text, base: mac.text, version: mac.version });
      }
      if (failures.length) throw new AggregateError(failures, `Some edits are still waiting. ${String(failures[0])}`);
    });
  }

  /** Sends one document's waiting edit, if it has one. */
  push(client: Client, path: string): Promise<void> {
    return this.serial(async () => {
      try {
        await this.send(client, this.find(path)?.path ?? path);
      } catch (e) {
        throw this.failed(e);
      }
    });
  }

  private async send(client: Client, startPath: string) {
    let path = startPath;
    // Names the Mac already uses for another document.
    const taken = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt++) {
      const doc = this.docs.get(path);
      if (!doc || doc.conflict || !unsent(doc)) return;
      const prior = doc.sent;
      let target = path;
      let text = doc.text;
      let base = doc.version ?? EMPTY;
      const title = doc.fresh ? this.title(doc) : null;
      if (doc.fresh) {
        // A note started here is named after its first line, as the Mac
        // names captures, and only renamed here once the Mac has it.
        if (!title) return;
        text = withTitle(doc.text, title);
        target = this.unique(`${INBOX}/${slugify(title)}`, path, taken);
        base = EMPTY;
        if (prior && !taken.has(prior.path)) {
          // An earlier send's reply never came: the note may be there already.
          if (prior.path === target || (await this.landed(client, prior))) {
            target = prior.path;
            base = version(prior.text);
          }
        }
      }
      // Re-read: typing may have gone on during the check above.
      this.put({ ...this.docs.get(path)!, sent: { path: target, text } }, false);
      const result = await client.write(target, text, base);
      this.publish('online');
      const now = this.docs.get(path);
      if (!now) return;
      const { sent: _, fresh, ...rest } = now;
      if (result.result === 'saved') {
        // Typing may have gone on while this was in flight: that stays unsent.
        const kept = fresh && title ? withTitle(now.text, title) : now.text;
        this.rename(path, target);
        this.put({ ...rest, path: target, text: kept, base: text, version: result.version });
        return;
      }
      const current = result.current;
      if (!fresh && prior && current.text === prior.text) {
        // The earlier send did land; only its reply was lost.
        this.put({ ...rest, base: current.text, version: current.version });
        continue;
      }
      if (fresh) {
        // The Mac has another document at this name: the next try picks another.
        taken.add(target);
        this.put(now.sent?.path === target ? { ...rest, fresh } : now, false);
        continue;
      }
      if (!this.resolve({ ...rest }, current)) return;
    }
  }

  /** Whether an earlier write of a new note reached the Mac. */
  private async landed(client: Client, sent: { path: string; text: string }): Promise<boolean> {
    try {
      return (await client.read(sent.path)).text === sent.text;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return false;
      throw e;
    }
  }

  /** Folds the Mac's copy into an unsent edit. Returns false on a collision. */
  private resolve(doc: LocalDoc, mac: Versioned): boolean {
    const { conflict: _, ...rest } = doc;
    if (mac.text === doc.text) {
      this.put({ ...rest, base: mac.text, version: mac.version });
      return true;
    }
    const merged = doc.base === null ? null : merge3(doc.base, doc.text, mac.text);
    if (merged?.clean) {
      this.put({ ...rest, text: merged.text, base: mac.text, version: mac.version });
      return true;
    }
    this.put({ ...doc, conflict: { text: mac.text, version: mac.version } });
    return false;
  }

  /** A note's title from its first line, once that line is done. */
  private title(doc: LocalDoc): string | null {
    const writing = body(doc.text);
    const title = captureTitle(writing);
    if (!title) return null;
    if (this.open === doc.path && !writing.trimStart().includes('\n')) return null;
    return title;
  }

  private rename(from: string, to: string) {
    const doc = this.docs.get(from);
    if (!doc || from === to) return;
    this.remove(from, false);
    this.moved.delete(to);
    this.moved.set(from, to);
    if (this.kv.getItemSync(LAST) === from) this.last = to;
    if (this.open === from) this.open = to;
    this.put({ ...doc, path: to });
  }

  /** `stem.mdx`, or `stem-2.mdx`…, not used by another local document. */
  private unique(stem: string, self?: string, taken?: Set<string>): string {
    for (let n = 1; ; n++) {
      const path = `${stem}${n === 1 ? '' : `-${n}`}.mdx`;
      if (taken?.has(path)) continue;
      if (path === self || !this.docs.has(path)) return path;
    }
  }

  private failed(e: unknown) {
    if (e instanceof Offline) this.publish('offline');
    return e;
  }

  /** One network conversation at a time, so two sends never race. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private put(doc: LocalDoc, notify = true) {
    this.kv.setItemSync(DOC + doc.path, JSON.stringify(doc));
    this.docs.set(doc.path, doc);
    if (notify) this.publish();
  }

  private remove(path: string, notify = true) {
    this.kv.removeItemSync(DOC + path);
    this.docs.delete(path);
    if (notify) this.publish();
  }

  private publish(connection = this.snapshot.connection) {
    this.snapshot = { docs: [...this.docs.values()], connection };
    this.listeners.forEach((listener) => listener());
  }
}

function withTitle(text: string, title: string): string {
  const change = setField(text, 'title', quoted(title));
  return text.slice(0, change.from) + change.insert + text.slice(change.to);
}

const quoted = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Local time as `2026-10-29T09:14`. */
function localStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Mirrors `kintsugi_vault::slugify`. */
export function slugify(title: string): string {
  let slug = '';
  for (const c of title.trim().toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(c)) slug += c;
    else if (!slug.endsWith('-')) slug += '-';
  }
  slug = slug.replace(/^-+|-+$/g, '');
  return slug ? [...slug].slice(0, 72).join('').replace(/-+$/, '') : 'untitled';
}

/** Mirrors `capture_title` in crates/vault: the first non-empty line, without
 *  heading or list marks, cut at a word if it runs long. */
export function captureTitle(text: string): string {
  const LIMIT = 60;
  const line = (text.trim().split('\n')[0] ?? '').replace(/^[#\-*> ]+/, '').trim();
  if ([...line].length <= LIMIT) return line;
  const cut = [...line].slice(0, LIMIT).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space === -1 ? cut : cut.slice(0, space)).replace(/[,;:.]+$/, '')}…`;
}
