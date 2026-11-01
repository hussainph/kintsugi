import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpRight, BookmarkCheck, BookmarkPlus, EyeOff, Headphones, Heart, MessagesSquare, NotebookPen, Video } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Textarea } from "@kintsugi/ui/components/textarea";
import { cn } from "@kintsugi/ui/lib/utils";
import { discuss as discussWithKin, useScreenContext } from "@/lib/chat";
import { feed, refreshPicked, type FeedItem as Item, type Place } from "./api";
import { describeEffect } from "./ranking";
import { ago, itemTitle, paragraphs, webUrl } from "./model";

type Props = {
  ref?: Ref<HTMLElement>;
  item: Item;
  place: Place;
  onChange: (item: Item) => void;
  onDismiss: (item: Item) => void;
  /** Below the actions: Picked for you's "Why this?". */
  footer?: ReactNode;
};

const requestClip = (path: string) => window.dispatchEvent(new CustomEvent("kintsugi:open-clip", { detail: { path } }));

/** One item: what it is, then the four things he can do with it. */
export function FeedItem({ ref, item, place, onChange, onDismiss, footer }: Props) {
  const [reading, setReading] = useState<{ text: string | null } | null>(null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState(item.note ?? "");
  const [busy, setBusy] = useState<"save" | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const noteSaved = useRef(item.note ?? "");
  const noteQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<number | undefined>(undefined);

  // Another window of the list (a refresh) can bring a newer copy.
  useEffect(() => {
    if (note === noteSaved.current) setNote(item.note ?? "");
    noteSaved.current = item.note ?? "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.note]);

  const title = itemTitle(item);
  const link = webUrl(item.url);
  const chip = { kind: "feed", path: String(item.id), label: title };
  // The item he's reading is what Kin's chat picks up.
  useScreenContext(`feed:${item.id}`, reading ? () => [chip] : null, [item.id, title]);
  const when = item.publishedAt ?? item.fetchedAt;

  const run = async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (e) {
      toast.error(String(e));
      return undefined;
    }
  };

  /** Notes are queued so a save always carries the latest words. */
  const flushNote = (text = note) => {
    window.clearTimeout(timer.current);
    noteQueue.current = noteQueue.current.then(async () => {
      if (text.trim() === noteSaved.current.trim()) return true;
      const next = await run(() => feed.note(item.id, text, place));
      if (!next) return false;
      noteSaved.current = next.note ?? "";
      onChange(next);
      return true;
    });
    return noteQueue.current;
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const toggleLike = async () => {
    const liked = !item.liked;
    const next = await run(() => feed.act(item.id, liked ? "like" : "unlike", place));
    if (!next) return;
    onChange(next);
    // What the like changed in Picked for you, with an exact undo.
    const effect = liked ? await feed.effect(item.id).catch(() => null) : null;
    refreshPicked();
    if (liked) {
      toast("Liked", {
        description: effect ? describeEffect(effect) : "A signal for Picked for you.",
        action: {
          label: "Undo",
          onClick: () =>
            void feed
              .act(item.id, "unlike", place)
              .then((undone) => {
                onChange(undone);
                refreshPicked();
              })
              .catch((e) => toast.error(String(e))),
        },
      });
    }
  };

  const save = async () => {
    if (item.savedPath) return requestClip(item.savedPath);
    setBusy("save");
    try {
      if (!(await flushNote())) return;
      const next = await run(() => feed.save(item.id, place));
      if (!next?.savedPath) return;
      onChange(next);
      refreshPicked();
      const path = next.savedPath;
      toast("Saved to Inspiration", {
        description: next.note ? "Your note went with it." : undefined,
        action: { label: "Open", onClick: () => requestClip(path) },
      });
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async () => {
    await flushNote();
    const next = await run(() => feed.act(item.id, "notInterested", place));
    if (!next) return;
    onDismiss(next);
    refreshPicked();
    toast("Not interested", {
      description: "Hidden. The strongest signal Picked for you gets.",
      action: {
        label: "Undo",
        onClick: () =>
          void feed
            .act(item.id, "undoNotInterested", place)
            .then((undone) => {
              onChange(undone);
              refreshPicked();
            })
            .catch((e) => toast.error(String(e))),
      },
    });
  };

  const read = async () => {
    if (reading) return setReading(null);
    const result = await run(() => feed.read(item.id, place));
    if (result) setReading({ text: result.text });
  };

  const openOriginal = () => {
    if (!link) return;
    void feed.act(item.id, "openOriginal", place).catch(() => {});
    void openUrl(link).catch((e) => toast.error(String(e)));
  };

  const discuss = () => {
    void feed.act(item.id, "discuss", place).catch(() => {});
    discussWithKin(chip);
  };

  return (
    <article
      ref={ref}
      data-feed-item={item.id}
      aria-label={title}
      className="group/item border-b border-border/60 py-5 last:border-b-0"
    >
      <div className="flex gap-5">
        <div className="min-w-0 flex-1">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {item.media === "video" && <Video className="size-3" aria-label="Video" />}
            {item.media === "audio" && <Headphones className="size-3" aria-label="Audio" />}
            <span className="truncate">{item.sourceTitle ?? "Feed"}</span>
            {item.author && item.author !== item.sourceTitle && <span className="truncate">· {item.author}</span>}
            <span aria-hidden>·</span>
            <time dateTime={new Date(when * 1000).toISOString()} title={new Date(when * 1000).toLocaleString()}>{ago(when)}</time>
          </p>
          <h2 className="text-[15px] leading-snug font-medium">
            <button type="button" className="text-left outline-none hover:underline focus-visible:underline" aria-expanded={!!reading} onClick={read}>
              {title}
            </button>
          </h2>
          {item.summary && item.summary !== title && !reading && (
            <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-muted-foreground">{item.summary}</p>
          )}
        </div>
        {item.image && !imageFailed && (
          <button type="button" tabIndex={-1} aria-hidden onClick={read} className="shrink-0">
            <img
              src={item.image}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setImageFailed(true)}
              className="h-[72px] w-[108px] rounded-md bg-muted object-cover"
            />
          </button>
        )}
      </div>

      {reading && (
        <div className="mt-4 rounded-lg bg-muted/40 px-5 py-4" role="region" aria-label={`Reading ${title}`}>
          {reading.text ? (
            <div className="max-w-prose space-y-3 font-[family-name:var(--font-prose)] text-[15px] leading-relaxed whitespace-pre-line">
              {paragraphs(reading.text).map((p, i) => <p key={i}>{p}</p>)}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">This feed only sends a headline.</p>
          )}
          {link && (
            <Button variant="link" size="sm" className="mt-3 h-auto px-0 text-muted-foreground" onClick={openOriginal}>
              Open the original <ArrowUpRight />
            </Button>
          )}
        </div>
      )}

      {!item.savedPath && (noting || item.note) && (
        <Textarea
          autoFocus={noting && !item.note}
          aria-label={`Note on ${title}`}
          placeholder="What does this make you think?"
          value={note}
          onChange={(e) => {
            const text = e.target.value;
            setNote(text);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => void flushNote(text), 800);
          }}
          onBlur={() => {
            void flushNote();
            if (!note.trim()) setNoting(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          className="mt-3 min-h-16 resize-none border-0 bg-muted/50 text-sm shadow-none focus-visible:ring-1"
        />
      )}
      {item.savedPath && item.note && (
        <p className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-sm whitespace-pre-line text-muted-foreground">{item.note}</p>
      )}

      <div className="mt-3 -ml-2 flex items-center gap-0.5 text-muted-foreground">
        <Button variant="ghost" size="sm" aria-pressed={item.liked} onClick={toggleLike} className={cn(item.liked && "text-foreground")}>
          <Heart className={cn(item.liked && "fill-current text-primary")} />
          {item.liked ? "Liked" : "Like"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={noting || !!item.note}
          disabled={!!item.savedPath}
          title={item.savedPath ? "Saved items keep their note in Inspiration" : undefined}
          onClick={() => setNoting(true)}
        >
          <NotebookPen />
          Note
        </Button>
        <Button variant="ghost" size="sm" onClick={save} disabled={busy === "save"} className={cn(item.savedPath && "text-foreground")}>
          {item.savedPath ? <BookmarkCheck className="text-primary" /> : <BookmarkPlus />}
          {item.savedPath ? "Saved · Open" : busy === "save" ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" size="sm" onClick={discuss} title="Discuss with Kin">
          <MessagesSquare />
          Discuss
        </Button>
        <Button variant="ghost" size="sm" onClick={dismiss} className="ml-auto opacity-70 group-hover/item:opacity-100 focus-visible:opacity-100">
          <EyeOff />
          Not interested
        </Button>
      </div>
      {footer}
    </article>
  );
}
