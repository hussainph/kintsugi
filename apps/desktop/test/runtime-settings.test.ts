// KI-61 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, in a fresh scratch vault and config, with Kin on the
// scripted headless model (`KINTSUGI_HEADLESS_KIN=mock`): no credentials,
// no provider, no cost. The mock makes the first default's provider
// (OpenCode Go) usable, so its models are listed.
//
// Settings as a page: ⌘, and the sidebar open it, Esc and Back return to
// where he was; a default model and effort changed in Settings are kept and
// used; the pickers offer only the models turned on in Settings (KI-77); the
// model picker and effort in Kin's chat apply to one conversation and are
// kept per conversation. Screenshots go to .headless/<run>/shots/ (light, or dark with
// KINTSUGI_COLOR_SCHEME=dark).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App, openApp } from "./headless-app.ts";

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
  await openApp(page, app.url, app.output);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
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

/** Opens a model menu and picks the model named `name`. */
async function pick(trigger: ReturnType<Page["getByRole"]>, name: string) {
  await trigger.click();
  await menu().getByRole("menuitemradio", { name: new RegExp(`^${name.replace(/[.]/g, "\\.")}`) }).click();
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

test("the pickers offer a short list; a model turned on in Settings and a default model and effort are kept", { timeout: 120_000 }, async () => {
  await openDoc(NOTE);
  await page.keyboard.press("Meta+,");
  await section("Kin and models").click();
  const defaults = settings().getByTestId("default-models");
  const chat = defaults.getByRole("button", { name: /^Chat model:/ });
  // The lighter defaults: a mid-size model for chat, a small fast one for triage.
  await defaults.getByRole("button", { name: "Chat model: Qwen3.7 Plus" }).waitFor();
  await defaults.getByRole("button", { name: "Feed triage model: GLM-5.3-Flash" }).waitFor();

  await chat.click();
  await menu().getByRole("menuitemradio", { name: /^Qwen3\.7 Plus/ }).waitFor();
  // Only the models turned on: OpenCode Go's defaults and two alternatives,
  // each with its price per million tokens. One provider: no heading, no filter.
  const offered = await menu().getByRole("menuitemradio").allTextContents();
  assert.equal(offered.length, 5, offered.join(" | "));
  await menu().getByRole("menuitemradio", { name: /^Qwen3\.7 Plus/ }).getByText("$0.40 · $1.60").waitFor();
  assert.equal(await menu().getByRole("menuitemradio", { name: /^MiniMax-M3/ }).count(), 0);
  assert.equal(await page.getByRole("searchbox", { name: /^Filter/ }).count(), 0);
  assert.equal(await menu().locator('[data-provider="ollama"]').count(), 0);
  await page.waitForTimeout(300);
  await shot("03-default-menu");
  await page.keyboard.press("Escape");
  await menu().waitFor({ state: "detached" });
  // That Esc closed only the menu.
  await settings().waitFor();

  // The list of models: the ones on, and a search over the rest.
  const models = settings().getByTestId("enabled-models");
  await models.locator('[data-model="opencode-go/kimi-k3.1-pro"]').waitFor();
  // A task's default can't be turned off.
  assert.equal(await models.locator('[data-model="opencode-go/qwen3.7-plus"]').getByRole("switch").isDisabled(), true);
  await models.getByRole("searchbox", { name: "Search all models" }).fill("minimax m3");
  const minimax = models.locator('[data-model="opencode-go/minimax-m3"]').getByRole("switch");
  assert.equal(await minimax.getAttribute("aria-checked"), "false");
  await minimax.click();
  await until(() => json(resolve(app.config, "kin/settings.json")), (s) => s?.enabled?.some((m: { model: string }) => m.model === "minimax-m3"), "the model is turned on");
  await shot("02-models-search");
  await models.getByRole("searchbox", { name: "Search all models" }).fill("");
  // One of the defaults turned off leaves the pickers.
  await models.locator('[data-model="opencode-go/deepseek-v4-pro"]').getByRole("switch").click();
  await until(() => json(resolve(app.config, "kin/settings.json")), (s) => s?.disabled?.some((m: { model: string }) => m.model === "deepseek-v4-pro"), "the model is turned off");
  await models.locator('[data-model="opencode-go/deepseek-v4-pro"]').waitFor({ state: "detached" });

  await pick(chat, "MiniMax-M3");
  await defaults.getByRole("button", { name: "Chat model: MiniMax-M3" }).waitFor();
  const stored = await until(
    () => json(resolve(app.config, "kin/settings.json")),
    (s) => s?.models?.chat?.model === "minimax-m3",
    "the chat default reaches kin/settings.json",
  );
  assert.deepEqual(stored.models.chat, { provider: "opencode-go", model: "minimax-m3" });

  // Its effort, beside it: medium unless he says otherwise.
  const effort = defaults.getByRole("slider", { name: "Chat effort" });
  assert.equal(await effort.getAttribute("aria-valuetext"), "Medium");
  await effort.focus();
  await page.keyboard.press("ArrowRight");
  await until(() => json(resolve(app.config, "kin/settings.json")), (s) => s?.efforts?.chat === "high", "the chat effort reaches kin/settings.json");
  // The slider shows the level once the save answers, just after the file is written.
  await effort.and(page.locator('[aria-valuetext="High"]')).waitFor();
  await page.waitForTimeout(300);
  await shot("02-kin-and-models-effort");

  // Edits take a default too, and Automatic clears one.
  const edits = defaults.getByRole("button", { name: /^Edits model:/ });
  await pick(edits, "GLM-5.3-Flash");
  await defaults.getByRole("button", { name: "Edits model: GLM-5.3-Flash" }).waitFor();
  await pick(edits, "Automatic");
  await defaults.getByRole("button", { name: "Edits model: Qwen3.7 Plus" }).waitFor();
  await until(() => json(resolve(app.config, "kin/settings.json")), (s) => !s?.models?.edit, "Automatic clears the edit default");

  // Kept when Settings opens again.
  await page.keyboard.press("Escape");
  await settings().waitFor({ state: "detached" });
  await page.keyboard.press("Meta+,");
  await settings().getByTestId("default-models").getByRole("button", { name: "Chat model: MiniMax-M3" }).waitFor();
  assert.equal(await settings().getByTestId("default-models").getByRole("slider", { name: "Chat effort" }).getAttribute("aria-valuetext"), "High");
  await page.keyboard.press("Escape");
  await settings().waitFor({ state: "detached" });
});

test("the chat's model and effort apply to one conversation and are kept per conversation", { timeout: 120_000 }, async () => {
  const model = () => panel().getByTestId("chat-model").getByRole("button");
  const effort = () => panel().getByTestId("chat-model").getByRole("slider", { name: "Effort" });
  await openDoc(DRAFT);
  await page.keyboard.press("Meta+j");
  await panel().waitFor();
  // The chat default and its effort from Settings (previous test).
  await panel().getByRole("button", { name: "Model: MiniMax-M3" }).waitFor();
  assert.equal(await effort().getAttribute("aria-valuetext"), "High");

  await model().click();
  await menu().getByRole("menuitemradio", { name: /^GLM-5\.3-Flash/ }).waitFor();
  // The one turned on in Settings is offered; the one turned off isn't.
  await menu().getByRole("menuitemradio", { name: /^MiniMax-M3/ }).waitFor();
  assert.equal(await menu().getByRole("menuitemradio", { name: /^DeepSeek/ }).count(), 0);
  await menu().getByRole("menuitem", { name: "Choose models" }).waitFor();
  await page.waitForTimeout(250);
  await shot("04-chat-picker");
  // Esc closes the menu, not the chat.
  await page.keyboard.press("Escape");
  await menu().waitFor({ state: "detached" });
  await panel().waitFor();

  await pick(model(), "GLM-5.3-Flash");
  await panel().getByRole("button", { name: "Model: GLM-5.3-Flash" }).waitFor();
  // GLM-5.3-Flash thinks at low, high or max; the chat's high carries over.
  assert.equal(await effort().getAttribute("aria-valuetext"), "High");
  await effort().focus();
  await page.keyboard.press("ArrowLeft");
  await panel().getByTestId("chat-model").locator('[data-level="low"]').waitFor();
  await shot("05-chat-picked");
  const picks = resolve(app.vault, ".kintsugi/kin/models.json");
  const stored = await until(() => json(picks), (p) => p?.[DRAFT]?.reasoning === "low", "the pick and effort reach the vault");
  assert.deepEqual(stored[DRAFT], { provider: "opencode-go", model: "glm-5.3-flash", reasoning: "low" });

  // A message in this conversation runs on it (the mock answers either way).
  await panel().getByRole("textbox", { name: "Message Kin" }).fill("Tighten the opening?");
  await panel().getByRole("textbox", { name: "Message Kin" }).press("Enter");
  await panel().locator('[data-role="kin"]').first().waitFor({ timeout: 30_000 });

  // Another conversation keeps the defaults.
  await page.keyboard.press("Meta+j");
  await panel().waitFor({ state: "detached" });
  await openDoc(NOTE);
  await page.keyboard.press("Meta+j");
  await panel().getByRole("button", { name: "Model: MiniMax-M3" }).waitFor();
  assert.equal(await effort().getAttribute("aria-valuetext"), "High");
  await page.keyboard.press("Meta+j");
  await panel().waitFor({ state: "detached" });

  // Back on the draft, after a reload: its own pick and effort.
  await page.reload();
  await openDoc(DRAFT);
  await page.keyboard.press("Meta+j");
  await panel().getByRole("button", { name: "Model: GLM-5.3-Flash" }).waitFor();
  assert.equal(await effort().getAttribute("aria-valuetext"), "Low");

  // Default goes back to the chat default model; the effort stays his.
  await pick(model(), "Default");
  await panel().getByRole("button", { name: "Model: MiniMax-M3" }).waitFor();
  await until(() => json(picks), (p) => !p?.[DRAFT]?.model && p?.[DRAFT]?.reasoning === "low", "Default clears the model pick");

  // Choose models opens Settings' list.
  await model().click();
  await menu().getByRole("menuitem", { name: "Choose models" }).click();
  await settings().getByRole("heading", { name: "Kin and models", level: 1 }).waitFor();
  await settings().getByTestId("enabled-models").waitFor();
  await page.keyboard.press("Escape");
  await settings().waitFor({ state: "detached" });
});
