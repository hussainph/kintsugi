// KI-38 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, with Kin on the scripted headless model
// (`KINTSUGI_HEADLESS_KIN=mock`): no credentials, no provider, no cost.
//
// Kin's comment threads on paragraphs: @Kin starts one, Kin replies in the
// margin, a reference it found drags into the draft; threads move with their
// paragraph through edits and reloads, live outside the document in
// `.kintsugi/comments/`, resolve and reopen, survive as detached when their
// paragraph is deleted, and are rows in Kin's one conversation log. Then
// "Kin, review this draft", and the popover at phone width. Everything lives
// in a fresh scratch vault and config; screenshots go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App } from "./headless-app.ts";

const DOC = "drafts/seams.md";
const BODY = [
  "The first bowl I mended broke along an old line.",
  "Golden joinery makes the break the most visible part of the bowl.",
  "Kilns teach patience, and patience teaches repair.",
].join("\n\n");
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki38", { KINTSUGI_HEADLESS_KIN: "mock" }, (vault) => {
    writeFileSync(resolve(vault, DOC), `---\ntitle: "Seams"\nstatus: draft\n---\n\n${BODY}\n`);
  });
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(app.url);
  await openDoc();
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  app?.stop();
});

const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
const disk = () => readFileSync(resolve(app.vault, DOC), "utf8");
const store = () => resolve(app.vault, `.kintsugi/comments/${DOC}.json`);
type Stored = { threads: { id: string; status: string; origin: string; orphaned?: boolean; anchor: { exact: string; line: number } }[] };
const stored = (): Stored => JSON.parse(readFileSync(store(), "utf8"));
const log = () => readFileSync(resolve(app.config, "kin/conversation/log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

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
const popover = () => page.locator(".cm-comment-popover");
const markerOn = (text: string) => line(text).locator(".cm-comment-marker");
const kinReplies = () => popover().locator('.cm-comment-message[data-role="kin"]');

test("@Kin on a paragraph starts a comment thread; Kin replies in the margin", { timeout: 90_000 }, async () => {
  const before = disk();
  await line("Golden joinery makes").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" @");
  await page.locator('.cm-reference-kin[aria-selected="true"]').waitFor();
  await page.keyboard.press("Enter");
  const composer = page.getByRole("textbox", { name: "Ask Kin about this paragraph" });
  await composer.waitFor();
  await composer.fill("Is this claim sourced?");
  await shot("01-composer");
  await composer.press("Enter");

  await markerOn("Golden joinery makes").waitFor();
  await popover().locator('.cm-comment-message[data-role="owner"]', { hasText: "Is this claim sourced?" }).waitFor();
  // Kin's reply streams in, then lands; it names what it found as a link.
  await kinReplies().first().waitFor({ timeout: 30_000 });
  await kinReplies().first().locator(".cm-comment-ref").first().waitFor({ timeout: 30_000 });
  await popover().locator("[data-live]").waitFor({ state: "detached", timeout: 30_000 });
  assert.match(await kinReplies().first().textContent() ?? "", /Mock note: you asked “Is this claim sourced\?”/);
  await shot("02-kin-replied");

  // Stored outside the document; the draft itself is untouched: the @ went
  // back out, leaving only the space he typed before it.
  await until(() => existsSync(store()), "the thread is stored in .kintsugi/comments/");
  const [thread] = stored().threads;
  assert.equal(thread.origin, "mention");
  assert.equal(thread.anchor.exact, "Golden joinery makes the break the most visible part of the bowl.");
  await until(() => disk() === before.replace("of the bowl.", "of the bowl. "), `the document is unchanged:\n${disk()}`);
});

test("a reply continues the thread, and a reference Kin found drags into the draft", { timeout: 90_000 }, async () => {
  const reply = popover().getByRole("textbox", { name: "Reply to Kin" });
  await reply.fill("Which clip says so?");
  await reply.press("Enter");
  await kinReplies().nth(1).waitFor({ timeout: 30_000 });
  await popover().locator("[data-live]").waitFor({ state: "detached", timeout: 30_000 });

  const chip = kinReplies().nth(1).locator(".cm-comment-ref").first();
  const link = await chip.getAttribute("data-comment-link");
  assert.ok(link?.startsWith("[[") && link.endsWith("]]"), String(link));
  await chip.dragTo(line("The first bowl"), { targetPosition: { x: 650, y: 8 } });
  await until(() => disk().includes(link!), `dragging the reference in writes ${link}:\n${disk()}`);
  await shot("03-dragged-reference");
  // Only his drag wrote anything: one link, nothing of Kin's prose.
  assert.ok(!disk().includes("Mock note"));
});

test("the thread moves with its paragraph through edits and a reload", { timeout: 90_000 }, async () => {
  await page.keyboard.press("Escape");
  // A new paragraph above, and a change inside the commented one.
  await line("The first bowl").click({ position: { x: 5, y: 8 } });
  await page.keyboard.press("Home");
  await page.keyboard.type("A new opening paragraph.\n\n");
  await line("Golden joinery makes").click();
  await page.keyboard.press("End");
  await page.keyboard.type("Every time.");
  await markerOn("Every time.").waitFor();
  await until(() => disk().includes("bowl. Every time."), "the edit is saved");
  await until(() => stored().threads[0].anchor.exact.endsWith("bowl. Every time."), "the anchor follows the edited paragraph");
  assert.equal(stored().threads[0].anchor.line, 10);

  await page.reload();
  await openDoc();
  await markerOn("Every time.").waitFor();
  assert.equal(await page.locator(".cm-comment-marker").count(), 1);
  await markerOn("Every time.").click();
  await kinReplies().nth(1).waitFor();
  await shot("04-after-reload");
});

test("resolve hides the thread, Show resolved brings it back, and it reopens", { timeout: 60_000 }, async () => {
  await popover().getByRole("button", { name: "Resolve" }).click();
  await until(() => stored().threads[0].status === "resolved", "resolved is stored");
  await page.getByRole("button", { name: "Show resolved" }).waitFor();
  await page.locator(".cm-comment-marker").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Show resolved" }).click();
  await page.locator(".cm-comment-marker-resolved").waitFor();
  await page.locator(".cm-comment-marker-resolved").click();
  await shot("05-resolved");
  await popover().getByRole("button", { name: "Reopen" }).click();
  await until(() => stored().threads[0].status === "open", "reopened is stored");
  // With nothing resolved left, the toggle goes away.
  await page.getByRole("button", { name: "Hide resolved" }).waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
});

test("deleting the paragraph keeps the thread, detached, across a reload", { timeout: 90_000 }, async () => {
  await page.locator(".cm-comment-popover").waitFor({ state: "detached" });
  await line("Every time.").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Backspace");
  await page.locator(".cm-comment-panel").getByText("1 detached").waitFor();
  const card = page.locator(".cm-comment-panel [data-comment-thread]");
  await card.getByText("Was on: “Golden joinery makes the break", { exact: false }).waitFor();
  assert.equal(await card.locator('.cm-comment-message[data-role="kin"]').count(), 2, "its messages are kept");
  await until(() => stored().threads[0].orphaned === true, "detached is stored");
  await shot("06-detached");

  await page.reload();
  await openDoc();
  await page.locator(".cm-comment-panel").getByText("1 detached").waitFor();
  assert.equal(stored().threads.length, 1, "never lost");
});

test("threads are rows in Kin's one conversation log, about the document", { timeout: 60_000 }, async () => {
  const entries = log().filter((e) => e.comment);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((e) => e.role), ["owner", "kin", "owner", "kin"]);
  assert.ok(entries.every((e) => e.topic === DOC && e.comment === stored().threads[0].id));
  assert.ok(entries[0].chips.some((c: { kind: string; lines?: number[] }) => c.kind === "paragraph" && c.lines), "his message carries the paragraph");
  // The chat shows them in the document's thread, marked as comments.
  await page.getByRole("button", { name: "Ask Kin" }).click();
  const chat = page.getByRole("dialog", { name: "Kin" });
  await chat.waitFor();
  await chat.locator("[data-comment-tag]").first().waitFor();
  await chat.locator('[data-role="kin"][data-comment]').first().waitFor();
  await shot("07-in-the-log");
  await chat.getByRole("button", { name: "Close Kin" }).first().click();
});

test("⌘K › Kin, review this draft leaves comments on paragraphs", { timeout: 90_000 }, async () => {
  await line("Kilns teach patience").click();
  await page.keyboard.press("Meta+k");
  await page.locator("[data-slot=popover-content]").getByRole("option", { name: /Kin, review this draft/ }).click();
  await page.locator(".cm-comment-marker").nth(1).waitFor({ timeout: 30_000 });
  await until(() => stored().threads.filter((t) => t.origin === "review").length === 2, "two review threads are stored");
  const review = stored().threads.filter((t) => t.origin === "review");
  assert.equal(review[0].anchor.exact, "A new opening paragraph.");
  assert.match(review[1].anchor.exact, /^Kilns teach patience/);
  await markerOn("A new opening paragraph.").click();
  await kinReplies().first().getByText("Mock review: the opening makes a claim", { exact: false }).waitFor();
  await shot("08-review");
  assert.ok(log().some((e) => e.review && e.role === "kin" && /left 2 comments/.test(e.text)));
  await page.keyboard.press("Escape");
});

test("at phone width the thread popover fits the screen", { timeout: 60_000 }, async () => {
  await page.setViewportSize({ width: 390, height: 780 });
  // The desktop's reference margin, left open from the wide window, isn't part of the phone.
  const margin = page.getByRole("button", { name: "Hide reference margin" });
  if (await margin.isVisible()) await margin.click();
  await markerOn("A new opening paragraph.").click();
  await popover().waitFor();
  const box = await popover().boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  await shot("09-phone-width");
});
