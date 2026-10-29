import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Clip, ClipCapture, ClipSummary } from "./clips.ts";
import { localStamp, Offline, parsePairLink, remote, Unpaired, type Remote } from "./remote.ts";

test("reads the link from the desktop's QR code", () => {
  assert.deepEqual(parsePairLink("kintsugi://pair?url=https%3A%2F%2Fmac.tail1.ts.net%3A47474&token=AAAA-BBBB"), {
    url: "https://mac.tail1.ts.net:47474",
    token: "AAAA-BBBB",
  });
  assert.deepEqual(parsePairLink("  kintsugi:///pair/?url=http%3A%2F%2F127.0.0.1%3A47474%2F&token=T  "), {
    url: "http://127.0.0.1:47474",
    token: "T",
  });
});

test("rejects anything that isn't a pairing link", () => {
  assert.equal(parsePairLink("https://mac.tail1.ts.net:47474"), null);
  assert.equal(parsePairLink("kintsugi://pair?url=https%3A%2F%2Fmac"), null);
  assert.equal(parsePairLink("kintsugi://pair?url=ftp%3A%2F%2Fmac&token=T"), null);
  assert.equal(parsePairLink("kintsugi://pair?url=https%3A%2F%2Fmac%2Fpath&token=T"), null);
});

test("stamps local time to the minute", () => {
  assert.equal(localStamp(new Date(2026, 9, 29, 9, 4)), "2026-10-29T09:04");
});

const pairing = { url: "https://mac.tail1.ts.net:47474", token: "AAAA-BBBB" };
const summary: ClipSummary = {
  path: "inspiration/why-we-sleep.md",
  kind: "link",
  captured: "2026-10-29T09:04",
  tags: ["sleep", "science"],
  title: "Why we sleep",
  url: "https://example.com/sleep",
  site: "Example",
  author: null,
  image: "media/why-we-sleep.jpg",
  summary: null,
  enriched: null,
  enrichError: "Fetch failed",
  via: "share",
};
const capture: ClipCapture = { text: "A passing thought", capturedAt: "2026-10-29T09:04", via: "phone" };

function mockResponse(t: TestContext, method: string, path: string, json: unknown, body?: unknown) {
  return t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input, pairing.url + path);
    assert.equal(init?.method, method);
    assert.deepEqual(init?.headers, {
      Authorization: `Bearer ${pairing.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    });
    assert.equal(init?.body, body === undefined ? undefined : JSON.stringify(body));
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json(json);
  });
}

test("lists clips with an authenticated GET", async (t) => {
  const fetch = mockResponse(t, "GET", "/v1/clips", [summary]);
  assert.deepEqual(await remote(pairing).clips(), [summary]);
  assert.equal(fetch.mock.callCount(), 1);
});

test("reads a clip with a URL-encoded vault path", async (t) => {
  const path = "inspiration/sleep & dreams #1?夜.md";
  const clip: Clip = { ...summary, path, text: "> A passage.\n\nMy note.", hasSource: true };
  const fetch = mockResponse(t, "GET", "/v1/clip?path=" + encodeURIComponent(path), clip);
  assert.deepEqual(await remote(pairing).clip(path), clip);
  assert.equal(fetch.mock.callCount(), 1);
});

test("captures a clip with all supplied fields as authenticated JSON", async (t) => {
  const fullCapture: ClipCapture = {
    ...capture,
    via: "share",
    url: "https://example.com/sleep?a=1&b=2",
    text: "A shared passage",
    note: "My own note",
    title: "Why we sleep",
    image: "aW1hZ2U=",
    imageType: "image/png",
  };
  const result = { path: summary.path };
  const fetch = mockResponse(t, "POST", "/v1/clips", result, fullCapture);
  assert.deepEqual(await remote(pairing).captureClip(fullCapture), result);
  assert.equal(fetch.mock.callCount(), 1);
});

test("captures a clip without inventing optional fields", async (t) => {
  const minimalCapture: ClipCapture = { capturedAt: capture.capturedAt, via: "mac" };
  const result = { path: "inspiration/untitled.md" };
  const fetch = mockResponse(t, "POST", "/v1/clips", result, minimalCapture);
  assert.deepEqual(await remote(pairing).captureClip(minimalCapture), result);
  assert.equal(fetch.mock.callCount(), 1);
});

test("keeps the existing document capture endpoint and body", async (t) => {
  const result = { path: "inbox/a-passing-thought.md" };
  const fetch = mockResponse(t, "POST", "/v1/capture", result, {
    text: capture.text,
    capturedAt: capture.capturedAt,
  });
  assert.deepEqual(await remote(pairing).capture(capture.text!, capture.capturedAt), result);
  assert.equal(fetch.mock.callCount(), 1);
});

const clipCalls: { name: string; call: (client: Remote) => Promise<unknown> }[] = [
  { name: "clips", call: (client) => client.clips() },
  { name: "clip", call: (client) => client.clip(summary.path) },
  { name: "captureClip", call: (client) => client.captureClip(capture) },
];

const failures = [
  { name: "unpaired", response: () => new Response(null, { status: 401 }), error: Unpaired },
  { name: "offline on 502", response: () => new Response(null, { status: 502 }), error: Offline },
  { name: "offline on 504", response: () => new Response(null, { status: 504 }), error: Offline },
  {
    name: "server error",
    response: () => Response.json({ error: "Clip not found." }, { status: 404 }),
    error: /^Error: Clip not found\.$/,
  },
  {
    name: "non-JSON error",
    response: () => new Response("Server failed", { status: 500 }),
    error: /^Error: Kintsugi answered 500\.$/,
  },
];

for (const { name, call } of clipCalls) {
  for (const failure of failures) {
    test(`${name} reports ${failure.name}`, async (t) => {
      t.mock.method(globalThis, "fetch", async () => failure.response());
      await assert.rejects(() => call(remote(pairing)), failure.error);
    });
  }

  test(`${name} reports network failures as offline with their cause`, async (t) => {
    const cause = new TypeError("Network request failed");
    t.mock.method(globalThis, "fetch", async () => { throw cause; });
    await assert.rejects(() => call(remote(pairing)), (error: unknown) => {
      assert.ok(error instanceof Offline);
      assert.equal(error.cause, cause);
      return true;
    });
  });

  test(`${name} aborts unreachable requests after eight seconds`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal: AbortSignal | undefined;
    t.mock.method(globalThis, "fetch", (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
      });
    });
    const result = assert.rejects(() => call(remote(pairing)), Offline);
    assert.ok(signal);
    t.mock.timers.tick(7999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    await result;
  });
}
