import { listen } from "@tauri-apps/api/event";
import { Bookmark, Plus, Search, SlidersHorizontal, X } from "@kintsugi/ui/icons";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import type { Clip, ClipChanged } from "@kintsugi/core/clips";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@kintsugi/ui/components/popover";
import { Toggle } from "@kintsugi/ui/graphical";
import { clips, type ClipSearch } from "./api";
import { CaptureDialog } from "./CaptureDialog";
import { Detail, type DetailHandle } from "./Detail";
import { searchWindow } from "./pagination";
import { Masonry } from "./Masonry";
import { useCapture } from "./useCapture";

export type LibraryHandle = { flush: () => Promise<boolean>; showGrid: () => Promise<boolean> };

type Props = {
  ref?: Ref<LibraryHandle>;
  openClip?: { path: string; seq: number };
  renderUsedIn?: (clip: Clip) => ReactNode;
};

/** A self-contained sibling of the editor; no editor state or backlink index here. */
export function Library({ ref, openClip, renderUsedIn }: Props) {
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [data, setData] = useState<ClipSearch>({ clips: [], total: 0, tags: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [detail, setDetail] = useState<string>();
  const [adding, setAdding] = useState(false);
  const detailRef = useRef<DetailHandle>(null);
  const grid = useRef<HTMLDivElement>(null);
  const loaded = useRef(60);
  loaded.current = Math.max(60, data.clips.length);
  const filter = JSON.stringify([query, tags]);
  const previousFilter = useRef(filter);
  const request = useRef(0);
  const morePending = useRef(false);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const { capture, dragging } = useCapture(refresh);

  const closeDetail = useCallback(() => {
    setDetail(undefined);
    requestAnimationFrame(() => {
      const card = detail && grid.current?.querySelector<HTMLButtonElement>(`[data-clip-path="${CSS.escape(detail)}"]`);
      (card || grid.current)?.focus();
    });
  }, [detail]);
  useImperativeHandle(ref, () => ({
    flush: async () => (await detailRef.current?.flush()) ?? true,
    showGrid: async () => {
      if (await detailRef.current?.flush() === false) return false;
      closeDetail();
      return true;
    },
  }), [closeDetail]);
  useEffect(() => { grid.current?.focus(); }, []);
  useEffect(() => { if (openClip) setDetail(openClip.path); }, [openClip]);

  useEffect(() => {
    const seq = ++request.current;
    setLoading(true);
    morePending.current = false;
    const count = previousFilter.current === filter ? loaded.current : 60;
    previousFilter.current = filter;
    const timer = window.setTimeout(() => {
      searchWindow(clips.search, { query, tags }, count, () => seq === request.current).then((next) => {
        if (!next || seq !== request.current) return;
        setData(next);
        setError(undefined);
      }).catch((e) => { if (seq === request.current) setError(String(e)); })
        .finally(() => { if (seq === request.current) setLoading(false); });
    }, 120);
    return () => { window.clearTimeout(timer); request.current++; };
  }, [query, tags, filter, revision]);

  useEffect(() => {
    const off = listen<ClipChanged>("clips:changed", refresh);
    return () => { off.then((stop) => stop()); };
  }, [refresh]);

  const more = useCallback(async () => {
    if (loading || morePending.current || data.clips.length >= data.total) return;
    const seq = request.current;
    morePending.current = true;
    setLoading(true);
    try {
      const next = await clips.search({ query, tags, offset: data.clips.length, limit: 60 });
      if (seq === request.current) setData((old) => ({ ...next, clips: [...old.clips, ...next.clips.filter((clip) => !old.clips.some((item) => item.path === clip.path))] }));
    } catch (e) { if (seq === request.current) setError(String(e)); }
    finally { if (seq === request.current) { setLoading(false); morePending.current = false; } }
  }, [data, query, tags, loading]);

  const toggleTag = (tag: string) => setTags((old) => old.includes(tag) ? old.filter((t) => t !== tag) : [...old, tag]);
  const tagButton = (tag: string) => <Toggle key={tag} pressed={tags.includes(tag)} onPressedChange={() => toggleTag(tag)}><Toggle.Label>{tag}</Toggle.Label></Toggle>;
  const shownTags = [...new Set([...tags, ...data.tags.slice(0, 8)])];

  return (
    <section className="ki-library relative flex h-full min-h-0 flex-col" aria-label="Inspiration library" aria-busy={loading}>
      {detail && <Detail ref={detailRef} key={detail} path={detail} onClose={closeDetail} onChanged={refresh} renderUsedIn={renderUsedIn} />}
      <div ref={grid} tabIndex={-1} inert={!!detail} className={detail ? "hidden" : "flex min-h-0 flex-1 flex-col outline-none"}>
        <header className="ki-library-header ki-stack-l shrink-0">
          <div className="flex items-start justify-between gap-[var(--space-l)]">
            <div>
              <h1 className="ki-title">Inspiration</h1>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setAdding(true)}><Plus />Add a clip</Button>
          </div>
          <div className="ki-search">
            <Search className="ki-search-icon" />
            <Input type="search" aria-label="Search inspiration" placeholder="Search clips…" value={query} onChange={(e) => setQuery(e.target.value)} />
            {query && <Button variant="ghost" size="icon-xs" aria-label="Clear search" className="ki-search-clear" onClick={() => setQuery("")}><X /></Button>}
          </div>
          {(shownTags.length > 0 || tags.length > 0) && <div className="flex items-center gap-[var(--space-xs)]">
            <div className="flex flex-1 flex-wrap gap-[var(--space-xs)]">{shownTags.map(tagButton)}</div>
            {data.tags.length > 8 && <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="All tags"><SlidersHorizontal /></Button></PopoverTrigger><PopoverContent align="end" className="max-h-72 w-72 overflow-y-auto"><p className="ki-text-s ki-medium mb-[var(--space-s)]">Filter by tags</p><div className="flex flex-wrap gap-[var(--space-xs)]">{data.tags.map(tagButton)}</div></PopoverContent></Popover>}
            {tags.length > 0 && <Button variant="ghost" size="xs" onClick={() => setTags([])}>Clear</Button>}
          </div>}
        </header>
        <div className="ki-text-xs ki-muted mb-[var(--space-m)] flex shrink-0 items-center justify-between">
          <span role="status">{loading ? "Looking…" : `${data.total.toLocaleString()} ${data.total === 1 ? "clip" : "clips"}`}</span>
          <span>Newest first</span>
        </div>
        {error && <div role="alert" className="ki-error-surface ki-text-s mb-[var(--space-m)] flex items-center justify-between gap-[var(--space-s)]"><span>{error}</span><Button variant="ghost" size="sm" onClick={refresh}>Try again</Button></div>}
        {data.clips.length ? <Masonry active={!detail} key={JSON.stringify([query, tags])} items={data.clips} total={data.total} loading={loading} onOpen={setDetail} onMore={more} /> : loading ? <div className="flex-1" /> : <div className="ki-library-empty flex flex-1 flex-col items-center justify-center text-center">
          <Bookmark className="ki-muted mb-[var(--space-l)] size-[var(--size-l)]" />
          <h2 className="ki-prose-title">{query || tags.length ? "No clips match." : "Nothing saved yet."}</h2>
          {!(query || tags.length) && <p className="ki-text-s ki-muted mt-[var(--space-s)] max-w-xs">Paste a link, drop an image, PDF or EPUB here, or write a note.</p>}
          {(query || tags.length > 0) ? <Button variant="ghost" className="mt-[var(--space-l)]" onClick={() => { setQuery(""); setTags([]); }}>Clear filters</Button> : <Button variant="ghost" className="mt-[var(--space-l)]" onClick={() => setAdding(true)}><Plus />Add a clip</Button>}
        </div>}
      </div>
      {dragging && <div className="ki-drop-target pointer-events-none absolute z-20 flex items-center justify-center"><div className="text-center"><Plus className="mx-auto mb-[var(--space-m)] size-[var(--size-l)]" /><p className="ki-prose-title">Drop to save</p></div></div>}
      <CaptureDialog open={adding} onClose={() => setAdding(false)} capture={capture} />
    </section>
  );
}
