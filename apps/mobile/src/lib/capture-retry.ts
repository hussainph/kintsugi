/** Bounded backoff while the app is open. Disk queues remain authoritative;
 * restarting may retry sooner, but always with the already persisted UUID. */
export class CaptureRetry {
  private attempts = new Map<string, { count: number; after: number }>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  ready(id: string): boolean { return (this.attempts.get(id)?.after ?? 0) <= this.now(); }
  failed(id: string) {
    const count = (this.attempts.get(id)?.count ?? 0) + 1;
    this.attempts.set(id, {
      count,
      after: this.now() + Math.min(30_000 * 2 ** Math.min(count - 1, 10), 30 * 60_000),
    });
  }
  clear(id: string) { this.attempts.delete(id); }
}
