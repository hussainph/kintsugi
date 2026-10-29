import { Offline, type Pairing, Unpaired } from '@kintsugi/core/remote';

/** docs/inspiration.md → Phone API. Kept local only until KI-1's core client lands. */
export type ClipCapture = {
  url?: string;
  text?: string;
  note?: string;
  image?: string;
  imageType?: string;
  capturedAt: string;
  via: 'phone' | 'share';
};

export async function postClip({ url, token }: Pairing, capture: ClipCapture): Promise<{ path: string }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);
  try {
    let response: Response;
    try {
      response = await fetch(`${url}/v1/clips`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(capture),
        signal: abort.signal,
      });
    } catch (error) {
      throw new Offline(error);
    }
    if (response.status === 401) throw new Unpaired();
    if (response.status === 502 || response.status === 504) throw new Offline();
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error ?? `Kintsugi answered ${response.status}.`);
    if (typeof body?.path !== 'string') throw new Error('The Mac did not confirm saving this clip.');
    return body;
  } finally {
    clearTimeout(timer);
  }
}
