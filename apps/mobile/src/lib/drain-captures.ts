import { CLIP_FILE_API, type ClipCapture } from '@kintsugi/core/clips';
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

/** Whether the paired Mac takes this capture: one carrying a PDF or EPUB
 *  needs `hello.api` 4. An older Mac would reject or drop the file, so the
 *  capture waits, queued (never rejected), until the Mac is updated. */
export function macAccepts(capture: ClipCapture, api: number): boolean {
  return capture.file == null || api >= CLIP_FILE_API;
}

/** Queued captures held because the paired Mac is too old to take files.
 *  Unknown (`api` 0: not asked yet, or offline) holds nothing. */
export function heldForMacUpdate<T extends { file?: boolean; error?: string }>(items: T[], api: number): T[] {
  return api > 0 && api < CLIP_FILE_API ? items.filter((item) => item.file && !item.error) : [];
}

/** `api` is the Mac's `hello.api`; captures it can't take yet stay queued.
 *  Unknown (0, the default) holds every file. */
export async function drainCaptures(
  queue: CaptureQueue,
  deliver: (capture: ClipCapture) => Promise<unknown>,
  retry?: CaptureRetry,
  api = 0,
) {
  const items = JSON.parse(await queue.pending()) as { id: string; error?: string; file?: boolean }[];
  const failures: unknown[] = [];
  for (const { id, error: rejected, file } of items) {
    if (rejected || (retry && !retry.ready(id))) continue;
    // Listed as carrying a file: skip it without claiming or reading 67 MB.
    if (file && api < CLIP_FILE_API) continue;
    let claimed = false;
    try {
      claimed = await queue.claim(id);
      if (!claimed) continue;
      const capture = JSON.parse(await queue.read(id)) as ClipCapture;
      // A file the listing didn't flag (queued by an older build) is held too.
      if (!macAccepts(capture, api)) continue;
      await deliver(capture);
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
