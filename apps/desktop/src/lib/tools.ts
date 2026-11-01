import { invoke } from "@tauri-apps/api/core";

/** Mirrors `kintsugi_ingest::tools::ToolStatus` (crates/ingest/src/tools/mod.rs). */
export type ToolStatus = {
  id: string;
  name: string;
  purpose: string;
  homepage: string;
  license: string;
  approxBytes: number;
  /** `download`: fetched by Kintsugi. `system`: fetched by macOS on first use. */
  kind: "download" | "system";
  supported: boolean;
  consented: boolean;
  installed: { version: string; sha256: string; installedAt: string } | null;
  latest: string | null;
  checkedAt: string | null;
  path: string | null;
};

/** Optional tools Kintsugi downloads only with consent (see docs/ingest.md). */
export const tools = {
  list: () => invoke<ToolStatus[]>("tools_list"),
  install: (id: string) => invoke<ToolStatus[]>("tools_install", { id }),
  update: (id: string) => invoke<ToolStatus[]>("tools_update", { id }),
  remove: (id: string) => invoke<ToolStatus[]>("tools_remove", { id }),
};

/** Tools installed together with another one, shown as part of it. */
export const COMPANIONS: Record<string, string> = { deno: "yt-dlp" };

export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}
