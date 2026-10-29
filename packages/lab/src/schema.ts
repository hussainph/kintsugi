import type { ReactNode } from "react";

export const kinds = [
  "foundation",
  "component",
  "pattern",
  "page",
  "experiment",
] as const;
export const statuses = [
  "idea",
  "exploring",
  "refining",
  "ready",
  "shipped",
  "archived",
] as const;
export type Kind = (typeof kinds)[number];
export type Status = (typeof statuses)[number];
export type Scalar = string | number | boolean;
export type Values = Record<string, Scalar>;
export interface Scenario {
  theme: "light" | "dark";
  width: number;
  textScale: number;
  reducedMotion: boolean;
  density: "comfortable" | "compact";
}
export const defaultScenario: Readonly<Scenario> = Object.freeze({
  theme: "light",
  width: 1280,
  textScale: 1,
  reducedMotion: false,
  density: "comfortable",
});
export interface Control {
  type: "number" | "boolean" | "text" | "select" | "color";
  default: Scalar;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  target: string;
}
export interface EntryMeta {
  id: string;
  title: string;
  kind: Kind;
  group: string;
  status: Status;
  sources: string[];
  tickets: string[];
  related: string[];
  summary: string;
  question?: string;
}
export interface StoryContext {
  scenario: Scenario;
  values: Values;
}
export interface Entry {
  meta: EntryMeta;
  controls: Record<string, Control>;
  stories: Array<{
    id: string;
    title: string;
    render: (context: StoryContext) => ReactNode;
  }>;
  variants?: Array<{ id: string; title: string; values: Values }>;
}
export interface RegistryRecord {
  meta: EntryMeta;
  controls: Record<string, Control>;
}
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
export function fail(message: string): never {
  throw new ValidationError(message);
}
export function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${label}: unknown field ${key}`);
}
export function text(value: unknown, label: string, max = 4000): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  ) {
    fail(`${label} must be nonempty text (at most ${max} characters)`);
  }
  return value;
}
export function isSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 100 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}
export function validateEntryId(value: unknown): string {
  if (typeof value !== "string") fail("entry id must be kind/slug");
  const parts = value.split("/");
  if (
    parts.length !== 2 ||
    !kinds.includes(parts[0] as Kind) ||
    !isSlug(parts[1])
  )
    fail(`Invalid entry id: ${value}`);
  return value;
}
export function validateStatus(value: unknown): Status {
  if (!statuses.includes(value as Status))
    fail(`Invalid status: ${String(value)}`);
  return value as Status;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 1000)
    fail(`${label} must be an array`);
  const result = value.map((item) => text(item, label, 1000));
  if (new Set(result).size !== result.length)
    fail(`${label} contains duplicates`);
  return result;
}
export function validateMeta(value: unknown): EntryMeta {
  const m = object(value, "meta");
  exactKeys(
    m,
    [
      "id",
      "title",
      "kind",
      "group",
      "status",
      "sources",
      "tickets",
      "related",
      "summary",
      "question",
    ],
    "meta",
  );
  const id = validateEntryId(m.id);
  if (!kinds.includes(m.kind as Kind) || id.split("/")[0] !== m.kind)
    fail(`${id}: kind must match id`);
  if (!isSlug(m.group)) fail(`${id}: group must be kebab-case`);
  const result: EntryMeta = {
    id,
    title: text(m.title, `${id}.title`, 200),
    kind: m.kind as Kind,
    group: m.group,
    status: validateStatus(m.status),
    sources: strings(m.sources, `${id}.sources`),
    tickets: strings(m.tickets, `${id}.tickets`),
    related: strings(m.related, `${id}.related`),
    summary: text(m.summary, `${id}.summary`),
  };
  for (const source of result.sources) {
    if (
      source.startsWith("/") ||
      source.includes("\\") ||
      source
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      /^[A-Za-z]:/.test(source)
    ) {
      fail(`${id}: source must be a workspace-relative file: ${source}`);
    }
  }
  for (const related of result.related) validateEntryId(related);
  if (m.question !== undefined)
    result.question = text(m.question, `${id}.question`);
  if (m.kind === "experiment" && !result.question)
    fail(`${id}: experiments require a question`);
  return result;
}
export function validateControls(value: unknown): Record<string, Control> {
  const input = object(value, "controls");
  if (Object.keys(input).length > 100)
    fail("At most 100 controls are supported");
  const result: Record<string, Control> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key) ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      fail(`Invalid control name: ${key}`);
    const c = object(raw, `control ${key}`);
    exactKeys(
      c,
      ["type", "default", "min", "max", "step", "options", "target"],
      `control ${key}`,
    );
    if (
      !["number", "boolean", "text", "select", "color"].includes(
        c.type as string,
      )
    )
      fail(`${key}: invalid control type`);
    text(c.target, `${key}.target`, 1000);
    for (const field of ["min", "max", "step"] as const) {
      if (
        c[field] !== undefined &&
        (c.type !== "number" ||
          typeof c[field] !== "number" ||
          !Number.isFinite(c[field]))
      )
        fail(`${key}.${field} must be a finite number on a number control`);
    }
    if (typeof c.step === "number" && c.step <= 0)
      fail(`${key}.step must be positive`);
    if (typeof c.min === "number" && typeof c.max === "number" && c.min > c.max)
      fail(`${key}: min exceeds max`);
    if (c.type === "select") {
      const options = strings(c.options, `${key}.options`);
      if (!options.length) fail(`${key}: select needs options`);
    } else if (c.options !== undefined)
      fail(`${key}: only select controls have options`);
    validateControlValue(c as unknown as Control, c.default, key);
    result[key] = { ...c } as unknown as Control;
  }
  return result;
}
export function validateControlValue(
  control: Control,
  value: unknown,
  label: string,
): Scalar {
  if (control.type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (control.min !== undefined && value < control.min) ||
      (control.max !== undefined && value > control.max)
    )
      fail(`${label}: number outside control bounds`);
  } else if (control.type === "boolean") {
    if (typeof value !== "boolean") fail(`${label}: expected boolean`);
  } else {
    if (
      typeof value !== "string" ||
      value.length > 10000 ||
      value.includes("\0")
    )
      fail(`${label}: expected text`);
    if (control.type === "select" && !control.options?.includes(value))
      fail(`${label}: not a select option`);
    if (control.type === "color" && !value.trim())
      fail(`${label}: expected a color`);
  }
  return value as Scalar;
}
export function validateValues(
  value: unknown,
  controls?: Record<string, Control>,
): Values {
  const input = object(value, "values");
  if (Object.keys(input).length > 100) fail("At most 100 values are supported");
  const result: Values = {};
  for (const [key, item] of Object.entries(input)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key) ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      fail(`Invalid value name: ${key}`);
    if (controls) {
      if (!Object.hasOwn(controls, key)) fail(`Unknown control: ${key}`);
      result[key] = validateControlValue(controls[key], item, key);
    } else {
      if (
        !["string", "number", "boolean"].includes(typeof item) ||
        (typeof item === "number" && !Number.isFinite(item)) ||
        (typeof item === "string" &&
          (item.length > 10000 || item.includes("\0")))
      )
        fail(`${key}: invalid scalar value`);
      result[key] = item as Scalar;
    }
  }
  return result;
}
export function defaultValues(controls: Record<string, Control>): Values {
  return Object.fromEntries(
    Object.entries(controls).map(([key, control]) => [key, control.default]),
  );
}
export function validateScenario(value: unknown): Scenario {
  const s = object(value, "scenario");
  exactKeys(
    s,
    ["theme", "width", "textScale", "reducedMotion", "density"],
    "scenario",
  );
  if (s.theme !== "light" && s.theme !== "dark")
    fail("scenario.theme must be light or dark");
  if (
    typeof s.width !== "number" ||
    !Number.isInteger(s.width) ||
    s.width < 240 ||
    s.width > 7680
  )
    fail("scenario.width must be an integer from 240 to 7680");
  if (
    typeof s.textScale !== "number" ||
    !Number.isFinite(s.textScale) ||
    s.textScale < 0.5 ||
    s.textScale > 3
  )
    fail("scenario.textScale must be from 0.5 to 3");
  if (typeof s.reducedMotion !== "boolean")
    fail("scenario.reducedMotion must be boolean");
  if (s.density !== "comfortable" && s.density !== "compact")
    fail("scenario.density must be comfortable or compact");
  return {
    theme: s.theme,
    width: s.width,
    textScale: s.textScale,
    reducedMotion: s.reducedMotion,
    density: s.density,
  };
}
export function defineEntry<const T extends Entry>(entry: T): T {
  const e = object(entry, "entry");
  exactKeys(e, ["meta", "controls", "stories", "variants"], "entry");
  validateMeta(entry.meta);
  validateControls(entry.controls);
  if (!Array.isArray(entry.stories) || !entry.stories.length)
    fail(`${entry.meta.id}: needs at least one story`);
  const storyIds = new Set<string>();
  for (const story of entry.stories) {
    object(story, "story");
    exactKeys(
      story as unknown as Record<string, unknown>,
      ["id", "title", "render"],
      "story",
    );
    if (!isSlug(story.id) || storyIds.has(story.id))
      fail(`${entry.meta.id}: invalid or duplicate story id ${story.id}`);
    storyIds.add(story.id);
    text(story.title, "story.title", 200);
    if (typeof story.render !== "function")
      fail(`${story.id}: story.render must be a function`);
  }
  if (entry.variants !== undefined) {
    if (!Array.isArray(entry.variants)) fail("variants must be an array");
    const ids = new Set<string>();
    for (const variant of entry.variants) {
      object(variant, "variant");
      exactKeys(
        variant as unknown as Record<string, unknown>,
        ["id", "title", "values"],
        "variant",
      );
      if (!isSlug(variant.id) || ids.has(variant.id))
        fail(`Invalid or duplicate variant id ${variant.id}`);
      ids.add(variant.id);
      text(variant.title, "variant.title", 200);
      validateValues(variant.values, entry.controls);
    }
  }
  return entry;
}
/** Validates both runtime entry modules and the AST-only metadata registry. */
export function validateRegistry<T extends RegistryRecord>(
  entries: readonly T[],
): readonly T[] {
  if (!Array.isArray(entries)) fail("Registry must be an array");
  const ids = new Set<string>();
  for (const entry of entries) {
    validateMeta(entry.meta);
    validateControls(entry.controls);
    if ("stories" in entry) defineEntry(entry as unknown as Entry);
    if (ids.has(entry.meta.id)) fail(`Duplicate entry id: ${entry.meta.id}`);
    ids.add(entry.meta.id);
  }
  for (const { meta } of entries)
    for (const id of meta.related) {
      if (id === meta.id) fail(`${meta.id}: cannot relate an entry to itself`);
      if (!ids.has(id)) fail(`${meta.id}: related entry does not exist: ${id}`);
    }
  return entries;
}

/** History is immutable evidence; reconcile old settings only at the preview boundary. */
export function reconcileValues(
  saved: Values,
  controls: Record<string, Control>,
): { values: Values; issues: string[] } {
  const values = defaultValues(controls);
  const issues: string[] = [];
  for (const [key, value] of Object.entries(saved)) {
    if (!Object.hasOwn(controls, key)) {
      issues.push(`${key} was removed`);
      continue;
    }
    try {
      values[key] = validateControlValue(controls[key], value, key);
    } catch {
      issues.push(`${key} no longer matches its control`);
    }
  }
  return { values, issues };
}
