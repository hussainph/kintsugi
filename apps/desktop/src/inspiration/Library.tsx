import { listen } from "@tauri-apps/api/event";
import { Bookmark, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import type { Clip, ClipChanged } from "@kintsugi/core/clips";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@kintsugi/ui/components/popover";
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
  const tagButton = (tag: string) => <button key={tag} type="button" aria-pressed={tags.includes(tag)} onClick={() => toggleTag(tag)} className={`rounded-full px-3 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${tags.includes(tag) ? "bg-foreground text-background" : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{tag}</button>;
  const shownTags = [...new Set([...tags, ...data.tags.slice(0, 8)])];

  return (
    <section className="relative flex h-full min-h-0 flex-col px-7 pt-14 pb-2 lg:px-10" aria-label="Inspiration library">
      {detail && <Detail ref={detailRef} key={detail} path={detail} onClose={closeDetail} onChanged={refresh} renderUsedIn={renderUsedIn} />}
      <div ref={grid} tabIndex={-1} inert={!!detail} className={detail ? "hidden" : "flex min-h-0 flex-1 flex-col outline-none"}>
        <header className="mb-7 shrink-0 space-y-5">
          <div className="flex items-start justify-between gap-5">
            <div>
              <h1 className="text-xl font-medium tracking-tight">Inspiration</h1>
              <p className="mt-1.5 text-xs text-muted-foreground">A place for things that stay with you.</p>
            </div>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setAdding(true)}><Plus />Keep something</Button>
          </div>
          <div className="relative max-w-xl">
            <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground/60" />
            <Input type="search" aria-label="Search inspiration" placeholder="Find a thought, a phrase, a place…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-10 border-0 bg-muted/60 pr-9 pl-10 shadow-none focus-visible:ring-1" />
            {query && <button aria-label="Clear search" className="absolute top-3 right-3 text-muted-foreground" onClick={() => setQuery("")}><X className="size-4" /></button>}
          </div>
          {(shownTags.length > 0 || tags.length > 0) && <div className="flex items-center gap-2">
            <div className="flex flex-1 flex-wrap gap-2">{shownTags.map(tagButton)}</div>
            {data.tags.length > 8 && <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="All tags"><SlidersHorizontal /></Button></PopoverTrigger><PopoverContent align="end" className="max-h-72 w-72 overflow-y-auto"><p className="mb-3 text-xs text-muted-foreground">Filter by tags</p><div className="flex flex-wrap gap-2">{data.tags.map(tagButton)}</div></PopoverContent></Popover>}
            {tags.length > 0 && <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setTags([])}>Clear</Button>}
          </div>}
        </header>
        <div className="mb-4 flex shrink-0 items-center justify-between text-[11px] text-muted-foreground">
          <span role="status">{loading ? "Looking…" : `${data.total.toLocaleString()} ${data.total === 1 ? "clip" : "clips"}`}</span>
          <span>Newest first</span>
        </div>
        {error && <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-destructive/5 p-3 text-sm text-destructive"><span>{error}</span><Button variant="ghost" size="sm" onClick={refresh}>Try again</Button></div>}
        {data.clips.length ? <Masonry active={!detail} key={JSON.stringify([query, tags])} items={data.clips} total={data.total} loading={loading} onOpen={setDetail} onMore={more} /> : <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center">
          <Bookmark className="mb-6 size-7 stroke-1 text-muted-foreground/40" />
          <h2 className="font-[family-name:var(--font-prose)] text-2xl">{query || tags.length ? "Nothing here just yet." : "Good things find their way here."}</h2>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">{query || tags.length ? "Try another word, or let a tag go." : "Paste a link, drop an image or a PDF, or keep a passing thought. It’s all welcome."}</p>
          {(query || tags.length > 0) ? <Button variant="ghost" className="mt-5 text-muted-foreground" onClick={() => { setQuery(""); setTags([]); }}>Clear filters</Button> : <Button variant="ghost" className="mt-5 text-muted-foreground" onClick={() => setAdding(true)}><Plus />Keep your first inspiration</Button>}
        </div>}
        <p className="shrink-0 pt-2 pb-3 text-center text-[11px] text-muted-foreground/65">Paste or drop a link, image, PDF, EPUB or text anywhere here.</p>
      </div>
      {dragging && <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-2xl border border-dashed border-foreground/30 bg-background/95"><div className="text-center"><Plus className="mx-auto mb-4 size-6 stroke-1" /><p className="font-[family-name:var(--font-prose)] text-2xl">Let it land here.</p><p className="mt-2 text-sm text-muted-foreground">A link, an image, a PDF, a little inspiration.</p></div></div>}
      <CaptureDialog open={adding} onClose={() => setAdding(false)} capture={capture} />
    </section>
  );
}
