import type { ClipCapture } from '@kintsugi/core/clips';
import { HttpError, isPermanentCaptureStatus, Offline, Unpaired } from '@kintsugi/core/remote';

import type { CaptureRetry } from './capture-retry';

/** Small port for the disk queue: claims coordinate app and extension processes. */
export type CaptureQueue = {
  pending(): Promise<string>;
  claim(id: string): Promise<boolean>;
  read(id: string): Promise<string>;
  acknowledge(id: string): Promise<void>;
  reject(id: string, reason: string): Promise<void>;
  release(id: string): Promise<void>;
};

export async function drainCaptures(queue: CaptureQueue, deliver: (capture: ClipCapture) => Promise<unknown>, retry?: CaptureRetry) {
  const items = JSON.parse(await queue.pending()) as { id: string; error?: string }[];
  const failures: unknown[] = [];
  for (const { id, error: rejected } of items) {
    if (rejected || (retry && !retry.ready(id))) continue;
    let claimed = false;
    try {
      claimed = await queue.claim(id);
      if (!claimed) continue;
      await deliver(JSON.parse(await queue.read(id)) as ClipCapture);
      await queue.acknowledge(id);
      retry?.clear(id);
    } catch (error) {
      if (error instanceof Unpaired) throw error;
      if (error instanceof HttpError && isPermanentCaptureStatus(error.status)) {
        await queue.reject(id, `Couldn’t send this capture. Its contents are preserved on this phone. ${String(error)}`);
        retry?.clear(id);
      } else {
        retry?.failed(id);
      }
      if (error instanceof Offline) throw error;
      failures.push(error);
    } finally {
      if (claimed) {
        try { await queue.release(id); } catch (error) { failures.push(error); }
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} capture(s) still waiting or need attention. ${String(failures[0])}`);
}
