// KI-116: browser clipboard/drop/file input → real storage → mock model,
// then a backend restart and a later read of the persisted image reference.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

let app: App;
let browser: Browser;
let page: Page;
let png: number[];
let thread = "";
const panel = () => page.getByRole("region", { name: "Kin" });
const composer = () => panel().locator(".ki-kin-composer");
const pending = () => composer().locator("[data-attachment]");
const timeout = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

function pdf() {
  const stream = "BT /F1 18 Tf 40 700 Td (A PDF attachment for Kin.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let file = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(file));
    file += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(file);
  file += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(file);
}

before(async () => {
  app = await startApp("ki116", { KINTSUGI_HEADLESS_KIN: "mock" });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await openApp(page, app.url, app.output);
  await page.locator('[title="drafts/kintsugi-and-gold.md"]').click();
  png = Array.from(await page.screenshot());
  await page.keyboard.press("Meta+j");
  await panel().getByRole("button", { name: "New thread" }).click();
}, { timeout });
after(async () => { await browser?.close(); await app?.stop(); });

async function transfer(kind: "paste" | "drop", name: string) {
  await composer().evaluate((element, { kind, name, png }) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(png)], name, { type: "image/png" }));
    element.dispatchEvent(kind === "paste"
      ? new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
      : new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, { kind, name, png });
  await pending().filter({ hasText: name }).locator("img").waitFor();
}

const entries = () => readFileSync(resolve(app.vault, `.kintsugi/kin/threads/${thread}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("overlapping paste events keep both screenshots", { timeout: 120_000 }, async () => {
  await composer().evaluate((element, png) => {
    for (const name of ["burst-one.png", "burst-two.png"]) {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(png)], name, { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    }
  }, png);
  for (const name of ["burst-one.png", "burst-two.png"]) {
    await pending().filter({ hasText: name }).locator("img").waitFor();
  }
  assert.equal(await pending().count(), 2);
  for (const name of ["burst-one.png", "burst-two.png"]) {
    await pending().getByRole("button", { name: `Remove ${name}` }).click();
  }
  assert.equal(await pending().count(), 0);
});

test("paste, remove, drop and attach files; send thumbnails with images", { timeout: 120_000 }, async () => {
  await transfer("paste", "pasted.png");
  await page.screenshot({ path: resolve(app.shots, "01-pasted.png") });
  await pending().getByRole("button", { name: "Remove pasted.png" }).click();
  assert.equal(await pending().count(), 0);
  await transfer("drop", "dropped.png");
  await composer().locator('input[type="file"]').setInputFiles([
    { name: "attached.png", mimeType: "image/png", buffer: Buffer.from(png) },
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("A note about this screenshot.") },
    { name: "paper.pdf", mimeType: "application/pdf", buffer: pdf() },
  ]);
  await pending().filter({ hasText: "attached.png" }).locator("img").waitFor();
  await pending().filter({ hasText: "notes.md" }).waitFor();
  await pending().filter({ hasText: "paper.pdf" }).waitFor();
  await panel().getByRole("textbox", { name: "Message Kin" }).fill("What is in these images?");
  await page.screenshot({ path: resolve(app.shots, "02-ready.png") });
  await panel().getByRole("button", { name: "Send", exact: true }).click();
  await panel().getByText("I received 2 images. The image is available in this thread.", { exact: true }).waitFor({ timeout: 30_000 });
  await panel().locator('[data-role="owner"] [data-attachment] img').first().waitFor();
  const index = JSON.parse(readFileSync(resolve(app.vault, ".kintsugi/kin/threads/index.json"), "utf8"));
  thread = index.threads.find((t: { title: string }) => t.title === "What is in these images?").id;
  const sent = entries()[0];
  assert.equal(sent.chips.filter((c: { kind: string }) => c.kind === "attachment").length, 4);
  for (const chip of sent.chips.filter((c: { kind: string }) => c.kind === "attachment")) {
    assert.ok(chip.path.startsWith(`@attachment/${thread}/`));
    assert.ok(!JSON.stringify(chip).includes("base64"));
  }
  await page.screenshot({ path: resolve(app.shots, "03-sent.png") });
});

test("restart keeps previews and later turns read image references", { timeout }, async () => {
  const old = app;
  await page.close();
  await old.stop();
  const restarted = await startApp("ki116-restart", {
    KINTSUGI_HEADLESS_KIN: "mock", KINTSUGI_VAULT: old.vault, KINTSUGI_CONFIG_DIR: old.config,
  });
  // startApp creates a throwaway seed before applying env overrides; its
  // returned metadata names that seed, not the vault the backend reopened.
  app = { ...restarted, vault: old.vault, config: old.config };
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await openApp(page, app.url, app.output);
  await page.locator('[title="drafts/kintsugi-and-gold.md"]').click();
  await page.keyboard.press("Meta+j");
  await panel().locator(`[data-thread="${thread}"]`).click();
  await panel().locator('[data-role="owner"] [data-attachment] img').first().waitFor();
  await panel().getByRole("textbox", { name: "Message Kin" }).fill("Read that previous image again.");
  await panel().getByRole("button", { name: "Send", exact: true }).click();
  await panel().getByText("I received 1 image. The image is available in this thread.", { exact: true }).waitFor({ timeout: 30_000 });
  assert.ok(entries().at(-1).tools.some((t: { name: string }) => t.name === "read"));
  await page.screenshot({ path: resolve(app.shots, "04-restarted.png") });
});
