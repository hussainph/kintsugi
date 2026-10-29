// Run: node --test apps/desktop/src/headless/*.test.ts
//
// Drives the real `@tauri-apps/*` packages against the bridge, with a fake
// headless backend behind fake fetch and EventSource.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen, once } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as pickFolder, confirm, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createHeadlessBridge,
  installHeadlessBridge,
  readHeadlessConfig,
  shouldInstallHeadlessBridge,
  type EventSourceLike,
  type HeadlessBridge,
} from "./bridge.ts";

const BASE = "http://127.0.0.1:1423";
const TOKEN = "secret";

class FakeEventSource implements EventSourceLike {
  static last: FakeEventSource | null = null;
  readyState = 0;
  onopen: EventSourceLike["onopen"] = null;
  onmessage: EventSourceLike["onmessage"] = null;
  onerror: EventSourceLike["onerror"] = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  /** The connection opens; the backend's handshake follows unless told not to. */
  connect({ handshake = true } = {}) {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
    if (handshake) this.send({ ready: true });
  }
  send(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
  fail(permanently: boolean) {
    this.readyState = permanently ? 2 : 0;
    this.onerror?.(new Event("error"));
  }
  packet(callback: number, payload: unknown) {
    this.send({ callback, payload });
  }
}

type Call = { cmd: string; args: Record<string, unknown>; client: string; auth: string | null };
type Handler = (call: Call) => { ok: true; value: unknown } | { ok: false; error: unknown };

/** A tiny backend: answers invokes and, like Tauri's Listener, emits to listeners. */
function fakeBackend() {
  const calls: Call[] = [];
  const listeners = new Map<number, { event: string; handler: number }>();
  let nextEventId = 1;
  const handlers: Record<string, Handler> = {
    "plugin:event|listen": ({ args }) => {
      const id = nextEventId++;
      listeners.set(id, { event: String(args.event), handler: Number(args.handler) });
      return { ok: true, value: id };
    },
    "plugin:event|unlisten": ({ args }) => {
      listeners.delete(Number(args.eventId));
      return { ok: true, value: null };
    },
    "plugin:event|emit": ({ args }) => {
      for (const [id, l] of listeners) {
        if (l.event === args.event) {
          // Omit `id` on purpose: the bridge fills it in, as Tauri's JS does.
          setTimeout(() => es().packet(l.handler, { event: args.event, payload: args.payload }));
          void id;
        }
      }
      return { ok: true, value: null };
    },
  };
  const es = () => FakeEventSource.last!;
  const fetch = async (input: string, init: RequestInit) => {
    assert.equal(input, `${BASE}/invoke`);
    assert.equal(init.method, "POST");
    const body = JSON.parse(String(init.body));
    const auth = new Headers(init.headers).get("Authorization");
    const call: Call = { ...body, auth };
    calls.push(call);
    const handler = handlers[call.cmd];
    const reply = handler ? handler(call) : { ok: false, error: `unknown command ${call.cmd}` };
    return new Response(JSON.stringify(reply), { status: reply.ok ? 200 : 400 });
  };
  return { calls, listeners, handlers, fetch, es };
}

type Ui = { prompts: string[]; promptAnswer: string | null; confirmAnswer: boolean; alerts: string[]; opened: unknown[][] };

let backend: ReturnType<typeof fakeBackend>;
let bridge: HeadlessBridge;
let ui: Ui;
let warnings: unknown[][];

function setup(overrides: { fetch?: typeof backend.fetch; readyTimeoutMs?: number } = {}) {
  backend = fakeBackend();
  ui = { prompts: [], promptAnswer: null, confirmAnswer: true, alerts: [], opened: [] };
  warnings = [];
  const win: Record<string, unknown> = {};
  (globalThis as Record<string, unknown>).window = win;
  bridge = createHeadlessBridge(
    { base: BASE, token: TOKEN },
    {
      fetch: overrides.fetch ?? backend.fetch,
      EventSource: FakeEventSource,
      // Async, like the in-page DOM dialogs.
      prompt: async (m) => (ui.prompts.push(m), ui.promptAnswer),
      alert: async (m) => void ui.alerts.push(m),
      confirm: async () => ui.confirmAnswer,
      open: (...a) => void ui.opened.push(a),
      clientId: "client-1",
      readyTimeoutMs: overrides.readyTimeoutMs,
      log: { warn: (...a: unknown[]) => void warnings.push(a), error: (...a: unknown[]) => void warnings.push(a) },
    },
  );
  installHeadlessBridge(win, bridge);
  return win;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const callbacks = () => bridge.internals.callbacks;

describe("gating", () => {
  test("installs only in dev outside a Tauri webview", () => {
    assert.equal(shouldInstallHeadlessBridge({ DEV: true }, {}), true);
    assert.equal(shouldInstallHeadlessBridge({ DEV: false }, {}), false, "production");
    assert.equal(shouldInstallHeadlessBridge({}, {}), false, "no env");
    assert.equal(shouldInstallHeadlessBridge({ DEV: true }, { __TAURI_INTERNALS__: {} }), false, "native webview");
  });
});

describe("config", () => {
  const storage = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  test("reads the fragment, remembers it, and leaves other fragment keys", () => {
    const s = storage();
    const found = readHeadlessConfig(`#headless=${encodeURIComponent(BASE + "/")}&token=a%26b&doc=x`, s);
    assert.deepEqual(found, { config: { base: BASE, token: "a&b" }, rest: "doc=x", fromFragment: true });
    assert.deepEqual(readHeadlessConfig("", s)?.config, { base: BASE, token: "a&b" }, "survives a reload");
  });

  test("no fragment and nothing stored is no bridge", () => {
    assert.equal(readHeadlessConfig("#doc=x", storage()), null);
  });

  test("refuses a non-loopback or non-http bridge", () => {
    assert.throws(() => readHeadlessConfig("#headless=http://example.com:1423&token=t"));
    assert.throws(() => readHeadlessConfig("#headless=https://127.0.0.1:1423&token=t"));
  });
});

describe("bridge", () => {
  beforeEach(() => setup());
  afterEach(() => bridge.close());

  test("opens the event stream for this client with the token", () => {
    const url = new URL(backend.es().url);
    assert.equal(url.origin + url.pathname, `${BASE}/events`);
    assert.equal(url.searchParams.get("token"), TOKEN);
    assert.equal(url.searchParams.get("client"), "client-1");
  });

  test("invoke waits for the event stream, then posts {cmd, args, client} with the bearer token", async () => {
    backend.handlers.greet = ({ args }) => ({ ok: true, value: `hi ${args.name}` });
    const reply = invoke<string>("greet", { name: "H" });
    await tick();
    assert.equal(backend.calls.length, 0, "nothing sent before the stream is open");
    backend.es().connect();
    assert.equal(await reply, "hi H");
    assert.deepEqual(backend.calls[0], { cmd: "greet", args: { name: "H" }, client: "client-1", auth: `Bearer ${TOKEN}` });
  });

  test("an open connection is not enough: invokes wait for the {ready: true} handshake", async () => {
    backend.handlers.x = () => ({ ok: true, value: 1 });
    const held = invoke("x");
    backend.es().connect({ handshake: false });
    await tick();
    assert.equal(backend.calls.length, 0);
    backend.es().send({ ready: true });
    assert.equal(await held, 1);
    assert.equal(warnings.length, 0, "the handshake is not a callback packet");
  });

  test("command errors reject with the backend's error value, as in Tauri", async () => {
    backend.es().connect();
    backend.handlers.boom = () => ({ ok: false, error: "no vault open" });
    await assert.rejects(invoke("boom"), (e) => e === "no vault open");
  });

  test("transport failures reject with a readable string", async () => {
    bridge.close();
    setup({ fetch: async () => new Response("nope", { status: 401 }) });
    backend.es().connect();
    await assert.rejects(invoke("x"), /HTTP 401/);
    bridge.close();
    setup({ fetch: async () => Promise.reject(new TypeError("connection refused")) });
    backend.es().connect();
    await assert.rejects(invoke("x"), /could not reach .*connection refused/);
  });

  test("a stream that closes for good fails pending and later invokes", async () => {
    const pending = invoke("x");
    backend.es().fail(true);
    await assert.rejects(pending, /event stream .* closed/);
    await assert.rejects(invoke("y"), /event stream .* closed/);
  });

  test("a reconnecting stream holds invokes until it is open again", async () => {
    backend.es().connect();
    backend.handlers.x = () => ({ ok: true, value: 1 });
    backend.es().fail(false);
    const held = invoke("x");
    backend.es().connect({ handshake: false });
    await tick();
    assert.equal(backend.calls.length, 0);
    backend.es().send({ ready: true });
    assert.equal(await held, 1);
  });

  test("an invoke times out if the stream never opens", async () => {
    bridge.close();
    setup({ readyTimeoutMs: 5 });
    await assert.rejects(invoke("x"), /did not open within 5 ms/);
  });

  test("binary payloads are refused rather than mangled", async () => {
    backend.es().connect();
    await assert.rejects(invoke("x", new Uint8Array([1]) as unknown as Record<string, unknown>), /raw/);
  });
});

describe("callbacks", () => {
  beforeEach(() => setup());
  afterEach(() => bridge.close());

  test("transformCallback ids are unique; once callbacks clean up after one call", () => {
    const seen: unknown[] = [];
    const a = bridge.internals.transformCallback((d) => seen.push(["a", d]), true);
    const b = bridge.internals.transformCallback((d) => seen.push(["b", d]));
    assert.notEqual(a, b);
    backend.es().packet(a, 1);
    backend.es().packet(a, 2);
    backend.es().packet(b, 3);
    backend.es().packet(b, 4);
    assert.deepEqual(seen, [["a", 1], ["b", 3], ["b", 4]]);
    assert.equal(callbacks().has(a), false);
    assert.equal(warnings.length, 1, "the late packet for a warns, like Tauri");
    bridge.internals.unregisterCallback(b);
    assert.equal(callbacks().has(b), false);
  });

  test("a throwing handler doesn't stop later packets; bad packets are logged", () => {
    const seen: unknown[] = [];
    const id = bridge.internals.transformCallback((d) => {
      if (d === "bad") throw new Error("handler");
      seen.push(d);
    });
    backend.es().packet(id, "bad");
    backend.es().onmessage?.(new MessageEvent("message", { data: "not json" }));
    backend.es().onmessage?.(new MessageEvent("message", { data: "{}" }));
    backend.es().packet(id, "good");
    assert.deepEqual(seen, ["good"]);
    assert.equal(warnings.length, 3);
  });
});

describe("events", () => {
  beforeEach(() => {
    setup();
    backend.es().connect();
  });
  afterEach(() => bridge.close());

  test("listen, emit and unlisten round-trip through the backend", async () => {
    const got: unknown[] = [];
    const off = await listen<{ path: string }>("vault:changed", (e) => got.push(e));
    const listenCall = backend.calls.find((c) => c.cmd === "plugin:event|listen")!;
    assert.deepEqual(listenCall.args.target, { kind: "Any" });
    const handler = Number(listenCall.args.handler);
    assert.ok(callbacks().has(handler));

    await emit("vault:changed", { path: "a.md" });
    await tick();
    assert.deepEqual(got, [{ event: "vault:changed", id: 1, payload: { path: "a.md" } }]);

    await off();
    assert.equal(callbacks().has(handler), false, "handler callback freed");
    assert.equal(backend.listeners.size, 0, "backend told to unlisten");
    assert.deepEqual(backend.calls.at(-1)?.args, { event: "vault:changed", eventId: 1 });
  });

  test("once unlistens using the event id the bridge stamps on the event", async () => {
    const got: unknown[] = [];
    await once("ping", (e) => got.push(e.payload));
    await emit("ping", 1);
    await tick();
    await tick();
    assert.deepEqual(got, [1]);
    assert.equal(backend.listeners.size, 0);
    assert.equal(callbacks().size, 0);
  });

  test("after a reconnect, live listeners are registered again under the same handlers", async () => {
    const got: unknown[] = [];
    await listen("vault:changed", (e) => got.push(e.payload));
    const off = await listen("gone", () => {});
    await off();
    // The backend drops a client's listeners when its stream ends.
    backend.es().fail(false);
    backend.listeners.clear();
    const before = backend.calls.length;
    backend.es().connect();
    await tick();
    const again = backend.calls.slice(before);
    assert.deepEqual(again.map((c) => [c.cmd, c.args.event]), [["plugin:event|listen", "vault:changed"]]);
    await emit("vault:changed", "after");
    await tick();
    assert.deepEqual(got, ["after"]);
  });

  test("window listeners target the main window (metadata)", async () => {
    const off = await getCurrentWindow().onCloseRequested(() => {});
    const call = backend.calls.at(-1)!;
    assert.equal(call.cmd, "plugin:event|listen");
    assert.equal(call.args.event, "tauri://close-requested");
    assert.deepEqual(call.args.target, { kind: "Window", label: "main" });
    await off();
  });
});

describe("channels", () => {
  beforeEach(() => {
    setup();
    backend.es().connect();
  });
  afterEach(() => bridge.close());

  test("a Channel crosses as __CHANNEL__:id and receives ordered packets until end", async () => {
    const got: unknown[] = [];
    const channel = new Channel<string>((m) => got.push(m));
    backend.handlers.stream = () => ({ ok: true, value: null });
    await invoke("stream", { request: { id: "r" }, onEvent: channel });
    const sent = backend.calls.at(-1)!.args.onEvent;
    assert.equal(sent, `__CHANNEL__:${channel.id}`);

    // Out of order: the channel reorders by index, then cleans up at end.
    backend.es().packet(channel.id, { index: 1, message: "b" });
    backend.es().packet(channel.id, { index: 0, message: "a" });
    backend.es().packet(channel.id, { index: 3, end: true });
    assert.equal(callbacks().has(channel.id), true, "end waits for missing index 2");
    backend.es().packet(channel.id, { index: 2, message: "c" });
    assert.deepEqual(got, ["a", "b", "c"]);
    assert.equal(callbacks().has(channel.id), false, "callback freed at end");
  });
});

describe("binary channel messages", () => {
  beforeEach(() => {
    setup();
    backend.es().connect();
  });
  afterEach(() => bridge.close());

  test("raw invoke responses are ArrayBuffers without per-command adapters", async () => {
    backend.handlers["new_raw_command"] = () => ({ ok: true, value: { __headlessBytes: [137, 80, 78, 71] } });
    const bytes = await invoke<ArrayBuffer>("new_raw_command");
    assert.ok(bytes instanceof ArrayBuffer);
    assert.deepEqual([...new Uint8Array(bytes)], [137, 80, 78, 71]);
  });

  test("the byte envelope arrives as an ArrayBuffer, as from native Tauri", () => {
    const got: unknown[] = [];
    const channel = new Channel<ArrayBuffer>((m) => got.push(m));
    backend.es().packet(channel.id, { index: 0, message: { __headlessBytes: [1, 2, 255] } });
    backend.es().packet(channel.id, { index: 1, message: { text: "json stays json" } });
    assert.ok(got[0] instanceof ArrayBuffer);
    assert.deepEqual([...new Uint8Array(got[0] as ArrayBuffer)], [1, 2, 255]);
    assert.deepEqual(got[1], { text: "json stays json" });
  });
});

describe("native UI stays in the tab", () => {
  beforeEach(() => {
    setup();
    backend.es().connect();
  });
  afterEach(() => bridge.close());

  test("the folder picker is a prompt; cancel or blank is null", async () => {
    ui.promptAnswer = "  /Users/h/vault  ";
    assert.equal(await pickFolder({ directory: true, title: "Open a vault" }), "/Users/h/vault");
    assert.match(ui.prompts[0], /Open a vault/);
    ui.promptAnswer = null;
    assert.equal(await pickFolder({ directory: true }), null);
    ui.promptAnswer = " ";
    assert.equal(await pickFolder({ directory: true }), null);
    assert.equal(backend.calls.length, 0, "the backend never sees dialog commands");
  });

  test("message dialogs use alert and confirm", async () => {
    await message("saved");
    assert.deepEqual(ui.alerts, ["saved"]);
    ui.confirmAnswer = false;
    assert.equal(await confirm("trash it?"), false);
    ui.confirmAnswer = true;
    assert.equal(await confirm("trash it?", { okLabel: "Trash" }), true);
  });

  test("openUrl opens the backend's validated URL in a browser tab", async () => {
    backend.handlers["plugin:opener|open_url"] = ({ args }) => ({ ok: true, value: { url: args.url } });
    await openUrl("https://hussain.ph");
    assert.deepEqual(ui.opened, [["https://hussain.ph", "_blank", "noopener,noreferrer"]]);

    backend.handlers["plugin:opener|open_url"] = () => ({ ok: true, value: { url: "file:///etc/passwd" } });
    await assert.rejects(openUrl("x"), /no http\(s\) URL/);
    assert.equal(ui.opened.length, 1);
  });

  test("start_dragging is a local no-op", async () => {
    await getCurrentWindow().startDragging();
    assert.equal(backend.calls.length, 0);
  });

  test("convertFileSrc points at the bridge's asset route", () => {
    const url = new URL(convertFileSrc("/Users/h/vault/a b.png"));
    assert.equal(url.origin + url.pathname, `${BASE}/asset`);
    assert.equal(url.searchParams.get("token"), TOKEN);
    assert.equal(url.searchParams.get("path"), "/Users/h/vault/a b.png");
  });
});
