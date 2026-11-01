import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ClipChanged, ClipSummary } from "@kintsugi/core/clips";
import { searchReferences, type ReferenceSource } from "@kintsugi/core/references";

type ClipPreview = ClipSummary & { text: string };
type ClipSearch = { clips: ClipPreview[]; total: number; tags: string[] };

/** Object URLs only come from the scoped clip_image command. Vault paths and
 * externally supplied frontmatter URLs never become image src attributes. */
export class ClipImages {
  private entries = new Map<string, { url: string; signature: string }>();
  private inflight = new Map<string, { request: Promise<string | null>; signature: string }>();
  private tokens = new Map<string, number>();
  private sequence = 0;
  private changed: () => void;
  private fetchImage: (path: string) => Promise<ArrayBuffer>;
  constructor(changed: () => void, fetchImage: (path: string) => Promise<ArrayBuffer> = (path) => invoke<ArrayBuffer>("clip_image", { path })) {
    this.changed = changed; this.fetchImage = fetchImage;
  }
  get(path: string) { return this.entries.get(path)?.url ?? null; }
  invalidate(path: string, notify = true) {
    const cached = this.entries.get(path);
    if (cached) URL.revokeObjectURL(cached.url);
    this.entries.delete(path);
    this.inflight.delete(path);
    this.tokens.delete(path);
    if (cached && notify) this.changed();
  }
  load(clip: ClipSummary): Promise<string | null> {
    if (!clip.image) { this.invalidate(clip.path); return Promise.resolve(null); }
    const signature = JSON.stringify([clip.image, clip.captured, clip.enriched]);
    const cached = this.entries.get(clip.path);
    if (cached?.signature === signature) return Promise.resolve(cached.url);
    const pending = this.inflight.get(clip.path);
    if (pending?.signature === signature) return pending.request;
    this.invalidate(clip.path, false);
    const token = ++this.sequence;
    this.tokens.set(clip.path, token);
    const request = this.fetchImage(clip.path).then((bytes) => {
      if (this.tokens.get(clip.path) !== token || !bytes.byteLength) return null;
      const url = URL.createObjectURL(new Blob([bytes]));
      this.entries.set(clip.path, { url, signature });
      this.changed();
      return url;
    }).catch(() => null).finally(() => {
      if (this.tokens.get(clip.path) === token) this.inflight.delete(clip.path);
    });
    this.inflight.set(clip.path, { request, signature });
    return request;
  }
  prune(clips: ClipSummary[]) {
    const paths = new Set(clips.map((clip) => clip.path));
    for (const path of this.tokens.keys()) if (!paths.has(path)) this.invalidate(path);
  }
  dispose() {
    for (const path of this.tokens.keys()) this.invalidate(path, false);
  }
}

export function useReferenceSearch(root: string | null, sources: ReferenceSource[], clips: ClipSummary[]) {
  const [revision, changed] = useReducer((n: number) => n + 1, 0);
  const images = useMemo(() => new ClipImages(changed), [root]);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  useEffect(() => () => images.dispose(), [images]);
  useEffect(() => {
    const off = listen<ClipChanged>("clips:changed", ({ payload }) => {
      images.invalidate(payload.path);
      const clip = clipsRef.current.find((clip) => clip.path === payload.path);
      if (clip) void images.load(clip);
    }).catch(() => () => {});
    return () => { void off.then((stop) => stop()); };
  }, [images]);
  useEffect(() => {
    images.prune(clips);
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
      site: clip.site, summary: clip.summary, text: clip.text, quoteBy: clip.quoteBy, quoteLink: clip.quoteLink,
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
