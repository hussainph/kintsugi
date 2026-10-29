import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Clip, ClipCapture, ClipSummary, DesktopClipCapture } from "./clips.ts";
import {
  HttpError,
  isPermanentCaptureStatus,
  localStamp,
  Offline,
  parsePairLink,
  remote,
  Unpaired,
  type Remote,
  type Saved,
} from "./remote.ts";

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

test("sends the capture's id unchanged so a retry reuses it", async (t) => {
  const id = "6f1e6c4a-2b0e-4d6e-9f0a-2f7c8b9d1e3a";
  const retried: ClipCapture = { ...capture, id };
  const result = { path: summary.path };
  const fetch = mockResponse(t, "POST", "/v1/clips", result, retried);
  const client = remote(pairing);
  assert.deepEqual(await client.captureClip(retried), result);
  assert.deepEqual(await client.captureClip(retried), result);
  const bodies = fetch.mock.calls.map((call) => JSON.parse(String(call.arguments[1]?.body)) as ClipCapture);
  assert.deepEqual(bodies.map((body) => body.id), [id, id]);
  assert.equal(fetch.mock.callCount(), 2);
});

test("desktop captures inherit the capture id", () => {
  const desktop: DesktopClipCapture = {
    id: "9b2f0c4e-8a1d-4c3b-9e7f-1a2b3c4d5e6f",
    capturedAt: capture.capturedAt,
    via: "mac",
    image: [137, 80, 78, 71],
  };
  const phone: ClipCapture = { ...desktop, image: "iVBORw==" };
  assert.equal(desktop.id, "9b2f0c4e-8a1d-4c3b-9e7f-1a2b3c4d5e6f");
  assert.equal(phone.id, desktop.id);
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

test("HttpError keeps the status and the server's message", () => {
  const error = new HttpError(422, "The capturedAt field must be a string.");
  assert.ok(error instanceof Error);
  assert.equal(error.status, 422);
  assert.equal(error.message, "The capturedAt field must be a string.");
});

test("HttpError falls back to a safe message when the server sent none", () => {
  for (const message of [undefined, null, "", "   ", 42, [], {}, { message: "nested" }, new Error("nested")]) {
    const error = new HttpError(500, message);
    assert.equal(error.status, 500);
    assert.equal(error.message, "Kintsugi answered 500.");
  }
});

const captureStatuses = [400, 404, 408, 409, 413, 422, 429, 500, 503];

for (const status of captureStatuses) {
  test(`captureClip reports ${status} as an HttpError`, async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({ error: `Server says ${status}.` }, { status }),
    );
    await assert.rejects(() => remote(pairing).captureClip(capture), (error: unknown) => {
      assert.ok(error instanceof HttpError, `expected an HttpError for ${status}`);
      assert.equal(error.status, status);
      assert.equal(error.message, `Server says ${status}.`);
      assert.equal(isPermanentCaptureStatus(error.status), status === 400 || status === 413 || status === 422);
      return true;
    });
  });
}

const malformedReplies = [
  { name: "a non-JSON body", reply: () => new Response("Server failed", { status: 500 }) },
  { name: "an empty body", reply: () => new Response(null, { status: 500 }) },
  { name: "JSON with no error field", reply: () => Response.json({ message: "nope" }, { status: 500 }) },
  { name: "a JSON string body", reply: () => Response.json("nope", { status: 500 }) },
  { name: "a number error", reply: () => Response.json({ error: 42 }, { status: 500 }) },
  { name: "an object error", reply: () => Response.json({ error: { message: "nope" } }, { status: 500 }) },
  { name: "a null error", reply: () => Response.json({ error: null }, { status: 500 }) },
  { name: "a blank error", reply: () => Response.json({ error: "  " }, { status: 500 }) },
];

for (const { name, reply } of malformedReplies) {
  test(`captureClip answers ${name} with a safe message`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => reply());
    await assert.rejects(() => remote(pairing).captureClip(capture), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Kintsugi answered 500.");
      return true;
    });
  });
}

test("only an invalid, oversized or mistyped capture is permanent", () => {
  for (const status of [400, 413, 422]) {
    assert.equal(isPermanentCaptureStatus(status), true, `status ${status}`);
  }
  const retryable = [0, 200, 201, 204, 401, 403, 404, 408, 409, 418, 429, 500, 501, 502, 503, 504, 507, 599];
  for (const status of retryable) {
    assert.equal(isPermanentCaptureStatus(status), false, `status ${status}`);
  }
});

test("write accepts the Mac's 409 as a conflict result", async (t) => {
  const current = { text: "Their version", version: "v2" };
  const saved: Saved = { result: "conflict", current };
  const fetch = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input, pairing.url + "/v1/doc");
    assert.equal(init?.method, "PUT");
    assert.equal(init?.body, JSON.stringify({ path: "notes/a-post.md", text: "My version", base: "v1" }));
    return Response.json(saved, { status: 409 });
  });
  assert.deepEqual(await remote(pairing).write("notes/a-post.md", "My version", "v1"), saved);
  assert.equal(fetch.mock.callCount(), 1);
});

test("write still reports other statuses as an HttpError", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "The vault is read-only." }, { status: 500 }),
  );
  await assert.rejects(() => remote(pairing).write("notes/a-post.md", "My version", "v1"), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 500);
    assert.equal(error.message, "The vault is read-only.");
    return true;
  });
});

const clipCalls: { name: string; call: (client: Remote) => Promise<unknown> }[] = [
  { name: "clips", call: (client) => client.clips() },
  { name: "clip", call: (client) => client.clip(summary.path) },
  { name: "captureClip", call: (client) => client.captureClip(capture) },
];

/** A validation function keeps every expected failure in one table, whatever
 *  its class, message or status. */
type Expected = (error: unknown) => boolean;

const failures: { name: string; response: () => Response; expected: Expected }[] = [
  {
    name: "unpaired",
    response: () => new Response(null, { status: 401 }),
    expected: (error) => error instanceof Unpaired,
  },
  {
    name: "unpaired even with an error body",
    response: () => Response.json({ error: "Bad token." }, { status: 401 }),
    expected: (error) => error instanceof Unpaired,
  },
  {
    name: "offline on 502",
    response: () => new Response(null, { status: 502 }),
    expected: (error) => error instanceof Offline,
  },
  {
    name: "offline on 504",
    response: () => new Response(null, { status: 504 }),
    expected: (error) => error instanceof Offline,
  },
  {
    name: "the server's message as an HttpError",
    response: () => Response.json({ error: "Clip not found." }, { status: 404 }),
    expected: (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 404);
      assert.equal(error.message, "Clip not found.");
      return true;
    },
  },
  {
    name: "a safe message when the error body isn't JSON",
    response: () => new Response("Server failed", { status: 500 }),
    expected: (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Kintsugi answered 500.");
      return true;
    },
  },
];

for (const { name, call } of clipCalls) {
  for (const failure of failures) {
    test(`${name} reports ${failure.name}`, async (t) => {
      t.mock.method(globalThis, "fetch", async () => failure.response());
      await assert.rejects(() => call(remote(pairing)), failure.expected);
    });
  }

  test(`${name} reports network failures as offline with their cause`, async (t) => {
    const cause = new TypeError("Network request failed");
    t.mock.method(globalThis, "fetch", async () => {
      throw cause;
    });
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
