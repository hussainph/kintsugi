import { Channel, invoke } from "@tauri-apps/api/core";

/** Where a credential comes from: OpenCode's login, Pi's, Kintsugi's own
 *  (Settings › Providers), an environment variable, or a local server. */
export type Source = "opencode" | "pi" | "kintsugi" | "env" | "local";

/** Mirrors `ai::ProviderStatus` in src-tauri/src/ai/mod.rs. */
export type ProviderStatus = {
  id: string;
  name: string;
  /** What kind of credential, or why there's no usable one. */
  auth: "api_key" | "login" | "local" | "unsupported_login" | "expired_login" | "none" | "mock";
  source: Source | null;
};

const SOURCE: Record<string, string> = { opencode: "OpenCode login", pi: "Pi login", kintsugi: "Saved in Kintsugi", env: "environment" };

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
      if (p.id === "openai-codex") return `${from}: ChatGPT's newer sign-in, which Kintsugi can't use yet. Sign in here instead`;
      return `${from}: a Claude subscription, which Kintsugi can't use. Kintsugi uses only Anthropic API keys`;
    case "expired_login":
      if (p.source === "opencode") return "OpenCode login expired: open OpenCode once to refresh it";
      if (p.source === "kintsugi") return "Sign-in expired";
      return `${from} expired`;
    default:
      return "Not set up";
  }
}

/** Mirrors `ai::CredentialView`: a provider in Settings › Providers. No secrets. */
export type CredentialView = ProviderStatus & {
  /** What Kintsugi itself has saved for it. */
  saved: "api_key" | "oauth" | null;
  /** A key can be added. */
  apiKey: boolean;
  /** Kintsugi can sign in to it. */
  signIn: boolean;
  /** Listed without picking it first. */
  listed: boolean;
};

/** Mirrors `ai::sign_in::Event`. */
export type SignInEvent =
  | { type: "prompt"; id: number; kind: "select" | "text" | "paste"; message: string; placeholder?: string; options?: { id: string; label: string }[] }
  | { type: "auth_url"; url: string; open: boolean }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "progress"; message: string }
  | { type: "done" }
  | { type: "failed"; message: string };

/** Kintsugi's own keys and sign-ins (Settings › Providers). Keys go to Rust and never come back. */
export const credentials = {
  list: () => invoke<CredentialView[]>("ai_credentials"),
  setKey: (provider: string, key: string) => invoke<CredentialView[]>("ai_set_key", { provider, key }),
  remove: (provider: string) => invoke<CredentialView[]>("ai_remove_credential", { provider }),
  /** Starts a sign-in; `onEvent` gets its prompts and progress. Resolves with its id. */
  signIn: (provider: string, onEvent: (event: SignInEvent) => void) => {
    const events = new Channel<SignInEvent>();
    events.onmessage = onEvent;
    return invoke<string>("ai_sign_in", { provider, events });
  },
  answer: (id: string, prompt: number, value: string) => invoke<void>("ai_sign_in_answer", { id, prompt, value }),
  cancel: (id: string) => invoke<void>("ai_sign_in_cancel", { id }),
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

/** Providers Kintsugi doesn't offer, though Kin can speak to them: the owner
 *  doesn't run local models (Ollama). */
const HIDDEN = new Set(["ollama"]);
export const shown = (p: { id: string }) => !HIDDEN.has(p.id);

/** Pi's thinking levels, weakest first. A `ModelRef`'s `reasoning` is one of them. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** US dollars per million tokens. */
export type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Mirrors `ai::models::ModelInfo` in src-tauri/src/ai/models.rs. */
export type ModelInfo = {
  id: string;
  name: string;
  /** The wire format (Pi's API id), e.g. `openai-completions`. */
  api: string;
  contextWindow: number;
  maxOutput: number;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
  tools: boolean;
  images: boolean;
  /** `tiers`: the rates for a whole request whose input is over `inputTokensAbove`. */
  price: Rates & { tiers?: (Rates & { inputTokensAbove: number })[] };
};

/** Mirrors `ai::models::ProviderModels`. */
export type ProviderModels = ProviderStatus & {
  /** A request would find a credential now. */
  usable: boolean;
  /** Flat-rate or local: calls cost nothing in the ledger, whatever `price` says. */
  subscription: boolean;
  models: ModelInfo[];
};

/** The providers with a usable credential and their models; `all` lists every provider. */
export const models = (all = false) => invoke<ProviderModels[]>("ai_models", { all });

/** The same model, whatever its thinking level. */
export const sameEntry = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) =>
  !!a && !!b && a.provider === b.provider && a.model === b.model;

/** A model's catalog entry, while its provider is listed. */
export function modelInfo(list: ProviderModels[] | null, m: ModelRef | null | undefined): ModelInfo | null {
  if (!m) return null;
  return list?.find((p) => p.id === m.provider)?.models.find((x) => x.id === m.model) ?? null;
}

/** The levels an effort control offers for a model: none unless it thinks
 *  and has more than one. */
export function effortLevels(model: ModelInfo | null): ThinkingLevel[] {
  return model?.reasoning && model.thinkingLevels.length > 1 ? model.thinkingLevels : [];
}

const LEVEL_NAMES: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};
export const levelName = (level: ThinkingLevel) => LEVEL_NAMES[level];

/** A model's name from the catalog, else its id. */
export function modelName(list: ProviderModels[] | null, m: ModelRef): string {
  return list?.find((p) => p.id === m.provider)?.models.find((x) => x.id === m.model)?.name ?? m.model;
}

/** US dollars per million tokens, input and output: "$0.40 · $1.60". */
export function priceLabel(p: Rates): string {
  const usd = (n: number) => (n === 0 ? "$0" : n < 1 ? `$${n.toFixed(2)}` : `$${n % 1 ? n.toFixed(2) : n}`);
  return p.input === 0 && p.output === 0 ? "Free" : `${usd(p.input)} · ${usd(p.output)}`;
}

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
