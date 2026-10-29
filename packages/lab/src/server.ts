import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { exactKeys, object, ValidationError } from "./schema.ts";
import { createStore, LockTimeout, RevisionConflict } from "./store.ts";

export interface LabPluginOptions {
  root: string;
  entriesDir: string;
  analysis?: () => unknown | Promise<unknown>;
}
const JSON_LIMIT = 128 * 1024;
class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
function loopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
function checkRequest(req: IncomingMessage): void {
  const address = req.socket.remoteAddress;
  if (!address || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address))
    throw new HttpError(403, "Lab is loopback-only");
  const host = req.headers.host;
  if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/.test(host))
    throw new HttpError(403, "Invalid Lab Host");
  const protocol = (req.socket as typeof req.socket & { encrypted?: boolean })
    .encrypted
    ? "https:"
    : "http:";
  const requestHost = new URL(`${protocol}//${host}`);
  if (!loopbackHost(requestHost.hostname))
    throw new HttpError(403, "Invalid Lab Host");
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new HttpError(403, "Invalid Lab Origin");
    }
    if (
      parsed.protocol !== protocol ||
      !loopbackHost(parsed.hostname) ||
      parsed.host !== requestHost.host ||
      parsed.origin !== origin
    )
      throw new HttpError(403, "Cross-origin Lab requests are forbidden");
  }
  if (req.headers["sec-fetch-site"] === "cross-site")
    throw new HttpError(403, "Cross-site Lab requests are forbidden");
}
function send(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      req.headers["content-type"] ?? "",
    )
  )
    throw new HttpError(415, "Content-Type must be application/json");
  if (
    req.headers["content-encoding"] &&
    req.headers["content-encoding"] !== "identity"
  )
    throw new HttpError(415, "Encoded request bodies are not supported");
  const length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > JSON_LIMIT)) {
    req.resume();
    throw new HttpError(413, "JSON body exceeds 128 KiB");
  }
  const content = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const timer = setTimeout(
      () => finish(new HttpError(408, "JSON request timed out")),
      10000,
    );
    timer.unref();
    function finish(error?: Error): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        chunks.length = 0;
        reject(error);
      } else {
        try {
          resolve(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          );
        } catch {
          reject(new HttpError(400, "JSON body must be valid UTF-8"));
        }
      }
    }
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > JSON_LIMIT)
        finish(new HttpError(413, "JSON body exceeds 128 KiB"));
      else chunks.push(chunk);
    });
    req.on("end", () => finish());
    req.on("error", (error) => finish(error));
    req.on("aborted", () => finish(new HttpError(400, "Request aborted")));
  });
  try {
    return JSON.parse(content);
  } catch {
    throw new HttpError(400, "Invalid JSON request");
  }
}
/** Exported for focused middleware tests; the Vite plugin is the public integration. */
export function createLabMiddleware(options: LabPluginOptions) {
  const store = createStore(options);
  return (
    req: IncomingMessage,
    res: ServerResponse,
    next: (error?: unknown) => void,
  ): void => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/__lab" && !path.startsWith("/__lab/")) {
      next();
      return;
    }
    void (async () => {
      checkRequest(req);
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/__lab/catalog") {
        if (url.search)
          throw new HttpError(400, "Catalog does not accept query parameters");
        send(res, 200, await store.catalog());
      } else if (req.method === "GET" && url.pathname === "/__lab/state") {
        const ids = url.searchParams.getAll("id");
        if (
          ids.length !== 1 ||
          [...url.searchParams.keys()].some((key) => key !== "id")
        )
          throw new HttpError(400, "Provide exactly one entry id");
        send(res, 200, await store.read(ids[0]));
      } else if (req.method === "POST" && url.pathname === "/__lab/state") {
        if (url.search)
          throw new HttpError(
            400,
            "State writes do not accept query parameters",
          );
        const body = object(await readJson(req), "request");
        exactKeys(body, ["entryId", "revision", "action"], "request");
        if (
          typeof body.entryId !== "string" ||
          typeof body.revision !== "number"
        )
          throw new HttpError(400, "entryId and revision are required");
        send(
          res,
          200,
          await store.append(body.entryId, body.revision, body.action),
        );
      } else if (req.method === "GET" && url.pathname === "/__lab/analysis") {
        if (url.search)
          throw new HttpError(400, "Analysis does not accept query parameters");
        send(res, 200, options.analysis ? await options.analysis() : null);
      } else if (
        ["/__lab/catalog", "/__lab/state", "/__lab/analysis"].includes(
          url.pathname,
        )
      ) {
        throw new HttpError(405, "Method not allowed");
      } else throw new HttpError(404, "Unknown Lab endpoint");
    })().catch((error: unknown) => {
      const status =
        error instanceof HttpError ||
        error instanceof RevisionConflict ||
        error instanceof LockTimeout
          ? error.statusCode
          : error instanceof ValidationError
            ? 400
            : 500;
      send(res, status, {
        error: error instanceof Error ? error.message : "Lab request failed",
        ...(error instanceof RevisionConflict
          ? { revision: error.actual }
          : {}),
      });
    });
  };
}
export function labPlugin(options: LabPluginOptions): Plugin {
  return {
    name: "lab-file-state",
    config: () => ({
      server: { host: "127.0.0.1", cors: false },
      preview: { host: "127.0.0.1", cors: false },
    }),
    configureServer(server) {
      server.middlewares.use(createLabMiddleware(options));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createLabMiddleware(options));
    },
  };
}
