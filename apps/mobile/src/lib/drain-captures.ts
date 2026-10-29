import { Offline, Unpaired } from '@kintsugi/core/remote';

import type { ClipCapture } from './clip-capture';

/** Small port for the disk queue: claims coordinate app and extension processes. */
export type CaptureQueue = {
  pending(): Promise<string>;
  claim(id: string): Promise<boolean>;
  read(id: string): Promise<string>;
  acknowledge(id: string): Promise<void>;
  release(id: string): Promise<void>;
};

export type CaptureRetries = Map<string, { attempts: number; after: number }>;

export async function drainCaptures(
  queue: CaptureQueue,
  deliver: (capture: ClipCapture) => Promise<unknown>,
  retries: CaptureRetries = new Map(),
  now = Date.now,
) {
  const items = JSON.parse(await queue.pending()) as { id: string }[];
  const failures: unknown[] = [];
  for (const { id } of items) {
    if ((retries.get(id)?.after ?? 0) > now()) continue;
    let claimed = false;
    try {
      claimed = await queue.claim(id);
      if (!claimed) continue;
      await deliver(JSON.parse(await queue.read(id)) as ClipCapture);
      await queue.acknowledge(id);
      retries.delete(id);
    } catch (error) {
      // Connectivity/auth failures apply to the entire pass. A bad payload or
      // server rejection must not strand later, valid captures behind it.
      if (error instanceof Offline || error instanceof Unpaired) throw error;
      failures.push(error);
      const attempts = (retries.get(id)?.attempts ?? 0) + 1;
      retries.set(id, { attempts, after: now() + Math.min(30_000 * 2 ** Math.min(attempts - 1, 10), 30 * 60_000) });
    } finally {
      if (claimed) {
        try { await queue.release(id); } catch (error) { failures.push(error); }
      }
    }
  }
  const pending = new Set(items.map(({ id }) => id));
  for (const id of retries.keys()) if (!pending.has(id)) retries.delete(id);
  if (failures.length) throw new AggregateError(failures, `${failures.length} capture(s) still waiting. ${String(failures[0])}`);
}
