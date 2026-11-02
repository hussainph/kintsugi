import { invoke } from "@tauri-apps/api/core";
import type { Clip, ClipEdit, ClipSummary, DesktopClipCapture } from "@kintsugi/core/clips";

export type ClipPreview = ClipSummary & { text: string };
export type ClipSearch = { clips: ClipPreview[]; total: number; tags: string[] };
/** An Open Library search result from `book_search`. `url` is the work's
 *  canonical `https://openlibrary.org/works/OL…W` page. */
export type BookHit = {
  key: string;
  url: string;
  title: string;
  authors: string[];
  year: number | null;
  isbn: string | null;
  coverUrl: string | null;
  editions: number | null;
};
export type ClipSearchQuery = { query?: string; tags?: string[]; offset?: number; limit?: number };

/** Also used by the editor's reference picker. Search includes extracted source. */
export const clips = {
  search: (query: ClipSearchQuery = {}) => invoke<ClipSearch>("clip_search", query),
  read: (path: string) => invoke<Clip>("clip_read", { path }),
  create: (capture: DesktopClipCapture) => invoke<string>("clip_create", { capture }),
  update: (edit: ClipEdit) => invoke<Clip>("clip_update", edit),
  trash: (path: string) => invoke<void>("clip_trash", { path }),
  image: (path: string) => invoke<ArrayBuffer>("clip_image", { path }),
  /** A title (optionally with author) or an ISBN. Rejects with a short reason. */
  bookSearch: (query: string) => invoke<BookHit[]>("book_search", { query }),
  /** Opens a clip's saved PDF or EPUB, by clip path, in the default app. */
  openFile: (path: string) => invoke<void>("clip_open_file", { path }),
};

export { clipLabel, clipSite } from "@kintsugi/core/clips";

/** The kind of saved file, for actions like "Open PDF". */
export function clipFileLabel(clip: Pick<ClipSummary, "file" | "kind">): "PDF" | "book" | null {
  if (!clip.file) return null;
  return /\.pdf$/i.test(clip.file) || (clip.kind === "document" && !/\.epub$/i.test(clip.file)) ? "PDF" : "book";
}

export { sourceUrl } from "@kintsugi/core/clips";
