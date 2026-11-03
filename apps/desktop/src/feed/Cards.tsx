// The Feed's cards (picks) and rows (Newest). One card shows an article or a
// story the same way: its picture, a serif title, two lines, and who said it.
import { cn } from "@kintsugi/ui/lib/utils";
import type { Ref } from "react";
import type { FeedItem as Item, Pick, Place, Story } from "./api";
import { itemActions, storyActions } from "./actions";
import { itemSource, itemTitle, sourcesLine, storyBlurb, webUrl } from "./model";
import { ActionRow, itemIcon, ItemWhen, MediaMark, menuIcons, Picture, serif, SourceIcons, When, WhyThis, type Icon, type MenuEntry } from "./parts";
import { FollowSuggestion } from "./SuggestionActions";

/** An entry as the Feed shows it: an article or a story, with its pick if it is one. */
export type Shown = ({ kind: "item"; item: Item } | { kind: "story"; story: Story }) & { pick?: Pick };

/** What to open, and where it was (for the event log). */
export type Open = (
  target: ({ kind: "item"; id: number; item?: Item; note?: boolean } | { kind: "story"; id: number; story?: Story }) & { pick?: Pick; place?: Place },
) => void;

/** The item that stands for it: the article, or the story's pick (else its lead). */
export const standIn = (shown: Shown): Item => (shown.kind === "item" ? shown.item : (shown.pick?.item ?? shown.story.lead));

export const shownKey = (shown: Shown) => (shown.kind === "item" ? `i${shown.item.id}` : `s${shown.story.id}`);

function describe(shown: Shown) {
  if (shown.kind === "item") {
    const { item } = shown;
    const { name, via } = itemSource(item);
    return {
      title: itemTitle(item),
      image: item.image,
      text: item.summary && item.summary !== item.title ? item.summary : null,
      icons: [itemIcon(item)] as Icon[],
      sources: via ? `${name} · via ${via}` : name,
      at: item.publishedAt ?? item.fetchedAt,
      lead: item,
    };
  }
  const { story } = shown;
  return {
    title: story.title,
    image: story.image,
    text: storyBlurb(story),
    icons: story.sources.map((s) => ({ key: s.id, title: s.title, kind: s.kind, site: s.site })),
    sources: sourcesLine(story.sources),
    at: story.sortAt,
    lead: story.lead,
  };
}

/** The … menu's entries for an article or a story. */
export function menuFor(shown: Shown, place: Place, open: Open, onDismissed?: () => void): MenuEntry[] {
  if (shown.kind === "story") {
    const act = storyActions(shown.story, place);
    return [
      { label: "Discuss", icon: menuIcons.discuss, onSelect: act.discuss },
      { label: "Not interested", icon: menuIcons.dismiss, onSelect: () => void act.dismiss().then((done) => done && onDismissed?.()) },
    ];
  }
  const { item } = shown;
  const act = itemActions(item, place);
  return [
    { label: "Note", icon: menuIcons.note, onSelect: () => open({ kind: "item", id: item.id, item, note: true, place }), disabled: !!item.savedPath },
    { label: "Discuss", icon: menuIcons.discuss, onSelect: act.discuss },
    { label: "Open the original", icon: menuIcons.open, onSelect: act.openOriginal, disabled: !webUrl(item.url) },
    { label: "Not interested", icon: menuIcons.dismiss, onSelect: () => void act.dismiss().then((done) => done && onDismissed?.()) },
  ];
}

const go = (shown: Shown, open: Open, place: Place) =>
  shown.kind === "item"
    ? open({ kind: "item", id: shown.item.id, item: shown.item, pick: shown.pick, place })
    : open({ kind: "story", id: shown.story.id, story: shown.story, pick: shown.pick, place });

type CardProps = {
  ref?: Ref<HTMLElement>;
  shown: Shown;
  place: Place;
  open: Open;
  /** lead: the big one; card: a grid cell. */
  size: "lead" | "card";
  /** The lead card puts its picture beside the text when there's room. */
  wide?: boolean;
};

export function Card({ ref, shown, place, open, size, wide }: CardProps) {
  const d = describe(shown);
  const act = shown.kind === "item" ? itemActions(shown.item, place) : storyActions(shown.story, place);
  const lead = size === "lead";
  return (
    <article
      ref={ref}
      data-feed-item={standIn(shown).id}
      data-story={shown.kind === "story" ? shown.story.id : undefined}
      data-surface={place.surface}
      aria-label={d.title}
      className={cn("group/card flex min-w-0 flex-col gap-3", lead && wide && "lg:grid lg:grid-cols-[1fr_1.1fr] lg:items-start lg:gap-8")}
    >
      {d.image && (
        <button type="button" tabIndex={-1} aria-hidden onClick={() => go(shown, open, place)} className={cn("block overflow-hidden rounded-xl", lead && wide && "lg:order-2")}>
          <Picture src={d.image} className={cn("w-full", lead ? "aspect-[2/1]" : "aspect-[16/10]", lead && wide && "lg:aspect-[16/10]")} />
        </button>
      )}
      <div className="flex min-w-0 flex-col gap-2">
        <h2 className={cn(serif, "text-pretty", lead ? "text-[1.75rem] leading-tight" : "text-lg leading-snug")}>
          <button type="button" className="text-left outline-none hover:underline focus-visible:underline" onClick={() => go(shown, open, place)}>
            {d.title}
          </button>
        </h2>
        {d.text && <p className={cn("text-pretty text-muted-foreground", lead ? `${serif} line-clamp-3 text-base leading-relaxed` : "line-clamp-2 text-sm leading-relaxed")}>{d.text}</p>}
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <SourceIcons sources={d.icons} />
            <span className="truncate">{d.sources}</span>
            <span aria-hidden>·</span>
            {shown.kind === "item" ? <ItemWhen item={shown.item} /> : <When at={d.at} />}
          </p>
          <ActionRow
            liked={d.lead.liked}
            saved={!!d.lead.savedPath}
            onLike={() => void act.like()}
            onSave={() => void act.save()}
            menu={menuFor(shown, place, open)}
            why={{ id: standIn(shown).id, title: d.title, reasons: shown.pick?.reasons }}
            extra={shown.kind === "item" && <FollowSuggestion item={shown.item} />}
          />
        </div>
      </div>
    </article>
  );
}

/** A dense row in Newest: source icons, the title, who and when; a small picture in the tabs. */
export function Row({ ref, shown, place, open, thumbnail }: { ref?: Ref<HTMLElement>; shown: Shown; place: Place; open: Open; thumbnail?: boolean }) {
  const d = describe(shown);
  return (
    <article
      ref={ref}
      data-feed-item={standIn(shown).id}
      data-story={shown.kind === "story" ? shown.story.id : undefined}
      data-surface={place.surface}
      aria-label={d.title}
      className="flex items-center gap-1 border-b border-border/60 last:border-b-0"
    >
      <button type="button" onClick={() => go(shown, open, place)} className="flex min-w-0 flex-1 items-start gap-3 py-3 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/50">
        <span className="mt-0.5">
          <SourceIcons sources={d.icons} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-snug font-medium text-pretty">{d.title}</span>
          <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            {shown.kind === "item" && <MediaMark item={shown.item} />}
            <span className="truncate">{d.sources}</span>
            <span aria-hidden>·</span>
            {shown.kind === "item" ? <ItemWhen item={shown.item} /> : <When at={d.at} />}
          </span>
        </span>
        {thumbnail && <Picture src={d.image} className="h-12 w-16 shrink-0 rounded-md" />}
      </button>
      {shown.kind === "item" && shown.item.suggestion && (
        // A suggested piece (KI-95) keeps its one-click Follow and its (?) in the row.
        <div className="flex shrink-0 items-center">
          <FollowSuggestion item={shown.item} />
          <WhyThis id={shown.item.id} title={d.title} />
        </div>
      )}
    </article>
  );
}
