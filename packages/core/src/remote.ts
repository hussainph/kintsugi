/** A client for the phone API the desktop app serves over Tailscale.
 *  Mirrors apps/desktop/src-tauri/src/phone/server.rs. */
import type { Clip, ClipCapture, ClipSummary } from "./clips";
import type { Entry } from "./vault";

export type Pairing = { url: string; token: string };
export type Versioned = { text: string; version: string };
export type Saved = { result: "saved"; version: string } | { result: "conflict"; current: Versioned };
export type Hello = { app: "kintsugi"; api: number; vault: string };

/** The Mac couldn't be reached: asleep, Kintsugi closed, or Tailscale off. */
export class Offline extends Error {
  constructor(cause?: unknown) {
    super("Your Mac isn't reachable right now.", { cause });
  }
}

/** The Mac answered but no longer knows this phone's token. */
export class Unpaired extends Error {
  constructor() {
    super("This phone isn't paired with Kintsugi any more. Scan the code on your Mac again.");
  }
}

/** Reads `kintsugi://pair?url=…&token=…`, as shown in the desktop's QR code. */
export function parsePairLink(link: string): Pairing | null {
  const query = link.trim().match(/^kintsugi:\/\/+pair\/?\?(.*)$/)?.[1];
  if (query == null) return null;
  const params = new Map(
    query.split("&").map((pair) => {
      const [key, value = ""] = pair.split("=");
      return [key, decodeURIComponent(value)] as const;
    }),
  );
  const url = params.get("url")?.replace(/\/+$/, "");
  const token = params.get("token");
  if (!url || !token || !/^https?:\/\/[^/]+$/.test(url)) return null;
  return { url, token };
}

const TIMEOUT = 8000;

export function remote({ url, token }: Pairing) {
  async function call<T>(method: string, path: string, body?: unknown, accept: number[] = []): Promise<T> {
    let response: Response;
    // AbortSignal.timeout isn't in every runtime this runs in (React Native).
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT);
    try {
      response = await fetch(url + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (e) {
      throw new Offline(e);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) throw new Unpaired();
    // 502/504: `tailscale serve` is up but Kintsugi isn't running behind it.
    if (response.status === 502 || response.status === 504) throw new Offline();
    const json = await response.json().catch(() => null);
    if (!response.ok && !accept.includes(response.status)) {
      throw new Error(json?.error ?? `Kintsugi answered ${response.status}.`);
    }
    return json as T;
  }

  const query = (path: string) => `?path=${encodeURIComponent(path)}`;

  return {
    hello: () => call<Hello>("GET", "/v1/hello"),
    tree: () => call<Entry[]>("GET", "/v1/tree"),
    read: (path: string) => call<Versioned>("GET", "/v1/doc" + query(path)),
    /** Saves only if the Mac still has `base`; otherwise returns its current copy. */
    write: (path: string, text: string, base: string) =>
      call<Saved>("PUT", "/v1/doc", { path, text, base }, [409]),
    create: (dir: string, title: string) => call<{ path: string }>("POST", "/v1/docs", { dir, title }),
    capture: (text: string, capturedAt: string) =>
      call<{ path: string }>("POST", "/v1/capture", { text, capturedAt }),
    clips: () => call<ClipSummary[]>("GET", "/v1/clips"),
    clip: (path: string) => call<Clip>("GET", "/v1/clip" + query(path)),
    captureClip: (capture: ClipCapture) => call<{ path: string }>("POST", "/v1/clips", capture),
  };
}

export type Remote = ReturnType<typeof remote>;

/** Local time as `2026-10-29T09:14`, which is what a writer means by "when". */
export function localStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
