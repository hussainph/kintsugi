import { invoke } from "@tauri-apps/api/core";
import type { Asset, ImageRef } from "@kintsugi/core/export";
import { HUMAN_STATEMENT } from "@kintsugi/core/publish";

/** Settings → Export, as the backend keeps them. */
export type ExportSettings = {
  /** Destinations shown in the Export menu, by id. */
  destinations: string[];
  appendix: boolean;
  statement: boolean;
  /** Null until the writer words it himself. */
  statementText: string | null;
};

export type PdfReply = { pages: number; preview: string[]; written: string | null };

export const exporting = {
  settings: () => invoke<ExportSettings>("export_settings"),
  configure: (change: Partial<ExportSettings>) => invoke<ExportSettings>("export_configure", { change }),
  images: (images: ImageRef[]) => invoke<Record<string, string | null>>("export_images", { images }),
  assets: (assets: Asset[]) => invoke<Record<string, string>>("export_assets", { assets }),
  pdf: (request: { source: string; assets: Asset[]; path?: string }) => invoke<PdfReply>("export_pdf", { request }),
  write: (path: string, content: string) => invoke<string>("export_write", { path, content }),
};

/** The statement as it goes on a piece, or null when it's off. */
export const statementFor = (s: ExportSettings) => (s.statement ? s.statementText ?? HUMAN_STATEMENT : null);

/** Opens the Export dialog, on one destination when given. */
export const openExport = (destination?: string) => window.dispatchEvent(new CustomEvent("kintsugi:export", { detail: { destination } }));
