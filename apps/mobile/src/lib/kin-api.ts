import { HttpError, Offline, type Pairing, type Remote, Unpaired } from '@kintsugi/core/remote';
import type { Chip, Job } from '@kintsugi/core/sections';

/** Kin's threads as phone API 8 sends them. `@kintsugi/core` still
 *  describes API 6's one conversation, so the phone keeps these here. */

/** The phone API that has Kin's threads (/v1/kin/threads, /v1/kin/thread). */
export const THREADS_API = 8;

export type Quote = { exact: string; prefix: string; suffix: string; line: number };
export type Anchor = {
  kind: 'doc' | 'paragraph' | 'feed' | 'clip' | 'idea';
  path: string;
  label?: string;
  quote?: Quote;
  orphaned?: boolean;
};
export type Thread = {
  id: string;
  title: string;
  titled?: boolean;
  anchor?: Anchor;
  status: 'open' | 'resolved';
  origin: string;
  created: string;
  updated: string;
  resolved?: string;
  entries: number;
  preview: string;
  /** A search's best match in it. */
  hit?: string;
};
export type Entry = {
  /** Position in its thread, from 1. */
  seq: number;
  thread: string;
  at: string;
  role: 'owner' | 'kin' | 'helper';
  text: string;
  chips?: { kind: string; path: string; label?: string }[];
  answers?: number[];
  interrupted?: boolean;
  error?: string;
  job?: string;
  usd?: number;
  review?: boolean;
  web?: unknown[];
  tools?: unknown[];
  ms?: number;
  model?: string;
  capReached?: boolean;
  was?: number;
};
export type ThreadList = {
  threads: Thread[];
  /** Threads Kin is answering in. */
  running: string[];
  reviewing: string[];
};
export type RunningTurn = { turn: string; thread: string; answers: number[] };
export type ThreadView = { thread: Thread; entries: Entry[]; pending: number[]; running: RunningTurn | null };
/** A message reached its thread; a resend of the same id answers `duplicate`
 *  with the thread's id (empty for a message sent before threads). */
export type ThreadSent = { entry: Entry; thread: Thread; duplicate: false } | { seq: number; thread: string; duplicate: true };
export type ThreadFilter = { q?: string; about?: string; resolved?: boolean };

export type KinRoutes = {
  kinThreads: (filter?: ThreadFilter) => Promise<ThreadList>;
  kinThread: (id: string) => Promise<ThreadView>;
  /** Without `thread`, starts a new thread about the first chip. `id` makes a
   *  resend (after an uncertain failure, or from the queue) land once. */
  kinPost: (id: string, text: string, chips: Chip[], thread?: string) => Promise<ThreadSent>;
  /** Stops Kin in `thread`, or everywhere. */
  kinHalt: (thread?: string) => Promise<object>;
  kinJobs: () => Promise<Job[]>;
};

/** The paired Mac, with Kin's thread routes. */
export type PhoneRemote = Remote & KinRoutes;

const TIMEOUT = 8000;

/** Kin's thread routes, called the way `@kintsugi/core/remote` calls the rest. */
export function kinRoutes({ url, token }: Pairing): Omit<KinRoutes, 'kinJobs'> {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT);
    try {
      response = await fetch(url + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (e) {
      throw new Offline(e);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) throw new Unpaired();
    if (response.status === 502 || response.status === 504) throw new Offline();
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new HttpError(response.status, json?.error);
    return json as T;
  }

  return {
    kinThreads: (filter = {}) => {
      const params = new URLSearchParams();
      if (filter.q?.trim()) params.set('q', filter.q.trim());
      if (filter.about) params.set('about', filter.about);
      if (filter.resolved) params.set('resolved', 'true');
      const query = params.toString();
      return call<ThreadList>('GET', `/v1/kin/threads${query ? `?${query}` : ''}`);
    },
    kinThread: (id) => call<ThreadView>('GET', `/v1/kin/thread?id=${encodeURIComponent(id)}`),
    kinPost: (id, text, chips, thread) => call<ThreadSent>('POST', '/v1/kin', thread ? { id, text, chips, thread } : { id, text, chips }),
    kinHalt: (thread) => call<object>('POST', '/v1/kin/stop', thread ? { thread } : {}),
  };
}

/** The core client plus Kin's thread routes. */
export function phoneRemote(remote: Remote, pairing: Pairing): PhoneRemote {
  return { ...remote, ...kinRoutes(pairing) };
}
