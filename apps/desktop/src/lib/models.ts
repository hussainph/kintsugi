import { ModelRef, providers, ProviderStatus } from "./ai";

/** What a model is used for decides how fast and how strong it needs to be. */
export type Task = "edit" | "complete";

/** First usable entry wins. Edits want quality; completions want speed. */
const PREFERENCES: Record<Task, ModelRef[]> = {
  edit: [
    { provider: "openai-codex", model: "gpt-6-luna", reasoning: "low" },
    { provider: "anthropic", model: "claude-sonnet-5-5" },
    { provider: "zai", model: "glm-5.3" },
    { provider: "openrouter", model: "~anthropic/claude-haiku-latest" },
  ],
  complete: [
    { provider: "zai", model: "glm-5.3-flash" },
    { provider: "anthropic", model: "claude-haiku-5-5" },
    { provider: "openrouter", model: "~google/gemini-flash-latest" },
    { provider: "openai-codex", model: "gpt-6-luna", reasoning: "none" },
  ],
};

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
