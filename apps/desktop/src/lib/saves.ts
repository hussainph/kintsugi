/**
 * The documents the writer has changed and the disk hasn't seen yet.
 *
 * A write that fails stays pending: nothing leaves this queue until the disk
 * has it or the writer discards it. Navigation asks `flush()` first and only
 * moves on when it reports everything saved.
 */
/** `held`: not tried, because the writer is choosing between this change and
 *  another app's (see `hold`). */
export type Failure = { path: string; error: string; held?: true };

export const HELD = "It changed in another app. Choose which version to keep.";
export type Flushed = { ok: true } | { ok: false; failures: Failure[] };

export class Saves {
  #pending = new Map<string, string>();
  #held = new Set<string>();
  #write: (path: string, contents: string) => Promise<unknown>;
  // One flush at a time, so an older write can never land after a newer one.
  #tail: Promise<unknown> = Promise.resolve();

  constructor(write: (path: string, contents: string) => Promise<unknown>) {
    this.#write = write;
  }

  get size() {
    return this.#pending.size;
  }

  paths() {
    return [...this.#pending.keys()];
  }

  set(path: string, contents: string) {
    this.#pending.set(path, contents);
  }

  /** The disk already has a newer version of this document (the phone saved it). */
  drop(path: string) {
    this.#pending.delete(path);
  }

  /** Another app changed this document and the two edits collide: keep the
   *  change pending but don't write it until the writer chooses (`release`). */
  hold(path: string) {
    this.#held.add(path);
  }

  release(path: string) {
    this.#held.delete(path);
  }

  isHeld(path: string) {
    return this.#held.has(path);
  }

  /** The writer chose to lose these changes. */
  discard() {
    const paths = this.paths();
    this.#pending.clear();
    this.#held.clear();
    return paths;
  }

  /** Writes everything pending. Failed writes stay pending for the next try. */
  flush(): Promise<Flushed> {
    const run = this.#tail.then(() => this.#flushNow());
    this.#tail = run.catch(() => {});
    return run;
  }

  async #flushNow(): Promise<Flushed> {
    const writes = [...this.#pending].filter(([path]) => !this.#held.has(path));
    const results = await Promise.allSettled(writes.map(([path, contents]) => this.#write(path, contents)));
    const failures: Failure[] = [...this.#held].filter((path) => this.#pending.has(path)).map((path) => ({ path, error: HELD, held: true }));
    results.forEach((result, i) => {
      const [path, contents] = writes[i];
      if (result.status === "rejected") failures.push({ path, error: String(result.reason) });
      // Keystrokes that arrived during the write are still pending, and so
      // is a change held during it (the write found another app's edit).
      else if (this.#held.has(path)) failures.push({ path, error: HELD, held: true });
      else if (this.#pending.get(path) === contents) this.#pending.delete(path);
    });
    return failures.length ? { ok: false, failures } : { ok: true };
  }
}
