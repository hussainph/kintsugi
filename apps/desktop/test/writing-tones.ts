// Kin's tones (KI-102), one run per tone on the scripted headless model
// (`KINTSUGI_HEADLESS_KIN=mock`): no credentials, no provider, $0. Not part
// of the test suite; run it to review what each tone looks like.
//
//   pnpm --filter @kintsugi/desktop exec node test/writing-tones.ts
//   KI_TONES=plain,dry pnpm --filter @kintsugi/desktop exec node test/writing-tones.ts
//
// Each run starts `pnpm desktop:headless` on a fresh scratch vault, picks the
// tone in Settings, asks for ideas, follows the three news fixture feeds and
// opens their shared story once Kin has summarised it. Shots go to
// .headless/ki102-tones/: the setting in light and dark, then each tone's
// idea and story.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { root, startApp, openApp } from "./headless-app.ts";
import { NEWS, startFeedFixtures } from "./feed-fixtures.ts";

const TONES = ["plain", "editorial", "casual", "dry"] as const;
const LABELS: Record<(typeof TONES)[number], string> = { plain: "Plain", editorial: "Editorial", casual: "Casual", dry: "Dry" };
const tones = (process.env.KI_TONES?.split(",") ?? [...TONES]) as (typeof TONES)[number][];
const out = resolve(root, ".headless/ki102-tones");
mkdirSync(out, { recursive: true });

const invoke = <T>(page: Page, cmd: string, args: unknown = {}) =>
  page.evaluate(
    ([c, a]) => (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(c as string, a),
    [cmd, args] as const,
  ) as Promise<T>;

const fixtures = await startFeedFixtures();
const browser = await chromium.launch({ headless: true });
try {
  for (const [n, tone] of tones.entries()) {
    const app = await startApp(`ki102-${tone}`, { KINTSUGI_HEADLESS_KIN: "mock" });
    try {
      for (const mode of n === 0 ? (["light", "dark"] as const) : (["light"] as const)) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: mode, deviceScaleFactor: 2 });
        await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
        await openApp(page, app.url, app.output);

        // The setting: Settings › Kin and models › Kin.
        await page.keyboard.press("Meta+,");
        const settings = page.getByRole("region", { name: "Settings" });
        await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Kin and models" }).click();
        const row = page.getByTestId("kin-tone");
        await row.scrollIntoViewIfNeeded();
        await row.getByRole("combobox").click();
        await page.getByRole("option", { name: LABELS[tone] }).click();
        await page.getByRole("option").first().waitFor({ state: "detached" });
        await page.waitForTimeout(300);
        const group = row.locator("xpath=ancestor::section[1]");
        await group.screenshot({ path: resolve(out, `setting-${tone}-${mode}.png`), animations: "disabled" });
        if (n === 0) {
          await row.getByRole("combobox").click();
          await page.waitForTimeout(300);
          await page.screenshot({ path: resolve(out, `setting-menu-${mode}.png`), animations: "disabled" });
          await page.keyboard.press("Escape");
          await page.getByRole("option").first().waitFor({ state: "detached" });
        }
        await page.keyboard.press("Escape");
        await settings.waitFor({ state: "detached" });
        if (mode === "dark") {
          await page.close();
          continue;
        }

        // Ideas, in this tone.
        await invoke(page, "ideas_generate", {});
        await page.keyboard.press("Meta+Shift+e");
        const ideas = page.getByRole("region", { name: "Ideas" });
        await ideas.locator("li[data-idea]").first().waitFor({ timeout: 90_000 });
        await ideas.locator("li[data-idea]").first().locator("button[aria-expanded]").first().click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: resolve(out, `idea-${tone}.png`), animations: "disabled" });

        // A story, summarised in this tone.
        await page.keyboard.press("Meta+Shift+f");
        await page.getByRole("button", { name: "Following" }).click();
        for (const [feed, name] of [["orchard", "Orchard Daily"], ["ledger", "The Ledger"], ["bench", "Bench Notes"]]) {
          await page.getByRole("tab", { name: "Link" }).click();
          const form = page.getByRole("form", { name: "Follow something" });
          await form.getByRole("textbox").first().fill(`${fixtures.base}/${feed}.xml`);
          await form.getByRole("button", { name: "Follow" }).click();
          await page.getByText(new RegExp(`Following ${name}`)).first().waitFor();
        }
        await page.keyboard.press("Escape");
        const feed = page.getByRole("region", { name: "Feed" });
        const story = feed.getByRole("feed", { name: "Newest first" }).locator(`article[aria-label="${NEWS.quarter}"]`);
        await story.getByText(/^\d articles from 3 sources$/).waitFor({ timeout: 60_000 });
        await story.getByRole("button").first().click();
        await feed.locator(".ki-cite").first().waitFor({ timeout: 60_000 });
        // Let the "Following …" toasts go first.
        await page.locator("[data-sonner-toast]").first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(500);
        await page.screenshot({ path: resolve(out, `story-${tone}.png`), animations: "disabled" });
        console.log(`${tone}: ${out}`);
        await page.close();
      }
    } finally {
      await app.stop();
    }
  }
} finally {
  await browser.close();
  await fixtures.close();
}
