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
  setModel: (task: KinTask, model: ModelRef | null) => invoke<KinSettings>("kin_set_model", { task, model }),
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

export const modelLabel = (m: ModelRef) => `${m.provider} · ${m.model}${m.reasoning ? ` (${m.reasoning})` : ""}`;

export const dollars = (usd: number) =>
  usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;

/** Opens Settings or the Kin developer panel from anywhere. */
export const openSettings = () => window.dispatchEvent(new CustomEvent("kintsugi:open-settings"));
export const openKinDev = () => window.dispatchEvent(new CustomEvent("kintsugi:open-kin-dev"));
export const openAboutYou = () => window.dispatchEvent(new CustomEvent("kintsugi:open-about-you"));
