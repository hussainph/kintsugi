import { invoke } from "@tauri-apps/api/core";
import type { ModelRef } from "./ai";

/** What a model is used for decides how fast and how strong it needs to be. */
export type Task = "edit" | "complete";

/**
 * The model for an edit or a completion: the default chosen in Settings
 * while its provider has a credential, else the first usable entry of
 * `models.json` (shared with Rust's `ai::chosen_model`, so background work
 * picks the same way). Asked fresh each time, so a change in Settings
 * applies to the next edit.
 */
export async function modelFor(task: Task): Promise<ModelRef> {
  const model = await invoke<ModelRef | null>("ai_model_for", { task });
  if (!model) throw new Error("No AI provider is set up. Log in with OpenCode (or Pi), or add an API key, then try again.");
  return model;
}
