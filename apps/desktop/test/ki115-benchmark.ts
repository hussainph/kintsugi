// Scratch-only, scripted model; never a provider or the owner's vault.
// Run before/after with: node test/ki115-benchmark.ts baseline|after
// Mock-reported tokens are synthetic zeros, NOT provider token measurements.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { startApp, openApp, type App } from "./headless-app.ts";

export const PARAGRAPH_PATH = "drafts/ki115-paragraph.md";
export const MEMORY_PATH = "drafts/ki115-memory.md";
export const END = "The final sentence keeps café, 東京, and **every mark** intact.";
export const PARAGRAPH = "It is really important to keep the full paragraph. " + "Every useful detail stays visible, even on a long physical line. ".repeat(9) + END;
const MEMORY = "# Memory\n\nThe original opening asks whether this argument is clear.\n\n" + "A supporting paragraph keeps the source material available.\n\n".repeat(400);

type Chip = { kind: string; path: string; lines?: [number, number] };
type Entry = { seq: number; role: string; text: string; error?: string; ms?: number; tools?: { name: string; arguments: unknown }[] };
type Sent = { thread: { id: string }; entry: Entry };
type Charge = { usage: { input: number; output: number; cacheRead: number; cacheWrite: number } };
export type Measurement = {
  scenario: string; turn: number; reads: number; toolCalls: number; modelCalls: number;
  tokens: Charge["usage"]; tokenKind: "synthetic mock-reported zeros";
  latencyMs: number; wallMs: number; text: string;
};

const invoke = <T>(page: Page, cmd: string, args: unknown) => page.evaluate(
  ([cmd, args]) => (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(cmd, args),
  [cmd, args] as const,
) as Promise<T>;
const jsonl = <T>(file: string): T[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s)) : [];

export async function measureMemory(label: string) {
  let app: App | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const measurements: Measurement[] = [];
  try {
    app = await startApp(`ki115-${label}`, { KINTSUGI_HEADLESS_KIN: "mock" }, (vault) => {
      // These names are new; refuse to replace a seed or concurrent writer's file.
      writeFileSync(resolve(vault, PARAGRAPH_PATH), `# Paragraph\n\n${PARAGRAPH}\n`, { flag: "wx" });
      writeFileSync(resolve(vault, MEMORY_PATH), MEMORY, { flag: "wx" });
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await openApp(page, app.url, app.output);
    const ledger = resolve(app.config, "kin/usage.jsonl");
    async function ask(scenario: string, turn: number, text: string, chips: Chip[], thread?: string) {
      const start = Date.now();
      const chargesBefore = jsonl<Charge>(ledger).length;
      const sent = await invoke<Sent>(page, "kin_thread_send", { thread, text, chips });
      const file = resolve(app!.vault, `.kintsugi/kin/threads/${sent.thread.id}.jsonl`);
      let answer: Entry | undefined;
      while (Date.now() - start < 90_000) {
        answer = jsonl<Entry>(file).find((entry) => entry.seq > sent.entry.seq && entry.role === "kin");
        if (answer) break;
        await page.waitForTimeout(100);
      }
      assert.ok(answer, `${scenario} turn ${turn}: no answer; ${app!.output().slice(-1500)}`);
      assert.ok(!answer.error, answer.error);
      const charges = jsonl<Charge>(ledger).slice(chargesBefore);
      const tokens = charges.reduce((sum, charge) => ({ input: sum.input + charge.usage.input, output: sum.output + charge.usage.output, cacheRead: sum.cacheRead + charge.usage.cacheRead, cacheWrite: sum.cacheWrite + charge.usage.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      const tools = answer.tools ?? [];
      measurements.push({ scenario, turn, reads: tools.filter((t) => t.name === "read").length, toolCalls: tools.length, modelCalls: charges.length, tokens, tokenKind: "synthetic mock-reported zeros", latencyMs: answer.ms ?? 0, wallMs: Date.now() - start, text: answer.text });
      return sent.thread.id;
    }
    const paragraphChip: Chip[] = [{ kind: "paragraph", path: PARAGRAPH_PATH, lines: [3, 3] }];
    const paragraphThread = await ask("paragraph", 1, "Tighten this paragraph.", paragraphChip);
    await ask("paragraph", 2, "better?", paragraphChip, paragraphThread);
    const docChip: Chip[] = [{ kind: "doc", path: MEMORY_PATH }];
    const memoryThread = await ask("document", 1, "Is this argument clear?", docChip);
    await ask("document", 2, "better?", docChip, memoryThread);
    // Change the scratch document, then ask the same question. Do not touch owner data.
    writeFileSync(resolve(app.vault, MEMORY_PATH), MEMORY.replace("The original opening", "The revised opening"));
    await ask("document", 3, "better?", docChip, memoryThread);
    await page.screenshot({ path: resolve(app.shots, "memory.png") });
    const report = { label, scratch: app.scratch, mock: true, note: "Token counts are synthetic mock-reported zeros; latency includes scripted word delays. No real model, tokenizer, or cost comparison.", measurements };
    const file = resolve(app.scratch, "metrics.json");
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ file, ...report }, null, 2));
    return report;
  } finally {
    await browser?.close();
    await app?.stop();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await measureMemory(process.argv[2] ?? "after");
}
