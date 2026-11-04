// One article, opened: its text (the full article once fetched), his note,
// and the actions. Reading it is logged as an `open`.
import { ArrowLeft, ArrowUpRight, BookmarkCheck, BookmarkPlus, Heart, MessagesSquare, NotebookPen } from "@kintsugi/ui/icons";
import { Button } from "@kintsugi/ui/components/button";
import { Textarea } from "@kintsugi/ui/components/textarea";
import { cn } from "@kintsugi/ui/lib/utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useScreenContext } from "@/lib/chat";
import { feed, type Coverage, type FeedItem as Item, type Pick, type Place } from "./api";
import type { Open } from "./Cards";
import { Reader } from "./Reader";
import { announce, chipFor, itemActions, useItemChanges } from "./actions";
import { itemSource, itemTitle, webUrl } from "./model";
import { itemIcon, ItemWhen, MediaMark, menuIcons, MoreMenu, Picture, serif, SourceIcons, WhyThis } from "./parts";
import { FollowSuggestion } from "./SuggestionActions";

type Props = {
  id: number;
  initial?: Item;
  pick?: Pick;
  place: Place;
  /** Open with the note field ready. */
  note?: boolean;
  /** What the back button returns to: the Feed, or the story it came from. */
  backLabel: string;
  /** Opens news about the same thing ("Also covered by"). */
  open: Open;
  onBack: () => void;
};

export function ItemPage({ id, initial, pick, place, note: startNoting, backLabel, open, onBack }: Props) {
  const [item, setItem] = useState<Item | null>(initial ?? null);
  const [text, setText] = useState<string | null | undefined>(undefined);
  const [coverage, setCoverage] = useState<Coverage[]>([]);
  const [noting, setNoting] = useState(!!startNoting);
  const [note, setNote] = useState(initial?.note ?? "");
  const noteSaved = useRef(initial?.note ?? "");
  const noteQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let live = true;
    feed.read(id, place).then(
      (reading) => {
        if (!live) return;
        setItem(reading.item);
        setText(reading.text);
        setCoverage(reading.coverage ?? []);
        if (note === noteSaved.current) setNote(reading.item.note ?? "");
        noteSaved.current = reading.item.note ?? "";
      },
      (e) => live && toast.error(String(e)),
    );
    return () => {
      live = false;
    };
    // Opening is logged once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useItemChanges((changed) => {
    if (changed.id !== id) return;
    setItem(changed);
    if (note === noteSaved.current) setNote(changed.note ?? "");
    noteSaved.current = changed.note ?? "";
  });

  useScreenContext(`feed:${id}`, item ? () => [chipFor(item)] : null, [id, item?.title]);

  if (!item) {
    return (
      <div className="mx-auto max-w-3xl">
        <Back label={backLabel} onBack={onBack} />
      </div>
    );
  }

  /** Notes are queued so a save always carries the latest words. */
  const flushNote = (words = note) => {
    window.clearTimeout(timer.current);
    noteQueue.current = noteQueue.current.then(async () => {
      if (words.trim() === noteSaved.current.trim()) return true;
      try {
        const next = await feed.note(item.id, words, place);
        noteSaved.current = next.note ?? "";
        announce([next]);
        return true;
      } catch (e) {
        toast.error(String(e));
        return false;
      }
    });
    return noteQueue.current;
  };

  const act = itemActions(item, place);
  const title = itemTitle(item);
  const { name, via } = itemSource(item);
  const link = webUrl(item.url);
  const discussion = webUrl(item.discussion);
  // A page's change or a book says what it is in its summary, not its text.
  const dek = text !== undefined && (item.sourceKind === "page" || item.media === "book") ? item.summary : null;
  return (
    <article aria-label={title} data-feed-item={item.id} className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between gap-4">
        <Back label={backLabel} onBack={onBack} />
        <div className="flex items-center gap-0.5 text-muted-foreground">
          <Button variant="ghost" size="sm" aria-pressed={item.liked} onClick={() => void act.like()} className={cn(item.liked && "text-foreground")}>
            <Heart className={cn(item.liked && "fill-current text-primary")} />
            {item.liked ? "Liked" : "Like"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void act.save(flushNote)} className={cn(item.savedPath && "text-foreground")}>
            {item.savedPath ? <BookmarkCheck className="text-primary" /> : <BookmarkPlus />}
            {item.savedPath ? "Saved · Open" : "Save"}
          </Button>
          <Button variant="ghost" size="sm" aria-pressed={noting || !!item.note} disabled={!!item.savedPath} onClick={() => setNoting(true)}>
            <NotebookPen />
            Note
          </Button>
          <Button variant="ghost" size="sm" onClick={act.discuss}>
            <MessagesSquare />
            Discuss
          </Button>
          <FollowSuggestion item={item} />
          <WhyThis id={item.id} title={title} reasons={pick?.item.id === item.id ? pick.reasons : undefined} />
          <MoreMenu
            entries={[
              { label: "Open the original", icon: menuIcons.open, onSelect: act.openOriginal, disabled: !link },
              { label: "Not interested", icon: menuIcons.dismiss, onSelect: () => void flushNote().then(() => act.dismiss()).then((done) => done && onBack()) },
            ]}
          />
        </div>
      </div>

      <div className="mx-auto mt-8 max-w-[44rem]">
        <h1 className={cn(serif, "text-[2.25rem] leading-[1.15] text-pretty")}>{title}</h1>
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          <SourceIcons sources={[itemIcon(item)]} />
          <MediaMark item={item} />
          <span>{name}</span>
          {item.author && item.author !== item.sourceTitle && <span>· {item.author}</span>}
          <span aria-hidden>·</span>
          <ItemWhen item={item} />
          {via && (
            <>
              <span aria-hidden>·</span>
              {discussion ? (
                <button type="button" className="underline-offset-2 hover:underline" onClick={() => void openUrl(discussion).catch((e) => toast.error(String(e)))}>
                  via {via}
                </button>
              ) : (
                <span>via {via}</span>
              )}
            </>
          )}
        </p>

        {dek && <p className="mt-4 text-sm text-pretty text-muted-foreground">{dek}</p>}

        {!item.savedPath && (noting || item.note) && (
          <Textarea
            autoFocus={noting && !item.note}
            aria-label={`Note on ${title}`}
            placeholder="Add a note…"
            value={note}
            onChange={(e) => {
              const words = e.target.value;
              setNote(words);
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => void flushNote(words), 800);
            }}
            onBlur={() => {
              void flushNote();
              if (!note.trim()) setNoting(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.currentTarget.blur();
            }}
            className="mt-5 min-h-16 resize-none border-0 bg-muted/50 text-sm shadow-none focus-visible:ring-1"
          />
        )}
        {item.savedPath && item.note && <p className="mt-5 rounded-md bg-muted/40 px-3 py-2 text-sm whitespace-pre-line text-muted-foreground">{item.note}</p>}

        {/* The reader shows a picture that's in the text where the author put it. */}
        {!(text && item.image && text.includes(item.image)) && <Picture src={item.image} className="mt-6 max-h-96 w-full rounded-xl" />}

        <div role="region" aria-label={`Reading ${title}`} className="mt-6">
          {text === undefined ? (
            (item.excerpt || item.summary) && <p className={cn(serif, "text-[1.0625rem] leading-[1.75] text-muted-foreground")}>{item.excerpt || item.summary}</p>
          ) : text ? (
            <Reader markdown={text} title={title} base={link} />
          ) : (
            <p className="text-sm text-muted-foreground">This feed only sends a headline.</p>
          )}
        </div>
        {coverage.length > 0 && <AlsoCovered coverage={coverage} open={open} />}
        {link && (
          <Button variant="link" size="sm" className="mt-4 h-auto px-0 text-muted-foreground" onClick={act.openOriginal}>
            Open the original <ArrowUpRight />
          </Button>
        )}
      </div>
    </article>
  );
}

/** News about the same thing as this piece of writing: links, never folded into it (KI-105). */
function AlsoCovered({ coverage, open }: { coverage: Coverage[]; open: Open }) {
  return (
    <p data-coverage className="mt-6 text-sm text-pretty text-muted-foreground">
      Also covered by{" "}
      {coverage.map((c, i) => (
        <span key={c.id}>
          {i > 0 && (i === coverage.length - 1 ? " and " : ", ")}
          <button
            type="button"
            title={c.title}
            className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
            onClick={() => open(c.story != null ? { kind: "story", id: c.story } : { kind: "item", id: c.id })}
          >
            {c.source}
          </button>
        </span>
      ))}
    </p>
  );
}

function Back({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onBack}>
      <ArrowLeft />
      {label}
    </Button>
  );
}
