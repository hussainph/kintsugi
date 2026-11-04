import { Channel, invoke } from "@tauri-apps/api/core";
import type { ModelRef, ThinkingLevel } from "./ai";
import type { Chip } from "./chips";
import type { WebCall } from "./web";

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
  | { type: "toolResult"; id: string; isError: boolean; preview: string; web?: WebCall }
  | { type: "step"; step: number; usage: Usage; usd: number; stopReason: string | null; textChars: number }
  | { type: "done"; summary: Summary }
  | { type: "error"; message: string };

/** Something on screen, passed as a reference Kin reads on demand. */
export type { Chip } from "./chips";

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

/** Every task with a default model in Settings. Mirrors `ai::Task::SETTINGS`. */
export type DefaultTask = "chat" | "ideas" | "edit" | "complete" | "triage";

/** Mirrors `kin::SettingsView`. `resolved`: what the task would use now, at
 *  the thinking level it runs at. `enabled`: the models the pickers offer,
 *  every task's default included. */
export type KinSettings = {
  capUsd: number | null;
  tasks: { task: DefaultTask; chosen: ModelRef | null; effort: ThinkingLevel | null; resolved: ModelRef | null }[];
  enabled: ModelRef[];
  tone: Tone;
};

/** Mirrors `writing::Tone`: how Kin writes Feed summaries and Ideas (KI-102). */
export type Tone = "plain" | "editorial" | "casual" | "dry";

/** Mirrors `kin::ChatModel`: the model and effort for one conversation in the chat. */
export type ChatModel = { topic: string; chosen: ModelRef | null; effort: ThinkingLevel | null; resolved: ModelRef | null };

/** `remember: false` marks the conversation "don't remember this". */
export type Ask = { question: string; task?: KinTask; background?: boolean; context?: Chip[]; remember?: boolean };

/** Mirrors `memory::File`. */
export type MemoryFile = "user" | "notes";

/** Mirrors `memory::Source`: who made a change. */
export type MemorySource =
  | { kind: "chat"; turn: string; about: string }
  | { kind: "review"; job: string; about: string }
  | { kind: "owner" }
  | { kind: "outside" };

/** Mirrors `memory::Op`. */
export type MemoryOp = { op: "add"; text: string } | { op: "remove"; text: string } | { op: "patch"; old: string; new: string };

/** Mirrors `memory::Edit`: one edit Hussain (or Kin) asks for. */
export type MemoryEdit = { op: "add"; text: string } | { op: "patch"; old: string; text: string } | { op: "remove"; old: string };

/** Mirrors `memory::Skill`. `command` puts it in the editor's / menu. */
export type Skill = { name: string; description: string; command: boolean; body: string };

export type Origin = { change: string; at: string; source: MemorySource };

type Used = { origin: Origin | null; uses: number; lastUsed: string | null; blocked: string | null };

/** Mirrors `memory::View`: everything About you shows. */
export type MemoryView = {
  files: { file: MemoryFile; name: string; label: string; cap: number; used: number; entries: ({ text: string } & Used)[] }[];
  skills: (Skill & Used & { path: string })[];
  /** Newest first. */
  changes: {
    id: string;
    at: string;
    path: string;
    source: MemorySource;
    ops: MemoryOp[];
    skill: { name: string; action: "created" | "edited" | "deleted" } | null;
    undoes: string | null;
    undoneBy: string | null;
  }[];
};

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
  setModel: (task: DefaultTask, model: ModelRef | null) => invoke<KinSettings>("kin_set_model", { task, model }),
  /** A task's default thinking level; null goes back to the model's own. */
  setEffort: (task: DefaultTask, effort: ThinkingLevel | null) => invoke<KinSettings>("kin_set_effort", { task, effort }),
  /** Turns a model on or off in the pickers. */
  setEnabled: (model: ModelRef, on: boolean) => invoke<KinSettings>("kin_set_enabled", { model, on }),
  setTone: (tone: Tone) => invoke<KinSettings>("kin_set_tone", { tone }),
  /** The model for one conversation (a thread's key, "" for general). */
  chatModel: (topic: string) => invoke<ChatModel>("kin_chat_model", { topic }),
  setChatModel: (topic: string, model: ModelRef | null) => invoke<ChatModel>("kin_chat_set_model", { topic, model }),
  setChatEffort: (topic: string, effort: ThinkingLevel | null) => invoke<ChatModel>("kin_chat_set_effort", { topic, effort }),
};

/** Kin's memory and skills (About you), and the skills list for the / menu. */
export const memory = {
  view: () => invoke<MemoryView>("kin_memory"),
  undo: (change: string) => invoke<MemoryView>("kin_memory_undo", { change }),
  edit: (file: MemoryFile, edits: MemoryEdit[]) => invoke<MemoryView>("kin_memory_edit", { file, edits }),
  skills: () => invoke<Skill[]>("kin_skills"),
  skill: (name: string) => invoke<Skill>("kin_skill", { name }),
};

export const sameModel = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) =>
  !!a && !!b && a.provider === b.provider && a.model === b.model && (a.reasoning ?? null) === (b.reasoning ?? null);

export const dollars = (usd: number) =>
  usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;

/** Settings' sections, in the order its sidebar lists them. */
export type SettingsSection = "general" | "appearance" | "kin" | "providers" | "web" | "phone" | "blog" | "export" | "privacy";

/** Opens Settings (at a section) or the Kin developer panel from anywhere. */
export const openSettings = (section?: SettingsSection) =>
  window.dispatchEvent(new CustomEvent<SettingsSection | undefined>("kintsugi:open-settings", { detail: section }));
export function onOpenSettings(listener: (section?: SettingsSection) => void) {
  const handler = (e: Event) => listener((e as CustomEvent<SettingsSection | undefined>).detail);
  window.addEventListener("kintsugi:open-settings", handler);
  return () => window.removeEventListener("kintsugi:open-settings", handler);
}
export const openKinDev = () => window.dispatchEvent(new CustomEvent("kintsugi:open-kin-dev"));
export const openAboutYou = () => window.dispatchEvent(new CustomEvent("kintsugi:open-about-you"));
