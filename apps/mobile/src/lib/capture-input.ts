/** A URL pasted into the phone's capture box is inspiration, not an inbox draft.
 * Only complete HTTP(S) URLs count; prose and other schemes stay ordinary notes. */
export function captureURL(text: string): string | null {
  const value = text.trim();
  if (!/^https?:\/\/\S+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}
