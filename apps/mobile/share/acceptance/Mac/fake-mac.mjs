#!/usr/bin/env node
/**
 * Acceptance stand-in for the Mac's Phone API, so the share extension and the
 * app's outbox can be exercised without the desktop app (a Tauri GUI app) and
 * without Tailscale. Mirrors the contract in `docs/inspiration.md` and
 * `apps/desktop/src-tauri/src/phone/server.rs`:
 *
 *   GET  /v1/hello   -> {app:"kintsugi", api:2, vault:"acceptance"}
 *   GET  /v1/tree    -> []
 *   GET  /v1/clips   -> []
 *   POST /v1/clips   -> {path} | 400 | 401 | 413 | 500 | dropped reply
 *   GET  /page.html  -> a page for the real-Safari case
 *   POST /_control   -> {"mode":"ok|offline|500|400|lost|handoff"} switch faults at runtime
 *   GET  /_state     -> {"mode":..., "ids":[...]}
 *
 * Every request is appended to a JSONL journal so assertions run on the host,
 * not inside the UI test. `id` reuse answers with the original path (the
 * contract's dedupe) and is journaled with `dedup:true`.
 *
 * Loopback only: ATS exempts 127.0.0.1 and iOS does not raise the Local Network
 * privacy prompt for it, so no SpringBoard alert ever needs dismissing.
 *
 * No dependencies, no private APIs, no credentials beyond the test token.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const MODES = new Set(["ok", "offline", "500", "400", "lost", "handoff"]);
const MAX_BODY = 32 * 1024 * 1024;

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8848" },
    token: { type: "string", default: "test-token" },
    journal: { type: "string", default: "mac.jsonl" },
    mode: { type: "string", default: "ok" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    [
      "usage: fake-mac.mjs [--port 8848] [--token test-token] [--journal mac.jsonl] [--mode ok|offline|500|400|lost|handoff]",
      "",
      "  ok       accept captures (dedupe by id), answer {path}",
      "  offline  drop the connection before reading the body",
      "  lost     read and journal the capture, commit it, then drop the reply (a retry dedupes)",
      "  500      journal the capture, answer 500 (retryable on the phone)",
      "  400      journal the capture, answer 400 (permanent rejection)",
      "  handoff  commit/drop the first extension request, then 503 its retries; only Kintsugi/ succeeds",
    ].join("\n"),
  );
  process.exit(0);
}
if (!MODES.has(values.mode)) {
  console.error(`fake-mac: unknown --mode ${values.mode}`);
  process.exit(2);
}

const journalPath = resolve(values.journal);
mkdirSync(dirname(journalPath), { recursive: true });

const state = { mode: values.mode, seen: new Map() };

function journal(event) {
  appendFileSync(journalPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function send(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.length),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function authorized(req) {
  return req.headers.authorization === `Bearer ${values.token}`;
}

/** The fields an assertion may look at; never the whole image. */
function summarize(capture, raw) {
  const image = typeof capture?.image === "string" ? capture.image : null;
  const imageBytes = image === null ? null : Buffer.from(image, "base64").length;
  return {
    id: typeof capture?.id === "string" ? capture.id : null,
    via: typeof capture?.via === "string" ? capture.via : null,
    url: typeof capture?.url === "string" ? capture.url : null,
    note: typeof capture?.note === "string" ? capture.note : null,
    textBytes: typeof capture?.text === "string" ? Buffer.byteLength(capture.text) : null,
    imageBytes,
    imageType: typeof capture?.imageType === "string" ? capture.imageType : null,
    capturedAt: typeof capture?.capturedAt === "string" ? capture.capturedAt : null,
    bodyBytes: raw.length,
    bodySha256: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    // Capture fields are flat scalars. Ignore JSON key order / escaped slashes
    // when checking that Swift-to-JS handoff preserves all semantic content.
    captureSha256: createHash("sha256").update(JSON.stringify(capture, Object.keys(capture ?? {}).sort())).digest("hex"),
  };
}

/** The contract's dedupe: a repeated id answers with the original clip's path. */
function captureKey(capture, raw) {
  return typeof capture?.id === "string" ? capture.id.toLowerCase() : createHash("sha256").update(raw).digest("hex");
}

function clipPath(capture, raw) {
  const key = captureKey(capture, raw);
  const existing = state.seen.get(key);
  if (existing !== undefined) return { path: existing, dedup: true, key };
  const created = `inspiration/clip-${String(key).replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}.md`;
  state.seen.set(key, created);
  return { path: created, dedup: false, key };
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>KI-2 acceptance page</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font: 20px/1.5 -apple-system, system-ui; margin: 48px 24px">
<h1>KI-2 acceptance page</h1>
<p>Share this page from Safari to Kintsugi.</p>
<p><a href="https://example.com/">A link that must not be followed</a></p>
</body></html>
`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method ?? "GET";

  try {
    if (method === "POST" && path === "/_control") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!MODES.has(body.mode)) return send(res, 400, { error: `mode must be one of ${[...MODES].join(", ")}` });
      state.mode = body.mode;
      journal({ event: "control", mode: state.mode });
      return send(res, 200, { mode: state.mode });
    }

    if (method === "GET" && path === "/_state") {
      return send(res, 200, { mode: state.mode, ids: [...state.seen.keys()] });
    }

    if (method === "GET" && (path === "/" || path === "/page.html")) {
      journal({ event: "page", path });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(page);
    }

    if (!path.startsWith("/v1/")) return send(res, 404, { error: "not found" });
    if (!authorized(req)) {
      journal({ event: "unauthorized", method, path });
      return send(res, 401, { error: "bad token" });
    }

    if (method === "GET" && path === "/v1/hello") {
      journal({ event: "hello" });
      return send(res, 200, { app: "kintsugi", api: 2, vault: "acceptance" });
    }
    if (method === "GET" && path === "/v1/tree") {
      journal({ event: "tree" });
      return send(res, 200, []);
    }
    if (method === "GET" && path === "/v1/clips") {
      journal({ event: "clips-list" });
      return send(res, 200, []);
    }

    if (method === "POST" && path === "/v1/clips") {
      if (state.mode === "offline") {
        journal({ event: "clips", outcome: "dropped-before-body", mode: state.mode });
        return req.socket.destroy();
      }

      let raw;
      try {
        raw = await readBody(req);
      } catch (error) {
        journal({ event: "clips", outcome: error?.tooLarge ? "too-large" : "read-error", mode: state.mode });
        return send(res, 413, { error: "capture too large" });
      }

      let capture;
      try {
        capture = JSON.parse(raw.toString("utf8"));
      } catch {
        journal({ event: "clips", outcome: "invalid-json", mode: state.mode, bodyBytes: raw.length });
        return send(res, 400, { error: "not JSON" });
      }

      const view = { ...summarize(capture, raw), userAgent: req.headers["user-agent"] ?? null };
      if (typeof capture?.capturedAt !== "string" || typeof capture?.via !== "string" || (view.imageBytes !== null && view.imageType === null)) {
        journal({ event: "clips", outcome: "invalid-capture", mode: state.mode, ...view, status: 400 });
        return send(res, 400, { error: "invalid capture" });
      }

      if (state.mode === "handoff" && !view.userAgent?.startsWith("Kintsugi/")) {
        const key = captureKey(capture, raw);
        if (view.userAgent?.startsWith("KintsugiShare/") && !state.seen.has(key)) {
          const committed = clipPath(capture, raw);
          journal({ event: "clips", outcome: "reply-lost", mode: state.mode, status: null, ...committed, ...view });
          return req.socket.destroy();
        }
        // Fail closed for unknown/missing User-Agents. The receipt stays in
        // memory, but no extension retry can acknowledge/remove the payload.
        journal({ event: "clips", outcome: "extension-paused", mode: state.mode, status: 503,
          dedup: state.seen.has(key), path: state.seen.get(key) ?? null, ...view });
        return send(res, 503, { error: "acceptance: waiting for main-app handoff" });
      }
      if (state.mode === "lost") {
        // The Mac committed the clip; only the reply was lost. Registering the
        // id is what makes the retry dedupe (and answers with the same path).
        const committed = clipPath(capture, raw);
        journal({ event: "clips", outcome: "reply-lost", mode: state.mode, status: null, ...committed, ...view });
        return req.socket.destroy();
      }
      if (state.mode === "500") {
        journal({ event: "clips", outcome: "forced-500", mode: state.mode, status: 500, ...view });
        return send(res, 500, { error: "acceptance: forced server error" });
      }
      if (state.mode === "400") {
        journal({ event: "clips", outcome: "forced-400", mode: state.mode, status: 400, ...view });
        return send(res, 400, { error: "acceptance: forced invalid capture" });
      }

      const accepted = clipPath(capture, raw);
      journal({ event: "clips", outcome: "accepted", mode: state.mode, status: 200, dedup: accepted.dedup, path: accepted.path, ...view });
      return send(res, 200, { path: accepted.path });
    }

    journal({ event: "unrouted", method, path });
    return send(res, 404, { error: "not found" });
  } catch (error) {
    journal({ event: "error", method, path, message: String(error) });
    if (!res.headersSent) send(res, 500, { error: "acceptance server error" });
    else res.destroy();
  }
});

server.on("error", (error) => {
  console.error(`fake-mac: ${error.message}`);
  process.exit(1);
});

server.listen(Number(values.port), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : Number(values.port);
  journal({ event: "listening", port, mode: state.mode });
  console.log(`LISTENING ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    journal({ event: "stop", signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
