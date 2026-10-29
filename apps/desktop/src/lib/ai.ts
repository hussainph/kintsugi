import { Channel, invoke } from "@tauri-apps/api/core";

/** Mirrors `ai::ProviderStatus` in src-tauri/src/ai/mod.rs. */
export type ProviderStatus = {
  id: string;
  name: string;
  auth: "pi_api_key" | "pi_login" | "env" | "local" | "unsupported_login" | "none";
};

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
