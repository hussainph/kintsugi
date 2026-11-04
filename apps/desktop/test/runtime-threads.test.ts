// KI-38's comments as KI-104's threads, against the real runtime: `pnpm
// desktop:headless` (the real Rust command registry on Tauri MockRuntime,
// and the real React app) driven by headless Chromium, with Kin on the
// scripted headless model (`KINTSUGI_HEADLESS_KIN=mock`): no credentials,
// no provider, no cost.
//
// The vault starts the way the app left it before KI-104: one log and a
// comment thread in `.kintsugi/comments/`. They become threads on open; the
// old comment's paragraph shows its gutter mark, which opens it in the Kin
// pane. Then @Kin starts a thread on a paragraph, which moves with its
// paragraph through edits and reloads, resolves and reopens, and survives
// its paragraph being deleted; a quick ask leaves a "Kin replied" chip; and
// "Kin, review this draft" starts threads on paragraphs. Everything lives in
// a fresh scratch vault and config; screenshots go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App, openApp } from "./headless-app.ts";

const DOC = "drafts/seams.md";
const BODY = [
  "The first bowl I mended broke along an old line.",
  "Golden joinery makes the break the most visible part of the bowl.",
  "Kilns teach patience, and patience teaches repair.",
].join("\n\n");
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const OLD = "c-20261020-101500-a1b0000";

let app: App;
let browser: Browser;
let page: Page;

/** The vault as the app kept it before KI-104: a log and a comment thread. */
function oldVault(vault: string) {
  writeFileSync(resolve(vault, DOC), `---\ntitle: "Seams"\nstatus: draft\n---\n\n${BODY}\n`);
  const kin = resolve(vault, ".kintsugi/kin");
  mkdirSync(kin, { recursive: true });
  const log = [
    { seq: 1, at: "2026-10-20T09:00:00+01:00", role: "owner", text: "What should I read tonight?", topic: "" },
    { seq: 2, at: "2026-10-20T09:00:05+01:00", role: "kin", text: "Start with the kiln clip.", topic: "", answers: [1] },
    { seq: 3, at: "2026-10-20T10:15:00+01:00", role: "owner", text: "Does this opening hold up?", chips: [{ kind: "paragraph", path: DOC, lines: [6, 6] }, { kind: "doc", path: DOC }], topic: DOC, comment: OLD },
    { seq: 4, at: "2026-10-20T10:15:09+01:00", role: "kin", text: "It names the line but not the break.", topic: DOC, answers: [3], comment: OLD },
  ];
  writeFileSync(resolve(kin, "log.jsonl"), log.map((e) => JSON.stringify(e)).join("\n") + "\n");
  mkdirSync(resolve(vault, ".kintsugi/comments/drafts"), { recursive: true });
  writeFileSync(
    resolve(vault, `.kintsugi/comments/${DOC}.json`),
    JSON.stringify({ version: 1, path: DOC, threads: [{ id: OLD, anchor: { exact: "The first bowl I mended broke along an old line.", prefix: "---\n\n", suffix: "\n\nGolden", line: 6 }, status: "open", origin: "mention", created: "2026-10-20T10:15:00+01:00" }] }),
  );
}

before(async () => {
  app = await startApp("ki104", { KINTSUGI_HEADLESS_KIN: "mock" }, oldVault);
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await openApp(page, app.url, app.output);
  await openDoc();
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
});

const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
const disk = () => readFileSync(resolve(app.vault, DOC), "utf8");
const kinDir = () => resolve(app.vault, ".kintsugi/kin");
type Meta = { id: string; title: string; status: string; origin: string; anchor?: { kind: string; path: string; orphaned?: boolean; quote?: { exact: string; line: number } } };
const index = (): Meta[] => JSON.parse(readFileSync(resolve(kinDir(), "threads/index.json"), "utf8")).threads;
const paragraphs = () => index().filter((t) => t.anchor?.kind === "paragraph" && t.anchor.path === DOC);
/** The thread @Kin starts below (the migrated comment was a mention too). */
const claim = () => paragraphs().find((t) => t.title === "Is this claim sourced?")!;

async function until(check: () => boolean, what: string, tries = 150) {
  for (let i = 0; i < tries; i++) {
    try { if (check()) return; } catch { /* not there yet */ }
    await page.waitForTimeout(100);
  }
  assert.fail(what);
}

async function openDoc() {
  await page.locator(`[title="${DOC}"]`).click();
  await page.locator(`[title="${DOC}"][data-active="true"]`).waitFor();
  await page.locator(".cm-line", { hasText: "Kilns teach patience" }).waitFor();
}

const line = (text: string) => page.locator(".cm-line", { hasText: text });
const markerOn = (text: string) => line(text).locator(".cm-comment-marker");
const pane = () => page.getByRole("region", { name: "Kin" });
const kinReplies = () => pane().locator('[data-role="kin"]');
const passage = () => pane().locator(".ki-kin-about-passage");

test("the old log and comment thread are threads now; its paragraph's mark opens it", { timeout: 90_000 }, async () => {
  await markerOn("The first bowl I mended").waitFor();
  assert.ok(!existsSync(resolve(kinDir(), "log.jsonl")), "the old log moved aside");
  assert.ok(!existsSync(resolve(app.vault, ".kintsugi/comments")), "the comments folder moved aside");
  const archived = readdirSync(resolve(kinDir(), "archive"));
  assert.ok(archived.some((n) => n.startsWith("log-")) && archived.includes("comments"), archived.join(", "));
  const earlier = index().find((t) => t.title === "Earlier conversation");
  assert.ok(earlier, "the general messages are an earlier conversation");

  await markerOn("The first bowl I mended").click();
  await pane().waitFor();
  await passage().getByText("The first bowl I mended broke along an old line.").waitFor();
  await pane().locator('[data-role="owner"]').getByText("Does this opening hold up?").waitFor();
  await kinReplies().getByText("It names the line but not the break.").waitFor();
  await page.locator(".cm-comment-active", { hasText: "The first bowl" }).waitFor();
  await shot("01-migrated-thread");
  await pane().getByRole("button", { name: "Back" }).click();
  await pane().locator("[data-thread]").getByText("Does this opening hold up?").waitFor();
  await page.keyboard.press("Meta+j");
  await pane().waitFor({ state: "detached" });
});

test("@Kin on a paragraph starts a thread about it in the Kin pane", { timeout: 90_000 }, async () => {
  const before = disk();
  await line("Golden joinery makes").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" @");
  await page.locator('.cm-reference-kin[aria-selected="true"]').waitFor();
  await page.keyboard.press("Enter");
  await pane().locator("[data-new]").waitFor();
  await passage().getByText("Golden joinery makes the break the most visible part of the bowl.").waitFor();
  await page.locator(".cm-comment-active", { hasText: "Golden joinery" }).waitFor();
  const box = pane().getByRole("textbox", { name: "Message Kin" });
  await box.fill("Is this claim sourced?");
  await shot("02-new-paragraph-thread");
  await box.press("Enter");

  await markerOn("Golden joinery makes").waitFor({ timeout: 30_000 });
  await kinReplies().first().getByText(/Mock note: you asked “Is this claim sourced\?”/).waitFor({ timeout: 30_000 });
  await pane().locator("[data-live]").waitFor({ state: "detached", timeout: 30_000 });
  await shot("03-kin-replied");
  await until(() => !!claim(), "the thread is stored, anchored to its paragraph");
  const thread = claim();
  assert.equal(thread.origin, "mention");
  assert.equal(thread.anchor?.quote?.exact, "Golden joinery makes the break the most visible part of the bowl.");
  // The draft itself is untouched: the @ went back out, leaving only the space he typed.
  await until(() => disk() === before.replace("of the bowl.", "of the bowl. "), `the document is unchanged:\n${disk()}`);
});

test("the thread moves with its paragraph through edits and a reload, and reopens from its mark", { timeout: 90_000 }, async () => {
  await page.keyboard.press("Meta+j");
  await pane().waitFor({ state: "detached" });
  await line("The first bowl").click({ position: { x: 5, y: 8 } });
  await page.keyboard.press("Home");
  await page.keyboard.type("A new opening paragraph.\n\n");
  await line("Golden joinery makes").click();
  await page.keyboard.press("End");
  await page.keyboard.type("Every time.");
  await markerOn("Every time.").waitFor();
  await until(() => disk().includes("bowl. Every time."), "the edit is saved");
  await until(() => claim().anchor!.quote!.exact.endsWith("bowl. Every time."), "the anchor follows the edited paragraph");
  assert.equal(claim().anchor!.quote!.line, 10);

  await page.reload();
  await openDoc();
  await markerOn("Every time.").waitFor();
  assert.equal(await page.locator(".cm-comment-marker").count(), 2);
  await markerOn("Every time.").click();
  await pane().locator("[data-thread-title]").getByText("Is this claim sourced?").waitFor();
  await kinReplies().first().waitFor();
  await shot("04-after-reload");
});

test("resolving hides the mark; the thread reopens from All threads", { timeout: 60_000 }, async () => {
  await pane().getByRole("button", { name: "Resolve" }).click();
  await until(() => claim().status === "resolved", "resolved is stored");
  await markerOn("Every time.").waitFor({ state: "detached" });
  await pane().getByRole("button", { name: "All threads" }).click();
  const row = pane().locator(`[data-thread="${claim().id}"]`);
  await row.getByText("Resolved").waitFor();
  await row.click();
  await pane().getByRole("button", { name: "Reopen" }).click();
  await until(() => claim().status === "open", "reopened is stored");
  await markerOn("Every time.").waitFor();
  await shot("05-reopened");
});

test("deleting the paragraph keeps the thread, with the text it was on", { timeout: 90_000 }, async () => {
  await page.keyboard.press("Meta+j");
  await pane().waitFor({ state: "detached" });
  // Triple-click selects the whole paragraph; End/Shift+Home only reach the
  // visual line, and the paragraph wraps at the theme's editor size.
  await line("Every time.").click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await until(() => claim().anchor?.orphaned === true, "detached is stored");
  assert.match(claim().anchor!.quote!.exact, /^Golden joinery makes the break/);
  await page.keyboard.press("Meta+j");
  // Kin opens where he left it: the thread; Back is its draft's list.
  await pane().getByRole("button", { name: "Back" }).click();
  const row = pane().locator(`[data-thread="${claim().id}"]`);
  await row.locator('.ki-kin-passage[data-orphaned]').waitFor();
  await shot("06-detached");
  await row.click();
  await pane().locator("[data-thread-title]").getByText("Is this claim sourced?").waitFor();
  await kinReplies().first().waitFor();
  assert.equal(await kinReplies().count(), 1, "its messages are kept");

  // Closed first: an open margin folds the sidebar at this width.
  await page.keyboard.press("Meta+j");
  await pane().waitFor({ state: "detached" });
  await page.reload();
  await openDoc();
  assert.ok(claim(), "never lost");
});

test("a quick ask leaves a Kin replied chip under the paragraph", { timeout: 90_000 }, async () => {
  await line("Kilns teach patience").click();
  await page.keyboard.press("Meta+k");
  await page.locator("[data-slot=popover-content]").getByRole("option", { name: /Who disagrees/ }).click();
  const chip = page.locator(".cm-comment-ask");
  await chip.waitFor({ timeout: 30_000 });
  assert.equal(await pane().count(), 0, "Kin stays out of the way");
  await page.locator('.cm-comment-ask[data-state="replied"]').waitFor({ timeout: 30_000 });
  // In view, and clear of the document bar.
  const box = (await chip.boundingBox())!;
  const bar = (await page.locator(".ki-document-bar").boundingBox())!;
  assert.ok(box.y >= 0 && box.y + box.height <= bar.y, JSON.stringify({ box, bar }));
  await shot("07-kin-replied-chip");
  await chip.click();
  await pane().waitFor();
  await pane().locator('[data-role="owner"]').getByText(/^Who disagrees/).waitFor();
  await kinReplies().first().waitFor();
  await chip.waitFor({ state: "detached" });
  const ask = index().find((t) => t.origin === "ask")!;
  assert.equal(ask.anchor?.kind, "paragraph");
  assert.match(ask.anchor!.quote!.exact, /^Kilns teach patience/);
  await shot("08-ask-thread");
});

test("⌘K › Kin, review this draft starts threads on paragraphs", { timeout: 90_000 }, async () => {
  await page.keyboard.press("Meta+j");
  await pane().waitFor({ state: "detached" });
  await line("Kilns teach patience").click();
  await page.keyboard.press("Meta+k");
  await page.locator("[data-slot=popover-content]").getByRole("option", { name: /Kin, review this draft/ }).click();
  await pane().waitFor();
  await until(() => paragraphs().filter((t) => t.origin === "review").length === 2, "two review threads are stored");
  const review = paragraphs().filter((t) => t.origin === "review");
  assert.equal(review[0].anchor?.quote?.exact, "A new opening paragraph.");
  assert.match(review[1].anchor!.quote!.exact, /^Kilns teach patience/);
  await markerOn("A new opening paragraph.").waitFor();
  await pane().locator(`[data-thread="${review[0].id}"]`).waitFor();
  await shot("09-review-list");
  // The pane covers the gutter at this width; its mark opens it once it's away.
  await page.keyboard.press("Meta+j");
  await pane().waitFor({ state: "detached" });
  await markerOn("A new opening paragraph.").click();
  await kinReplies().first().getByText("Mock review: the opening makes a claim", { exact: false }).waitFor();
  await shot("10-review-thread");
  const own = index().find((t) => t.origin === "review" && t.anchor?.kind === "doc")!;
  assert.equal(own.title, "Review");
  const lines = readFileSync(resolve(kinDir(), `threads/${own.id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.role === "kin" && /left 2 comments/.test(e.text)));
});
