import { Channel, invoke } from "@tauri-apps/api/core";

/** Mirrors `ai::ProviderStatus` in src-tauri/src/ai/mod.rs. */
export type ProviderStatus = {
  id: string;
  name: string;
  /** What kind of credential, or why there's no usable one. */
  auth: "api_key" | "login" | "local" | "unsupported_login" | "expired_login" | "none" | "mock";
  /** Where it comes from: OpenCode's login, Pi's, an environment variable. */
  source: "opencode" | "pi" | "env" | "local" | null;
};

const SOURCE: Record<string, string> = { opencode: "OpenCode login", pi: "Pi login", env: "environment" };

/** Where a provider's credential comes from, in a few words for Settings. */
export function credentialLabel(p: ProviderStatus): string {
  const from = p.source ? SOURCE[p.source] ?? "" : "";
  switch (p.auth) {
    case "api_key":
      return p.source === "env" ? "API key from the environment" : `${from} · API key`;
    case "login":
      return `${from} · signed in`;
    case "local":
      return "On this Mac, no key needed";
    case "mock":
      return "Scripted mock model";
    case "unsupported_login":
      if (p.id === "openai-codex") return `${from}: ChatGPT's newer sign-in, which Kintsugi can't use yet. Use the ChatGPT browser login`;
      return `${from}: a Claude subscription, which Kintsugi can't use. Kintsugi uses only Anthropic API keys`;
    case "expired_login":
      return p.source === "opencode" ? "OpenCode login expired: open OpenCode once to refresh it" : `${from} expired`;
    default:
      return "Not set up";
  }
}

export type ModelRef = { provider: string; model: string; reasoning?: string };
export type Message = { role: "user" | "assistant"; content: string };

export type Ask = {
  system: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
};

type Event =
  | { type: "delta"; text: string }
  | { type: "done"; stopReason: string | null }
  | { type: "error"; message: string };

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export const providers = () => invoke<ProviderStatus[]>("ai_providers");

/** Streams one completion. `onText` gets the whole text so far on every
 *  delta; `done` resolves with the final text, or rejects with `Cancelled`. */
export function stream(model: ModelRef, ask: Ask, onText: (text: string) => void) {
  const id = crypto.randomUUID();
  const channel = new Channel<Event>();
  let text = "";
  let settle: { resolve: (text: string) => void; reject: (error: Error) => void };
  const done = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));

  channel.onmessage = (event) => {
    if (event.type === "delta") {
      text += event.text;
      onText(text);
    } else if (event.type === "done") {
      settle.resolve(text);
    } else {
      settle.reject(new Error(event.message));
    }
  };
  invoke("ai_stream", {
    request: { id, provider: model.provider, model: model.model, reasoning: model.reasoning, ...ask },
    onEvent: channel,
  }).catch((e) => settle.reject(new Error(String(e))));

  return {
    done,
    cancel() {
      invoke("ai_cancel", { id });
      settle.reject(new Cancelled());
    },
  };
}
