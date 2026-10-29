import type { ClipCapture } from '@kintsugi/core/clips';
import { type Remote } from '@kintsugi/core/remote';

/** Core owns the transport. Keep the outbox's stronger acknowledgement check:
 * a malformed success response must never remove a locally saved capture. */
export async function postClip(client: Remote, capture: ClipCapture): Promise<{ path: string }> {
  const result = await client.captureClip(capture);
  if (typeof result?.path !== 'string') throw new Error('The Mac did not confirm saving this clip.');
  return result;
}
