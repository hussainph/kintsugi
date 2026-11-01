/** Vault clip types and the app's capture envelope, using camelCase fields. */
/** `document` is a PDF (or another saved file); `book` is an EPUB or an
 *  Open Library book saved from its title or ISBN. */
export type ClipKind = "link" | "post" | "video" | "image" | "quote" | "note" | "document" | "book";
export type ClipVia = "mac" | "phone" | "share" | "feed";

export type ClipSummary = {
  path: string;
  kind: ClipKind;
  captured: string;
  tags: string[];
  title: string | null;
  url: string | null;
  site: string | null;
  author: string | null;
  image: string | null;
  /** A saved PDF or EPUB, relative to the clip file (`files/<slug>.pdf`). */
  file: string | null;
  summary: string | null;
  enriched: string | null;
  enrichError: string | null;
  via: ClipVia | null;
};

export type Clip = ClipSummary & {
  /** The clip's own text, without frontmatter or the extracted source section. */
  text: string;
  hasSource: boolean;
};

export type ClipCapture = {
  /** A UUID the caller generates once and repeats on every retry, so a
   *  capture delivered twice answers with the original clip's path instead
   *  of writing a duplicate. */
  id?: string;
  url?: string;
  text?: string;
  note?: string;
  title?: string;
  /** Base64-encoded image bytes. */
  image?: string;
  imageType?: string;
  /** Base64-encoded PDF or EPUB bytes (at most MAX_CLIP_FILE_BYTES decoded).
   *  The phone API accepts these from `hello.api` 4. */
  file?: string;
  /** `application/pdf` or `application/epub+zip`. Required with `file`. */
  fileType?: string;
  /** The file's original name, used as a title until enrichment reads the
   *  document's own. Never a path. */
  fileName?: string;
  capturedAt: string;
  via: ClipVia;
};

/** Files saved with a clip: PDFs and EPUBs, up to 50 MiB. */
export const MAX_CLIP_FILE_BYTES = 50 * 1024 * 1024;
export const CLIP_FILE_TYPES = ["application/pdf", "application/epub+zip"] as const;
export type ClipFileType = (typeof CLIP_FILE_TYPES)[number];

/** A file's type from its MIME type or, when that is empty or generic, its
 *  extension. Null for anything else. */
export function clipFileType(name: string, mime?: string | null): ClipFileType | null {
  const type = (mime ?? "").trim().toLowerCase();
  if ((CLIP_FILE_TYPES as readonly string[]).includes(type)) return type as ClipFileType;
  if (type && type !== "application/octet-stream" && type !== "application/zip") return null;
  const extension = name.split(".").pop()?.toLowerCase();
  return extension === "pdf" ? "application/pdf" : extension === "epub" ? "application/epub+zip" : null;
}

/** The first phone API version that accepts `file` captures. */
export const CLIP_FILE_API = 4;

/** Tauri expects a JSON number array for images; use Array.from(bytes) for a
 *  Uint8Array. Files travel as base64, like the phone API, because a number
 *  array of a 50 MiB PDF would be several times its size. */
export type DesktopClipCapture = Omit<ClipCapture, "image"> & { image?: number[] };

/** Desktop clip_update arguments. Omitted fields are left unchanged. */
export type ClipEdit = { path: string; title?: string; tags?: string[]; note?: string };

/** The clips:changed event carries only a stable vault-relative path. */
export type ClipChanged = { path: string };
