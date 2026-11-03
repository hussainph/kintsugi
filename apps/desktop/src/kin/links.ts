/**
 * What Kin names in a reply, made clickable (KI-79): vault paths
 * (`drafts/x.md`, `inspiration/clip.md`) and [[wikilinks]]. The app opens
 * them (`kintsugi:open-link`, handled in App.tsx): a document in the
 * editor, a clip in Inspiration.
 */
const OPEN_LINK = "kintsugi:open-link";

export const openLink = (target: string) => window.dispatchEvent(new CustomEvent<{ target: string }>(OPEN_LINK, { detail: { target } }));

export function onOpenLink(listener: (target: string) => void) {
  const handler = (e: Event) => {
    const target = (e as CustomEvent<{ target: string }>).detail?.target;
    if (typeof target === "string" && target.trim()) listener(target.trim());
  };
  window.addEventListener(OPEN_LINK, handler);
  return () => window.removeEventListener(OPEN_LINK, handler);
}

/** A vault-relative Markdown path: at least one folder, ending in .md or .mdx, no spaces. */
export const PATH = /(?<![\w/.:@-])((?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.mdx?)(?![\w/])/g;

/** Splits text into plain runs and vault paths. */
export function splitPaths(text: string): (string | { path: string })[] {
  const out: (string | { path: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(PATH)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push({ path: match[1] });
    last = at + match[1].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Where a [[wikilink]] or path points, given the vault's documents. */
export function resolveTarget(target: string, docs: { path: string; title?: string | null }[]): { doc: string } | { clip: string } | null {
  const bare = target.replace(/#.*$/, "").replace(/^\.?\//, "").replace(/\.mdx?$/, "").trim();
  if (!bare) return null;
  if (bare.startsWith("inspiration/")) return { clip: `${bare}.md` };
  const stem = (p: string) => p.replace(/\.mdx?$/, "");
  const doc =
    docs.find((d) => stem(d.path) === bare) ??
    docs.find((d) => stem(d.path).endsWith(`/${bare}`)) ??
    docs.find((d) => (d.title ?? "").toLowerCase() === bare.toLowerCase());
  if (doc) return { doc: doc.path };
  // Not a document: a clip named by its file.
  return bare.includes("/") ? null : { clip: `inspiration/${bare}.md` };
}
