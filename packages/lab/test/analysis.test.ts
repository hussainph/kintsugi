import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { chromium } from "playwright";
import { analyze, ANALYSIS_HEURISTICS, contrastRatio } from "../src/analysis";
import { contrastRatio as browserContrast } from "../src/contrast";
import { boot, bootConcurrency } from "../src/boot";

const artifacts = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.lab-artifacts",
);
async function fixture(
  t: TestContext,
  files: Record<string, string> = {},
): Promise<string> {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "analysis-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

const tokens = `/* --fake: #123; */
@theme inline {
  --color-surface: var(--surface);
  --font-body: Georgia, serif;
}
:root {
  --surface: #ffffff;
  --space-sm: 8px;
  --duration-fast: 120ms;
}
.dark {
  --surface: rgb(0 0 0);
}
@media (prefers-contrast: more) {
  .dark { --surface: #010101; }
}
`;
const card = `// color: '#bad'; padding: '999px'; var(--fake)
export const Card = () => <div className="bg-surface dark:bg-surface/80 p-[22px]" style={{
  color: 'var(--surface)',
  padding: '12px 0px',
  fontSize: '18px',
  lineHeight: 1.5,
  transition: 'opacity 150ms ease',
  border: '1px solid #abc',
  outlineColor: 'red',
  background: "url('/image-32px-fff.png')",
  backgroundColor: 'color-mix(in srgb, var(--surface), #000 20%)',
}}>A card</div>;
`;

test("inventory preserves light/dark/at-rule contexts, lines and alias consumers", async (t) => {
  const root = await fixture(t, {
    "tokens.css": tokens,
    "src/Card.tsx": card,
    "src/Alias.tsx":
      'export const Alias = () => <div className="text-surface" />;',
  });
  const report = await analyze({
    root,
    tokenFiles: ["tokens.css"],
    sourceDirs: ["src", "src"],
    entries: [],
  });
  const surfaces = report.tokens.filter((token) => token.name === "--surface");
  assert.deepEqual(
    surfaces.map(({ value, line, context }) => ({ value, line, context })),
    [
      { value: "#ffffff", line: 7, context: ":root" },
      { value: "rgb(0 0 0)", line: 12, context: ".dark" },
      {
        value: "#010101",
        line: 15,
        context: "@media (prefers-contrast: more) > .dark",
      },
    ],
  );
  assert.equal(
    report.tokens.some((token) => token.name === "--fake"),
    false,
  );
  for (const token of surfaces) {
    assert.deepEqual(token.consumers, [
      "src/Alias.tsx",
      "src/Card.tsx",
      "tokens.css",
    ]);
    assert.equal(token.source, "tokens.css");
  }
  assert.deepEqual(
    report.tokens.find((token) => token.name === "--color-surface")?.consumers,
    ["src/Alias.tsx", "src/Card.tsx"],
  );
  assert.equal(
    report.hardcoded.some((finding) => finding.source === "tokens.css"),
    false,
    "token values are not hardcoded candidates",
  );
  assert.ok(ANALYSIS_HEURISTICS.length > 0);
});

test("style literal candidates ignore comments, URL fragments, prose, nonstyle strings and zero units", async (t) => {
  const root = await fixture(t, {
    "tokens.css": tokens,
    "src/Card.tsx": card,
    "src/noise.tsx": `
/* color: '#f00'; padding: '888px'; */
const prose = "Render red at 16px; wait 5s";
const config = { id: '#fff', timeout: '5s', url: 'https://example.test/16px/#fff' };
export const Noise = () => <a href="#fff" title="red 17px">Hello</a>;
const neutral = { padding: '0px /* 888px */', transition: 'opacity 0s', color: 'transparent', borderColor: 'var(--red)', background: 'url("data:image/svg+xml;#fff-32px")' };\nconst raw = css\`/* var(--duration-fast) */ .example { padding: 0px; }\`;
`,
  });
  const report = await analyze({
    root,
    tokenFiles: ["tokens.css"],
    sourceDirs: ["src"],
    entries: [],
  });
  assert.deepEqual(
    report.hardcoded.filter((finding) => finding.source === "src/Card.tsx"),
    [
      { source: "src/Card.tsx", line: 2, value: "22px", kind: "px" },
      { source: "src/Card.tsx", line: 4, value: "12px", kind: "px" },
      { source: "src/Card.tsx", line: 5, value: "18px", kind: "px" },
      { source: "src/Card.tsx", line: 7, value: "150ms", kind: "duration" },
      { source: "src/Card.tsx", line: 8, value: "1px", kind: "px" },
      { source: "src/Card.tsx", line: 8, value: "#abc", kind: "color" },
      { source: "src/Card.tsx", line: 9, value: "red", kind: "color" },
      {
        source: "src/Card.tsx",
        line: 11,
        value: "color-mix(in srgb, var(--surface), #000 20%)",
        kind: "color",
      },
    ],
  );
  assert.deepEqual(
    report.hardcoded.filter((finding) => finding.source === "src/noise.tsx"),
    [],
  );
  assert.deepEqual(
    report.tokens.find((token) => token.name === "--duration-fast")?.consumers,
    [],
    "raw CSS comments are not references",
  );
});

test("CSS, editor style objects and raw templates derive type/spacing/motion scales", async (t) => {
  const root = await fixture(t, {
    "tokens.css": tokens,
    "src/theme.ts": `export const theme = EditorView.theme({
  '&': { fontSize: '19px', color: 'var(--surface)', fontWeight: 650 },
  '.cm-content': { padding: '88px 32px 40vh', transition: 'opacity .2s ease' }
});`,
    "src/raw.ts":
      "const raw = css`\n.card { margin: 14px; color: #123456; width: calc(100% - ${ gap }px); }\n`;",
    "src/style.css":
      ".card {\n font-size: 20px;\n padding: 10px;\n transition-duration: 200ms;\n color: hsl(120 50% 50%);\n}\n",
    "src/Utilities.tsx":
      'export const Utility = () => <div className="text-[17px] px-[21px] duration-[.3s]" />; const transition = { duration: 0.25 };',
  });
  const report = await analyze({
    root,
    tokenFiles: ["tokens.css"],
    sourceDirs: ["src"],
    entries: [],
  });
  assert.ok(
    report.scales.type.some(
      (finding) =>
        finding.property === "font-size" &&
        finding.value === "19px" &&
        finding.source === "src/theme.ts",
    ),
  );
  assert.ok(
    report.scales.type.some(
      (finding) =>
        finding.property === "font-weight" && finding.value === "650",
    ),
  );
  assert.ok(
    report.scales.type.some((finding) => finding.property === "--font-body"),
  );
  assert.ok(
    report.scales.spacing.some(
      (finding) =>
        finding.property === "padding" && finding.value === "88px 32px 40vh",
    ),
  );
  assert.ok(
    report.scales.spacing.some(
      (finding) => finding.property === "--space-sm" && finding.value === "8px",
    ),
  );
  assert.ok(
    report.scales.motion.some(
      (finding) =>
        finding.property === "--duration-fast" && finding.value === "120ms",
    ),
  );
  assert.ok(
    report.scales.motion.some(
      (finding) =>
        finding.property === "transition-duration" && finding.value === "200ms",
    ),
  );
  assert.ok(
    report.scales.motion.some(
      (finding) => finding.property === "duration" && finding.value === "0.25",
    ),
  );
  assert.ok(
    report.scales.motion.some(
      (finding) =>
        finding.property === "transition-duration" && finding.value === ".3s",
    ),
  );
  assert.ok(
    report.scales.type.some(
      (finding) => finding.property === "font-size" && finding.value === "17px",
    ),
  );
  assert.ok(
    report.scales.spacing.some(
      (finding) => finding.property === "padding" && finding.value === "21px",
    ),
  );
  assert.ok(
    report.hardcoded.some(
      (finding) => finding.value === ".2s" && finding.source === "src/theme.ts",
    ),
  );
  assert.deepEqual(
    report.hardcoded.filter((finding) => finding.source === "src/raw.ts"),
    [
      { source: "src/raw.ts", line: 2, value: "14px", kind: "px" },
      { source: "src/raw.ts", line: 2, value: "#123456", kind: "color" },
    ],
  );
  assert.ok(
    report.tokens
      .find((token) => token.name === "--surface")
      ?.consumers.includes("src/theme.ts"),
  );
});

test("coverage is derived from discovered component/page files and entry sources, not a registry", async (t) => {
  const root = await fixture(t, {
    "src/Covered.tsx": "export const Covered = () => <main />;",
    "src/Uncovered.jsx": "export default () => <aside />;",
    "src/theme.ts": "export const theme = {};",
    "src/main.tsx":
      "createRoot(document.getElementById('root')).render(<App />);",
    "src/Covered.test.tsx": "const test = <div />;",
    "src/Covered.stories.tsx": "const story = <div />;",
    "src/types.d.ts": "declare const value: string;",
    "src/node_modules/Hidden.tsx": "export default () => <div />;",
  });
  const report = await analyze({
    root,
    tokenFiles: [],
    sourceDirs: ["src"],
    entries: [{ id: "page/example", sources: ["src/../src/Covered.tsx"] }],
  });
  assert.deepEqual(report.coverage, {
    covered: ["src/Covered.tsx"],
    uncovered: ["src/Uncovered.jsx"],
  });
});

test("malformed configured source roots fail rather than silently dropping sources", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    analyze({ root, tokenFiles: ["missing.css"], sourceDirs: [], entries: [] }),
    /ENOENT/,
  );
});

test("WCAG contrast is symmetric, uses sRGB transfer and rejects invalid samples", () => {
  assert.equal(
    browserContrast,
    contrastRatio,
    "browser utility is re-exported by server analysis",
  );
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), 21);
  assert.equal(contrastRatio([123, 45, 67], [123, 45, 67]), 1);
  const ratio = contrastRatio([119, 119, 119], [255, 255, 255]);
  assert.ok(Math.abs(ratio - 4.478089453577214) < 1e-12);
  assert.equal(ratio, contrastRatio([255, 255, 255], [119, 119, 119]));
  for (const channel of [-1, 256, NaN, Infinity])
    assert.throws(
      () => contrastRatio([channel, 0, 0], [255, 255, 255]),
      RangeError,
    );
});

test("boot workers are bounded by the shared concurrency hint", () => {
  assert.equal(bootConcurrency(undefined, "1"), 1);
  assert.equal(bootConcurrency(undefined, "3"), 3);
  assert.equal(bootConcurrency(8, "2"), 2);
  assert.equal(bootConcurrency(1, "2"), 1);
  assert.throws(() => bootConcurrency(0, "2"), /positive integer/);
  assert.throws(() => bootConcurrency(undefined, "bad"), /positive integer/);
});

async function fixtureServer(
  t: TestContext,
  catalog: unknown,
  html: (url: URL) => string,
): Promise<string> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__lab/catalog") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(catalog));
    } else if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(html(url));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("boot emits a failed manifest for invalid discovery without launching a browser", async (t) => {
  const outputDir = await fixture(t);
  const url = await fixtureServer(
    t,
    [{ id: "component/card" }, { id: "component/card" }],
    () => "",
  );
  const result = await boot({ url, outputDir });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /Duplicate catalog entry/);
  assert.equal(result.executablePath, undefined);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8")),
    result,
  );
});

test("headless boot discovers runtime stories, screenshots each and rejects browser/boundary errors", async (t) => {
  let executablePath: string | undefined;
  for (const candidate of [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ]) {
    if (!candidate) continue;
    try {
      await access(candidate);
      executablePath = candidate;
      break;
    } catch {
      /* Optional local browser. */
    }
  }
  if (!executablePath) {
    t.skip("No installed headless Chromium/Chrome executable");
    return;
  }
  const outputDir = await fixture(t);
  const storyIds = ["2-up", "console-error", "page-error", "boundary-error"];
  const stories = storyIds.map((storyId) => ({
    entryId: "component/card",
    storyId,
  }));
  const url = await fixtureServer(
    t,
    [{ meta: { id: "component/card" } }],
    (route) => {
      const storyId = route.searchParams.get("story");
      return `<!doctype html><html><head><title>Boot fixture</title></head><body><div id="root">Fixture shell</div><script>
window.__LAB_STORIES__ = ${JSON.stringify(stories)};
${
  route.searchParams.has("preview")
    ? `
window.__LAB_READY__ = false;
setTimeout(() => {
  document.getElementById('root').textContent = ${JSON.stringify(storyId)};
  window.__LAB_READY__ = true;
  ${storyId === "console-error" ? "console.error('intentional console failure');" : ""}
  ${storyId === "page-error" ? "queueMicrotask(() => { throw new Error('intentional page failure'); });" : ""}
  ${storyId === "boundary-error" ? "window.__LAB_ERROR__ = 'intentional boundary failure';" : ""}
}, 25);`
    : ""
}
</script></body></html>`;
    },
  );
  const result = await boot({
    url,
    outputDir,
    concurrency: 1,
    executablePath,
    timeout: 5_000,
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.discovery, [
    { entryId: "component/card", errors: [] },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 4);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].screenshot, "component--card--2-up.png");
  assert.match(
    result.results[1].errors.join("\n"),
    /intentional console failure/,
  );
  assert.match(result.results[2].errors.join("\n"), /intentional page failure/);
  assert.match(
    result.results[3].errors.join("\n"),
    /intentional boundary failure/,
  );
  const png = await readFile(path.join(outputDir, "component--card--2-up.png"));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8")),
    result,
  );
});
