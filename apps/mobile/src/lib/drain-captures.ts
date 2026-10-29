import type { ClipCapture } from '@kintsugi/core/clips';
import { Offline, Unpaired } from '@kintsugi/core/remote';

/** Small port for the disk queue: claims coordinate app and extension processes. */
export type CaptureQueue = {
  pending(): Promise<string>;
  claim(id: string): Promise<boolean>;
  read(id: string): Promise<string>;
  acknowledge(id: string): Promise<void>;
  reject(id: string, reason: string): Promise<void>;
  release(id: string): Promise<void>;
};

export async function drainCaptures(queue: CaptureQueue, deliver: (capture: ClipCapture) => Promise<unknown>) {
  const items = JSON.parse(await queue.pending()) as { id: string; error?: string }[];
  const failures: unknown[] = [];
  for (const { id, error: rejected } of items) {
    if (rejected) continue;
    let claimed = false;
    try {
      claimed = await queue.claim(id);
      if (!claimed) continue;
      await deliver(JSON.parse(await queue.read(id)) as ClipCapture);
      await queue.acknowledge(id);
    } catch (error) {
      // Only connectivity/auth failures retry. Core currently erases other HTTP
      // statuses, so conservatively preserve those items for manual recovery.
      // Never loop forever on a 400/413/422 or strand later valid captures.
      if (error instanceof Offline || error instanceof Unpaired) throw error;
      await queue.reject(id, `Couldn’t send this capture. Its contents are preserved on this phone. ${String(error)}`);
      failures.push(error);
    } finally {
      if (claimed) {
        try { await queue.release(id); } catch (error) { failures.push(error); }
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} capture(s) need attention. ${String(failures[0])}`);
}
