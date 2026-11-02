import { HttpError, Offline, type Remote, Unpaired } from '@kintsugi/core/remote';
import type { Chip, Entry, Job, KinPage, RunningTurn, Thread } from '@kintsugi/core/sections';

import type { Connection, KV } from './library';
import { permanent, Waiting } from './waiting.ts';

/** A message written on the phone that the Mac hasn't taken yet. Its id
 *  goes with it, so sending it again (after an uncertain failure, or from
 *  the queue) puts it in the conversation once. */
export type Outgoing = {
  id: string;
  text: string;
  chips: Chip[];
  /** When he wrote it (ISO), shown while it waits. */
  written: string;
  /** The Mac refused it (too long, a chip it can't read); kept until he
   *  discards it or tries again. */
  error?: string;
};

export type KinClient = Pick<Remote, 'kin' | 'kinSend' | 'kinStop' | 'kinJobs'>;

type State = { entries: Entry[]; threads: Thread[]; pending: number[]; running: RunningTurn | null; jobs: Job[] };

export type KinSnapshot = State & {
  /** Messages still on this phone, oldest first. */
  outgoing: Outgoing[];
  connection: Connection;
  problem: string | null;
};

/** How many of the conversation's latest entries the phone keeps. */
export const KEPT = 100;

/** Kin's one conversation on the phone. Kin runs on the Mac: the phone keeps
 *  the latest of the conversation to read offline, and every message he
 *  writes waits here, in order, until the Mac takes it. */
export class Kin extends Waiting<State, Outgoing> {
  private current!: KinSnapshot;
  private newId: () => string;
  private now: () => Date;

  constructor(kv: KV, newId: () => string, now: () => Date = () => new Date()) {
    super(kv, 'kin', { entries: [], threads: [], pending: [], running: null, jobs: [] });
    this.newId = newId;
    this.now = now;
    this.snapshot();
  }

  getSnapshot = () => this.current;

  protected snapshot() {
    this.current = { ...this.state, outgoing: this.waiting, connection: this.connection, problem: this.problem };
  }

  /** Writes a message. It's kept on the phone at once; `sync` sends it. */
  write(text: string, chips: Chip[] = []): Outgoing {
    const message: Outgoing = { id: this.newId(), text: text.trim(), chips, written: this.now().toISOString() };
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

  /** Is Kin answering, or is something on its way? Then the screen asks again soon. */
  get busy(): boolean {
    const s = this.current;
    return s.connection !== 'offline' && (s.running !== null || s.pending.length > 0 || s.outgoing.some((m) => !m.error));
  }

  /** Sends waiting messages, then reads the conversation and jobs. Throws
   *  Unpaired; Offline leaves everything waiting and marks the Mac away. */
  sync(client: KinClient): Promise<void> {
    return this.serial(async () => {
      this.problem = null;
      if (!(await this.send(client))) return;
      try {
        const [page, jobs] = await Promise.all([client.kin(undefined, KEPT), client.kinJobs()]);
        this.take(page, jobs);
        this.publish('online');
      } catch (e) {
        throw this.failed(e);
      }
    });
  }

  /** Stops Kin's reply. Needs the Mac. */
  stop(client: KinClient): Promise<void> {
    return this.serial(async () => {
      try {
        await client.kinStop();
      } catch (e) {
        throw this.failed(e);
      }
    });
  }

  /** False when the Mac couldn't take them (away, or not ready). */
  private async send(client: KinClient): Promise<boolean> {
    // Refused messages stay put, out of the way of the rest.
    const ready = this.waiting.filter((m) => !m.error);
    for (const message of ready) {
      try {
        await client.kinSend(message.id, message.text, message.chips);
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
      this.setWaiting(this.waiting.filter((m) => m.id !== message.id));
      this.publish('online');
    }
    return true;
  }

  private take(page: KinPage, jobs: Job[]) {
    this.setState({
      entries: page.entries.slice(-KEPT),
      threads: page.threads,
      pending: page.pending,
      running: page.running,
      jobs,
    });
  }
}

/** What a list of entries shows: the chat's own messages, and paragraph
 *  comments tagged as such (they live in the same log). */
export type Shown =
  | { kind: 'entry'; entry: Entry; thread: string | null }
  | { kind: 'outgoing'; message: Outgoing; offline: boolean };

/** The conversation as the phone shows it: every thread, oldest first, with
 *  a thread label where the subject changes, then what is still waiting here. */
export function shown(snapshot: KinSnapshot): Shown[] {
  const label = (topic: string) => snapshot.threads.find((t) => t.key === topic)?.label ?? null;
  const out: Shown[] = [];
  let last: string | null = null;
  for (const entry of snapshot.entries) {
    out.push({ kind: 'entry', entry, thread: entry.topic !== last ? label(entry.topic) : null });
    last = entry.topic;
  }
  for (const message of snapshot.outgoing) out.push({ kind: 'outgoing', message, offline: snapshot.connection === 'offline' });
  return out;
}

/** A short, honest line about where Kin is. */
export function kinStatus(snapshot: KinSnapshot): string | null {
  const waiting = snapshot.outgoing.filter((m) => !m.error).length;
  if (snapshot.connection === 'offline') {
    return waiting
      ? `Your Mac is offline. ${waiting === 1 ? 'One message' : `${waiting} messages`} waiting.`
      : 'Your Mac is offline. Messages wait here until it’s back.';
  }
  if (snapshot.problem) return snapshot.problem;
  if (waiting) return 'Sending to your Mac…';
  if (snapshot.running) return 'Kin is replying…';
  if (snapshot.pending.length) return 'Kin will answer in a moment.';
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
