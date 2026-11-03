// KI-92 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, in a fresh scratch vault and config.
//
// Settings › Providers: a key added and removed, and the scripted headless
// sign-ins (a device code that finishes by itself, and a browser login that
// waits for the pasted redirect URL). Headless runs keep Kintsugi's
// credentials in memory: nothing is written to the scratch config, and the
// key never reaches the page. Screenshots go to .headless/<run>/shots/
// (light, or dark with KINTSUGI_COLOR_SCHEME=dark).
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App, openApp } from "./headless-app.ts";

const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const SCHEME = process.env.KINTSUGI_COLOR_SCHEME === "dark" ? "dark" : "light";
const SECRET = "gsk-ki92-not-a-real-key";

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki92", { KINTSUGI_HEADLESS_SIGN_IN_MS: "2500" });
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: SCHEME });
  await openApp(page, app.url, app.output);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
});

const shot = async (name: string) => {
  await page.mouse.move(1270, 10);
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(app.shots, `${SCHEME}-${name}.png`) });
};
const settings = () => page.getByRole("region", { name: "Settings" });
const providers = () => settings().getByTestId("credentials");
const row = (id: string) => providers().locator(`[data-provider="${id}"]`);
const note = (id: string) => row(id).locator(".ki-settings-note");

/** Adds a provider that isn't listed yet, by name. */
async function pick(name: string) {
  await settings().getByTestId("add-provider").getByRole("combobox").click();
  await page.getByRole("option", { name, exact: true }).click();
  await row(name === "Groq" ? "groq" : "xai").waitFor();
}

/** No credential file anywhere in the scratch config. */
function assertNothingWritten() {
  const files = existsSync(app.config) ? readdirSync(app.config, { recursive: true }).map(String) : [];
  assert.ok(!files.some((f) => f.endsWith("auth.json") || f.includes("auth.json.lock")), files.join(", "));
}

test("Settings › Providers lists the default models' providers, and a key can be added and removed", { timeout: 120_000 }, async () => {
  await page.keyboard.press("Meta+,");
  await settings().getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Providers" }).click();
  await settings().getByRole("heading", { name: "Providers", level: 1 }).waitFor();
  // The default models' providers; Ollama is never shown.
  for (const id of ["opencode-go", "openai-codex", "anthropic", "openrouter"]) await row(id).waitFor();
  assert.equal(await row("ollama").count(), 0);
  assert.equal(await note("anthropic").textContent(), "Not set up");
  // ChatGPT (Codex) is sign-in only; Anthropic is keys only.
  assert.equal(await row("openai-codex").getByRole("button", { name: "Add key" }).count(), 0);
  await row("openai-codex").getByRole("button", { name: "Sign in" }).waitFor();
  assert.equal(await row("anthropic").getByRole("button", { name: "Sign in" }).count(), 0);
  await shot("01-providers");

  await pick("Groq");
  await row("groq").getByRole("button", { name: "Add key" }).click();
  const field = row("groq").getByLabel("Groq API key");
  await field.fill(SECRET);
  assert.equal(await field.getAttribute("type"), "password");
  await shot("02-key-field");
  await row("groq").getByRole("button", { name: "Save" }).click();
  await note("groq").getByText("Saved in Kintsugi · API key").waitFor();
  await row("groq").getByRole("button", { name: "Remove key" }).waitFor();
  await row("groq").getByRole("button", { name: "Replace key" }).waitFor();
  await shot("03-key-saved");
  // The key went to Rust and stays there: not in the page, not on disk.
  assert.ok(!(await page.content()).includes(SECRET));
  assertNothingWritten();

  await row("groq").getByRole("button", { name: "Remove key" }).click();
  await note("groq").getByText("Not set up").waitFor();
  await row("groq").getByRole("button", { name: "Add key" }).waitFor();
});

test("a device-code sign-in shows its code, then signs in, and signs out", { timeout: 120_000 }, async () => {
  await pick("xAI");
  await row("xai").getByRole("button", { name: "Sign in" }).click();
  const panel = providers().locator('[data-sign-in="xai"]');
  await panel.getByTestId("device-code").getByText("MOCK-1234").waitFor();
  await panel.getByText("at example.com/kintsugi/device").waitFor();
  await panel.getByRole("button", { name: "Open page" }).waitFor();
  await panel.getByRole("button", { name: "Copy code" }).waitFor();
  // One sign-in at a time.
  assert.equal(await row("openai-codex").getByRole("button", { name: "Sign in" }).isDisabled(), true);
  await shot("04-sign-in-device-code");

  await note("xai").getByText("Saved in Kintsugi · signed in").waitFor({ timeout: 15_000 });
  await panel.waitFor({ state: "detached" });
  await row("xai").getByRole("button", { name: "Sign out" }).waitFor();
  // A login replaces the key option; there's nothing to add until signing out.
  assert.equal(await row("xai").getByRole("button", { name: "Add key" }).count(), 0);
  await shot("05-signed-in");
  assertNothingWritten();

  await row("xai").getByRole("button", { name: "Sign out" }).click();
  await note("xai").getByText("Not set up").waitFor();
});

test("a browser sign-in asks how, waits for the browser, and takes a pasted redirect URL; Cancel stops one", { timeout: 120_000 }, async () => {
  await row("openai-codex").getByRole("button", { name: "Sign in" }).click();
  const panel = providers().locator('[data-sign-in="openai-codex"]');
  await panel.getByText("Sign in with").waitFor();
  await panel.getByRole("button", { name: "Browser" }).click();
  await panel.getByText("Finish signing in to ChatGPT (Codex) in your browser.").waitFor();
  const paste = panel.getByLabel("Paste the redirect URL");
  await paste.waitFor();
  await shot("06-sign-in-browser");
  await paste.fill("http://localhost:1455/auth/callback?code=mock&state=mock");
  await panel.getByRole("button", { name: "Continue" }).click();
  await note("openai-codex").getByText("Saved in Kintsugi · signed in").waitFor();
  await row("openai-codex").getByRole("button", { name: "Sign out" }).click();
  await note("openai-codex").getByText("Not set up").waitFor();

  // Cancelled midway: nothing is saved.
  await row("openrouter").getByRole("button", { name: "Sign in" }).click();
  const openrouter = providers().locator('[data-sign-in="openrouter"]');
  await openrouter.getByLabel("Paste the redirect URL").waitFor();
  await openrouter.getByRole("button", { name: "Cancel" }).click();
  await openrouter.waitFor({ state: "detached" });
  assert.equal(await note("openrouter").textContent(), "Not set up");
  assertNothingWritten();
});
