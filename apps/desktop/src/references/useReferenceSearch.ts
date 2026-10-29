import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useReducer } from "react";
import type { ClipSummary } from "@kintsugi/core/clips";
import { searchReferences, type ReferenceSource } from "@kintsugi/core/references";

type ClipPreview = ClipSummary & { text: string };
type ClipSearch = { clips: ClipPreview[]; total: number; tags: string[] };

/** Object URLs only come from the scoped clip_image command. Vault paths and
 * externally supplied frontmatter URLs never become image src attributes. */
class ClipImages {
  urls = new Map<string, string>();
  private inflight = new Map<string, Promise<string | null>>();
  private generation = 0;
  constructor(private changed: () => void) {}
  get(path: string) { return this.urls.get(path) ?? null; }
  load(clip: ClipSummary): Promise<string | null> {
    if (!clip.image) return Promise.resolve(null);
    const cached = this.urls.get(clip.path);
    if (cached) return Promise.resolve(cached);
    const pending = this.inflight.get(clip.path);
    if (pending) return pending;
    const generation = this.generation;
    const request = invoke<ArrayBuffer>("clip_image", { path: clip.path }).then((bytes) => {
      if (generation !== this.generation || !bytes.byteLength) return null;
      const url = URL.createObjectURL(new Blob([bytes]));
      this.urls.set(clip.path, url);
      this.changed();
      return url;
    }).catch(() => null).finally(() => {
      if (generation === this.generation) this.inflight.delete(clip.path);
    });
    this.inflight.set(clip.path, request);
    return request;
  }
  dispose() {
    this.generation++;
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.urls.clear();
    this.inflight.clear();
  }
}

export function useReferenceSearch(root: string | null, sources: ReferenceSource[], clips: ClipSummary[]) {
  const [revision, changed] = useReducer((n: number) => n + 1, 0);
  const images = useMemo(() => new ClipImages(changed), [root]);
  useEffect(() => () => images.dispose(), [images]);
  useEffect(() => {
    // Only warm the few newest thumbnails, not thousands of clips.
    void Promise.all(clips.slice(0, 8).map((clip) => images.load(clip)));
  }, [clips, images]);
  const decorated = useMemo(() => sources.map((source) => source.kind === "clip" ? { ...source, image: images.get(source.path) } : source), [sources, images, revision]);
  const search = useCallback(async (query: string): Promise<ReferenceSource[]> => {
    const documents = searchReferences(query, sources.filter((source) => source.kind === "document")).slice(0, 20);
    const result = await invoke<ClipSearch>("clip_search", { query, limit: 20 });
    const found = await Promise.all(result.clips.map(async (clip, index) => ({
      kind: "clip" as const,
      path: clip.path, title: clip.title || clip.path.replace(/^.*\//, "").replace(/\.mdx?$/, ""),
      site: clip.site, summary: clip.summary, text: clip.text,
      image: index < 8 ? await images.load(clip) : images.get(clip.path),
    })));
    return [...documents, ...found];
  }, [sources, images]);
  const warmImages = useCallback((paths: string[]) => {
    const wanted = new Set(paths);
    void Promise.all(clips.filter((clip) => wanted.has(clip.path)).slice(0, 16).map((clip) => images.load(clip)));
  }, [clips, images]);
  return { sources: decorated, search, warmImages };
}
