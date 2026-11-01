import { ArrowUpRight, BookOpen, FileText, Quote } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@kintsugi/ui/components/button";
import { clipLabel, clipSite, type ClipPreview } from "./api";
import { ClipImage } from "./ClipImage";
import { masonry, type Tile } from "./layout";

type Props = {
  active: boolean;
  items: ClipPreview[];
  total: number;
  loading: boolean;
  onOpen: (path: string) => void;
  onMore: () => void;
};

export function Masonry({ active, items, total, loading, onOpen, onMore }: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  const position = useRef(0);
  useLayoutEffect(() => { if (active && scroll.current) scroll.current.scrollTop = position.current; }, [active]);
  const [viewport, setViewport] = useState({ width: 0, height: 800, top: 0 });
  useEffect(() => {
    const el = scroll.current!;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth) setViewport((v) => ({ ...v, width: el.clientWidth - 2, height: el.clientHeight }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => masonry(items, viewport.width), [items, viewport.width]);
  // Keep DOM and decoded images bounded even after paging through thousands.
  // Focused tiles stay mounted so keyboard navigation doesn't lose its place.
  const [focused, setFocused] = useState<string>();
  const visible = layout.tiles.filter((tile) => tile.clip.path === focused || (tile.y + tile.height > viewport.top - 600 && tile.y < viewport.top + viewport.height + 600));
  return (
    <div ref={scroll} className="inspiration-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-px pb-8" onScroll={(e) => {
      const el = e.currentTarget;
      if (!active || !el.clientWidth) return;
      position.current = el.scrollTop;
      setViewport((v) => ({ ...v, top: el.scrollTop }));
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 600 && !loading && items.length < total) onMore();
    }} aria-label="Inspiration clips">
      <div className="relative" role="list" style={{ height: layout.height }}>
        {viewport.width > 0 && visible.map((tile) => (
          <div key={tile.clip.path} role="listitem" aria-posinset={items.indexOf(tile.clip) + 1} aria-setsize={total} className="absolute" style={{ left: tile.x, top: tile.y, width: tile.width, height: tile.height }}>
            <Card tile={tile} onOpen={onOpen} onFocus={() => setFocused(tile.clip.path)} onBlur={() => setFocused(undefined)} />
          </div>
        ))}
      </div>
      {items.length < total && (
        <div className="py-4 text-center">
          <Button variant="ghost" disabled={loading} onClick={onMore}>{loading ? "Loading…" : "Show more"}</Button>
          <p className="mt-1 text-xs text-muted-foreground">{items.length.toLocaleString()} of {total.toLocaleString()}</p>
        </div>
      )}
    </div>
  );
}

function Card({ tile, onOpen, onFocus, onBlur }: { tile: Tile; onOpen: (path: string) => void; onFocus: () => void; onBlur: () => void }) {
  const { clip, bodyHeight } = tile;
  const own = clip.text.replace(/^> ?/gm, "").trim();
  return (
    <button type="button" onClick={() => onOpen(clip.path)} onFocus={onFocus} onBlur={onBlur} className="group block w-full rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4" data-clip-path={clip.path} aria-label={`Open ${clipLabel(clip)}`}>
      <div className="overflow-hidden rounded-xl bg-muted/70" style={{ height: bodyHeight }}>
        {clip.image ? (
          <ClipImage path={clip.path} image={clip.image} alt={clip.title ?? "Saved inspiration"} className="size-full object-cover" />
        ) : (
          <div className="flex h-full flex-col justify-center gap-3 overflow-hidden p-6">
            {clip.kind === "quote" && <Quote className="size-4 shrink-0 text-muted-foreground/50" />}
            {own || clip.summary ? (
              <p className="line-clamp-6 whitespace-pre-wrap break-words font-[family-name:var(--font-prose)] text-[19px] leading-relaxed" style={{ WebkitLineClamp: Math.max(2, Math.floor((bodyHeight - 48 - (clip.kind === "quote" ? 28 : 0)) / 31)) }}>{own || clip.summary}</p>
            ) : (
              <div className="space-y-3 break-words">
                {clip.kind === "book" ? <BookOpen className="size-5 stroke-[1.5] text-muted-foreground/60" /> : clip.kind === "document" ? <FileText className="size-5 stroke-[1.5] text-muted-foreground/60" /> : <ArrowUpRight className="size-5 text-muted-foreground/60" />}
                <p className="font-[family-name:var(--font-prose)] text-xl leading-snug">{clip.title || clipSite(clip)}</p>
                <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{(clip.kind === "book" || clip.kind === "document") && clip.author || clip.url || clip.file?.split("/").pop() || "Saved for later"}</p>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="space-y-1 px-1 pt-3">
        <p className="truncate text-[11px] text-muted-foreground">{clipSite(clip)}</p>
        <p className="line-clamp-2 break-words text-[13px] leading-snug group-hover:underline decoration-foreground/20 underline-offset-4">{clip.title || (own ? own.split("\n")[0] : clipLabel(clip))}</p>
      </div>
    </button>
  );
}
