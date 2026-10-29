import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EntryMeta, Control } from "../src/schema.ts";

export const fixtureMeta: EntryMeta = {
  id: "component/sample",
  title: "Sample",
  kind: "component",
  group: "writing",
  status: "idea",
  sources: ["source.tsx"],
  tickets: ["KI-15"],
  related: [],
  summary: "A local component fixture.",
};
export const fixtureControls: Record<string, Control> = {
  size: {
    type: "number",
    default: 16,
    min: 8,
    max: 32,
    step: 1,
    target: "source.tsx:fontSize",
  },
  enabled: { type: "boolean", default: true, target: "source.tsx:enabled" },
  label: { type: "text", default: "Words", target: "source.tsx:label" },
  tone: {
    type: "select",
    default: "quiet",
    options: ["quiet", "loud"],
    target: "source.tsx:tone",
  },
  ink: { type: "color", default: "#111111", target: "source.tsx:color" },
};
export function entrySource(
  meta: EntryMeta = fixtureMeta,
  controls: Record<string, Control> = fixtureControls,
): string {
  return `import { neverExecute } from './not-a-real-product-module';
throw new Error('Discovery must never execute product modules');
export const meta = ${JSON.stringify(meta, null, 2)} as const;
export const controls = ${JSON.stringify(controls, null, 2)} satisfies Record<string, Control>;
export default defineEntry({ meta, controls, stories: [{id: 'default', title: 'Default', render: () => null}],
variants: [{id:'large',title:'Large',values:{size:24}}] });\n`;
}
export async function fixture() {
  // Tests never write to the system temporary directory or a sibling checkout.
  const root = await mkdtemp(join(process.cwd(), ".lab-core-test-"));
  const directory = join(root, "entries", "component", "sample");
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, "source.tsx"), "export const source = true;\n");
  await writeFile(join(directory, "entry.tsx"), entrySource());
  return {
    root,
    entriesDir: "entries",
    directory,
    file: join(directory, "entry.tsx"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
