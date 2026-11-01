// KI-9 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium. A scratch blog repository under .headless/ gets its posts
// mirrored into the vault, and a complete document is published into it.
//
// Nothing touches the owner's vault, config or blog checkout; headless
// refuses any blog folder outside a .headless/ directory.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DOC = "posts/on-craft.mdx";
const MIRROR = "hussain.ph/essays/the-sixth-attempt.md";
const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const ID = `${TODAY}-on-craft-and-repair`;
const POST = `src/content/writing/${ID}.md`;
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const SHOTS = process.env.KINTSUGI_SHOTS;

let runner: ChildProcess;
let browser: Browser;
let url = "";
let vault = "";
let blog = "";
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

/** A 2×2 PNG, so the image copy is real bytes. */
function png(): Buffer {
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
  const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
  const raw = Buffer.from([0, 200, 160, 40, 200, 160, 40, 0, 200, 160, 40, 200, 160, 40]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const onDisk = (path: string) => readFileSync(resolve(vault, path), "utf8");
const inBlog = (path: string) => readFileSync(resolve(blog, path), "utf8");
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
};

before(async () => {
  mkdirSync(resolve(root, ".headless"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, ".headless/ki9-"));
  vault = resolve(scratch, "vault");
  const seeded = spawnSync(process.execPath, [resolve(root, "scripts/seed-desktop.mjs"), vault], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
  // The finished essay links a blog post and carries a figure.
  mkdirSync(resolve(vault, "media"));
  writeFileSync(resolve(vault, "media/bowl.png"), png());
  writeFileSync(resolve(vault, DOC), onDisk(DOC).replace(
    "## Practice",
    "Five sites in, [[the-sixth-attempt|the sixth attempt]] said it better.\n\n![A mended bowl](../media/bowl.png \"The seam, in gold.\")\n\n## Practice",
  ));

  // A scratch blog: the real site's shape (see docs/publishing.md).
  blog = resolve(scratch, "blog");
  mkdirSync(resolve(blog, "src/content/writing"), { recursive: true });
  mkdirSync(resolve(blog, "src/content/notes"), { recursive: true });
  writeFileSync(resolve(blog, "src/content.config.ts"), "export const collections = {};\n");
  writeFileSync(resolve(blog, "src/content/writing/2026-09-16-the-sixth-attempt.md"), "---\ntitle: The sixth attempt\ntags: [writing, design]\n---\n\nI have built five portfolio websites.\n");
  writeFileSync(resolve(blog, "src/content/notes/2026-09-12-friction.md"), "---\ntags: [writing]\n---\n\nThe distance between having a thought and publishing it should be one command.\n");

  const [frontend, backend] = [await freePort(), await freePort()];
  runner = spawn(process.execPath, [resolve(root, "scripts/desktop-headless.mjs")], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      KINTSUGI_VAULT: vault,
      KINTSUGI_CONFIG_DIR: resolve(scratch, "config"),
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

let page: Page;

test("Settings → Blog refuses a non-scratch folder, then imports posts as a read-only mirror", { timeout: 120_000 }, async () => {
  page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(url);
  await page.locator(`[title="${DOC}"]`).waitFor();
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const field = settings.getByLabel("Blog repository folder");
  // A real folder that isn't a scratch copy: headless refuses it.
  await field.fill(root);
  await settings.getByRole("button", { name: "Save", exact: true }).last().click();
  await page.getByText(/scratch blog copy under a \.headless/).first().waitFor();

  await field.fill(blog);
  await settings.getByRole("button", { name: "Save", exact: true }).last().click();
  await settings.getByTestId("blog-status").getByText(/2 posts, mirrored read-only in/).waitFor();
  // That status counts the repository's posts as soon as the folder is saved;
  // the import runs after it, and its summary says the mirror is written (KI-47).
  await page.getByText("Imported 2 posts into hussain.ph/ (2 updated, 0 removed).").waitFor();
  await shot(page, "1-settings-blog");
  await page.keyboard.press("Escape");

  assert.match(onDisk(MIRROR), /^---\ntitle: "The sixth attempt"\nstatus: published\n[\s\S]*url: https:\/\/hussain\.ph\/essays\/the-sixth-attempt\/\npost: src\/content\/writing\/2026-09-16-the-sixth-attempt\.md\nmirror: hussain\.ph\n---\n\nI have built five/);
  assert.match(onDisk("hussain.ph/notes/friction.md"), /title: "The distance between having a thought and publishing it…"/);

  // The mirror opens read-only: typing changes nothing on disk.
  await page.locator(`[title="${MIRROR}"]`).click();
  await page.getByText("Read-only mirror of hussain.ph").waitFor();
  const before = onDisk(MIRROR);
  await page.locator(".cm-content").click();
  await page.keyboard.type("an edit");
  await page.waitForTimeout(700);
  assert.equal(onDisk(MIRROR), before);
  assert.ok(!(await page.locator(".cm-content").innerText()).includes("an edit"));
  await shot(page, "2-mirror-read-only");
});

test("Publish shows a preview and checks, then writes the post and its image", { timeout: 120_000 }, async () => {
  await page.locator(`[title="${DOC}"]`).click();
  await page.locator(`[title="${DOC}"][data-active="true"]`).waitFor();
  await page.getByRole("button", { name: "Publish…" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish to the blog" });
  const checks = dialog.getByRole("list", { name: "Checks" });
  await checks.getByText(/\[\[Repair is a kind of attention\]\] becomes plain text: not published/).waitFor();
  await checks.getByText(/\[\[What attention costs\]\] becomes plain text/).waitFor();
  const preview = dialog.getByRole("article", { name: "Post preview" });
  await preview.getByRole("heading", { name: "On craft and repair" }).waitFor();
  await preview.getByText("Fig. 1").waitFor();
  await shot(page, "3-publish-preview");

  await dialog.getByRole("switch", { name: "Sources appendix" }).click();
  await preview.getByRole("heading", { name: "Sources" }).waitFor();
  await dialog.getByRole("tab", { name: "File" }).click();
  const file = await dialog.getByLabel("Post file").innerText();
  assert.match(file, /^---\ntitle: "On craft and repair"\ntags: \[writing, craft\]\n---\n\nThere is a moment/);
  await shot(page, "4-publish-file");

  await dialog.getByRole("button", { name: "Write to blog" }).click();
  const done = page.getByRole("dialog", { name: "Written to the blog" });
  await done.getByRole("list", { name: "Changed in the blog repository" }).getByText(POST).waitFor();
  await shot(page, "5-published");

  const post = inBlog(POST);
  assert.ok(post.includes("[the sixth attempt](/essays/the-sixth-attempt/) said it better."));
  assert.ok(post.includes(`![A mended bowl](/posts/${ID}/bowl.png "The seam, in gold.")`));
  assert.ok(post.includes("[Golden joinery](https://www.britannica.com/art/kintsugi)"));
  assert.ok(post.includes("I wrote about this before in Repair is a kind of attention, and"));
  assert.ok(post.includes("## Sources\n\n- [Golden joinery](https://www.britannica.com/art/kintsugi), The editors, Encyclopaedia Britannica"));
  assert.ok(!post.includes("[["), "no wikilinks reach the blog");
  assert.deepEqual(readFileSync(resolve(blog, `public/posts/${ID}/bowl.png`)), readFileSync(resolve(vault, "media/bowl.png")));

  await done.getByRole("button", { name: "Done" }).click();
  // The document records where it went; the post isn't mirrored a second time.
  await page.getByText("Saved", { exact: true }).waitFor();
  for (let i = 0; i < 300 && !onDisk(DOC).includes("post: "); i++) await page.waitForTimeout(100);
  assert.match(onDisk(DOC), new RegExp(`\\npost: ${POST}\\nurl: https://hussain\\.ph/essays/on-craft-and-repair/\\npublished: ${TODAY}\\n`));
  assert.ok(!existsSync(resolve(vault, "hussain.ph/essays/on-craft-and-repair.md")));

  // Publishing again updates the same post.
  await page.keyboard.press("Meta+Shift+P");
  await dialog.getByText(/This updates the published post at \/essays\/on-craft-and-repair\//).waitFor();
  await dialog.getByRole("button", { name: "Update the post" }).waitFor();
  await shot(page, "6-republish");
  await page.keyboard.press("Escape");
});
