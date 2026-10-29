import { invoke } from "@tauri-apps/api/core";
import type { Clip, ClipEdit, ClipSummary, DesktopClipCapture } from "@kintsugi/core/clips";

export type ClipPreview = ClipSummary & { text: string };
export type ClipSearch = { clips: ClipPreview[]; total: number; tags: string[] };
export type ClipSearchQuery = { query?: string; tags?: string[]; offset?: number; limit?: number };

/** Also used by the editor's reference picker. Search includes extracted source. */
export const clips = {
  search: (query: ClipSearchQuery = {}) => invoke<ClipSearch>("clip_search", query),
  read: (path: string) => invoke<Clip>("clip_read", { path }),
  create: (capture: DesktopClipCapture) => invoke<string>("clip_create", { capture }),
  update: (edit: ClipEdit) => invoke<Clip>("clip_update", edit),
  trash: (path: string) => invoke<void>("clip_trash", { path }),
  image: (path: string) => invoke<ArrayBuffer>("clip_image", { path }),
};

export function clipLabel(clip: Pick<ClipSummary, "title" | "url" | "kind">) {
  return clip.title || clip.url || ({ image: "An image", note: "A thought", quote: "A passage" }[clip.kind as "image" | "note" | "quote"] ?? "Untitled clip");
}

export function clipSite(clip: Pick<ClipSummary, "site" | "url" | "kind">) {
  if (clip.site) return clip.site;
  try {
    if (clip.url) return new URL(clip.url).hostname.replace(/^www\./, "");
  } catch { /* A hand-edited clip may have an invalid URL. */ }
  return clip.kind === "note" ? "Your thought" : clip.kind === "image" ? "Saved image" : "Saved passage";
}

/** Never hand a file/javascript URL from hand-edited frontmatter to the opener. */
export function sourceUrl(value: string | null): string | null {
  try {
    const url = new URL(value ?? "");
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
