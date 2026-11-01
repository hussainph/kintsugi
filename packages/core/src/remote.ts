/** A client for the phone API the desktop app serves over Tailscale.
 *  Mirrors apps/desktop/src-tauri/src/phone/server.rs. */
import type { Clip, ClipCapture, ClipSummary } from "./clips";
import type { Entry } from "./vault";

export type Pairing = { url: string; token: string };
export type Versioned = { text: string; version: string };
export type Saved = { result: "saved"; version: string } | { result: "conflict"; current: Versioned };
/** A document with its text, as the phone keeps it offline. */
export type Document = { path: string; text: string; version: string };
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

/** The Mac answered, but with a status the call didn't expect. `status` lets a
 *  caller tell a permanent refusal from one worth retrying, and `message` is
 *  the server's own message, or a safe stand-in when it sent none. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message?: unknown) {
    super(typeof message === "string" && message.trim() !== "" ? message : `Kintsugi answered ${status}.`);
    this.status = status;
  }
}

/** Capture failures a retry can't fix: the capture itself is invalid (400),
 *  too large (413), or has a field of the wrong type (422). Every other status
 *  is transient or handled as its own error (401 Unpaired, 502/504 Offline). */
export function isPermanentCaptureStatus(status: number): boolean {
  return status === 400 || status === 413 || status === 422;
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
/** A 50 MiB PDF takes a while over Tailscale or a phone connection; kept
 *  under the phone's 120-second delivery lease. */
const FILE_TIMEOUT = 100_000;

export function remote({ url, token }: Pairing) {
  async function call<T>(method: string, path: string, body?: unknown, accept: number[] = [], timeout = TIMEOUT): Promise<T> {
    let response: Response;
    // AbortSignal.timeout isn't in every runtime this runs in (React Native).
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
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
      throw new HttpError(response.status, json?.error);
    }
    return json as T;
  }

  const query = (path: string) => `?path=${encodeURIComponent(path)}`;

  return {
    hello: () => call<Hello>("GET", "/v1/hello"),
    tree: () => call<Entry[]>("GET", "/v1/tree"),
    read: (path: string) => call<Versioned>("GET", "/v1/doc" + query(path)),
    /** Every document with its text (API 3). An older Mac is read one document at a time. */
    library: async (): Promise<Document[]> => {
      try {
        return await call<Document[]>("GET", "/v1/library");
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
        // Not `flatten` from ./vault: this module imports only types, so it runs unbuilt.
        const paths = (entries: Entry[]): string[] =>
          entries.flatMap((e) => (e.kind === "doc" ? [e.path] : paths(e.children)));
        const out: Document[] = [];
        for (const path of paths(await call<Entry[]>("GET", "/v1/tree"))) {
          out.push({ path, ...(await call<Versioned>("GET", "/v1/doc" + query(path))) });
        }
        return out;
      }
    },
    /** Saves only if the Mac still has `base`; otherwise returns its current copy. */
    write: (path: string, text: string, base: string) =>
      call<Saved>("PUT", "/v1/doc", { path, text, base }, [409]),
    create: (dir: string, title: string) => call<{ path: string }>("POST", "/v1/docs", { dir, title }),
    capture: (text: string, capturedAt: string) =>
      call<{ path: string }>("POST", "/v1/capture", { text, capturedAt }),
    clips: () => call<ClipSummary[]>("GET", "/v1/clips"),
    clip: (path: string) => call<Clip>("GET", "/v1/clip" + query(path)),
    captureClip: (capture: ClipCapture) =>
      call<{ path: string }>("POST", "/v1/clips", capture, [], capture.file ? FILE_TIMEOUT : TIMEOUT),
  };
}

export type Remote = ReturnType<typeof remote>;

/** A document's version, as `kintsugi_vault::version` computes it: FNV-1a
 *  over the UTF-8 bytes, as 16 hex digits. */
export function version(text: string): string {
  const prime = 0x100000001b3n;
  let hash = 0xcbf29ce484222325n;
  const byte = (b: number) => {
    hash = BigInt.asUintN(64, (hash ^ BigInt(b)) * prime);
  };
  for (const char of text) {
    const c = char.codePointAt(0)!;
    if (c < 0x80) byte(c);
    else if (c < 0x800) [0xc0 | (c >> 6), 0x80 | (c & 63)].forEach(byte);
    else if (c < 0x10000) [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)].forEach(byte);
    else [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)].forEach(byte);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Local time as `2026-10-29T09:14`, which is what a writer means by "when". */
export function localStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
