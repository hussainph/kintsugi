// KI-61 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, in a fresh scratch vault and config, with Kin on the
// scripted headless model (`KINTSUGI_HEADLESS_KIN=mock`): no credentials,
// no provider, no cost. The mock makes the first default's provider
// (OpenCode Go) usable, so its models are listed.
//
// Settings as a page: ⌘, and the sidebar open it, Esc and Back return to
// where he was; a default model changed in Settings is kept and used; the
// model picker in Kin's chat applies to one conversation and is kept per
// conversation. Screenshots go to .headless/<run>/shots/ (light, or dark with
// KINTSUGI_COLOR_SCHEME=dark).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App } from "./headless-app.ts";

const DRAFT = "drafts/kintsugi-and-gold.md";
const NOTE = "notes/repair.md";
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
/** `KINTSUGI_COLOR_SCHEME=dark` runs it (and its screenshots) in dark mode. */
const SCHEME = process.env.KINTSUGI_COLOR_SCHEME === "dark" ? "dark" : "light";

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki61", { KINTSUGI_HEADLESS_KIN: "mock" });
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 820 }, colorScheme: SCHEME });
  await page.goto(app.url);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  app?.stop();
});

const shot = async (name: string) => {
  // Off every control, so no hover state is captured.
  await page.mouse.move(1270, 10);
  await page.screenshot({ path: resolve(app.shots, `${SCHEME}-${name}.png`) });
};
const settings = () => page.getByRole("region", { name: "Settings" });
const section = (name: string) => settings().getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name });
const panel = () => page.getByRole("dialog", { name: "Kin" });
const menu = () => page.getByRole("menu");

async function openDoc(path: string) {
  await page.locator(`[title="${path}"]`).click();
  await page.locator(`[title="${path}"][data-active="true"]`).waitFor();
}

/** Opens a model menu, filters it and picks the model named `name`. */
async function pick(trigger: ReturnType<Page["getByRole"]>, filter: string, name: string) {
  await trigger.click();
  await page.getByRole("searchbox", { name: /^Filter/ }).fill(filter);
  await menu().getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).click();
  await menu().waitFor({ state: "detached" });
}

async function until<T>(read: () => T, ok: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (ok(value)) return value;
    await page.waitForTimeout(100);
  }
  assert.fail(what);
}

const json = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);

test("⌘, and the sidebar open Settings as a page; Esc and Back return to where he was", { timeout: 120_000 }, async () => {
  await openDoc(DRAFT);
  await page.keyboard.press("Meta+,");
  await settings().getByRole("heading", { name: "General", level: 1 }).waitFor();
  assert.equal(await section("General").getAttribute("aria-current"), "page");
  // It covers the app: the document's sidebar can't be reached behind it.
  assert.equal(await page.locator("[data-sidebar=sidebar]").first().evaluate((el) => (el.closest("[inert]") ? "inert" : "live")), "inert");
  await shot("01-general");

  for (const [name, title] of [["Kin and models", "Kin and models"], ["Providers", "Providers"], ["Phone", "Phone"], ["Blog", "Blog"], ["Export", "Export"], ["Privacy", "Privacy"]]) {
    await section(name).click();
    await settings().getByRole("heading", { name: title, level: 1 }).waitFor();
    await page.waitForTimeout(300);
    await shot(`02-${title.toLowerCase().replace(/ /g, "-")}`);
  }
  await settings().getByTestId("privacy").getByText(/stay on this Mac/).waitFor();

  // Esc: back to the document, as it was.
  await page.keyboard.press("Escape");
  await settings().waitFor({ state: "detached" });
  await page.locator(`[title="${DRAFT}"][data-active="true"]`).waitFor();
  await page.locator(".cm-content").waitFor();

  // From the Feed, by the sidebar; it opens where he left it. Back returns to the Feed.
  await page.locator("[data-sidebar=sidebar]").getByRole("button", { name: /^Feed/ }).click();
  await page.getByRole("heading", { name: "Feed", level: 1 }).waitFor();
  await page.locator("[data-sidebar=sidebar]").getByRole("button", { name: "Settings" }).click();
  await settings().getByRole("heading", { name: "Privacy", level: 1 }).waitFor();
  await settings().getByRole("button", { name: /^Back/ }).click();
  await settings().waitFor({ state: "detached" });
  await page.getByRole("heading", { name: "Feed", level: 1 }).waitFor();

  // "Connect your phone" opens Settings › Phone.
  await page.locator("[data-sidebar=sidebar]").getByRole("button", { name: /phone/i }).click();
  await settings().getByRole("heading", { name: "Phone", level: 1 }).waitFor();
  await page.keyboard.press("Escape");
  await settings().waitFor({ state: "detached" });
});

test("a default model changed in Settings is kept, and Automatic goes back", { timeout: 120_000 }, async () => {
  await openDoc(NOTE);
  await page.keyboard.press("Meta+,");
  await section("Kin and models").click();
  const defaults = settings().getByTestId("default-models");
  const chat = defaults.getByRole("button", { name: /^Chat model:/ });
  // The lighter defaults: a mid-size model for chat, a small fast one for triage.
  await defaults.getByRole("button", { name: "Chat model: Qwen3.7 Plus" }).waitFor();
  await defaults.getByRole("button", { name: "Feed triage model: GLM-5.3-Flash" }).waitFor();

  await chat.click();
  // Grouped by provider, each with its price per million tokens; Ollama is never offered.
  await menu().locator('[data-provider="opencode-go"]').getByText("OpenCode Go").waitFor();
  assert.equal(await menu().locator('[data-provider="ollama"]').count(), 0);
  await menu().getByRole("menuitemradio", { name: /^Qwen3\.7 Plus/ }).getByText("$0.40 · $1.60").waitFor();
  await page.waitForTimeout(300);
  await shot("03-default-menu");
  await page.keyboard.press("Escape");
  await menu().waitFor({ state: "detached" });
  // That Esc closed only the menu.
  await settings().waitFor();

  await pick(chat, "minimax m3", "MiniMax-M3");
  await defaults.getByRole("button", { name: "Chat model: MiniMax-M3" }).waitFor();
  const stored = await until(
    () => json(resolve(app.config, "kin/settings.json")),
    (s) => s?.models?.chat?.model === "minimax-m3",
    "the chat default reaches kin/settings.json",
  );
  assert.deepEqual(stored.models.chat, { provider: "opencode-go", model: "minimax-m3" });

  // Edits take a default too, and Automatic clears one.
  const edits = defaults.getByRole("button", { name: /^Edits model:/ });
  await pick(edits, "glm-5.3-flash", "GLM-5.3-Flash");
  await defaults.getByRole("button", { name: "Edits model: GLM-5.3-Flash" }).waitFor();
  await pick(edits, "automatic", "Automatic");
  await defaults.getByRole("button", { name: "Edits model: Qwen3.7 Plus" }).waitFor();
  await until(() => json(resolve(app.config, "kin/settings.json")), (s) => !s?.models?.edit, "Automatic clears the edit default");

  // Kept when Settings opens again.
  await page.keyboard.press("Escape");
  await settings().waitFor({ state: "detached" });
  await page.keyboard.press("Meta+,");
  await settings().getByTestId("default-models").getByRole("button", { name: "Chat model: MiniMax-M3" }).waitFor();
  await page.keyboard.press("Escape");
  await settings().waitFor({ state: "detached" });
});

test("the chat's model picker applies to one conversation and is kept per conversation", { timeout: 120_000 }, async () => {
  const model = () => panel().getByTestId("chat-model").getByRole("button");
  await openDoc(DRAFT);
  await page.keyboard.press("Meta+j");
  await panel().waitFor();
  // The chat default from Settings (previous test).
  await panel().getByRole("button", { name: "Model: MiniMax-M3" }).waitFor();

  await model().click();
  await menu().getByRole("menuitemradio", { name: /^GLM-5\.3-Flash/ }).waitFor();
  await page.waitForTimeout(250);
  await shot("04-chat-picker");
  // Esc closes the menu, not the chat.
  await page.keyboard.press("Escape");
  await menu().waitFor({ state: "detached" });
  await panel().waitFor();

  await pick(model(), "flash", "GLM-5.3-Flash");
  await panel().getByRole("button", { name: "Model: GLM-5.3-Flash" }).waitFor();
  await shot("05-chat-picked");
  const picks = resolve(app.vault, ".kintsugi/kin/models.json");
  const stored = await until(() => json(picks), (p) => !!p?.[DRAFT], "the pick reaches the vault");
  assert.deepEqual(stored[DRAFT], { provider: "opencode-go", model: "glm-5.3-flash" });

  // A message in this conversation runs on it (the mock answers either way).
  await panel().getByRole("textbox", { name: "Message Kin" }).fill("Tighten the opening?");
  await panel().getByRole("textbox", { name: "Message Kin" }).press("Enter");
  await panel().locator('[data-role="kin"]').first().waitFor({ timeout: 30_000 });

  // Another conversation keeps the default.
  await page.keyboard.press("Meta+j");
  await panel().waitFor({ state: "detached" });
  await openDoc(NOTE);
  await page.keyboard.press("Meta+j");
  await panel().getByRole("button", { name: "Model: MiniMax-M3" }).waitFor();
  await page.keyboard.press("Meta+j");
  await panel().waitFor({ state: "detached" });

  // Back on the draft, after a reload: its own pick.
  await page.reload();
  await openDoc(DRAFT);
  await page.keyboard.press("Meta+j");
  await panel().getByRole("button", { name: "Model: GLM-5.3-Flash" }).waitFor();

  // Default goes back to the chat default.
  await pick(model(), "default", "Default");
  await panel().getByRole("button", { name: "Model: MiniMax-M3" }).waitFor();
  await until(() => json(picks), (p) => !p?.[DRAFT], "Default clears the pick");
});
