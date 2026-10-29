/** Vault clip types and the app's capture envelope, using camelCase fields. */
export type ClipKind = "link" | "post" | "video" | "image" | "quote" | "note";
export type ClipVia = "mac" | "phone" | "share";

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
  capturedAt: string;
  via: ClipVia;
};

/** Tauri expects a JSON number array; use Array.from(bytes) for a Uint8Array. */
export type DesktopClipCapture = Omit<ClipCapture, "image"> & { image?: number[] };

/** Desktop clip_update arguments. Omitted fields are left unchanged. */
export type ClipEdit = { path: string; title?: string; tags?: string[]; note?: string };

/** The clips:changed event carries only a stable vault-relative path. */
export type ClipChanged = { path: string };
