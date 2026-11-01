import { listen } from "@tauri-apps/api/event";
import { Compass, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { cn } from "@kintsugi/ui/lib/utils";
import { feed, FEED_CHANGED, PICKED_REFRESH, type FeedItem as Item, type Pick, type Picked as PickedList, type Reason } from "./api";
import { FeedItem } from "./FeedItem";
import { Impressions } from "./model";
import { learning } from "./ranking";

/** Shown before "Show more". */
const FIRST = 4;

/**
 * Picked for you (KI-32): a few items ranked locally for him, one of them
 * exploring. Each says why it's here, and any removable reason can be taken
 * away as a correction, with undo.
 */
export function Picked() {
  const [list, setList] = useState<PickedList | null>(null);
  const [expanded, setExpanded] = useState(false);
  const request = useRef(0);
  const impressions = useRef(new Impressions(feed.impressions));
  const observer = useRef<IntersectionObserver | null>(null);

  const reload = useCallback(async () => {
    const seq = ++request.current;
    try {
      const next = await feed.picked();
      if (seq === request.current) setList(next);
    } catch (e) {
      if (seq === request.current) console.warn("Picked for you", e);
    }
  }, []);

  useEffect(() => {
    void reload();
    const off = listen(FEED_CHANGED, () => void reload());
    const refresh = () => void reload();
    window.addEventListener(PICKED_REFRESH, refresh);
    return () => {
      off.then((stop) => stop());
      window.removeEventListener(PICKED_REFRESH, refresh);
    };
  }, [reload]);

  useEffect(() => {
    const tracker = impressions.current;
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const element = entry.target as HTMLElement;
          tracker.add({ id: Number(element.dataset.feedItem), position: Number(element.dataset.position), surface: "picked" });
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

  const replace = useCallback((next: Item) => {
    setList((old) => old && { ...old, picks: old.picks.map((p) => (p.item.id === next.id ? { ...p, item: next } : p)) });
  }, []);

  const remove = async (pick: Pick, reason: Reason) => {
    try {
      await feed.correct(reason.key, pick.item.id);
      await reload();
      toast("Picked for you won’t use that", {
        description: `Removed: ${reason.label}.`,
        action: {
          label: "Undo",
          onClick: () => void feed.correct(reason.key, pick.item.id, true).then(reload).catch((e) => toast.error(String(e))),
        },
      });
    } catch (e) {
      toast.error(String(e));
    }
  };

  if (!list || list.picks.length === 0) return null;
  const shown = expanded ? list.picks : list.picks.slice(0, FIRST);

  return (
    <section aria-label="Picked for you" className="mb-8 rounded-xl bg-muted/30 px-5 pt-4 pb-2">
      <header className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-2">
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-3.5 text-primary" />
          Picked for you
        </h2>
        <span className="text-[11px] text-muted-foreground">{learning(list.examples, list.learnedShare)}</span>
      </header>
      {shown.map((pick, position) => (
        <FeedItem
          key={pick.item.id}
          ref={track(position)}
          item={pick.item}
          place={{ surface: "picked", position }}
          onChange={replace}
          onDismiss={() => void reload()}
          footer={<WhyThis pick={pick} onRemove={(reason) => void remove(pick, reason)} />}
        />
      ))}
      {list.picks.length > FIRST && (
        <Button variant="ghost" size="sm" className="mb-1 text-muted-foreground" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show fewer" : `Show ${list.picks.length - FIRST} more`}
        </Button>
      )}
    </section>
  );
}

/** "Why this?": the reasons behind a pick, each removable one a correction. */
function WhyThis({ pick, onRemove }: { pick: Pick; onRemove: (reason: Reason) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <Button variant="link" size="sm" className="h-auto px-0 text-xs text-muted-foreground" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          Why this?
        </Button>
        {pick.explore && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
            <Compass className="size-3" /> Exploring
          </span>
        )}
      </div>
      {open && (
        <ul aria-label={`Why ${pick.item.title ?? "this"}`} className="mt-1.5 space-y-1">
          {pick.reasons.map((reason) => (
            <li key={reason.key} className={cn("flex items-center justify-between gap-3 rounded-md px-2 py-1", reason.removable && "hover:bg-muted/60")}>
              <span>{reason.label}</span>
              {reason.removable && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  aria-label={`Don’t use this: ${reason.label}`}
                  onClick={() => onRemove(reason)}
                >
                  <X className="size-3" /> Don’t use this
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
