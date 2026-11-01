import { Channel, invoke } from "@tauri-apps/api/core";
import type { ModelRef } from "./ai";

/** Mirrors `ai::Task::KIN` in src-tauri/src/ai/mod.rs. */
export type KinTask = "chat" | "ideas" | "triage";

/** Mirrors `wire::Usage`. */
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Mirrors `agent::Summary`. */
export type Summary = {
  text: string;
  stop: "answered" | "cancelled" | "capReached" | "stepLimit";
  steps: number;
  toolCalls: number;
  usage: Usage;
  usd: number;
  model: string;
  capReached: boolean;
};

/** Mirrors `agent::KinEvent`. */
export type KinEvent =
  | { type: "text"; delta: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "toolResult"; id: string; isError: boolean; preview: string }
  | { type: "step"; step: number; usage: Usage; usd: number }
  | { type: "done"; summary: Summary }
  | { type: "error"; message: string };

/** Something on screen, passed as a reference Kin reads on demand. */
export type Chip = { kind: string; path: string; label?: string };

/** Mirrors `cost::Report`. */
export type UsageReport = {
  month: string;
  spentUsd: number;
  capUsd: number | null;
  capReached: boolean;
  estimated: boolean;
  byTask: { task: string; usd: number; calls: number; usage: Usage }[];
  ledger: string | null;
};

/** Mirrors `kin::SettingsView`. */
export type KinSettings = {
  capUsd: number | null;
  tasks: {
    task: KinTask;
    chosen: ModelRef | null;
    resolved: ModelRef | null;
    options: (ModelRef & { usable: boolean })[];
  }[];
};

export type Ask = { question: string; task?: KinTask; background?: boolean; context?: Chip[] };

/** Runs one Kin turn. Events stream to `onEvent`; `done` settles with the
 *  summary, or rejects with the turn's error. `cancel` stops it early. */
export function ask(request: Ask, onEvent: (event: KinEvent) => void) {
  const id = crypto.randomUUID();
  const channel = new Channel<KinEvent>();
  let settle: { resolve: (summary: Summary) => void; reject: (error: Error) => void };
  const done = new Promise<Summary>((resolve, reject) => (settle = { resolve, reject }));
  channel.onmessage = (event) => {
    onEvent(event);
    if (event.type === "done") settle.resolve(event.summary);
    else if (event.type === "error") settle.reject(new Error(event.message));
  };
  invoke("kin_turn", { turn: { id, ...request }, onEvent: channel }).catch((e) => settle.reject(new Error(String(e))));
  return { done, cancel: () => invoke("kin_cancel", { id }) };
}

export const kin = {
  usage: () => invoke<UsageReport>("kin_usage"),
  settings: () => invoke<KinSettings>("kin_settings"),
  setCap: (capUsd: number | null) => invoke<UsageReport>("kin_set_cap", { capUsd }),
  setModel: (task: KinTask, model: ModelRef | null) => invoke<KinSettings>("kin_set_model", { task, model }),
};

export const sameModel = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) =>
  !!a && !!b && a.provider === b.provider && a.model === b.model && (a.reasoning ?? null) === (b.reasoning ?? null);

export const modelLabel = (m: ModelRef) => `${m.provider} · ${m.model}${m.reasoning ? ` (${m.reasoning})` : ""}`;

export const dollars = (usd: number) =>
  usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;

/** Opens Settings or the Kin developer panel from anywhere. */
export const openSettings = () => window.dispatchEvent(new CustomEvent("kintsugi:open-settings"));
export const openKinDev = () => window.dispatchEvent(new CustomEvent("kintsugi:open-kin-dev"));
