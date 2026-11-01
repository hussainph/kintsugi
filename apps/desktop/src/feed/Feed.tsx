import { listen } from "@tauri-apps/api/event";
import { Rss, RotateCw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { cn } from "@kintsugi/ui/lib/utils";
import { feed, FEED_CHANGED, type FeedItem as Item, type Page, type Source } from "./api";
import { FeedItem } from "./FeedItem";
import { Impressions } from "./model";
import { Sources } from "./Sources";

const PAGE = 40;

type Props = {
  /**
   * KI-32's ranked "Picked for you" section (`Picked.tsx`) renders here,
   * above the newest items. It logs its own impressions with surface "picked".
   */
  picked?: ReactNode;
};

/** The Feed: new work from sources he follows, newest first. */
export function Feed({ picked }: Props) {
  const [page, setPage] = useState<Page>({ items: [], total: 0 });
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [managing, setManaging] = useState(false);
  const loaded = useRef(PAGE);
  loaded.current = Math.max(PAGE, page.items.length);
  const request = useRef(0);
  const impressions = useRef(new Impressions(feed.impressions));
  const observer = useRef<IntersectionObserver | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const morePending = useRef(false);

  /** Reloads the window already shown, so a refresh never jumps back to the top. */
  const reload = useCallback(async () => {
    const seq = ++request.current;
    try {
      const [next, all] = await Promise.all([feed.items({ limit: Math.min(100, loaded.current) }), feed.sources()]);
      if (seq !== request.current) return;
      setPage(next);
      setSources(all);
      setError(undefined);
    } catch (e) {
      if (seq === request.current) setError(String(e));
    } finally {
      if (seq === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const off = listen(FEED_CHANGED, () => void reload());
    return () => {
      off.then((stop) => stop());
    };
  }, [reload]);

  // Impressions: an item counts as seen once half of it has been on screen.
  useEffect(() => {
    const tracker = impressions.current;
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const element = entry.target as HTMLElement;
          tracker.add({ id: Number(element.dataset.feedItem), position: Number(element.dataset.position), surface: "newest" });
        }
      },
      { threshold: 0.5 },
    );
    const flush = () => void tracker.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      observer.current?.disconnect();
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  const track = useCallback((position: number) => (element: HTMLElement | null) => {
    if (!element) return;
    element.dataset.position = String(position);
    observer.current?.observe(element);
    return () => observer.current?.unobserve(element);
  }, []);

  const more = useCallback(async () => {
    if (morePending.current || page.items.length >= page.total) return;
    morePending.current = true;
    const seq = request.current;
    try {
      const next = await feed.items({ offset: page.items.length, limit: PAGE });
      if (seq !== request.current) return;
      setPage((old) => ({ total: next.total, items: [...old.items, ...next.items.filter((item) => !old.items.some((o) => o.id === item.id))] }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      morePending.current = false;
    }
  }, [page]);

  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const watcher = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void more(), { rootMargin: "600px" });
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [more]);

  const shown = useRef(page.items);
  shown.current = page.items;
  const replace = useCallback((next: Item) => {
    // An undone Not interested comes back where it was.
    if (!next.dismissed && !shown.current.some((i) => i.id === next.id)) return void reload();
    setPage((old) =>
      next.dismissed
        ? { total: Math.max(0, old.total - (old.items.some((i) => i.id === next.id) ? 1 : 0)), items: old.items.filter((i) => i.id !== next.id) }
        : { ...old, items: old.items.map((i) => (i.id === next.id ? next : i)) },
    );
  }, [reload]);

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const polled = await feed.refresh();
      const failed = polled.filter((p) => p.error).length;
      const added = polled.reduce((n, p) => n + p.added, 0);
      if (failed) toast.error(`${failed} ${failed === 1 ? "source" : "sources"} didn’t load. See Following for why.`);
      else toast(added ? `${added} new ${added === 1 ? "item" : "items"}` : "Nothing new");
      await reload();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const failing = sources.filter((s) => s.lastError && !s.muted).length;
  const live = sources.filter((s) => !s.muted).length;

  return (
    <section className="relative flex h-full min-h-0 flex-col" aria-label="Feed">
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-14 pb-10 lg:px-10">
        <div className="mx-auto max-w-2xl">
          <header className="mb-6 flex items-start justify-between gap-5">
            <div>
              <h1 className="text-xl font-medium tracking-tight">Feed</h1>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {sources.length ? (
                  <>
                    New from {live} {live === 1 ? "source" : "sources"} you follow.
                    {failing > 0 && (
                      <button type="button" className="ml-1 text-destructive underline-offset-2 hover:underline" onClick={() => setManaging(true)}>
                        {failing} {failing === 1 ? "needs" : "need"} attention.
                      </button>
                    )}
                  </>
                ) : (
                  "New work from the people and places you follow."
                )}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {sources.length > 0 && (
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void refreshAll()} disabled={refreshing}>
                  <RotateCw className={cn(refreshing && "animate-spin")} />
                  {refreshing ? "Fetching…" : "Refresh"}
                </Button>
              )}
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setManaging(true)}>
                <Settings2 />
                Following
              </Button>
            </div>
          </header>

          {picked}

          {error && (
            <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
              <span>{error}</span>
              <Button variant="ghost" size="sm" onClick={() => void reload()}>Try again</Button>
            </div>
          )}

          {page.items.length > 0 ? (
            <div aria-label="Newest first" role="feed" aria-busy={loading}>
              <div className="flex items-center justify-between border-b border-border/60 pb-2 text-[11px] text-muted-foreground">
                <span role="status">{page.total.toLocaleString()} {page.total === 1 ? "item" : "items"}</span>
                <span>Newest first</span>
              </div>
              {page.items.map((item, position) => (
                <FeedItem key={item.id} ref={track(position)} item={item} place={{ surface: "newest", position }} onChange={replace} onDismiss={replace} />
              ))}
              <div ref={sentinel} className="h-px" />
              {page.items.length >= page.total && page.total > 0 && (
                <p className="pt-6 text-center text-[11px] text-muted-foreground/70">That’s everything. Items you don’t act on leave after 30 days.</p>
              )}
            </div>
          ) : (
            !loading && (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <Rss className="mb-6 size-7 stroke-1 text-muted-foreground/40" />
                <h2 className="font-[family-name:var(--font-prose)] text-2xl">{sources.length ? "Nothing new just yet." : "Follow a few good sources."}</h2>
                <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">
                  {sources.length
                    ? "New posts, videos and episodes land here as they’re published."
                    : "Blogs, YouTube channels, podcasts, Hacker News. What’s worth keeping, you save to Inspiration."}
                </p>
                <Button variant="ghost" className="mt-5 text-muted-foreground" onClick={() => setManaging(true)}>
                  {sources.length ? "See what you follow" : "Follow something"}
                </Button>
              </div>
            )
          )}
        </div>
      </div>
      <Sources open={managing} onOpenChange={setManaging} sources={sources} onChanged={() => void reload()} />
    </section>
  );
}
