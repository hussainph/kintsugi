import { ArrowUpRight, BookOpen, FileText, Quote } from "@kintsugi/ui/icons";
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
  const [viewport, setViewport] = useState({ width: 0, height: 800, top: 0, gap: 0, captionHeight: 0, proseLine: 0, copyPadding: 0, quoteHeight: 0 });
  useEffect(() => {
    const el = scroll.current!;
    const observer = new ResizeObserver(() => {
      const styles = getComputedStyle(el);
      const token = (name: string) => Number.parseFloat(styles.getPropertyValue(name)) || 0;
      if (el.clientWidth) setViewport((v) => ({
        ...v, width: el.clientWidth - 2, height: el.clientHeight,
        gap: token("--space-l"),
        captionHeight: token("--space-s") + token("--line-xs") + 2 * token("--line-s") + token("--space-xxs"),
        proseLine: token("--line-m"), copyPadding: token("--space-l"), quoteHeight: token("--size-s") + token("--space-s"),
      }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => masonry(items, viewport.width, { gap: viewport.gap, captionHeight: viewport.captionHeight }), [items, viewport.width, viewport.gap, viewport.captionHeight]);
  // Keep DOM and decoded images bounded even after paging through thousands.
  // Focused tiles stay mounted so keyboard navigation doesn't lose its place.
  const [focused, setFocused] = useState<string>();
  const visible = layout.tiles.filter((tile) => tile.clip.path === focused || (tile.y + tile.height > viewport.top - 600 && tile.y < viewport.top + viewport.height + 600));
  return (
    <div ref={scroll} className="inspiration-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-px pb-[var(--space-xl)]" onScroll={(e) => {
      const el = e.currentTarget;
      if (!active || !el.clientWidth) return;
      position.current = el.scrollTop;
      setViewport((v) => ({ ...v, top: el.scrollTop }));
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 600 && !loading && items.length < total) onMore();
    }} aria-label="Inspiration clips">
      <div className="relative" role="list" style={{ height: layout.height }}>
        {viewport.width > 0 && visible.map((tile) => (
          <div key={tile.clip.path} role="listitem" aria-posinset={items.indexOf(tile.clip) + 1} aria-setsize={total} className="absolute" style={{ left: tile.x, top: tile.y, width: tile.width, height: tile.height }}>
            <Card tile={tile} lineClamp={viewport.proseLine ? Math.max(2, Math.floor((tile.bodyHeight - 2 * viewport.copyPadding - (tile.clip.kind === "quote" ? viewport.quoteHeight : 0)) / viewport.proseLine)) : 2} onOpen={onOpen} onFocus={() => setFocused(tile.clip.path)} onBlur={() => setFocused(undefined)} />
          </div>
        ))}
      </div>
      {items.length < total && (
        <div className="py-[var(--space-m)] text-center">
          <Button variant="ghost" disabled={loading} onClick={onMore}>{loading ? "Loading…" : "Show more"}</Button>
          <p className="ki-data ki-muted mt-[var(--space-xxs)]">{items.length.toLocaleString()} of {total.toLocaleString()}</p>
        </div>
      )}
    </div>
  );
}

function Card({ tile, lineClamp, onOpen, onFocus, onBlur }: { tile: Tile; lineClamp: number; onOpen: (path: string) => void; onFocus: () => void; onBlur: () => void }) {
  const { clip, bodyHeight } = tile;
  const own = clip.text.replace(/^> ?/gm, "").trim();
  return (
    <button type="button" onClick={() => onOpen(clip.path)} onFocus={onFocus} onBlur={onBlur} className="ki-clip-card group block w-full text-left outline-none" data-clip-path={clip.path} aria-label={`Open ${clipLabel(clip)}`}>
      <div className="ki-clip-card-body" style={{ height: bodyHeight }}>
        {clip.image ? (
          <ClipImage path={clip.path} image={clip.image} alt={clip.title ?? "Saved inspiration"} className="size-full object-cover" />
        ) : (
          <div className="ki-clip-card-copy flex h-full flex-col justify-center overflow-hidden">
            {clip.kind === "quote" && <Quote className="ki-muted size-[var(--size-s)] shrink-0" />}
            {own || clip.summary ? (
              <p className="ki-prose line-clamp-6 whitespace-pre-wrap break-words" style={{ WebkitLineClamp: lineClamp }}>{own || clip.summary}</p>
            ) : (
              <div className="ki-stack-s break-words">
                {clip.kind === "book" ? <BookOpen className="ki-muted size-[var(--size-m)]" /> : clip.kind === "document" ? <FileText className="ki-muted size-[var(--size-m)]" /> : <ArrowUpRight className="ki-muted size-[var(--size-m)]" />}
                <p className="ki-prose-title">{clip.title || clipSite(clip)}</p>
                <p className="ki-text-xs ki-muted line-clamp-2">{(clip.kind === "book" || clip.kind === "document") && clip.author || clip.url || clip.file?.split("/").pop() || "Saved for later"}</p>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="ki-clip-card-meta ki-stack-xxs">
        <p className="ki-clip-card-title ki-text-s line-clamp-2 break-words">{clip.title || (own ? own.split("\n")[0] : clipLabel(clip))}</p>
        <p className="ki-text-xs ki-muted truncate">{clipSite(clip)}</p>
      </div>
    </button>
  );
}
