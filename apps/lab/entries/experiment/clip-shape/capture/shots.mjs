// Screenshots of every shape at desktop and phone widths, through the Lab's
// own preview protocol (a same-origin frame that receives scenario + values).
// From the repo root: node apps/lab/entries/experiment/clip-shape/capture/shots.mjs <lab url> <out dir> [name prefix…]
// Playwright comes from @kintsugi/lab, which already depends on it.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const { chromium } = createRequire(resolve("packages/lab/package.json"))("playwright");

const [base, out, ...only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const scenario = (width, theme = "light") => ({ theme, width, textScale: 1, reducedMotion: true, density: "comfortable" });
const shots = [];
for (const [width, tag] of [[1280, "desktop"], [390, "phone"]]) {
  shots.push([`ab-${tag}`, "default", {}, width]);
  shots.push([`ab-open-${tag}`, "default", { open: true }, width]);
  shots.push([`a-${tag}`, "card-thread", {}, width]);
  shots.push([`b-${tag}`, "expandable", {}, width]);
  shots.push([`b-open-${tag}`, "expandable", { open: true }, width]);
  shots.push([`c-youtube-${tag}`, "long-page", { clip: "youtube" }, width]);
  shots.push([`annotated-${tag}`, "default", { annotate: true }, width]);
}
for (const type of ["article", "x-thread", "youtube", "podcast", "paper", "hn-thread", "reddit", "screenshot", "note"]) {
  shots.push([`type-${type}-ab-open-phone`, "default", { clip: type, open: true }, 390]);
}
shots.push(["ab-dark-desktop", "default", { clip: "youtube", open: true }, 1280, "dark"]);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`${base}/?entry=experiment/clip-shape`);
for (const [name, story, values, width, theme] of shots) {
  if (only.length && !only.some((o) => name.startsWith(o))) continue;
  await page.evaluate(
    async ({ base, story, values, width, scenario }) => {
      document.body.innerHTML = "";
      document.body.style.margin = "0";
      const frame = document.createElement("iframe");
      frame.style.cssText = `width:${width}px;height:900px;border:0;display:block`;
      frame.src = `${base}/?preview=experiment/clip-shape&story=${story}`;
      document.body.append(frame);
      await new Promise((resolve) => {
        const ready = (e) => e.data?.type === "lab:ready" && (removeEventListener("message", ready), resolve());
        addEventListener("message", ready);
      });
      frame.contentWindow.postMessage({ type: "lab:scenario", scenario, values }, location.origin);
      await new Promise((r) => setTimeout(r, 600));
      const root = frame.contentDocument.querySelector(".lab-preview-root");
      root.style.height = "auto";
      root.style.minHeight = "0";
      frame.contentDocument.body.style.height = "auto";
      frame.contentDocument.getElementById("root").style.height = "auto";
      frame.style.height = `${Math.min(root.scrollHeight, 9000)}px`;
      await new Promise((r) => setTimeout(r, 200));
    },
    { base, story, values, width, scenario: scenario(width, theme) },
  );
  const frame = page.locator("iframe");
  await frame.screenshot({ path: `${out}/${name}.png` });
  // The first screenful too: what the shape looks like before any scrolling.
  const box = await frame.boundingBox();
  const fold = width < 600 ? 844 : 900;
  await page.screenshot({ path: `${out}/${name}.top.png`, clip: { x: 0, y: 0, width: box.width, height: Math.min(box.height, fold) } });
  console.log(name);
}
await browser.close();
