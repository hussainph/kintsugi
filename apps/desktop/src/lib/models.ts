import { ModelRef, providers, ProviderStatus } from "./ai";
import preferences from "./models.json";

/** What a model is used for decides how fast and how strong it needs to be. */
export type Task = "edit" | "complete";

/** First usable entry wins. Edits want quality; completions want speed.
 *  Shared with Rust (`ai::model_for`), so background work picks the same model. */
const PREFERENCES: Record<Task, ModelRef[]> = preferences;

/** Mirrors `ai::usable` in src-tauri/src/ai/mod.rs. */
const usable = (p: ProviderStatus) => p.auth !== "none" && p.auth !== "unsupported_login" && p.auth !== "local";

let cached: Promise<ProviderStatus[]> | null = null;

export async function modelFor(task: Task): Promise<ModelRef> {
  cached ??= providers();
  const ready = new Set((await cached).filter(usable).map((p) => p.id));
  const model = PREFERENCES[task].find((m) => ready.has(m.provider));
  if (!model) {
    cached = null;
    throw new Error("No AI provider is set up. Run `pi`, log in or add an API key, then try again.");
  }
  return model;
}
