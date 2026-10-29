// Dev-only stand-in for the Tauri webview runtime, so the Mac app's frontend
// runs in an ordinary browser tab against a headless backend (KI-12).
//
// It provides the same `window.__TAURI_INTERNALS__` surface Tauri's own init
// scripts do (tauri 2.12 `scripts/core.js` and `src/event/*`), so the app and
// `@tauri-apps/*` packages run unchanged. Commands go over HTTP; everything
// the backend pushes (event emits, channel messages) arrives over one SSE
// stream as callback packets.
//
// Contract with the headless backend:
//   POST {base}/invoke   Authorization: Bearer {token}
//        body {cmd, args, client}  ->  {ok: true, value} | {ok: false, error}
//   GET  {base}/events?token=…&client=…   (SSE, default `message` events)
//        first data {ready: true}, then {callback: number, payload: any}
//        events: payload {event, id, payload}; channels: {index, message} or {index, end: true}
//        a binary channel message arrives as {__headlessBytes: number[]}
//   GET  {base}/asset?token=…&path=…      (convertFileSrc)
//
// This file has no imports and touches no globals of its own, so tests can
// drive it under plain `node --test` with fakes for fetch and EventSource.

export type HeadlessConfig = { base: string; token: string };

/** The fragment keys that carry the bridge address and its token. */
const BASE_KEY = "headless";
const TOKEN_KEY = "token";
const STORAGE_KEY = "kintsugi:headless";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Only dev builds outside a real Tauri webview get the bridge. */
export function shouldInstallHeadlessBridge(env: { DEV?: boolean }, win: object): boolean {
  return env.DEV === true && !("__TAURI_INTERNALS__" in win);
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Reads `#headless=http://127.0.0.1:1423&token=…`. A fragment found is
 *  remembered for the tab so reloads keep working after it is stripped; `rest`
 *  is the fragment without the bridge keys. */
export function readHeadlessConfig(
  hash: string,
  storage?: StorageLike,
): { config: HeadlessConfig; rest: string; fromFragment: boolean } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const base = params.get(BASE_KEY);
  const token = params.get(TOKEN_KEY);
  if (base && token) {
    const config = { base: normalizeBase(base), token };
    params.delete(BASE_KEY);
    params.delete(TOKEN_KEY);
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // Storage can be unavailable; the fragment still works for this load.
    }
    return { config, rest: params.toString(), fromFragment: true };
  }
  let stored: string | null = null;
  try {
    stored = storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  if (!stored) return null;
  let parsed: Partial<HeadlessConfig>;
  try {
    parsed = JSON.parse(stored) as Partial<HeadlessConfig>;
  } catch {
    return null;
  }
  if (typeof parsed.base !== "string" || typeof parsed.token !== "string") return null;
  return { config: { base: normalizeBase(parsed.base), token: parsed.token }, rest: hash.replace(/^#/, ""), fromFragment: false };
}

/** The bridge must be a loopback http origin: the token never leaves the machine. */
function normalizeBase(base: string): string {
  const url = new URL(base);
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
    throw new Error(`headless bridge must be http on loopback, got ${base}`);
  }
  return url.origin;
}

/** Minimal EventSource surface the bridge uses (browser's, or a test fake). */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  close(): void;
}

export type BridgeDeps = {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  EventSource: new (url: string) => EventSourceLike;
  /** Stand-ins for native dialogs and the OS opener, all inside the tab. */
  prompt: (message: string, defaultValue: string) => MaybePromise<string | null>;
  alert: (message: string) => MaybePromise<void>;
  confirm: (message: string) => MaybePromise<boolean>;
  open: (url: string, target: string, features: string) => unknown;
  clientId: string;
  random?: () => number;
  /** How long an invoke waits for the event stream before failing. */
  readyTimeoutMs?: number;
  log?: Pick<Console, "warn" | "error">;
};

type Callback = (data: unknown) => unknown;
type MaybePromise<T> = T | Promise<T>;

const CLOSED = 2;
/** Tauri's SERIALIZE_TO_IPC_FN; Channel and dpi types implement it. */
const SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";

/** Same replacer Tauri's `process-ipc-message-fn.js` uses for JSON payloads. */
function ipcReplacer(_key: string, val: unknown): unknown {
  if (val instanceof Map) return Object.fromEntries(val.entries());
  if (val instanceof Uint8Array) return Array.from(val);
  if (val instanceof ArrayBuffer) return Array.from(new Uint8Array(val));
  if (typeof val === "object" && val !== null && SERIALIZE_TO_IPC_FN in val) {
    return (val as Record<string, () => unknown>)[SERIALIZE_TO_IPC_FN]();
  }
  return val;
}

/** Tauri rejects invokes with the command's error value; transport failures
 *  are strings too, so `String(e)` in the app reads well either way. */
const failure = (message: string) => `headless bridge: ${message}`;

export function createHeadlessBridge(config: HeadlessConfig, deps: BridgeDeps) {
  const log = deps.log ?? console;
  const random = deps.random ?? (() => Math.random());
  const readyTimeoutMs = deps.readyTimeoutMs ?? 15_000;

  // --- callbacks: same semantics as tauri's scripts/core.js ---------------
  const callbacks = new Map<number, Callback>();

  function transformCallback(callback?: Callback, once = false): number {
    let id: number;
    do id = Math.floor(random() * 0x1_0000_0000) >>> 0;
    while (callbacks.has(id));
    callbacks.set(id, (data) => {
      if (once) unregisterCallback(id);
      return callback && callback(data);
    });
    return id;
  }

  function unregisterCallback(id: number) {
    callbacks.delete(id);
    const listener = listenerByHandler.get(id);
    if (listener) {
      listenerByHandler.delete(id);
      listeners.get(listener.event)?.delete(listener.eventId);
    }
  }

  function runCallback(id: number, data: unknown) {
    const callback = callbacks.get(id);
    if (!callback) {
      log.warn(
        `[TAURI] Couldn't find callback id ${id}. This might happen when the app is reloaded while Rust is running an asynchronous operation.`,
      );
      return;
    }
    // Real Tauri stamps the listener's event id on the event before calling
    // it (`once` unlistens with it); do the same if the backend didn't.
    const listener = listenerByHandler.get(id);
    if (listener && isRecord(data) && data.id === undefined) data.id = listener.eventId;
    callback(data);
  }

  // --- event listeners: event name -> event id -> handler callback id -----
  const listeners = new Map<string, Map<number, number>>();
  const listenerByHandler = new Map<number, { event: string; eventId: number; args: Record<string, unknown> }>();

  function recordListener(args: Record<string, unknown>, eventId: number) {
    const event = String(args.event);
    const handlerId = Number(args.handler);
    if (!callbacks.has(handlerId)) return;
    const previous = listenerByHandler.get(handlerId);
    if (previous) listeners.get(previous.event)?.delete(previous.eventId);
    let byId = listeners.get(event);
    if (!byId) listeners.set(event, (byId = new Map()));
    byId.set(eventId, handlerId);
    listenerByHandler.set(handlerId, { event, eventId, args });
  }

  /** The backend drops a client's listeners when its stream ends; after the
   *  browser reconnects, register the live ones again under the same handlers. */
  function relisten() {
    for (const { args } of [...listenerByHandler.values()]) {
      send("plugin:event|listen", args).then(
        (eventId) => typeof eventId === "number" && recordListener(args, eventId),
        (e) => log.error(failure("could not re-register a listener after reconnecting"), e),
      );
    }
  }

  /** `window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`, called by
   *  `@tauri-apps/api/event` before it invokes `plugin:event|unlisten`. */
  function unregisterListener(event: string, eventId: number) {
    const handlerId = listeners.get(event)?.get(eventId);
    if (handlerId !== undefined) unregisterCallback(handlerId);
  }

  // --- event stream ---------------------------------------------------------
  // Invokes wait for the backend's {ready: true} handshake, so nothing it
  // pushes in answer to a command (an emit, a channel message) can beat the
  // stream. Each (re)connection sends a fresh handshake.
  let open = false;
  let connections = 0;
  let dead: string | null = null;
  const waiters = new Set<{ resolve: () => void; reject: (e: string) => void }>();

  const eventsUrl = `${config.base}/events?${new URLSearchParams({ token: config.token, client: deps.clientId })}`;
  const source = new deps.EventSource(eventsUrl);
  source.onopen = () => {
    // Connected, but the backend may not have registered this client yet.
  };
  function onReady() {
    open = true;
    if (connections++ > 0) relisten();
    for (const w of waiters) w.resolve();
    waiters.clear();
  }
  source.onerror = () => {
    open = false;
    if (source.readyState === CLOSED) {
      // The browser gave up (bad token, bridge gone); it won't reconnect.
      dead = failure(`event stream at ${config.base} closed; is the headless backend running and the token current?`);
      for (const w of waiters) w.reject(dead);
      waiters.clear();
    }
    // Otherwise the browser is reconnecting; new invokes wait for it.
  };
  source.onmessage = (ev) => {
    let packet: unknown;
    try {
      packet = JSON.parse(String(ev.data));
    } catch {
      log.error(failure("unreadable event packet"), ev.data);
      return;
    }
    if (isRecord(packet) && packet.ready === true) {
      onReady();
      return;
    }
    if (!isRecord(packet) || typeof packet.callback !== "number") {
      log.error(failure("event packet without a callback id"), packet);
      return;
    }
    try {
      runCallback(packet.callback, decodeBytes(packet.payload));
    } catch (e) {
      // A throwing handler must not stall the stream for everyone else.
      log.error(e);
    }
  };

  function ready(): Promise<void> {
    if (dead) return Promise.reject(dead);
    if (open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (e: string) => (clearTimeout(timer), reject(e)),
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(failure(`event stream at ${config.base} did not open within ${readyTimeoutMs} ms`));
      }, readyTimeoutMs);
      waiters.add(waiter);
    });
  }

  // --- invoke ---------------------------------------------------------------
  async function send(cmd: string, args: unknown): Promise<unknown> {
    if (
      args instanceof ArrayBuffer ||
      ArrayBuffer.isView(args) ||
      Array.isArray(args)
    ) {
      throw failure(`raw (binary) invoke payloads are not supported (${cmd})`);
    }
    await ready();
    const body = JSON.stringify({ cmd, args, client: deps.clientId }, ipcReplacer);
    let res: Response;
    try {
      res = await deps.fetch(`${config.base}/invoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body,
      });
    } catch (e) {
      throw failure(`${cmd} could not reach ${config.base}: ${String(e)}`);
    }
    let reply: unknown;
    try {
      reply = await res.json();
    } catch {
      reply = undefined;
    }
    if (!isRecord(reply) || typeof reply.ok !== "boolean") {
      throw failure(`${cmd} got HTTP ${res.status} without a {ok, …} reply`);
    }
    if (!reply.ok) throw reply.error;
    return reply.value;
  }

  async function invoke(cmd: string, args: Record<string, unknown> = {}, _options?: unknown): Promise<unknown> {
    const local = handleLocally(cmd, args);
    if (local) return await local.value;

    const value = await send(cmd, args);

    if (cmd === "plugin:event|listen" && typeof value === "number") {
      recordListener(args, value);
    } else if (cmd === "plugin:opener|open_url" || cmd === "plugin:opener|open_path") {
      // The backend validates and answers with a URL; open it in the browser,
      // never through the OS.
      const url = isRecord(value) && typeof value.url === "string" ? value.url : null;
      if (!url || !/^https?:$/.test(safeProtocol(url))) {
        throw failure(`${cmd} returned no http(s) URL to open`);
      }
      deps.open(url, "_blank", "noopener,noreferrer");
      return null;
    }
    return value;
  }

  /** Commands that would show native UI are answered inside the tab. */
  function handleLocally(cmd: string, args: Record<string, unknown>): { value: MaybePromise<unknown> } | null {
    switch (cmd) {
      case "plugin:dialog|open": {
        const options = (isRecord(args.options) ? args.options : {}) as {
          directory?: boolean;
          multiple?: boolean;
          title?: string;
          defaultPath?: string;
        };
        const what = options.directory ? "folder" : "file";
        const path = ask(options.title ?? `Open ${what}`, `Absolute ${what} path:`, options.defaultPath);
        return { value: path.then((p) => (p === null ? null : options.multiple ? [p] : p)) };
      }
      case "plugin:dialog|save": {
        const options = (isRecord(args.options) ? args.options : {}) as { title?: string; defaultPath?: string };
        return { value: ask(options.title ?? "Save file", "Absolute file path:", options.defaultPath) };
      }
      case "plugin:dialog|message":
        return { value: messageDialog(args) };
      case "plugin:window|start_dragging":
        // No window to drag in a browser tab (`data-tauri-drag-region`).
        return { value: null };
      default:
        return null;
    }
  }

  async function ask(title: string, label: string, defaultPath?: string): Promise<string | null> {
    const answer = await deps.prompt(`${title}\n${label}`, defaultPath ?? "");
    const path = answer?.trim();
    return path ? path : null;
  }

  /** Mirrors tauri-plugin-dialog's MessageDialogResult: the chosen button's label. */
  async function messageDialog(args: Record<string, unknown>): Promise<string> {
    const text = typeof args.title === "string" && args.title ? `${args.title}\n\n${String(args.message)}` : String(args.message);
    const buttons = args.buttons;
    if (buttons === "OkCancel") return (await deps.confirm(text)) ? "Ok" : "Cancel";
    if (buttons === "YesNo" || buttons === "YesNoCancel") return (await deps.confirm(text)) ? "Yes" : "No";
    if (isRecord(buttons) && Array.isArray(buttons.OkCancelCustom)) {
      const [ok, cancel] = buttons.OkCancelCustom as string[];
      return (await deps.confirm(text)) ? ok : cancel;
    }
    if (isRecord(buttons) && Array.isArray(buttons.YesNoCancelCustom)) {
      const [yes, no] = buttons.YesNoCancelCustom as string[];
      return (await deps.confirm(text)) ? yes : no;
    }
    await deps.alert(text);
    return isRecord(buttons) && typeof buttons.OkCustom === "string" ? buttons.OkCustom : "Ok";
  }

  function convertFileSrc(filePath: string, _protocol = "asset"): string {
    return `${config.base}/asset?${new URLSearchParams({ token: config.token, path: filePath })}`;
  }

  const internals = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    invoke,
    transformCallback,
    unregisterCallback,
    runCallback,
    callbacks,
    convertFileSrc,
  };

  return {
    internals,
    eventInternals: { unregisterListener },
    /** Ends the event stream so the backend can drop this client. */
    close() {
      source.close();
      open = false;
      dead = failure("closed");
      for (const w of waiters) w.reject(dead);
      waiters.clear();
    },
  };
}

export type HeadlessBridge = ReturnType<typeof createHeadlessBridge>;

/** Installs the bridge where Tauri's init scripts would put the runtime. */
export function installHeadlessBridge(win: Record<string, unknown>, bridge: HeadlessBridge) {
  win.__TAURI_INTERNALS__ = bridge.internals;
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = bridge.eventInternals;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Turns the backend's byte envelope in a channel message back into the
 *  ArrayBuffer native Tauri delivers for raw channel bodies. */
function decodeBytes(payload: unknown): unknown {
  if (!isRecord(payload) || !("index" in payload) || !isRecord(payload.message)) return payload;
  const bytes = payload.message.__headlessBytes;
  if (!Array.isArray(bytes)) return payload;
  return { ...payload, message: Uint8Array.from(bytes as number[]).buffer };
}

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}
