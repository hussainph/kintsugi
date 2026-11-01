// Starts `pnpm desktop:headless` on free ports with a fresh scratch vault and
// config under .headless/, for runtime tests driven by headless Chromium.
// Never the owner's vault, config or screen.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

export type App = { url: string; scratch: string; vault: string; config: string; shots: string; stop: () => void };

/** `prepare` runs on the seeded vault before the app starts. */
export async function startApp(prefix: string, env: Record<string, string>, prepare?: (vault: string) => void): Promise<App> {
  mkdirSync(resolve(root, ".headless"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, `.headless/${prefix}-`));
  const vault = resolve(scratch, "vault");
  const config = resolve(scratch, "config");
  const shots = resolve(scratch, "shots");
  mkdirSync(shots);
  const seeded = spawnSync(process.execPath, [resolve(root, "scripts/seed-desktop.mjs"), vault], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
  prepare?.(vault);

  const [frontend, backend] = [await freePort(), await freePort()];
  const runner: ChildProcess = spawn(process.execPath, [resolve(root, "scripts/desktop-headless.mjs")], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      KINTSUGI_VAULT: vault,
      KINTSUGI_CONFIG_DIR: config,
      KINTSUGI_FRONTEND_PORT: String(frontend),
      KINTSUGI_BACKEND_PORT: String(backend),
      ...env,
    },
  });
  let output = "";
  const url = await new Promise<string>((done, fail) => {
    const seen = (chunk: Buffer) => {
      output += chunk;
      const found = /^(http:\/\/127\.0\.0\.1:\d+\/#headless=\S+)$/m.exec(output);
      if (found) done(found[1]);
    };
    runner.stdout!.on("data", seen);
    runner.stderr!.on("data", (chunk) => (output += chunk));
    runner.once("exit", (code) => fail(new Error(`desktop:headless exited (${code}):\n${output.slice(-4000)}`)));
  });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${frontend}/`)).ok) break;
    } catch {
      if (i > 600) throw new Error(`frontend never started:\n${output.slice(-4000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const stop = () => {
    if (!runner.pid) return;
    try {
      process.kill(-runner.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  };
  return { url, scratch, vault, config, shots, stop };
}
