import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { createLabMiddleware, labPlugin } from "../src/server.ts";
import { createStore } from "../src/store.ts";
import { fixture } from "./helpers.ts";

async function serverFixture() {
  const f = await fixture();
  let analyses = 0;
  const middleware = createLabMiddleware({
    ...f,
    analysis: async () => ({ analyses: ++analyses }),
  });
  const server = createServer((req, res) =>
    middleware(req, res, () => {
      res.writeHead(404);
      res.end("Not Lab");
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ) =>
    new Promise<{
      status: number;
      body: string;
      headers: Record<string, unknown>;
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: options.method ?? "GET",
          headers: options.headers,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode!, body, headers: res.headers }),
          );
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  return {
    ...f,
    call,
    port,
    cleanup: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await f.cleanup();
    },
  };
}
test("Vite plugin middleware returns the discovered catalog, derived state and callback analysis", async () => {
  const f = await serverFixture();
  try {
    assert.equal(labPlugin(f).name, "lab-file-state");
    const catalog = await f.call("/__lab/catalog");
    assert.equal(catalog.status, 200);
    assert.equal(JSON.parse(catalog.body)[0].meta.id, "component/sample");
    const state = await f.call("/__lab/state?id=component%2Fsample");
    assert.equal(JSON.parse(state.body).revision, 0);
    assert.equal(state.headers["cache-control"], "no-store");
    assert.equal(
      JSON.parse((await f.call("/__lab/analysis")).body).analyses,
      1,
    );
    assert.equal(
      JSON.parse((await f.call("/__lab/analysis")).body).analyses,
      2,
    );
    assert.equal((await f.call("/product")).body, "Not Lab");
  } finally {
    await f.cleanup();
  }
});
test("middleware writes use the shared validators and optimistic revision; the store sees the same event", async () => {
  const f = await serverFixture();
  try {
    const body = JSON.stringify({
      entryId: "component/sample",
      revision: 0,
      action: { type: "note", kind: "critique", text: "Review from browser." },
    });
    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${f.port}`,
      },
      body,
    };
    const saved = await f.call("/__lab/state", options);
    assert.equal(saved.status, 200);
    assert.deepEqual(
      JSON.parse(saved.body),
      await createStore(f).read("component/sample"),
    );
    const conflict = await f.call("/__lab/state", options);
    assert.equal(conflict.status, 409);
    assert.equal(JSON.parse(conflict.body).revision, 1);
    const invalid = await f.call("/__lab/state", {
      ...options,
      body: JSON.stringify({
        entryId: "../escape",
        revision: 1,
        action: { type: "status", status: "ready" },
      }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await createStore(f).read("component/sample")).revision, 1);
  } finally {
    await f.cleanup();
  }
});
test("middleware rejects DNS-rebinding hosts, cross-origin writes, non-JSON and oversized bodies", async () => {
  const f = await serverFixture();
  try {
    const forbiddenHeaders: Record<string, string>[] = [
      { Host: "attacker.example" },
      { Origin: "https://attacker.example" },
      { Origin: "null" },
      { "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of forbiddenHeaders) {
      assert.equal((await f.call("/__lab/catalog", { headers })).status, 403);
    }
    assert.equal(
      (
        await f.call("/__lab/catalog", {
          headers: { Origin: `http://localhost:${f.port}` },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call("/__lab/catalog", {
          headers: { Origin: `https://127.0.0.1:${f.port}` },
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.call("/__lab/state", { method: "POST", body: "{}" })).status,
      415,
    );
    assert.equal(
      (
        await f.call("/__lab/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "invalid JSON",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call("/__lab/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "x".repeat(128 * 1024 + 1),
        })
      ).status,
      413,
    );
    assert.equal(
      (await f.call("/__lab/state?id=component/sample&id=page/another")).status,
      400,
    );
    assert.equal(
      (await f.call("/__lab/catalog", { method: "DELETE" })).status,
      405,
    );
    assert.equal((await f.call("/__lab/unknown")).status, 404);
    assert.equal((await createStore(f).read("component/sample")).revision, 0);
  } finally {
    await f.cleanup();
  }
});
