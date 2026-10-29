import type { DesktopClipCapture } from "@kintsugi/core/clips";

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

export async function imageCapture(file: File): Promise<DesktopClipCapture> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error("Choose a JPEG, PNG, GIF, WebP, HEIC, HEIF or AVIF image.");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("Images can be up to 15 MiB.");
  if (!file.size) throw new Error("That image is empty.");
  return { image: Array.from(new Uint8Array(await file.arrayBuffer())), imageType: file.type, capturedAt: capturedAt(), via: "mac" };
}

export function parseTags(text: string): string[] {
  return [...new Set(text.split(",").map((tag) => tag.trim().replace(/^#/, "").toLowerCase()).filter(Boolean))];
}

export function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("input, textarea, [contenteditable=true], [role=textbox]");
}
