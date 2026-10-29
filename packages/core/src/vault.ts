/** Mirrors `kintsugi_vault::Entry` in crates/vault. Paths are vault-relative and use `/`. */
export type Entry = Folder | Doc;
export type Folder = { kind: "folder"; name: string; path: string; children: Entry[] };
export type Doc = { kind: "doc"; name: string; path: string; title: string | null; status: string | null };

export function flatten(entries: Entry[]): Doc[] {
  return entries.flatMap((e) => (e.kind === "doc" ? [e] : flatten(e.children)));
}

export const parentDir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

export const displayName = (doc: Doc) => doc.title ?? doc.name.replace(/\.mdx?$/, "");

/** `path` after `from` was renamed to `to`, if it was it or lived inside it. */
export function renamedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(from + "/")) return to + path.slice(from.length);
  return null;
}
