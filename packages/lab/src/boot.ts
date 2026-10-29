import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

export interface StoryReference {
  entryId: string;
  storyId: string;
}
export interface BootOptions {
  /** An already running loopback Lab server. This tool never starts a native app/server. */
  url: string;
  outputDir?: string;
  concurrency?: number;
  executablePath?: string;
  timeout?: number;
}
export interface BootResult extends StoryReference {
  url: string;
  screenshot?: string;
  errors: string[];
  ok: boolean;
}
export interface BootManifest {
  version: 1;
  url: string;
  startedAt: string;
  finishedAt: string;
  concurrency: number;
  executablePath?: string;
  entries: number;
  results: BootResult[];
  discovery: Array<{ entryId: string; errors: string[] }>;
  errors: string[];
  ok: boolean;
}

interface CatalogEntry {
  id: string;
  stories?: string[];
}
interface LabWindow extends Window {
  __LAB_STORIES__?: StoryReference[];
  /** Set false before async rendering, true after the chosen story mounts. */
  __LAB_READY__?: boolean;
  __LAB_ERROR__?: string;
}

const segment = "[a-z0-9]+(?:-[a-z0-9]+)*";
const entryPattern = new RegExp(`^${segment}/${segment}$`);
const storyPattern = new RegExp(`^${segment}$`);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** An explicit worker request can lower, but never exceed, the shared machine's hint. */
export function bootConcurrency(
  requested?: number,
  hint = process.env.VOLLI_CONCURRENCY_HINT,
): number {
  const available = hint === undefined ? 1 : Number(hint);
  if (!Number.isInteger(available) || available < 1)
    throw new Error("VOLLI_CONCURRENCY_HINT must be a positive integer");
  if (
    requested !== undefined &&
    (!Number.isInteger(requested) || requested < 1)
  )
    throw new Error("Concurrency must be a positive integer");
  return Math.min(requested ?? available, available);
}

function catalogEntries(value: unknown): CatalogEntry[] {
  if (!Array.isArray(value) || !value.length)
    throw new Error("/__lab/catalog must return a nonempty array");
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object")
      throw new Error("Invalid catalog entry");
    const entry = item as {
      id?: unknown;
      meta?: { id?: unknown };
      stories?: unknown;
    };
    const id = entry.meta?.id ?? entry.id;
    if (typeof id !== "string" || !entryPattern.test(id))
      throw new Error(`Invalid catalog entry id: ${String(id)}`);
    if (seen.has(id)) throw new Error(`Duplicate catalog entry: ${id}`);
    seen.add(id);
    let stories: string[] | undefined;
    if (entry.stories !== undefined) {
      if (!Array.isArray(entry.stories))
        throw new Error(`Invalid story list for ${id}`);
      stories = entry.stories
        .map((story: unknown) =>
          typeof story === "string"
            ? story
            : (story as { id?: unknown } | null)?.id,
        )
        .map((story) => {
          if (typeof story !== "string" || !storyPattern.test(story))
            throw new Error(`Invalid story id for ${id}: ${String(story)}`);
          return story;
        });
      if (new Set(stories).size !== stories.length)
        throw new Error(`Duplicate stories for ${id}`);
    }
    return { id, stories };
  });
}

async function browserExecutable(explicit?: string): Promise<string> {
  const installed = chromium.executablePath();
  const candidates = explicit
    ? [explicit]
    : [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        installed,
        // Existing Chrome is driven through Playwright with headless:true, never opened as an app.
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try the next known executable. */
    }
  }
  throw new Error(
    `No Chromium executable found. Install Playwright Chromium (pnpm exec playwright install chromium) or pass --executable <path>. Expected ${installed}`,
  );
}

async function workers<T, R>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]);
      }
    }),
  );
  return results;
}

function observeErrors(page: Page, errors: string[]): void {
  page.on("pageerror", (error) =>
    errors.push(`page: ${error.stack ?? error.message}`),
  );
  page.on("console", (event) => {
    if (event.type() !== "error") return;
    const location = event.location();
    errors.push(
      `console: ${event.text()}${location.url ? ` (${location.url}:${location.lineNumber + 1})` : ""}`,
    );
  });
  page.on("response", (response) => {
    if (
      response.status() >= 400 &&
      ["document", "script", "stylesheet"].includes(
        response.request().resourceType(),
      )
    )
      errors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
}

function route(
  base: URL,
  key: "entry" | "preview",
  id: string,
  story?: string,
): string {
  const url = new URL(base);
  url.search = "";
  url.hash = "";
  url.searchParams.set(key, id);
  if (story) url.searchParams.set("story", story);
  return url.href;
}

async function settled(
  page: Page,
  timeout: number,
  preview = false,
): Promise<void> {
  // Preview readiness is explicit: mounting a shell/loading placeholder is not a story boot.
  await page.waitForFunction(
    (required) => {
      const lab = window as LabWindow;
      return (
        Boolean(lab.__LAB_ERROR__) ||
        (required ? lab.__LAB_READY__ === true : lab.__LAB_READY__ !== false)
      );
    },
    preview,
    { timeout },
  );
  const error = await page.evaluate(() => (window as LabWindow).__LAB_ERROR__);
  if (error) throw new Error(`Lab error boundary: ${error}`);
  await page.waitForFunction(
    () => {
      const root = document.getElementById("root");
      return root
        ? root.childNodes.length > 0
        : document.body.childNodes.length > 0;
    },
    undefined,
    { timeout },
  );
  await page.waitForFunction(
    () => document.fonts.status === "loaded",
    undefined,
    { timeout },
  );
  // Allow lazy modules, media and short fixture search timers to settle before capture.
  // A permanently active transport should declare its own fixture, not mask boot failures.
  await page.waitForLoadState("networkidle", { timeout });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  if (await page.locator("vite-error-overlay").count())
    throw new Error("Vite error overlay is visible");
}

/** Boot all discovered stories in headless Chromium; always emit manifest.json, even on failure. */
export async function boot(options: BootOptions): Promise<BootManifest> {
  const outputDir = path.resolve(options.outputDir ?? ".lab-artifacts");
  await mkdir(outputDir, { recursive: true });
  const manifest: BootManifest = {
    version: 1,
    url: options.url,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    concurrency: 1,
    entries: 0,
    results: [],
    discovery: [],
    errors: [],
    ok: false,
  };
  let browser: Browser | undefined;
  try {
    const base = new URL(options.url);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
      base.username ||
      base.password
    )
      throw new Error(
        "Lab boot requires an unauthenticated loopback HTTP(S) URL",
      );
    const timeout = options.timeout ?? 20_000;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error("Timeout must be positive");
    manifest.concurrency = bootConcurrency(options.concurrency);
    const response = await fetch(new URL("/__lab/catalog", base), {
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok)
      throw new Error(`Catalog request failed: HTTP ${response.status}`);
    const catalog = catalogEntries(await response.json());
    manifest.entries = catalog.length;
    manifest.executablePath = await browserExecutable(options.executablePath);
    browser = await chromium.launch({
      executablePath: manifest.executablePath,
      headless: true,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    const launched = browser;
    const discovered = await workers(
      catalog,
      manifest.concurrency,
      async (entry) => {
        const errors: string[] = [];
        const context = await launched.newContext({
          viewport: { width: 1440, height: 1000 },
          deviceScaleFactor: 1,
          colorScheme: "light",
        });
        const page = await context.newPage();
        page.setDefaultTimeout(timeout);
        observeErrors(page, errors);
        let stories: StoryReference[] = [];
        try {
          const response = await page.goto(route(base, "entry", entry.id), {
            waitUntil: "load",
            timeout,
          });
          if (!response?.ok())
            throw new Error(
              `Shell navigation failed: HTTP ${response?.status() ?? "no response"}`,
            );
          if (entry.stories === undefined)
            await page.waitForFunction(
              () => Array.isArray((window as LabWindow).__LAB_STORIES__),
              undefined,
              { timeout },
            );
          const runtime = await page.evaluate(
            () => (window as LabWindow).__LAB_STORIES__,
          );
          if (runtime !== undefined) {
            if (!Array.isArray(runtime))
              throw new Error("window.__LAB_STORIES__ must be an array");
            const seen = new Set<string>();
            for (const story of runtime) {
              if (
                !story ||
                !catalog.some((item) => item.id === story.entryId) ||
                typeof story.storyId !== "string" ||
                !storyPattern.test(story.storyId)
              )
                throw new Error("Invalid runtime story reference");
              const key = `${story.entryId}:${story.storyId}`;
              if (seen.has(key))
                throw new Error(`Duplicate runtime story: ${key}`);
              seen.add(key);
              if (story.entryId === entry.id) stories.push(story);
            }
          } else
            stories = (entry.stories ?? []).map((storyId) => ({
              entryId: entry.id,
              storyId,
            }));
          if (!stories.length)
            throw new Error(`No runtime stories discovered for ${entry.id}`);
          if (
            entry.stories &&
            (entry.stories.length !== stories.length ||
              entry.stories.some(
                (id) => !stories.some((story) => story.storyId === id),
              ))
          )
            throw new Error(`Catalog/runtime stories disagree for ${entry.id}`);
          await settled(page, timeout);
        } catch (error) {
          errors.push(message(error));
        } finally {
          await context.close();
        }
        manifest.discovery.push({ entryId: entry.id, errors });
        return stories;
      },
    );
    const stories = discovered.flat();
    manifest.results = await workers(
      stories,
      manifest.concurrency,
      async (story) => {
        const result: BootResult = {
          ...story,
          url: route(base, "preview", story.entryId, story.storyId),
          errors: [],
          ok: false,
        };
        const context = await launched.newContext({
          viewport: { width: 1440, height: 1000 },
          deviceScaleFactor: 1,
          colorScheme: "light",
        });
        const page = await context.newPage();
        page.setDefaultTimeout(timeout);
        observeErrors(page, result.errors);
        try {
          const response = await page.goto(result.url, {
            waitUntil: "load",
            timeout,
          });
          if (!response?.ok())
            throw new Error(
              `Preview navigation failed: HTTP ${response?.status() ?? "no response"}`,
            );
          await settled(page, timeout, true);
          const filename = `${story.entryId.replace("/", "--")}--${story.storyId}.png`;
          await page.screenshot({
            path: path.join(outputDir, filename),
            fullPage: true,
            animations: "disabled",
            timeout,
          });
          result.screenshot = filename;
          const error = await page.evaluate(
            () => (window as LabWindow).__LAB_ERROR__,
          );
          if (error) result.errors.push(`Lab error boundary: ${error}`);
        } catch (error) {
          result.errors.push(message(error));
        } finally {
          await context.close();
        }
        result.ok =
          result.errors.length === 0 && result.screenshot !== undefined;
        return result;
      },
    );
    if (!manifest.results.length)
      manifest.errors.push("No stories were booted");
  } catch (error) {
    manifest.errors.push(message(error));
  } finally {
    try {
      await browser?.close();
    } catch (error) {
      manifest.errors.push(`Browser shutdown: ${message(error)}`);
    }
    manifest.discovery.sort((a, b) => a.entryId.localeCompare(b.entryId));
    manifest.finishedAt = new Date().toISOString();
    manifest.ok =
      manifest.errors.length === 0 &&
      manifest.discovery.every((entry) => entry.errors.length === 0) &&
      manifest.results.length > 0 &&
      manifest.results.every((result) => result.ok);
    await writeFile(
      path.join(outputDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  return manifest;
}

async function main(args: string[]): Promise<void> {
  const options: BootOptions = { url: "http://127.0.0.1:4315" };
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === "--help" || argument === "-h") {
      console.log(
        "tsx src/boot.ts [--url http://127.0.0.1:4315] [--out .lab-artifacts] [--workers N] [--executable /path/to/chromium] [--timeout MS]\nRequires an already running Lab server. Always launches headless Chromium; never starts a native UI.",
      );
      return;
    }
    if (
      !["--url", "--out", "--workers", "--executable", "--timeout"].includes(
        argument,
      )
    )
      throw new Error(`Unknown argument: ${argument}`);
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${argument}`);
    if (argument === "--url") options.url = value;
    else if (argument === "--out") options.outputDir = value;
    else if (argument === "--workers") options.concurrency = Number(value);
    else if (argument === "--executable") options.executablePath = value;
    else options.timeout = Number(value);
  }
  const manifest = await boot(options);
  for (const error of manifest.errors) console.error(error);
  for (const entry of manifest.discovery)
    for (const error of entry.errors)
      console.error(`${entry.entryId} shell: ${error}`);
  for (const result of manifest.results) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"} ${result.entryId}/${result.storyId}${result.screenshot ? ` → ${result.screenshot}` : ""}`,
    );
    for (const error of result.errors) console.error(error);
  }
  console.log(
    `${manifest.results.filter((result) => result.ok).length}/${manifest.results.length} stories passed; manifest: ${path.resolve(options.outputDir ?? ".lab-artifacts", "manifest.json")}`,
  );
  if (!manifest.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
