import { listen } from "@tauri-apps/api/event";
import { Rss, RotateCw, Settings2 } from "@kintsugi/ui/icons";
import { Tabs } from "@kintsugi/ui/graphical";
import { Button } from "@kintsugi/ui/components/button";
import { cn } from "@kintsugi/ui/lib/utils";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { feed, FEED_CHANGED, PICKED_REFRESH, type Entry, type FeedItem as Item, type Pick, type Source } from "./api";
import { useItemChanges } from "./actions";
import { Card, Row, shownKey, type Open, type Shown } from "./Cards";
import { ItemPage } from "./ItemPage";
import { Impressions, layoutFor, type Layout } from "./model";
import { Sources } from "./Sources";
import { StoryPage } from "./StoryPage";

const PAGE = 40;
/** Picks shown before "Show more": the lead and a grid of four. */
const FIRST_PICKS = 5;

type View = Parameters<Open>[0];

const fromEntry = (entry: Entry): Shown => (entry.kind === "item" ? { kind: "item", item: entry.item } : { kind: "story", story: entry.story });
const fromPick = (pick: Pick): Shown => (pick.story ? { kind: "story", story: pick.story, pick } : { kind: "item", item: pick.item, pick });

/** Swaps in a newer copy of an item wherever an entry shows it. */
function patch(shown: Shown, item: Item): Shown {
  if (shown.kind === "item") return shown.item.id === item.id ? { ...shown, item } : shown;
  const { story } = shown;
  if (!story.items.some((i) => i.id === item.id)) return shown;
  return {
    ...shown,
    story: { ...story, lead: story.lead.id === item.id ? item : story.lead, items: story.items.map((i) => (i.id === item.id ? item : i)) },
    pick: shown.pick && shown.pick.item.id === item.id ? { ...shown.pick, item } : shown.pick,
  };
}

/**
 * The Feed (KI-94): the magazine (picks on the left, newest down the right)
 * when the Feed is at least `MAGAZINE_MIN_WIDTH` wide, else For you /
 * Newest tabs. Opening a story or an article shows it in place of the lists.
 */
export function Feed() {
  const section = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>("magazine");
  const [tab, setTab] = useState<"foryou" | "newest">("foryou");
  const [entries, setEntries] = useState<{ shown: Shown[]; total: number }>({ shown: [], total: 0 });
  const [picks, setPicks] = useState<Shown[]>([]);
  const [morePicks, setMorePicks] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [managing, setManaging] = useState(false);
  const [stack, setStack] = useState<View[]>([]);
  const listScroll = useRef(0);
  const loaded = useRef(PAGE);
  loaded.current = Math.max(PAGE, entries.shown.length);
  const request = useRef(0);
  const pickRequest = useRef(0);
  const morePending = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const impressions = useRef(new Impressions(feed.impressions));
  const observer = useRef<IntersectionObserver | null>(null);

  // The layout follows the Feed's own width, not a setting.
  useLayoutEffect(() => {
    const element = section.current;
    if (!element) return;
    const measure = () => setLayout(layoutFor(element.clientWidth));
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(element);
    return () => watcher.disconnect();
  }, []);

  /** Reloads the window already shown, so a refresh never jumps back to the top. */
  const reload = useCallback(async () => {
    const seq = ++request.current;
    try {
      const [next, all] = await Promise.all([feed.entries({ limit: Math.min(100, loaded.current) }), feed.sources()]);
      if (seq !== request.current) return;
      setEntries({ shown: next.entries.map(fromEntry), total: next.total });
      setSources(all);
      setError(undefined);
    } catch (e) {
      if (seq === request.current) setError(String(e));
    } finally {
      if (seq === request.current) setLoading(false);
    }
  }, []);

  const reloadPicks = useCallback(async () => {
    const seq = ++pickRequest.current;
    try {
      const next = await feed.picked();
      if (seq === pickRequest.current) setPicks(next.picks.map(fromPick));
    } catch (e) {
      if (seq === pickRequest.current) console.warn("Picked for you", e);
    }
  }, []);

  useEffect(() => {
    void reload();
    void reloadPicks();
    const off = listen(FEED_CHANGED, () => {
      void reload();
      void reloadPicks();
    });
    const refresh = () => void reloadPicks();
    window.addEventListener(PICKED_REFRESH, refresh);
    return () => {
      off.then((stop) => stop());
      window.removeEventListener(PICKED_REFRESH, refresh);
    };
  }, [reload, reloadPicks]);

  useItemChanges((item) => {
    if (item.dismissed) return; // feed:changed reloads the lists
    setEntries((old) => ({ ...old, shown: old.shown.map((s) => patch(s, item)) }));
    setPicks((old) => old.map((s) => patch(s, item)));
  });

  // Impressions: a card or row counts as seen once half of it has been on screen.
  useEffect(() => {
    const tracker = impressions.current;
    observer.current = new IntersectionObserver(
      (seen) => {
        for (const entry of seen) {
          if (!entry.isIntersecting) continue;
          const element = entry.target as HTMLElement;
          const surface = element.dataset.surface === "picked" ? "picked" : "newest";
          tracker.add({ id: Number(element.dataset.feedItem), position: Number(element.dataset.position), surface });
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

  const track = useCallback(
    (position: number) => (element: HTMLElement | null) => {
      if (!element) return;
      element.dataset.position = String(position);
      observer.current?.observe(element);
      return () => observer.current?.unobserve(element);
    },
    [],
  );

  const more = useCallback(async () => {
    if (morePending.current || entries.shown.length >= entries.total) return;
    morePending.current = true;
    const seq = request.current;
    try {
      const next = await feed.entries({ offset: entries.shown.length, limit: PAGE });
      if (seq !== request.current) return;
      setEntries((old) => {
        const keys = new Set(old.shown.map(shownKey));
        return { total: next.total, shown: [...old.shown, ...next.entries.map(fromEntry).filter((s) => !keys.has(shownKey(s)))] };
      });
    } catch (e) {
      toast.error(String(e));
    } finally {
      morePending.current = false;
    }
  }, [entries]);

  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const watcher = new IntersectionObserver((seen) => seen.some((e) => e.isIntersecting) && void more(), { rootMargin: "600px" });
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [more, layout, tab, stack.length]);

  const open: Open = useCallback((target) => {
    setStack((old) => {
      if (!old.length) listScroll.current = scroller.current?.scrollTop ?? 0;
      return [...old, target];
    });
    scroller.current?.scrollTo({ top: 0 });
  }, []);

  const back = useCallback(() => {
    setStack((old) => old.slice(0, -1));
  }, []);

  // Back on the lists, they're where he left them.
  useLayoutEffect(() => {
    if (!stack.length) scroller.current?.scrollTo({ top: listScroll.current });
  }, [stack.length]);

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
  const view = stack.at(-1);
  const empty = !loading && entries.shown.length === 0;

  const tools = (
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
  );

  const attention = failing > 0 && (
    <p className="mt-1.5 text-xs">
      <button type="button" className="text-destructive underline-offset-2 hover:underline" onClick={() => setManaging(true)}>
        {failing} {failing === 1 ? "source needs" : "sources need"} attention
      </button>
    </p>
  );

  const pickCards = (wide: boolean) => {
    const shown = morePicks ? picks : picks.slice(0, FIRST_PICKS);
    if (!picks.length) return null;
    return (
      <section aria-label="Picked for you" className="flex flex-col gap-8">
        <Card ref={track(0)} shown={shown[0]} place={{ surface: "picked", position: 0 }} open={open} size="lead" wide={wide} />
        {shown.length > 1 && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-8 border-t border-border/60 pt-6">
            {shown.slice(1).map((s, i) => (
              <Card key={shownKey(s)} ref={track(i + 1)} shown={s} place={{ surface: "picked", position: i + 1 }} open={open} size="card" />
            ))}
          </div>
        )}
        {picks.length > FIRST_PICKS && (
          <Button variant="ghost" size="sm" className="self-start text-muted-foreground" onClick={() => setMorePicks((m) => !m)}>
            {morePicks ? "Show fewer" : `Show ${picks.length - FIRST_PICKS} more`}
          </Button>
        )}
      </section>
    );
  };

  const newest = (thumbnails: boolean, heading: ReactNode) => (
    <div aria-label="Newest first" role="feed" aria-busy={loading}>
      {heading}
      {entries.shown.map((s, position) => (
        <Row key={shownKey(s)} ref={track(position)} shown={s} place={{ surface: "newest", position }} open={open} thumbnail={thumbnails} />
      ))}
      <div ref={sentinel} className="h-px" />
      {entries.shown.length >= entries.total && entries.total > 0 && (
        <p className="pt-6 text-center text-xs text-muted-foreground/70">Items you don’t act on are removed after 30 days.</p>
      )}
    </div>
  );

  const count = (
    <span role="status" className="text-xs text-muted-foreground tabular-nums">
      {entries.total.toLocaleString()} {entries.total === 1 ? "item" : "items"}
    </span>
  );

  const emptyState = (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Rss className="mb-6 size-7 stroke-1 text-muted-foreground/40" />
      <h2 className="ki-prose-title">{sources.length ? "Nothing new yet." : "You’re not following anything yet."}</h2>
      <Button variant="ghost" className="mt-5 text-muted-foreground" onClick={() => setManaging(true)}>
        {sources.length ? "See what you follow" : "Follow something"}
      </Button>
    </div>
  );

  const errorLine = error && (
    <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
      <span>{error}</span>
      <Button variant="ghost" size="sm" onClick={() => void reload()}>
        Try again
      </Button>
    </div>
  );

  return (
    <section ref={section} className="relative flex h-full min-h-0 flex-col" aria-label="Feed" data-layout={layout}>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-7 pt-[calc(3.5rem-var(--ki-titlebar-lift))] pb-10 lg:px-10">
        {view?.kind === "story" && (
          <StoryPage key={`s${view.id}`} id={view.id} initial={view.story} pick={view.pick} place={view.place ?? { surface: "newest", position: 0 }} open={open} onBack={back} />
        )}
        {view?.kind === "item" && (
          <ItemPage
            key={`i${view.id}`}
            id={view.id}
            initial={view.item}
            pick={view.pick}
            note={view.note}
            place={view.place ?? { surface: "newest", position: 0 }}
            backLabel={stack.length > 1 && stack.at(-2)?.kind === "story" ? "Story" : stack.length > 1 ? "Back" : "Feed"}
            open={open}
            onBack={back}
          />
        )}
        <div hidden={!!view} className={cn("mx-auto", layout === "magazine" ? "max-w-[78rem]" : "max-w-3xl")}>
          {layout === "magazine" ? (
            <>
              <header className="mb-8 flex items-start justify-between gap-5">
                <div>
                  <h1 className="ki-title">Feed</h1>
                  {attention}
                </div>
                {tools}
              </header>
              {errorLine}
              {empty ? (
                emptyState
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] items-start gap-12">
                  <div>{pickCards(false)}</div>
                  {newest(
                    false,
                    <div className="flex items-baseline justify-between border-b border-foreground/80 pb-2">
                      <h2 className="ki-prose-title">Newest</h2>
                      {count}
                    </div>,
                  )}
                </div>
              )}
            </>
          ) : (
            <Tabs.Root value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
              <header className="mb-6 flex items-start justify-between gap-5">
                <div className="flex items-end gap-6">
                  <div>
                    <h1 className="ki-title">Feed</h1>
                    {attention}
                  </div>
                  {!empty && (
                    <Tabs.List className="mb-1.5">
                      <Tabs.Tab value="foryou">For you</Tabs.Tab>
                      <Tabs.Tab value="newest">Newest</Tabs.Tab>
                    </Tabs.List>
                  )}
                </div>
                {tools}
              </header>
              {errorLine}
              {empty ? (
                emptyState
              ) : (
                <>
                  <Tabs.Panel value="foryou">{tab === "foryou" && (picks.length ? pickCards(false) : newest(true, null))}</Tabs.Panel>
                  <Tabs.Panel value="newest">{tab === "newest" && newest(true, <div className="flex justify-end border-b border-border/60 pb-2">{count}</div>)}</Tabs.Panel>
                </>
              )}
            </Tabs.Root>
          )}
        </div>
      </div>
      <Sources open={managing} onOpenChange={setManaging} sources={sources} onChanged={() => void reload()} />
    </section>
  );
}
