// KI-108: real Rust runtime, scratch vault, no provider or owner data.
// Source-wrapped prose must lay out exactly like a flowing paragraph,
// preserve source bytes through reading/copying/editing, and keep KI-103's
// fixed wrap with the margin open. Light/dark evidence goes to shots/.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

const DRAFT = "drafts/kintsugi-and-gold.md";
const FLOW = "drafts/flow-reference.md";
const NOTE = "notes/soft-breaks.md";
/** Greedy hard wrap at a fixed width, as tools wrap notes. */
const wrap = (text: string, width: number) => text.split(" ").reduce<string[]>((lines, word) => {
  const last = lines.at(-1);
  if (last !== undefined && last.length + 1 + word.length <= width) lines[lines.length - 1] = `${last} ${word}`;
  else lines.push(word);
  return lines;
}, []).join("\n");
const PROSE = "The first time I saw a kintsugi bowl I thought the gold was decoration. It is not. The gold is a decision: this break is part of the object now, and we are not going to pretend otherwise. That is the whole point of the repair.";
const WRAPPED = wrap(PROSE, 75);
const POEM = "Roses are red,\nViolets are blue,\nSugar is sweet,\nAnd so are you.";
const ADDRESS = "Hussain Phalasiya\n12 Harbour Street\nAmman 11118\nJordan";
const TEXT = `${WRAPPED}\n\n${POEM}\n\n${ADDRESS}\n\nA hard break  \nstays here.\n\n\`\`\`\ncode first\ncode second\n\`\`\`\n`;
let app: App;
let browser: Browser;
let page: Page;
let original: string;
let paragraph: string;

before(async () => {
  app = await startApp("ki108", {}, (vault) => {
    original = readFileSync(resolve(vault, DRAFT), "utf8");
    paragraph = original.split("\n\n").find((p) => p.startsWith("The first time"))!;
    writeFileSync(resolve(vault, FLOW), original.replace('title: "Kintsugi and gold"', 'title: "Flow reference"').replace(paragraph, paragraph.replaceAll("\n", " ")));
    writeFileSync(resolve(vault, NOTE), TEXT);
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  await openApp(page, app.url, app.output);
}, { timeout: Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000) });

after(async () => {
  await browser?.close();
  await app?.stop();
});

async function settle() {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== "running"));
}
async function openDoc(path: string) {
  await page.locator(`[title="${path}"]`).click();
  await page.locator(`[title="${path}"][data-active=true]`).waitFor();
  await page.locator(".cm-line").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await settle();
}
const prose = () => page.locator(".cm-line", { hasText: "The first time I saw a kintsugi bowl" });
const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
/** Light and dark, back to light. */
async function shots(name: string) {
  for (const scheme of ["light", "dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle();
    if (scheme === "dark") await shot(`${name}-dark`);
  }
  await shot(`${name}-light`);
}
const disk = (path: string) => readFileSync(resolve(app.vault, path), "utf8");

/** Character positions, including widget spaces, relative to the column.
 *  Independent of DOM splits from syntax highlighting or decorations. */
async function boxes() {
  return prose().evaluate((el) => {
    const left = el.closest(".cm-content")!.getBoundingClientRect().left;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const out: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let i = 0; i < (node.textContent?.length ?? 0); i++) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + 1);
        const box = r.getBoundingClientRect();
        out.push(`${Math.round((box.left - left) * 2) / 2},${Math.round(box.top * 2) / 2},${Math.round(box.width * 2) / 2}`);
      }
    }
    return out;
  });
}

test("source wraps read like flowing prose, unchanged by margin or theme", { timeout: 120_000 }, async () => {
  await openDoc(FLOW);
  const flowing = await boxes();
  await openDoc(DRAFT);
  assert.equal(await prose().textContent(), paragraph.replaceAll("\n", " "));
  assert.equal(await prose().locator(".cm-soft-break").count(), 2);
  const joined = await boxes();
  assert.equal(joined.length, flowing.length);
  for (let i = 0; i < joined.length; i++) {
    const [x, y, w] = joined[i].split(",").map(Number);
    const [fx, fy, fw] = flowing[i].split(",").map(Number);
    assert.equal(y, fy, `character ${i}: same row as flowing source`);
    // The inline widget splits font shaping runs; subpixel glyph rounding
    // can differ, but every character must stay in the same place and row.
    assert.ok(Math.abs(x - fx) <= 1 && Math.abs(w - fw) <= 1, `character ${i}: ${joined[i]} vs ${flowing[i]}`);
  }

  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await settle();
    const before = await boxes();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const name of ["References", "Kin", "Stash"]) {
        if (name === "References") await page.keyboard.press("Meta+Shift+r");
        else await page.getByRole("complementary", { name: "Margin" }).getByRole("tab", { name }).click();
        await settle();
        assert.deepEqual(await boxes(), before, `${width}, ${scheme}, ${name}: no rewrap`);
        assert.equal(await strandedSpaces(), 0, `${width}, ${scheme}, ${name}: no line starts with a soft-break space`);
        if (name === "References") await shot(`${width}-${scheme}-margin`);
      }
      await page.keyboard.press("Meta+Alt+Backslash");
      await settle();
      assert.deepEqual(await boxes(), before, "closing the margin preserves every wrap");
      await shot(`${width}-${scheme}-closed`);
    }
  }
  const linked = page.locator(".cm-line", { hasText: "That sentence belongs" });
  assert.equal(await linked.locator(".cm-soft-break").count(), 2);
  await linked.locator(".cm-reference-chip", { hasText: "Golden joinery" }).click();
  assert.equal(await copiedSelection(), "[[inspiration/golden-joinery]]", "a chip on the second source line still selects the right reference");
  await page.reload();
  await prose().waitFor();
  assert.equal(await prose().textContent(), paragraph.replaceAll("\n", " "));
  assert.equal(disk(DRAFT), original, "reading and toggling UI never rewrites the file");
});

test("a 75-character note flows; typed short lines stay; Enter shows a new line at once", { timeout: 60_000 }, async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await openDoc(NOTE);
  const line = (text: string) => page.locator(".cm-line", { hasText: text });
  assert.ok(WRAPPED.split("\n").length >= 3 && WRAPPED.split("\n").slice(0, -1).every((l) => l.length >= 60 && l.length <= 75));
  assert.equal(await line("The first time").textContent(), PROSE, "the hard-wrapped note reads as one paragraph");
  for (const text of [...POEM.split("\n"), ...ADDRESS.split("\n")]) assert.equal(await line(text).textContent(), text, `"${text}" keeps its own line`);
  assert.equal(await strandedSpaces(), 0, "a break at the measure hangs at the line end, never starts a line");
  assert.equal(await line("A hard break").textContent(), "A hard break  ");
  assert.equal(await line("code first").textContent(), "code first");
  await shots("note");

  await line("The first time").click();
  await page.keyboard.press("Meta+a");
  assert.equal(await copiedSelection(), TEXT, "copy keeps the underlying Markdown, including soft newlines");
  await page.keyboard.press("ArrowLeft"); // start of the document
  const at = PROSE.indexOf("decision:") + "decision:".length;
  for (let i = 0; i < at; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  // Synchronously, before any save or reparse settles: his line is there.
  assert.equal(await line("The first time").textContent(), PROSE.slice(0, at), "the new line shows at once");
  // Enter drops the space at the break, as it does anywhere in the editor.
  assert.equal(await line("this break is part").textContent(), PROSE.slice(at + 1), "the rest holds still while he types");
  await untilSaved(TEXT.slice(0, at) + "\n" + TEXT.slice(at + 1));
  await page.keyboard.type("So ");
  await untilSaved(TEXT.slice(0, at) + "\nSo " + TEXT.slice(at + 1));
  assert.equal(await line("So this break").textContent(), "So " + PROSE.slice(at + 1));
  await shots("enter");

  // Leaving the paragraph never collapses the line he broke.
  await line("Violets are blue").click();
  await settle();
  assert.equal(await line("The first time").textContent(), PROSE.slice(0, at));
  assert.ok((await line("So this break").textContent())!.startsWith("So this break"));
  for (let i = 0; i < 4 && disk(NOTE) !== TEXT; i++) {
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(400);
  }
  await untilSaved(TEXT);
  await line("Violets are blue").click();
  await settle();
  assert.equal(await line("The first time").textContent(), PROSE, "undone, the note flows again");
});

test("cursor, copy, editing and undo retain source line endings", { timeout: 60_000 }, async () => {
  await openDoc(NOTE);
  const first = page.locator(".cm-line", { hasText: "The first time" });
  await first.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("ArrowLeft");
  const soft = WRAPPED.indexOf("\n") + 1; // just after the first soft newline
  for (let i = 0; i < soft; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.type("Changed ");
  await untilSaved(TEXT.slice(0, soft) + "Changed " + TEXT.slice(soft));
  assert.ok((await first.textContent())!.includes(" Changed "), "typed across the flowing break, in place");
  await page.keyboard.press("Meta+z");
  await untilSaved(TEXT);
  await page.keyboard.press("Enter"); // a second source newline splits the paragraph
  await untilSaved(TEXT.slice(0, soft) + "\n" + TEXT.slice(soft));
  assert.equal(await first.textContent(), WRAPPED.split("\n")[0]);
  await page.keyboard.press("Meta+z");
  await untilSaved(TEXT);
  await page.locator(".cm-line", { hasText: "Violets are blue" }).click();
  await settle();
  assert.equal(await first.textContent(), PROSE);
});

/** Soft-break spaces that wrapped alone to the start of the next row. */
async function strandedSpaces() {
  return page.locator(".cm-content").evaluate((root) => {
    let stranded = 0;
    for (const line of root.querySelectorAll(".cm-line")) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let previous: number | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let i = 0; i < (node.textContent?.length ?? 0); i++) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const top = Math.round(range.getBoundingClientRect().top);
          if (node.parentElement?.classList.contains("cm-soft-break") && previous !== null && top > previous) stranded++;
          previous = top;
        }
      }
    }
    return stranded;
  });
}

async function copiedSelection() {
  return page.locator(".cm-content").evaluate((el) => {
    const clipboardData = new DataTransfer();
    el.dispatchEvent(new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }));
    return clipboardData.getData("text/plain");
  });
}

async function untilSaved(text: string) {
  // Saving is debounced; a disk read in node is the actual assertion.
  for (let i = 0; i < 100; i++) {
    if (disk(NOTE) === text) return;
    await page.waitForTimeout(50);
  }
  assert.equal(disk(NOTE), text);
}
