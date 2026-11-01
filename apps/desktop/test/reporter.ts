// A compact `node --test` reporter for the runtime suite (KI-47): one line per
// test, and for a failure its file, line and the error's first lines (a
// Playwright call log is cut to the locator it was waiting for). The run ends
// with every failure listed again, so one flaky run is diagnosable from the
// tail of a log.
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

type Location = { file?: string; line?: number; column?: number };
type TestData = Location & {
  name: string;
  nesting: number;
  details?: { duration_ms?: number; type?: string; error?: unknown };
  message?: string;
};
type Event = { type: string; data: TestData };

const cwd = process.cwd();
const where = (data: Location) => {
  if (!data.file) return "";
  const file = data.file.startsWith("file:") ? fileURLToPath(data.file) : data.file;
  return `${relative(cwd, file)}${data.line ? `:${data.line}` : ""}`;
};
const seconds = (ms = 0) => `${(ms / 1000).toFixed(1)}s`;

/** The useful part of an error: its message (call log trimmed) and the test file frame. */
function describe(error: unknown, file?: string): string[] {
  let cause = error as { cause?: unknown; message?: string; stack?: string; code?: string; failureType?: string };
  // node:test wraps the thrown error in ERR_TEST_FAILURE.
  while (cause?.code === "ERR_TEST_FAILURE" && cause.cause) cause = cause.cause as typeof cause;
  const message = String(cause?.message ?? cause ?? "unknown error");
  const lines = message.split("\n");
  const log = lines.findIndex((l) => /^\s*Call log:/.test(l));
  const kept = (log >= 0 ? [...lines.slice(0, log), ...lines.slice(log + 1, log + 3)] : lines).filter((l) => l.trim());
  const out = kept.slice(0, 12).map((l) => l.trimEnd());
  if (kept.length > 12) out.push(`… ${kept.length - 12} more lines`);
  const name = file && (file.startsWith("file:") ? fileURLToPath(file) : file);
  const frame = String(cause?.stack ?? "")
    .split("\n")
    .find((l) => (name ? l.includes(name) : /\.test\.ts:\d+/.test(l)));
  if (frame) out.push(`at ${relative(cwd, frame.trim().replace(/^at\s+(?:.*\()?(?:file:\/\/)?/, "").replace(/\)$/, ""))}`);
  return out;
}

export default async function* reporter(source: AsyncIterable<Event>) {
  const failures: string[] = [];
  let passed = 0;
  const started = Date.now();
  for await (const { type, data } of source) {
    if (type === "test:pass" && data.details?.type !== "suite") {
      passed++;
      yield `✔ ${data.name} (${seconds(data.details?.duration_ms)})\n`;
    } else if (type === "test:fail") {
      const head = `✖ ${data.name} (${seconds(data.details?.duration_ms)}) ${where(data)}`;
      const body = describe(data.details?.error, data.file).map((l) => `    ${l}`);
      failures.push([head, ...body].join("\n"));
      yield `${head}\n${body.join("\n")}\n`;
    } else if (type === "test:stderr" || type === "test:stdout") {
      yield data.message ?? "";
    } else if (type === "test:diagnostic" && data.nesting === 0 && /^(tests|pass|fail|cancelled|duration_ms) /.test(data.message ?? "")) {
      yield `ℹ ${data.message}\n`;
    }
  }
  yield `\n${failures.length ? `FAILED ${failures.length} (${passed} passed) in ${seconds(Date.now() - started)}:\n${failures.join("\n")}` : `All ${passed} passed in ${seconds(Date.now() - started)}.`}\n`;
}
