// KI-44 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium. Settings → Export chooses the destinations and the
// "written by a human" statement; a document is then exported as a PDF
// (typeset by Typst in the backend), LinkedIn text (the clipboard) and one
// HTML file. Files go to this run's scratch config folder; nothing touches
// the owner's vault, config or blog.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DOC = "posts/on-craft.mdx";
const STATEMENT = "Written by me, a human, one sentence at a time.";
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const SHOTS = process.env.KINTSUGI_SHOTS;

let runner: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let url = "";
let vault = "";
let config = "";
let output = "";

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

/** A PNG of gold bands, so the figure is real pixels. */
function png(w = 240, h = 120): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    const gold = y % 30 > 3;
    for (let x = 0; x < w; x++) row.set(gold ? [200, 160, 40] : [40, 34, 28], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const onDisk = (path: string) => readFileSync(resolve(vault, path), "utf8");
const shot = async (name: string) => {
  if (SHOTS) await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
};

/** Answers the save panel (an in-page prompt in headless mode). */
async function saveAs(path: string) {
  const prompt = page.locator("dialog[data-headless-dialog]");
  await prompt.locator("input").fill(path);
  await prompt.locator("input").press("Enter");
}

before(async () => {
  mkdirSync(resolve(root, ".headless"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, ".headless/ki44-"));
  vault = resolve(scratch, "vault");
  config = resolve(scratch, "config");
  const seeded = spawnSync(process.execPath, [resolve(root, "scripts/seed-desktop.mjs"), vault], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
  mkdirSync(resolve(vault, "media"));
  writeFileSync(resolve(vault, "media/bowl.png"), png());
  writeFileSync(resolve(vault, DOC), onDisk(DOC).replace(
    "## Practice",
    "Notes to self stay private. <!-- tighten the opening -->\n\n![A mended bowl](../media/bowl.png \"The seam, in gold.\")\n\n## Practice",
  ));

  const [frontend, backend] = [await freePort(), await freePort()];
  runner = spawn(process.execPath, [resolve(root, "scripts/desktop-headless.mjs")], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      KINTSUGI_VAULT: vault,
      KINTSUGI_CONFIG_DIR: config,
      KINTSUGI_FRONTEND_PORT: String(frontend),
      KINTSUGI_BACKEND_PORT: String(backend),
    },
  });
  url = await new Promise<string>((done, fail) => {
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
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  if (runner?.pid) {
    try {
      process.kill(-runner.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
});

test("Settings → Export picks the menu's destinations and words the statement", { timeout: 120_000 }, async () => {
  page = await context.newPage();
  await page.goto(url);
  await page.locator(`[title="${DOC}"]`).click();
  await page.locator(`[title="${DOC}"][data-active="true"]`).waitFor();

  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const destinations = settings.getByRole("list", { name: "Export destinations" });
  // Loaded from the backend: the switches turn on once the settings arrive.
  await destinations.locator('[role="switch"][aria-checked="true"]').nth(3).waitFor();
  for (const name of ["hussain.ph", "PDF", "LinkedIn text", "HTML"]) {
    assert.equal(await destinations.getByRole("switch", { name }).getAttribute("aria-checked"), "true", `${name} is on by default`);
  }
  const statement = settings.getByRole("switch", { name: "Add a “written by a human” statement" });
  assert.equal(await statement.getAttribute("aria-checked"), "false", "the statement is off by default");

  // The blog stays out of this writer's menu; the statement goes on, reworded.
  await destinations.getByRole("switch", { name: "hussain.ph" }).click();
  await statement.click();
  await settings.getByLabel("Statement wording").fill(STATEMENT);
  await settings.getByRole("switch", { name: "Sources appendix by default" }).click();
  await settings.getByLabel("Statement wording").blur();
  await settings.getByRole("button", { name: "Reset" }).waitFor();
  await settings.getByRole("heading", { name: "Export" }).scrollIntoViewIfNeeded();
  await shot("1-settings-export");
  await page.keyboard.press("Escape");

  for (let i = 0; i < 30 && !readFileSync(resolve(config, "export.json"), { encoding: "utf8", flag: "a+" }).includes(STATEMENT); i++) await page.waitForTimeout(100);
  const stored = JSON.parse(readFileSync(resolve(config, "export.json"), "utf8"));
  assert.deepEqual(stored.destinations, ["pdf", "linkedin", "html"]);
  assert.equal(stored.statement, true);
  assert.equal(stored.statementText, STATEMENT);

  await page.getByRole("button", { name: "Export…" }).click();
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitem", { name: /^PDF/ }).waitFor();
  assert.equal(await menu.getByRole("menuitem", { name: /hussain\.ph/ }).count(), 0);
  await shot("2-export-menu");
});

test("PDF: typeset by the backend, previewed page by page, saved where chosen", { timeout: 180_000 }, async () => {
  await page.getByRole("menu").getByRole("menuitem", { name: /^PDF/ }).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  const preview = dialog.getByRole("tabpanel", { name: "PDF preview" });
  await preview.getByRole("img", { name: "Page 1" }).waitFor({ timeout: 120_000 });
  await dialog.getByText(/^\d+ pages? · A4$/).waitFor();
  const checks = dialog.getByRole("list", { name: "Checks" });
  await checks.getByText(/\[\[Repair is a kind of attention\]\] becomes plain text: not published/).waitFor();
  assert.equal(await dialog.getByRole("switch", { name: "Written by a human" }).getAttribute("aria-checked"), "true");
  assert.equal(await dialog.getByRole("switch", { name: "Sources appendix" }).getAttribute("aria-checked"), "true");
  await shot("3-export-pdf");

  const target = resolve(config, "on-craft-and-repair.pdf");
  await dialog.getByRole("button", { name: "Save PDF…" }).click();
  await saveAs(target);
  await page.getByText("Saved on-craft-and-repair.pdf.").waitFor({ timeout: 120_000 });
  const pdf = readFileSync(target);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 10_000, `a real PDF with fonts and the figure (${pdf.length} bytes)`);
  assert.ok(pdf.toString("latin1").includes("https://www.britannica.com/art/kintsugi"), "the clip's link is a live PDF link");
});

test("LinkedIn: plain text with links spelled out, copied to the clipboard", { timeout: 120_000 }, async () => {
  await page.keyboard.press("Meta+Alt+e");
  const dialog = page.getByRole("dialog", { name: "Export" });
  await dialog.getByRole("radio", { name: "LinkedIn text" }).click();
  const text = dialog.getByLabel("Post text");
  await text.waitFor();
  await dialog.getByLabel("see more").waitFor();
  await dialog.getByText(/^[\d,]+ \/ 3,000 characters$/).waitFor();
  await shot("4-export-linkedin");

  await dialog.getByRole("button", { name: "Copy text" }).click();
  await page.getByText(/^Copied [\d,]+ characters for LinkedIn text\.$/).waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.startsWith("On craft and repair\n\nThere is a moment, somewhere in the second hour of sanding,"));
  assert.ok(copied.includes("I wrote about this before in Repair is a kind of attention, and I keep returning to\nGolden joinery (https://www.britannica.com/art/kintsugi)") || copied.includes("Golden joinery (https://www.britannica.com/art/kintsugi)"));
  assert.ok(copied.includes("“The gold seam is not the flaw."), "quotes are quoted, not >");
  assert.ok(copied.includes("\n\nSources\n• Golden joinery"));
  assert.ok(copied.trimEnd().endsWith(STATEMENT));
  assert.ok(!/\[\[|\]\(|^#{1,6} |^> |\*\*|tighten the opening/m.test(copied), "no Markdown and no private notes");
});

test("HTML: one self-contained file, previewed in a sandboxed frame", { timeout: 120_000 }, async () => {
  await page.keyboard.press("Meta+Alt+e");
  const dialog = page.getByRole("dialog", { name: "Export" });
  await dialog.getByRole("radio", { name: "HTML" }).click();
  const frame = dialog.frameLocator('iframe[title="HTML preview"]');
  await frame.getByRole("heading", { name: "On craft and repair" }).waitFor();
  await frame.getByText("Fig. 1").waitFor();
  await frame.getByText(STATEMENT).waitFor();
  await shot("5-export-html");

  const target = resolve(config, "on-craft-and-repair.html");
  await dialog.getByRole("button", { name: "Save HTML…" }).click();
  await saveAs(target);
  await page.getByText("Saved on-craft-and-repair.html.").waitFor();
  const html = readFileSync(target, "utf8");
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('<img src="data:image/png;base64,'), "the figure is inside the file");
  assert.ok(html.includes('<a href="https://www.britannica.com/art/kintsugi">'));
  assert.ok(html.includes(`<p class="statement">${STATEMENT}</p>`));
  assert.ok(!/<script|tighten the opening|\[\[/.test(html));

  // The saved file, opened on its own, as a reader would see it.
  const reader = await context.newPage();
  await reader.setContent(html);
  await reader.setViewportSize({ width: 900, height: 1100 });
  if (SHOTS) await reader.screenshot({ path: resolve(SHOTS, "6-html-file.png"), fullPage: false });
  await reader.close();
});
