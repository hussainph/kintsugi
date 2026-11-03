// Kin's chat, one screenshot per harness scenario (KI-79), on the scripted
// headless model (`KINTSUGI_HEADLESS_KIN=mock`): no credentials, no
// provider, $0. Not part of the test suite; run it to review the chat.
//
//   pnpm --filter @kintsugi/desktop kin:scenarios            # light and dark
//   KIN_SCENARIOS_MODES=dark pnpm --filter @kintsugi/desktop kin:scenarios
//
// It starts `pnpm desktop:headless` on a fresh scratch vault (with a long
// conversation seeded into General) and writes the shots to
// .headless/kin-scenarios-*/shots/<mode>/. KINTSUGI_FRONTEND_PORT and
// KINTSUGI_BACKEND_PORT pick the ports; KIN_SCENARIOS_URL drives an app
// that's already running instead (nothing is seeded then).
//
// The mock answers by what it's asked: "think" waits before answering,
// "compare" runs several tools, "points" answers in Markdown, "tighten" on
// a paragraph proposes an edit, "fail" and "timeout" fail like a provider.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { startApp, type App } from "./headless-app.ts";

const DRAFT = "drafts/kintsugi-and-gold.md";
const modes = (process.env.KIN_SCENARIOS_MODES ?? "light,dark").split(",").map((m) => m.trim()) as ("light" | "dark")[];
const only = process.env.KIN_SCENARIOS_ONLY?.split(",");

/** A long conversation in General, so scrolling and anchoring can be seen. */
function seedLongConversation(vault: string) {
  const dir = resolve(vault, ".kintsugi/kin");
  mkdirSync(dir, { recursive: true });
  const asks = [
    "What did I say about repair last spring?",
    "Is there a post where I argue against restoration?",
    "Which clip had the line about lacquer?",
    "Do I repeat myself across the two drafts?",
    "What's the weakest paragraph in on-craft?",
    "Find me something that disagrees with the gold idea.",
    "Who wrote the piece on visible mending?",
    "Have I written about kilns before?",
    "What's in my inbox from last week?",
    "Which of my posts gets linked the most?",
    "Is the ending of the repair note too neat?",
    "What did the Feed have on Japanese ceramics?",
  ];
  const lines: string[] = [];
  let seq = 0;
  asks.forEach((ask, i) => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 20 + Math.floor(i / 3), 9, i * 7 + m)).toISOString();
    const owner = ++seq;
    lines.push(JSON.stringify({ seq: owner, at: at(0), role: "owner", text: ask, topic: "" }));
    lines.push(
      JSON.stringify({
        seq: ++seq,
        at: at(1),
        role: "kin",
        text: `Seeded reply ${i + 1}. I looked in \`notes/repair.md\` and [[posts/on-craft]]. ${"The short answer is yes, in two places, and the second one is stronger. ".repeat(1 + (i % 3))}`,
        topic: "",
        answers: [owner],
        tools: [{ name: "search", arguments: { query: ask.split(" ").slice(-2).join(" ").replace(/\?$/, "") } }, { name: "read", arguments: { path: "notes/repair.md" } }],
        ms: 4200 + i * 300,
        model: "ollama/kin-headless-mock",
        usd: 0,
      }),
    );
  });
  writeFileSync(resolve(dir, "log.jsonl"), lines.join("\n") + "\n");
}

const invoke = <T>(page: Page, cmd: string, args: unknown) =>
  page.evaluate(
    ([cmd, args]) =>
      (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(cmd as string, args),
    [cmd, args] as const,
  ) as Promise<T>;

async function run(app: { url: string; shots: string }, mode: "light" | "dark") {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, colorScheme: mode, deviceScaleFactor: 2 });
  const dir = resolve(app.shots, mode);
  mkdirSync(dir, { recursive: true });
  const panel = () => page.getByRole("dialog", { name: "Kin" });
  const box = () => panel().getByRole("textbox", { name: "Message Kin" });
  const kinReplies = () => panel().locator('[data-role="kin"]');
  let n = 0;
  const shot = async (name: string, whole = false) => {
    n++;
    const file = resolve(dir, `${String(n).padStart(2, "0")}-${name}.png`);
    // The pane and a margin around it, or the whole window.
    const box = whole ? null : await panel().boundingBox().catch(() => null);
    await page.screenshot({
      path: file,
      animations: "disabled",
      clip: box ? { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 24), width: Math.min(1280 - Math.max(0, box.x - 24), box.width + 48), height: Math.min(820 - Math.max(0, box.y - 24), box.height + 48 + 60) } : undefined,
    });
    console.log(`${mode} ${file}`);
  };
  const scenario = async (name: string, body: () => Promise<void>) => {
    if (only && !only.some((o) => name.includes(o))) return;
    try {
      await body();
    } catch (e) {
      console.error(`${mode} ${name}: ${String(e).split("\n")[0]}`);
      await shot(`${name}-failed`, true).catch(() => {});
    }
  };
  const open = async () => {
    if (await panel().isVisible()) return;
    await page.keyboard.press("Meta+j");
    await panel().waitFor();
  };
  const hide = async () => {
    if (!(await panel().isVisible())) return;
    await panel().getByRole("button", { name: /^(Hide|Close) Kin$/ }).first().click();
    await panel().waitFor({ state: "hidden" });
  };
  const say = async (text: string) => {
    await box().fill(text);
    await box().press("Enter");
  };
  /** Sends, then waits for the reply after the ones there now. */
  const ask = async (text: string, timeout = 45_000) => {
    const before = await kinReplies().count();
    await say(text);
    await kinReplies().nth(before).waitFor({ timeout });
    await page.waitForTimeout(400);
    return kinReplies().nth(before);
  };
  const openDoc = async (path: string) => {
    await page.locator(`[title="${path}"]`).first().click();
    await page.locator(`[title="${path}"][data-active="true"]`).waitFor();
  };
  const selectParagraph = async () => {
    await page.locator(".cm-line", { hasText: "The first time I saw a kintsugi bowl" }).click({ clickCount: 3 });
  };
  const expandSteps = async (reply: ReturnType<typeof kinReplies>) => {
    const steps = reply.locator("[data-steps] button").first();
    if (await steps.count()) await steps.click();
  };

  await page.goto(app.url);
  await page.locator(`[title="${DRAFT}"]`).first().waitFor({ timeout: 120_000 });

  await scenario("empty", async () => {
    await openDoc("posts/on-craft.mdx").catch(() => openDoc(DRAFT));
    await open();
    await page.waitForTimeout(600);
    await shot("empty");
  });

  await scenario("context-chips", async () => {
    await hide();
    await openDoc(DRAFT);
    await selectParagraph();
    await open();
    await panel().getByLabel("Context").locator('[data-chip^="paragraph:"]').waitFor();
    await shot("context-chips", true);
  });

  await scenario("streaming", async () => {
    await say("Is the gold metaphor overworked here?");
    await panel().locator("[data-live]").getByText("You said", { exact: false }).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(900);
    await shot("streaming");
    await kinReplies().last().waitFor({ timeout: 30_000 });
    await panel().locator("[data-live]").waitFor({ state: "detached", timeout: 30_000 });
    await page.waitForTimeout(300);
  });

  await scenario("tool-calls", async () => {
    const reply = kinReplies().last();
    await expandSteps(reply);
    await page.waitForTimeout(300);
    await shot("tool-calls-vault");
  });

  await scenario("reasoning", async () => {
    await say("Think hard: does the ending land?");
    await panel().locator("[data-live]").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(2600);
    await shot("reasoning-thinking");
    const reply = kinReplies().last();
    await reply.getByText("does the ending land", { exact: false }).waitFor({ timeout: 45_000 });
    await panel().locator("[data-live]").waitFor({ state: "detached", timeout: 30_000 });
    await shot("reasoning-done");
  });

  await scenario("multiple-tools", async () => {
    await say("Compare my drafts about repair");
    await panel().locator("[data-live]").waitFor({ timeout: 30_000 });
    await panel().locator("[data-live]").getByText(/Read|read/).first().waitFor({ timeout: 30_000 });
    await shot("multiple-tools-live");
    await panel().locator("[data-live]").waitFor({ state: "detached", timeout: 45_000 });
    await expandSteps(kinReplies().last());
    await page.waitForTimeout(300);
    await shot("multiple-tools-done");
  });

  await scenario("web", async () => {
    await say("Search the web for golden joinery");
    await panel().locator("[data-live]").getByText("golden joinery", { exact: false }).first().waitFor({ timeout: 30_000 });
    await shot("web-live");
    await panel().locator("[data-live]").waitFor({ state: "detached", timeout: 45_000 });
    const sources = kinReplies().last().locator("[data-web-sources]");
    await sources.getByRole("button", { name: /web sources/ }).click();
    await page.waitForTimeout(300);
    await shot("web-sources");
  });

  await scenario("markdown", async () => {
    await ask("What are the main points?");
    await panel().locator("[data-live]").waitFor({ state: "detached", timeout: 45_000 });
    await shot("markdown-reply");
  });

  await scenario("edit-proposed", async () => {
    await hide();
    await selectParagraph();
    await open();
    await ask("Tighten this");
    await panel().locator("[data-live]").waitFor({ state: "detached", timeout: 45_000 });
    await shot("edit-proposed");
    const apply = kinReplies().last().getByRole("button", { name: "Apply" });
    if (await apply.count()) {
      await apply.click();
      await page.waitForTimeout(500);
      await shot("edit-applied", true);
    }
  });

  await scenario("error", async () => {
    await ask("This one should fail");
    await page.waitForTimeout(300);
    await shot("error");
  });

  await scenario("timeout", async () => {
    await say("Simulate a timeout");
    await page.waitForTimeout(700);
    await shot("timeout-waiting");
    await panel().locator("[data-live]").waitFor({ state: "detached", timeout: 30_000 });
    await page.waitForTimeout(300);
    await shot("timeout");
  });

  await scenario("helper-jobs", async () => {
    await invoke(page, "kin_job_create", { job: { kind: "feed-ranking", task: "triage", brief: "Rank recent clips about repair." } });
    await panel().locator("[data-job]").first().waitFor({ timeout: 10_000 }).catch(() => {});
    await shot("helper-running");
    // A helper's report lands in General; Everything shows it beside the draft's thread.
    await panel().locator("[data-job]").first().waitFor({ state: "detached", timeout: 45_000 }).catch(() => {});
    await panel().getByRole("button", { name: "Conversation", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /^Everything/ }).click();
    await panel().locator('[data-role="helper"]').first().waitFor({ timeout: 45_000 });
    await page.waitForTimeout(800);
    await shot("helper-report");
    // Back to the draft's thread.
    await panel().getByRole("button", { name: "Conversation", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /^Kintsugi and gold/ }).click();
    await page.waitForTimeout(500);
  });

  await scenario("cost-cap", async () => {
    await invoke(page, "kin_set_cap", { capUsd: 0 });
    await invoke(page, "kin_job_create", { job: { kind: "feed-ranking", task: "triage", brief: "Rank this week's Feed." } });
    await ask("What should I read next?");
    await panel().locator("[data-live]").waitFor({ state: "detached", timeout: 45_000 });
    await page.waitForTimeout(500);
    await shot("cost-cap");
    await invoke(page, "kin_set_cap", { capUsd: null });
  });

  await scenario("model-picker", async () => {
    const trigger = panel().getByRole("button", { name: /Model/ }).first();
    await trigger.click();
    await page.waitForTimeout(400);
    await shot("model-picker", true);
    await page.keyboard.press("Escape");
  });

  await scenario("long-conversation", async () => {
    await hide();
    await page.keyboard.press("Meta+Shift+i").catch(() => {});
    await open();
    const picker = panel().getByRole("button", { name: "Conversation", exact: true });
    await picker.click();
    await page.getByRole("menuitemradio", { name: /^General/ }).first().click({ timeout: 5_000 }).catch(() => page.getByRole("button", { name: /^General/ }).first().click());
    await page.waitForTimeout(800);
    await shot("long-conversation");
    const log = panel().getByLabel("Conversation").last();
    await log.evaluate((el) => (el.scrollTop = el.scrollHeight / 3));
    await page.waitForTimeout(500);
    await shot("long-conversation-scrolled-up");
  });

  await scenario("hidden-pill", async () => {
    await hide();
    await page.waitForTimeout(400);
    await shot("hidden", true);
  });

  await browser.close();
}

const attached = process.env.KIN_SCENARIOS_URL;
let app: App | null = null;
try {
  for (const mode of modes) {
    // A fresh vault per mode, so both show the same states.
    if (!attached) {
      app = await startApp(
        "kin-scenarios",
        {
          KINTSUGI_HEADLESS_KIN: "mock",
          KINTSUGI_HEADLESS_KIN_IDLE_MS: "600000",
          ...(process.env.KINTSUGI_FRONTEND_PORT ? { KINTSUGI_FRONTEND_PORT: process.env.KINTSUGI_FRONTEND_PORT } : {}),
          ...(process.env.KINTSUGI_BACKEND_PORT ? { KINTSUGI_BACKEND_PORT: process.env.KINTSUGI_BACKEND_PORT } : {}),
        },
        seedLongConversation,
      );
    }
    const target = attached ? { url: attached, shots: resolve(process.env.KIN_SCENARIOS_SHOTS ?? ".headless/kin-scenarios-attached") } : app!;
    await run(target, mode);
    app?.stop();
    app = null;
    if (!attached) await new Promise((r) => setTimeout(r, 1500));
  }
} finally {
  app?.stop();
}
