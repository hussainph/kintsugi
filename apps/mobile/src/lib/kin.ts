import { HttpError, Offline, Unpaired } from '@kintsugi/core/remote';
import type { Chip, Job } from '@kintsugi/core/sections';

import type { Entry, KinRoutes, Thread, ThreadList, ThreadView } from './kin-api.ts';
import type { Connection, KV } from './library';
import { permanent, Waiting } from './waiting.ts';

/** Where a message goes: a reply in a thread the Mac has, or a new thread
 *  started on the phone (`draft`, the phone's own id for it until the Mac
 *  answers with the thread's). */
export type Target = { thread: string } | { draft: string };

/** A message written on the phone that the Mac hasn't taken yet. Its id
 *  goes with it, so sending it again (after an uncertain failure, or from
 *  the queue) puts it in its thread once. */
export type Outgoing = {
  id: string;
  text: string;
  chips: Chip[];
  /** When he wrote it (ISO), shown while it waits. */
  written: string;
  /** A reply in this thread. */
  thread?: string;
  /** A message in a new thread started on the phone. The first one sent
   *  starts it; the rest follow it there. Neither: a thread of its own. */
  draft?: string;
  /** The Mac refused it (too long, a chip it can't read); kept until he
   *  discards it or tries again. */
  error?: string;
};

export type KinClient = Pick<KinRoutes, 'kinThreads' | 'kinThread' | 'kinPost' | 'kinHalt' | 'kinJobs'>;

type State = {
  /** The open threads, newest first, as the Mac last listed them. */
  threads: Thread[];
  /** Threads Kin is answering in. */
  running: string[];
  reviewing: string[];
  /** The threads he opened, kept to read offline. */
  views: Record<string, ThreadView>;
  /** Their ids, latest opened first. */
  opened: string[];
  /** A new thread started on the phone → the thread the Mac made for it. */
  made: Record<string, string>;
  jobs: Job[];
};

export type KinSnapshot = State & {
  /** Messages still on this phone, oldest first. */
  outgoing: Outgoing[];
  connection: Connection;
  problem: string | null;
};

/** How many of a thread's latest entries the phone keeps. */
export const KEPT = 100;
/** How many opened threads the phone keeps to read offline. */
export const KEPT_THREADS = 20;
const KEPT_MADE = 50;

const empty = (): State => ({ threads: [], running: [], reviewing: [], views: {}, opened: [], made: {}, jobs: [] });

/** Kin's threads on the phone. Kin runs on the Mac: the phone keeps the
 *  thread list and the threads he opened to read offline, and every message
 *  he writes waits here, in order, until the Mac takes it. */
export class Kin extends Waiting<State, Outgoing> {
  private current!: KinSnapshot;
  private newId: () => string;
  private now: () => Date;

  constructor(kv: KV, newId: () => string, now: () => Date = () => new Date()) {
    super(kv, 'kin', empty());
    // A copy from before threads (one conversation) has nothing to show now.
    if (!this.state || typeof this.state.views !== 'object' || !Array.isArray(this.state.threads)) this.state = empty();
    this.newId = newId;
    this.now = now;
    this.snapshot();
  }

  getSnapshot = () => this.current;

  protected snapshot() {
    this.current = { ...this.state, outgoing: this.waiting, connection: this.connection, problem: this.problem };
  }

  /** A new thread, on the phone until its first message reaches the Mac. */
  draft(): Target {
    return { draft: `draft-${this.newId()}` };
  }

  /** The thread a new thread became, once the Mac has it. */
  resolve(target: Target): Target {
    if ('draft' in target) {
      const made = this.state.made[target.draft];
      if (made) return { thread: made };
    }
    return target;
  }

  /** Writes a message. It's kept on the phone at once; `sync` sends it. */
  write(text: string, chips: Chip[] = [], to?: Target): Outgoing {
    const target = to && this.resolve(to);
    const message: Outgoing = {
      id: this.newId(),
      text: text.trim(),
      chips,
      written: this.now().toISOString(),
      ...(target && 'thread' in target ? { thread: target.thread } : {}),
      ...(target && 'draft' in target ? { draft: target.draft } : {}),
    };
    this.setWaiting([...this.waiting, message]);
    this.publish();
    return message;
  }

  /** Lets a refused message go. */
  discard(id: string) {
    this.setWaiting(this.waiting.filter((m) => m.id !== id));
    this.publish();
  }

  /** Tries a refused message again. */
  retry(id: string) {
    this.setWaiting(this.waiting.map((m) => (m.id === id ? { ...m, error: undefined } : m)));
    this.publish();
  }

  /** Is Kin answering, or is something on its way? Then the screen asks
   *  again soon. With a target, only that thread counts. */
  busy(target?: Target): boolean {
    const s = this.current;
    if (s.connection === 'offline') return false;
    if (!target) return s.running.length > 0 || s.outgoing.some((m) => !m.error);
    const to = this.resolve(target);
    const view = 'thread' in to ? s.views[to.thread] : undefined;
    return (
      (view != null && (view.running !== null || view.pending.length > 0)) ||
      ('thread' in to && s.running.includes(to.thread)) ||
      outgoingIn(s, to).some((m) => !m.error)
    );
  }

  /** Sends waiting messages, then reads the thread list, the jobs and the
   *  open thread. Throws Unpaired; Offline leaves everything waiting and
   *  marks the Mac away. */
  sync(client: KinClient, open?: Target): Promise<void> {
    return this.serial(async () => {
      this.problem = null;
      if (!(await this.send(client))) return;
      try {
        const [list, jobs] = await Promise.all([client.kinThreads(), client.kinJobs()]);
        this.take(list, jobs);
        const to = open && this.resolve(open);
        if (to && 'thread' in to) await this.read(client, to.thread);
        this.publish('online');
      } catch (e) {
        throw this.failed(e);
      }
    });
  }

  /** Stops Kin in a thread. Needs the Mac. */
  stop(client: KinClient, thread?: string): Promise<void> {
    return this.serial(async () => {
      try {
        await client.kinHalt(thread);
      } catch (e) {
        throw this.failed(e);
      }
    });
  }

  /** Threads matching `q`: the Mac searches their messages; offline, the
   *  phone looks through the titles and previews it has. */
  async search(client: KinClient | null, q: string): Promise<Thread[]> {
    const words = q.trim();
    if (!words) return this.state.threads;
    const local = () => {
      const lower = words.toLowerCase();
      return this.state.threads.filter((t) =>
        [t.title, t.preview, t.anchor?.label ?? '', t.anchor?.quote?.exact ?? ''].some((s) => s.toLowerCase().includes(lower)),
      );
    };
    if (!client) return local();
    try {
      return (await client.kinThreads({ q: words })).threads;
    } catch (e) {
      if (e instanceof Unpaired) throw e;
      return local();
    }
  }

  private async read(client: KinClient, id: string) {
    let view: ThreadView;
    try {
      view = await client.kinThread(id);
    } catch (e) {
      // The thread was deleted on the Mac: forget the copy.
      if (e instanceof HttpError && permanent(e.status)) {
        const views = { ...this.state.views };
        delete views[id];
        this.setState({ ...this.state, views, opened: this.state.opened.filter((o) => o !== id) });
        this.problem = e.message;
        return;
      }
      throw e;
    }
    const opened = [id, ...this.state.opened.filter((o) => o !== id)];
    const views: Record<string, ThreadView> = {};
    for (const o of opened.slice(0, KEPT_THREADS)) if (this.state.views[o]) views[o] = this.state.views[o];
    views[id] = { ...view, entries: view.entries.slice(-KEPT) };
    this.setState({ ...this.state, views, opened: opened.slice(0, KEPT_THREADS) });
  }

  /** False when the Mac couldn't take them (away, or not ready). */
  private async send(client: KinClient): Promise<boolean> {
    // Refused messages stay put, out of the way of the rest.
    const ready = this.waiting.filter((m) => !m.error);
    for (const message of ready) {
      // A new thread's key: its draft id, or for one written before threads, its own id.
      const draft = message.thread ? undefined : (message.draft ?? message.id);
      const thread = message.thread ?? (draft ? this.state.made[draft] : undefined);
      let sent: Awaited<ReturnType<KinClient['kinPost']>>;
      try {
        sent = await client.kinPost(message.id, message.text, message.chips, thread);
      } catch (e) {
        if (e instanceof HttpError && permanent(e.status)) {
          this.setWaiting(this.waiting.map((m) => (m.id === message.id ? { ...m, error: e.message } : m)));
          this.publish();
          continue;
        }
        // Offline, Unpaired, or the Mac not ready: the rest wait in order.
        if (e instanceof Unpaired) throw e;
        if (e instanceof Offline) this.publish('offline');
        else {
          this.problem = e instanceof Error ? e.message : String(e);
          this.publish();
        }
        return false;
      }
      const landed = sent.duplicate ? sent.thread : sent.thread.id;
      if (draft && landed && !this.state.made[draft]) {
        const made = Object.entries({ ...this.state.made, [draft]: landed }).slice(-KEPT_MADE);
        this.setState({ ...this.state, made: Object.fromEntries(made) });
      }
      if (!sent.duplicate) this.landed(sent.thread, sent.entry);
      this.setWaiting(this.waiting.filter((m) => m.id !== message.id));
      this.publish('online');
    }
    return true;
  }

  /** Shows a message that reached the Mac before the next read comes back. */
  private landed(thread: Thread, entry: Entry) {
    const threads = [thread, ...this.state.threads.filter((t) => t.id !== thread.id)];
    const view = this.state.views[thread.id];
    const views = view
      ? { ...this.state.views, [thread.id]: { ...view, thread, entries: [...view.entries, entry].slice(-KEPT), pending: [...view.pending, entry.seq] } }
      : this.state.views;
    this.setState({ ...this.state, threads, views });
  }

  private take(list: ThreadList, jobs: Job[]) {
    this.setState({ ...this.state, threads: list.threads, running: list.running, reviewing: list.reviewing, jobs });
  }
}

/** Messages still on the phone for one thread (or new thread). */
export function outgoingIn(snapshot: KinSnapshot, target: Target): Outgoing[] {
  return snapshot.outgoing.filter((m) => {
    // One written before threads has no draft id: its own id stands in.
    if ('draft' in target) return m.draft === target.draft || (!m.draft && !m.thread && m.id === target.draft);
    return m.thread === target.thread || snapshot.made[m.draft ?? m.id] === target.thread;
  });
}

/** What a thread shows: its messages, then what is still waiting here. */
export type Shown = { kind: 'entry'; entry: Entry } | { kind: 'outgoing'; message: Outgoing; offline: boolean };

export function shown(snapshot: KinSnapshot, target: Target): Shown[] {
  const view = 'thread' in target ? snapshot.views[target.thread] : undefined;
  const out: Shown[] = (view?.entries ?? []).map((entry) => ({ kind: 'entry', entry }));
  for (const message of outgoingIn(snapshot, target)) out.push({ kind: 'outgoing', message, offline: snapshot.connection === 'offline' });
  return out;
}

/** A thread for the list: one the Mac has, or one started here that hasn't
 *  reached it yet. */
export type Listed =
  | { kind: 'thread'; thread: Thread; here: boolean }
  | { kind: 'draft'; target: Target; title: string; written: string; chips: Chip[] };

/** Does the thread's anchor point at what a chip shows? */
export function anchoredTo(thread: Thread, chips: Chip[]): boolean {
  const anchor = thread.anchor;
  if (!anchor) return false;
  return chips.some((c) => c.path === anchor.path && (c.kind === anchor.kind || (c.kind === 'doc' && anchor.kind === 'paragraph')));
}

/** The list: threads still on the phone first, then those about what's on
 *  screen, then the rest, newest first. */
export function listed(snapshot: KinSnapshot, threads: Thread[], here: Chip[]): Listed[] {
  const drafts = new Map<string, Listed>();
  for (const m of snapshot.outgoing) {
    // One without a draft id (written before threads) starts a thread of its own.
    const key = m.draft ?? m.id;
    if (m.thread || snapshot.made[key] || drafts.has(key)) continue;
    drafts.set(key, { kind: 'draft', target: { draft: key }, title: m.text, written: m.written, chips: m.chips });
  }
  const rows = threads.map((thread): Listed => ({ kind: 'thread', thread, here: anchoredTo(thread, here) }));
  return [...drafts.values(), ...rows.filter((r) => r.kind === 'thread' && r.here), ...rows.filter((r) => r.kind === 'thread' && !r.here)];
}

/** A short, honest line about where Kin is: in one thread, or overall. */
export function kinStatus(snapshot: KinSnapshot, target?: Target): string | null {
  const messages = target ? outgoingIn(snapshot, target) : snapshot.outgoing;
  const waiting = messages.filter((m) => !m.error).length;
  if (snapshot.connection === 'offline') {
    return waiting
      ? `Your Mac is offline. ${waiting === 1 ? 'One message' : `${waiting} messages`} waiting.`
      : 'Your Mac is offline. Messages wait here until it’s back.';
  }
  if (snapshot.problem) return snapshot.problem;
  if (waiting) return 'Sending to your Mac…';
  if (!target) return null;
  const view = 'thread' in target ? snapshot.views[target.thread] : undefined;
  if (view?.running) return 'Kin is replying…';
  if (view?.pending.length) return 'Kin will answer in a moment.';
  return null;
}

/** Jobs worth showing: running or waiting first, then the latest few. */
export function activeJobs(jobs: Job[], recent = 3): Job[] {
  const live = jobs.filter((j) => j.status === 'queued' || j.status === 'running' || j.status === 'waiting');
  const done = jobs
    .filter((j) => !live.includes(j))
    .sort((a, b) => (b.finished ?? b.created).localeCompare(a.finished ?? a.created))
    .slice(0, recent);
  return [...live, ...done];
}
