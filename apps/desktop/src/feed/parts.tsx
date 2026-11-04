// Small pieces every Feed view shares: source icons, the time, a picture
// that disappears when it can't load, the action row, and the (?) card.
import { BookOpen, BookmarkCheck, BookmarkPlus, EyeOff, FileDiff, Headphones, Heart, Video, CircleHelp, MessagesSquare, MoreHorizontal, NotebookPen, ArrowUpRight, X } from "@kintsugi/ui/icons";
import { Menu, Popover } from "@kintsugi/ui/graphical";
import { cn } from "@kintsugi/ui/lib/utils";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { KinAvatar } from "@/kin/Avatar";
import { feed, refreshPicked, type FeedItem as Item, type Reason, type Story } from "./api";
import { ago, itemDate, itemSource, sourceIcon, sourceLetter, summarised, summaryLabel } from "./model";
import { shownReasons } from "./ranking";

export const serif = "font-[family-name:var(--font-prose)]";

export type Icon = { key: string | number; title: string | null; kind: string; site: string | null };

/** An item's source as an icon: an HN item shows the site it links to. */
export const itemIcon = (item: Item): Icon =>
  item.sourceKind === "hn"
    ? { key: item.sourceId, title: itemSource(item).name, kind: "feed", site: item.url }
    : { key: item.sourceId, title: item.sourceTitle, kind: item.sourceKind, site: item.sourceSite };

function SourceIcon({ source, size }: { source: Icon; size: number }) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : sourceIcon(source);
  return (
    <span
      data-source-icon
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[0.6rem] leading-none font-medium text-muted-foreground shadow-[0_0_0_1.5px_var(--background)]"
      style={{ width: size, height: size }}
    >
      {src ? <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-cover" /> : sourceLetter(source.title)}
    </span>
  );
}

/** Up to three source icons, stacked. */
export function SourceIcons({ sources, size = 16 }: { sources: Icon[]; size?: number }) {
  return (
    <span aria-hidden className="inline-flex shrink-0 -space-x-0.5">
      {sources.slice(0, 3).map((s) => (
        <SourceIcon key={s.key} source={s} size={size} />
      ))}
    </span>
  );
}

/**
 * A story's sources. While Kin's summary is what shows, they carry the
 * summary mark (KI-105): Kin's colour behind the stack and Kin's mark in
 * front. An author's own text, or a story showing its lead's, never does.
 */
export function StorySources({ story, size = 16 }: { story: Pick<Story, "sources" | "summary">; size?: number }) {
  const icons: Icon[] = story.sources.map((s) => ({ key: s.id, title: s.title, kind: s.kind, site: s.site }));
  if (!summarised(story)) return <SourceIcons sources={icons} size={size} />;
  return (
    <span role="img" aria-label={summaryLabel(story.sources)} data-summary-mark className="ki-summary-mark">
      <KinAvatar className="shrink-0" style={{ width: size, height: size }} />
      {icons.slice(0, 3).map((s) => (
        <SourceIcon key={s.key} source={s} size={size} />
      ))}
    </span>
  );
}

/** What kind of thing it is, when it isn't an article: a video, audio, a new book, a page that changed. */
export function MediaMark({ item }: { item: Item }) {
  const mark = "size-3 shrink-0";
  if (item.media === "video") return <Video className={mark} aria-label="Video" />;
  if (item.media === "audio") return <Headphones className={mark} aria-label="Audio" />;
  if (item.media === "book") return <BookOpen className={mark} aria-label="New book" />;
  if (item.sourceKind === "page" && !item.backCatalogue) return <FileDiff className={mark} aria-label="Page changed" />;
  return null;
}

/**
 * An item's date: older writing (KI-95) says so and keeps its original date,
 * or "Date unknown"; a suggested piece says it's suggested.
 */
export function ItemWhen({ item }: { item: Item }) {
  const unknown = item.backCatalogue && item.publishedAt == null;
  const at = item.publishedAt ?? item.fetchedAt;
  return (
    <>
      {item.backCatalogue && (
        <>
          <span className="shrink-0">Older writing</span>
          <span aria-hidden>·</span>
        </>
      )}
      <time className="shrink-0" dateTime={unknown ? undefined : new Date(at * 1000).toISOString()} title={unknown ? undefined : new Date(at * 1000).toLocaleString()}>
        {itemDate(item)}
      </time>
      {item.suggestion && (
        <>
          <span aria-hidden>·</span>
          <span className="shrink-0">Suggested</span>
        </>
      )}
    </>
  );
}

export function When({ at }: { at: number }) {
  return (
    <time dateTime={new Date(at * 1000).toISOString()} title={new Date(at * 1000).toLocaleString()}>
      {ago(at)}
    </time>
  );
}

/** A picture that gets out of the way when it can't load: no stand-in art. */
export function Picture({ src, className }: { src: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={cn("bg-muted object-cover", className)} />;
}

const iconButton =
  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4";

/** The heart, the bookmark, the … menu and the (?): an item's or story's actions in a row. */
export function ActionRow({
  liked,
  saved,
  onLike,
  onSave,
  menu,
  why,
  extra,
  className,
}: {
  liked: boolean;
  saved: boolean;
  onLike: () => void;
  onSave: () => void;
  menu: MenuEntry[];
  why: WhyProps;
  /** Before the (?): a suggestion's Follow. */
  extra?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <button type="button" className={cn(iconButton, liked && "text-foreground")} aria-label={liked ? "Liked" : "Like"} aria-pressed={liked} onClick={onLike}>
        <Heart className={cn(liked && "fill-current text-primary")} />
      </button>
      <button type="button" className={cn(iconButton, saved && "text-foreground")} aria-label={saved ? "Saved · Open" : "Save"} onClick={onSave}>
        {saved ? <BookmarkCheck className="text-primary" /> : <BookmarkPlus />}
      </button>
      <MoreMenu entries={menu} />
      {extra}
      <WhyThis {...why} />
    </div>
  );
}

export type MenuEntry = { label: string; icon: typeof Heart; onSelect: () => void; disabled?: boolean };

export const menuIcons = { note: NotebookPen, discuss: MessagesSquare, open: ArrowUpRight, dismiss: EyeOff };

export function MoreMenu({ entries, label = "More" }: { entries: MenuEntry[]; label?: string }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<button type="button" aria-label={label} className={cn(iconButton, "border-0! shadow-none! before:hidden")} />}>
        <MoreHorizontal />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} collisionPadding={8}>
          <Menu.Popup className="min-w-44">
            {entries.map((entry) => (
              <Menu.Item key={entry.label} label={entry.label} disabled={entry.disabled} onClick={entry.onSelect} closeOnClick>
                <entry.icon aria-hidden className="size-4 text-muted-foreground" />
                <span>{entry.label}</span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export type WhyProps = {
  /** The item the reasons are about (a story's best or lead item). */
  id: number;
  title: string;
  /** Picked for you's reasons; others are asked for when the card opens. */
  reasons?: Reason[];
};

/** (?): the reasons behind an item in a small card. A removable reason is a correction, with Undo. */
export function WhyThis({ id, title, reasons }: WhyProps) {
  const [asked, setAsked] = useState<Reason[] | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const shown = shownReasons(reasons ?? asked ?? []).filter((r) => !removed.includes(r.key));

  const remove = async (reason: Reason) => {
    try {
      await feed.correct(reason.key, id);
      setRemoved((r) => [...r, reason.key]);
      refreshPicked();
      toast("Picked for you won’t use that", {
        description: `Removed: ${reason.label}.`,
        action: {
          label: "Undo",
          onClick: () =>
            void feed
              .correct(reason.key, id, true)
              .then(() => {
                setRemoved((r) => r.filter((k) => k !== reason.key));
                refreshPicked();
              })
              .catch((e) => toast.error(String(e))),
        },
      });
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open && !reasons) void feed.why(id).then(setAsked, () => setAsked([]));
      }}
    >
      <Popover.Trigger render={<button type="button" aria-label="Why this?" className={cn(iconButton, "border-0! shadow-none! before:hidden")} />}>
        <CircleHelp />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={8}>
          <Popover.Popup className="w-80 p-1.5">
            <ul aria-label={`Why ${title}`} className="text-sm">
              {shown.map((reason) => (
                <li key={reason.key} className="flex items-center justify-between gap-3 rounded-md px-2.5 py-2">
                  <span className="text-pretty">{reason.label}</span>
                  {reason.removable && (
                    <button
                      type="button"
                      aria-label={`Don’t use this: ${reason.label}`}
                      title="Don’t use this"
                      className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => void remove(reason)}
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </li>
              ))}
              {(reasons || asked) && shown.length === 0 && <li className="px-2.5 py-2 text-muted-foreground">You follow its source.</li>}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
