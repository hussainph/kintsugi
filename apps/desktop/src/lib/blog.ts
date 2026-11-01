import { invoke } from "@tauri-apps/api/core";
import type { BlogCheck, ImageRef, PublishedDoc } from "@kintsugi/core/publish";

/** Settings → Blog, as the backend reports it. */
export type BlogStatus = {
  path: string | null;
  appendix: boolean;
  site: string;
  /** The vault folder posts are mirrored into, e.g. "hussain.ph". */
  folder: string;
  posts: number | null;
  error: string | null;
};

export type ImportReport = {
  folder: string;
  posts: number;
  written: string[];
  unchanged: number;
  removed: string[];
  sourced: number;
  skipped: string[];
};

export type BlogCheckReply = BlogCheck & { repo: string; site: string; appendix: boolean };
export type Published = { repo: string; written: string[]; removed: string[]; import: ImportReport | null };
export type Linked = PublishedDoc & { mirror: boolean };

export const blog = {
  status: () => invoke<BlogStatus>("blog_status"),
  configure: (change: { path?: string; appendix?: boolean }) => invoke<BlogStatus>("blog_configure", change),
  import: () => invoke<ImportReport>("blog_import"),
  links: () => invoke<Linked[]>("blog_links"),
  check: (request: { source: string; file: string; replaces: string | null; imports: string[]; images: ImageRef[] }) =>
    invoke<BlogCheckReply>("blog_check", { request }),
  publish: (request: { source: string; file: string; replaces: string | null; content: string; images: { from: string; to: string }[] }) =>
    invoke<Published>("blog_publish", { request }),
};

export const openPublish = () => window.dispatchEvent(new CustomEvent("kintsugi:publish"));

export function importSummary(report: ImportReport): string {
  const mirrored = report.posts - report.sourced;
  const posts = `${mirrored} post${mirrored === 1 ? "" : "s"}`;
  const sourced = report.sourced ? `; ${report.sourced} published from documents here` : "";
  const changed = report.written.length + report.removed.length;
  return changed
    ? `Imported ${posts} into ${report.folder}/ (${report.written.length} updated, ${report.removed.length} removed${sourced}).`
    : `${posts} in ${report.folder}/, all up to date${sourced}.`;
}
