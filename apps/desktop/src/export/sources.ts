import { useMemo } from "react";
import type { ClipInfo } from "@kintsugi/core/publish";
import type { ReferenceSource } from "@kintsugi/core/references";
import { useReferenceIndex } from "@/references/useReferenceIndex";

const name = (path: string) => path.replace(/^.*\//, "").replace(/\.mdx?$/, "");

/** What Publish and every export resolve [[links]] against: the vault's
 *  documents and clips, as the editor sees them. */
export function usePieceSources(root: string | null) {
  const index = useReferenceIndex(root);
  const sources = useMemo<ReferenceSource[]>(() => [
    ...index.documents.map((d) => ({ kind: "document" as const, path: d.path, title: d.title || name(d.path), status: d.status })),
    ...index.clips.map((c) => ({ kind: "clip" as const, path: c.path, title: c.title || name(c.path), site: c.site })),
  ], [index.documents, index.clips]);
  const clips = useMemo<ClipInfo[]>(() => index.clips.map((c) => ({ path: c.path, title: c.title, url: c.url, site: c.site, author: c.author })), [index.clips]);
  return { sources, clips };
}
