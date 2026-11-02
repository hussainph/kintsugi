import { HttpError, Offline, Unpaired } from '@kintsugi/core/remote';

import type { Connection, KV } from './library';

/** What the Feed, Ideas and Kin share on the phone: a copy of what the Mac
 *  last said (kept, so the screens open offline), and the owner's requests
 *  waiting in order until the Mac is reachable. All of the work happens on
 *  the Mac; the phone only shows and asks. Both live in the app's key-value
 *  store under `<name>:state` and `<name>:waiting`. */
export abstract class Waiting<State, Op> {
  protected state: State;
  protected waiting: Op[];
  connection: Connection = 'unknown';
  /** The Mac answered with something other than "not reachable". */
  problem: string | null = null;
  private listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  protected kv: KV;
  private name: string;

  constructor(kv: KV, name: string, empty: State) {
    this.kv = kv;
    this.name = name;
    this.state = read(kv, `${name}:state`) ?? empty;
    this.waiting = read<Op[]>(kv, `${name}:waiting`) ?? [];
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Called by `publish`; subclasses build their snapshot from the state. */
  protected abstract snapshot(): void;

  protected setState(state: State) {
    this.state = state;
    this.kv.setItemSync(`${this.name}:state`, JSON.stringify(state));
  }

  protected setWaiting(waiting: Op[]) {
    this.waiting = waiting;
    this.kv.setItemSync(`${this.name}:waiting`, JSON.stringify(waiting));
  }

  protected publish(connection = this.connection) {
    this.connection = connection;
    this.snapshot();
    this.listeners.forEach((listener) => listener());
  }

  /** One request to the Mac at a time, in order. */
  protected serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Sends what's waiting, oldest first. Offline stops and
   *  keeps the rest; a refusal the request can't recover from (400, 404,
   *  413, 422) drops that op with `problem` saying why; anything else stops,
   *  so it is tried again on the next sync. Throws Unpaired. Returns false
   *  when the Mac was away. */
  protected async flush(send: (op: Op) => Promise<void>): Promise<boolean> {
    while (this.waiting.length) {
      const op = this.waiting[0];
      try {
        await send(op);
      } catch (e) {
        if (e instanceof Unpaired) throw e;
        if (e instanceof Offline) {
          this.publish('offline');
          return false;
        }
        if (e instanceof HttpError && permanent(e.status)) {
          this.problem = e.message;
        } else {
          this.problem = e instanceof Error ? e.message : String(e);
          this.publish('online');
          return true;
        }
      }
      this.setWaiting(this.waiting.filter((o) => o !== op));
      this.publish('online');
    }
    return true;
  }

  /** Records how a read went: Offline marks the Mac away, Unpaired is thrown. */
  protected failed(e: unknown): unknown {
    if (e instanceof Offline) this.publish('offline');
    else if (!(e instanceof Unpaired)) {
      this.problem = e instanceof Error ? e.message : String(e);
      this.publish();
    }
    return e;
  }
}

export const permanent = (status: number) => [400, 404, 413, 422].includes(status);

function read<T>(kv: KV, key: string): T | null {
  try {
    const raw = kv.getItemSync(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
