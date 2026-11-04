import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

const DOC = "drafts/stash-safety.md";
const RENAMED = "drafts/stash-renamed.md";
const FIRST = "This paragraph survives a rejected reply.";
const SECOND = "This paragraph must reach the stash before a rename.";
const THIRD = "This paragraph must reach the stash before a vault switch.";
let app: App;
let browser: Browser;
let page: Page;
const disk = (path: string) => readFileSync(resolve(app.vault, path), "utf8");
const sidecar = (path: string) => `.kintsugi/stash/${path}.md`;
const row = (path: string) => page.locator(`[data-sidebar=sidebar] [title="${path}"]`);
const line = (text: string) => page.locator(".cm-line", { hasText: text });
const stashRows = () => page.locator(".ki-stash-row");

before(async () => {
  app = await startApp("ki89-safety", { KINTSUGI_HEADLESS_KIN: "mock", CARGO_BUILD_JOBS: "2" }, (vault) => {
    writeFileSync(resolve(vault, DOC), `---\ntitle: Stash safety\nstatus: draft\n---\n\n${FIRST}\n\n${SECOND}\n\n${THIRD}\n`);
    mkdirSync(resolve(vault, "elsewhere"));
    writeFileSync(resolve(vault, "elsewhere/other-vault.md"), "---\ntitle: Other vault\n---\n\nA different vault.\n");
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openApp(page, app.url, app.output);
  await row(DOC).click();
  await line(FIRST).waitFor();
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLInputElement>('.ki-stash input[aria-label="Add a note"]');
    return input && !input.disabled;
  });
}, { timeout: Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000) });
after(async () => { await browser?.close(); await app?.stop(); });

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    try { if (check()) return; } catch { /* write pending */ }
    await page.waitForTimeout(100);
  }
  assert.fail(what);
}
async function cut(text: string) {
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLInputElement>('.ki-stash input[aria-label="Add a note"]');
    return input && !input.disabled;
  });
  await line(text).click();
  await page.keyboard.press("Meta+Alt+x");
  await stashRows().filter({ hasText: text }).waitFor();
}
async function rename() {
  await row(DOC).focus();
  await row(DOC).press("F2");
  const input = page.locator("[data-sidebar=sidebar] input");
  await input.fill("stash-renamed");
  await input.press("Enter");
}

// The reply remains available in the conversation; none of it enters the
// editor's stash until the backend's read-only validation accepts it.
test("a rejected reply cannot poison the next cut or its save", { timeout: 90_000 }, async () => {
  await page.keyboard.press("Meta+j");
  const message = page.getByRole("textbox", { name: "Message Kin" });
  await message.fill("Tell me about password security.");
  await message.press("Enter");
  const reply = page.locator('[data-role="kin"]').last();
  const save = reply.getByRole("button", { name: "Stash", exact: true });
  await save.waitFor({ timeout: 60_000 });
  const rejected = page.waitForResponse((response) => response.url().endsWith("/invoke") && response.request().postDataJSON()?.cmd === "stash_validate_reply");
  await save.click();
  assert.equal((await (await rejected).json()).ok, false);
  await page.getByText(/That stash item/).first().waitFor();
  assert.equal(await stashRows().count(), 0);
  await cut(FIRST);
  await page.keyboard.press("Meta+s");
  await until(() => !disk(DOC).includes(FIRST) && disk(sidecar(DOC)).includes(FIRST), "a later cut saves both halves");
});

test("a failed stash write keeps cut prose on disk and blocks a rename", { timeout: 60_000 }, async () => {
  await page.route("**/invoke", async (route) => {
    if (route.request().postDataJSON()?.cmd !== "stash_save") return route.continue();
    await route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": new URL(page.url()).origin }, body: JSON.stringify({ ok: false, error: "KI-89 test: stash write blocked" }) });
  });
  try {
    await cut(SECOND);
    await page.getByText("Couldn't save the stash. Try again.", { exact: true }).first().waitFor();
    assert.ok(disk(DOC).includes(SECOND), "the draft cannot persist a cut before the stash");
    await rename();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-slot="sidebar-wrapper"]')?.hasAttribute("inert"));
    assert.ok(existsSync(resolve(app.vault, DOC)));
    assert.ok(!existsSync(resolve(app.vault, RENAMED)));
    await row(DOC).waitFor();
  } finally { await page.unroute("**/invoke"); }
});

test("rename waits for a pending stash write and moves the complete sidecar", { timeout: 60_000 }, async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let saving!: () => void;
  const started = new Promise<void>((resolve) => { saving = resolve; });
  await page.route("**/invoke", async (route) => {
    if (route.request().postDataJSON()?.cmd !== "stash_save") return route.continue();
    saving();
    await pending;
    await route.continue();
  });
  try {
    await page.keyboard.press("Meta+s");
    await started;
    await rename();
    await page.waitForFunction(() => document.querySelector('[data-slot="sidebar-wrapper"]')?.hasAttribute("inert"));
    assert.ok(disk(DOC).includes(SECOND));
    assert.ok(!existsSync(resolve(app.vault, RENAMED)));
    release();
    await row(RENAMED).waitFor();
    await until(() => !disk(RENAMED).includes(SECOND) && disk(sidecar(RENAMED)).includes(SECOND), "the renamed stash retains the pending cut");
    assert.ok(!existsSync(resolve(app.vault, sidecar(DOC))));
  } finally { release(); await page.unroute("**/invoke"); }
});

test("a vault switch waits for the pending cut in its original vault", { timeout: 60_000 }, async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let saving!: () => void;
  const started = new Promise<void>((resolve) => { saving = resolve; });
  await page.route("**/invoke", async (route) => {
    if (route.request().postDataJSON()?.cmd !== "stash_save") return route.continue();
    saving();
    await pending;
    await route.continue();
  });
  try {
    await cut(THIRD);
    await started;
    await page.keyboard.press("Meta+Shift+O");
    const prompt = page.locator("dialog[data-headless-dialog]");
    await prompt.locator("input").fill(resolve(app.vault, "elsewhere"));
    await prompt.getByRole("button", { name: "OK" }).click();
    await page.waitForFunction(() => document.querySelector('[data-slot="sidebar-wrapper"]')?.hasAttribute("inert"));
    assert.equal(await row("other-vault.md").count(), 0);
    release();
    await row("other-vault.md").waitFor();
    assert.ok(!disk(RENAMED).includes(THIRD));
    assert.ok(disk(sidecar(RENAMED)).includes(THIRD));
    assert.ok(!existsSync(resolve(app.vault, "elsewhere/.kintsugi/stash/drafts/stash-renamed.md.md")));
  } finally { release(); await page.unroute("**/invoke"); }
});

test("discarding a failed stash restores the disk's prose and allows leaving", { timeout: 60_000 }, async () => {
  await row("other-vault.md").click();
  await line("A different vault.").waitFor();
  await page.route("**/invoke", async (route) => {
    if (route.request().postDataJSON()?.cmd !== "stash_save") return route.continue();
    await route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": new URL(page.url()).origin }, body: JSON.stringify({ ok: false, error: "KI-89 test: stash write blocked" }) });
  });
  try {
    await cut("A different vault.");
    await page.keyboard.press("Meta+Shift+O");
    const prompt = page.locator("dialog[data-headless-dialog]");
    await prompt.locator("input").fill(app.vault);
    await prompt.getByRole("button", { name: "OK" }).click();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await row(RENAMED).waitFor();
    assert.ok(disk("elsewhere/other-vault.md").includes("A different vault."), "the unsaved cut was discarded with its stash");
    assert.ok(!existsSync(resolve(app.vault, "elsewhere/.kintsugi/stash/other-vault.md.md")));
  } finally { await page.unroute("**/invoke"); }
});
