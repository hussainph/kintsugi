import { CLIP_FILE_TYPES, clipFileType, MAX_CLIP_FILE_BYTES, type DesktopClipCapture } from "@kintsugi/core/clips";

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "image/avif"];

/** Captures use the device's local minute, not UTC. */
export function capturedAt(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function textCapture(value: string): DesktopClipCapture | null {
  const text = value.trim();
  if (!text) return null;
  let url: URL | undefined;
  try { url = new URL(text); } catch { /* Plain text is a note. */ }
  return {
    ...(url && ["https:", "http:"].includes(url.protocol) && !/\s/.test(text) ? { url: text } : { text }),
    capturedAt: capturedAt(),
    via: "mac",
  };
}

/** What the file pickers and drops accept: images, PDFs and EPUBs. */
export const FILE_ACCEPT = [...IMAGE_TYPES, ...CLIP_FILE_TYPES, ".pdf", ".epub"].join(",");

function imageType(file: File): string | undefined {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const type = file.type || ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif", avif: "image/avif" }[extension ?? ""]);
  return type && IMAGE_TYPES.includes(type) ? type : undefined;
}

export async function imageCapture(file: File): Promise<DesktopClipCapture> {
  const type = imageType(file);
  if (!type) throw new Error("Choose a JPEG, PNG, GIF, WebP, HEIC, HEIF or AVIF image.");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("Images can be up to 15 MiB.");
  if (!file.size) throw new Error("That image is empty.");
  return { image: Array.from(new Uint8Array(await file.arrayBuffer())), imageType: type, capturedAt: capturedAt(), via: "mac" };
}

/** Base64 without a giant intermediate string of numbers: native when the
 *  engine has `Uint8Array#toBase64`, otherwise `btoa` over 32 KiB chunks
 *  (small enough for `String.fromCharCode` arguments). */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(bytes);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]));
  return btoa(chunks.join(""));
}

/** A PDF or EPUB, sent as base64 with its type and original name. */
export async function fileCapture(file: File): Promise<DesktopClipCapture> {
  const type = clipFileType(file.name, file.type);
  if (!type) throw new Error("Choose a PDF or an EPUB.");
  if (file.size > MAX_CLIP_FILE_BYTES) throw new Error("PDFs and EPUBs can be up to 50 MiB.");
  if (!file.size) throw new Error("That file is empty.");
  const fileName = file.name.split(/[\\/]/).pop() || (type === "application/pdf" ? "document.pdf" : "book.epub");
  return { file: bytesToBase64(new Uint8Array(await file.arrayBuffer())), fileType: type, fileName, capturedAt: capturedAt(), via: "mac" };
}

/** A dropped, pasted or chosen file: a PDF or EPUB, or else an image. */
export function anyFileCapture(file: File): Promise<DesktopClipCapture> {
  if (clipFileType(file.name, file.type)) return fileCapture(file);
  if (imageType(file)) return imageCapture(file);
  return Promise.reject(new Error(`${file.name || "That file"} isn’t an image, a PDF or an EPUB.`));
}

/** The capture fields a file contributes, to merge over a link or note. */
export function fileFields(value: DesktopClipCapture): Partial<DesktopClipCapture> {
  return value.file
    ? { file: value.file, fileType: value.fileType, fileName: value.fileName }
    : value.image ? { image: value.image, imageType: value.imageType } : {};
}

/** A book from search, or an ISBN; enrichment fills author, cover and
 *  description from Open Library. */
export function bookCapture(book: { url: string; title?: string | null }): DesktopClipCapture {
  return { url: book.url, ...(book.title ? { title: book.title } : {}), capturedAt: capturedAt(), via: "mac" };
}

/** "Ursula K. Le Guin, Brian Attebery · 1969" */
export function bookByline(book: { authors: string[]; year: number | null }): string {
  const authors = book.authors.length > 3 ? `${book.authors.slice(0, 3).join(", ")} and others` : book.authors.join(", ");
  return [authors, book.year ?? ""].filter(Boolean).join(" · ");
}

export function parseTags(text: string): string[] {
  return [...new Set(text.split(",").map((tag) => tag.trim().replace(/^#/, "").toLowerCase()).filter(Boolean))];
}

export function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("input, textarea, [contenteditable=true], [role=textbox]");
}
