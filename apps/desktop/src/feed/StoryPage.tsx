// A story, opened (KI-94): its title, Kin's summary with a citation after
// each sentence, then its articles as one horizontal strip of compact
// tiles. Each tile's actions show on hover or focus.
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, BookmarkCheck, BookmarkPlus, Heart, MessagesSquare } from "@kintsugi/ui/icons";
import { Button } from "@kintsugi/ui/components/button";
import { cn } from "@kintsugi/ui/lib/utils";
import { useEffect, useState } from "react";
import { useScreenContext } from "@/lib/chat";
import { feed, FEED_CHANGED, type FeedItem as Item, type Pick, type Place, type Story } from "./api";
import { chipFor, itemActions, storyActions, useItemChanges } from "./actions";
import type { Open } from "./Cards";
import { ago, bySource, citeLabel, itemSource, itemTitle, paragraphs, storyCount, summaryNote } from "./model";
import { itemIcon, menuIcons, MoreMenu, Picture, serif, SourceIcons, StorySources, WhyThis } from "./parts";

/** Tiles shown before "+N more". */
const FIRST_TILES = 4;

type Props = { id: number; initial?: Story; pick?: Pick; place: Place; open: Open; onBack: () => void };

export function StoryPage({ id, initial, pick, place, open, onBack }: Props) {
  const [story, setStory] = useState<Story | null>(initial ?? null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      feed.story(id).then(
        (next) => live && setStory(next),
        () => live && setGone(true),
      );
    void load();
    const off = listen(FEED_CHANGED, () => void load());
    return () => {
      live = false;
      off.then((stop) => stop());
    };
  }, [id]);

  useItemChanges((item) =>
    setStory((old) =>
      old && {
        ...old,
        lead: old.lead.id === item.id ? item : old.lead,
        items: old.items.map((i) => (i.id === item.id ? item : i)),
      },
    ),
  );

  useScreenContext(`feed-story:${id}`, story ? () => story.items.map(chipFor) : null, [id, story?.items.length]);

  if (!story) {
    return (
      <div className="mx-auto max-w-3xl">
        <Back onBack={onBack} />
        {gone && <p className="mt-10 text-sm text-muted-foreground">This story isn’t in your Feed any more.</p>}
      </div>
    );
  }

  const act = storyActions(story, place);
  const note = story.summary ? null : summaryNote(story.summaryState);
  return (
    <article aria-label={story.title} data-story={story.id} className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between gap-4">
        <Back onBack={onBack} />
        <div className="flex items-center gap-0.5 text-muted-foreground">
          <Button variant="ghost" size="sm" aria-pressed={story.lead.liked} onClick={() => void act.like()} className={cn(story.lead.liked && "text-foreground")}>
            <Heart className={cn(story.lead.liked && "fill-current text-primary")} />
            {story.lead.liked ? "Liked" : "Like"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void act.save()} className={cn(story.lead.savedPath && "text-foreground")}>
            {story.lead.savedPath ? <BookmarkCheck className="text-primary" /> : <BookmarkPlus />}
            {story.lead.savedPath ? "Saved · Open" : "Save"}
          </Button>
          <Button variant="ghost" size="sm" onClick={act.discuss}>
            <MessagesSquare />
            Discuss
          </Button>
          <WhyThis id={pick?.item.id ?? story.lead.id} title={story.title} reasons={pick?.reasons} />
          <MoreMenu entries={[{ label: "Not interested", icon: menuIcons.dismiss, onSelect: () => void act.dismiss().then((done) => done && onBack()) }]} />
        </div>
      </div>

      <div className="mx-auto mt-8 max-w-[54rem]">
        <h1 className={cn(serif, "text-[2.5rem] leading-[1.15] text-pretty")}>{story.title}</h1>
        <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
          <StorySources story={story} />
          <span>{storyCount(story.sources)}</span>
          <span aria-hidden>·</span>
          <span>updated {ago(story.sortAt)}{/^\d/.test(ago(story.sortAt)) ? " ago" : ""}</span>
        </p>
      </div>

      <Strip story={story} place={place} open={open} />

      <div className="mx-auto max-w-[54rem]">
        <div aria-label="Summary" role="region" className={cn(serif, "mt-4 space-y-5 text-[1.125rem] leading-[1.75] text-pretty")}>
          {story.summary
            ? story.summary.paragraphs.map((paragraph, p) => (
                <p key={p}>
                  {paragraph.map((sentence, s) => {
                    const label = citeLabel(sentence.cites, story.items);
                    return (
                      <span key={s}>
                        {sentence.text}
                        {label && (
                          <button
                            type="button"
                            className="ki-cite"
                            aria-label={`Source: ${itemTitle(story.items.find((i) => i.id === sentence.cites[0])!)}`}
                            onClick={() => open({ kind: "item", id: sentence.cites[0], place })}
                          >
                            {label}
                          </button>
                        )}{" "}
                      </span>
                    );
                  })}
                </p>
              ))
            : paragraphs(story.lead.excerpt || story.lead.summary || "").map((p, i) => <p key={i}>{p}</p>)}
        </div>
        {note && <p className="mt-4 text-sm text-muted-foreground">{note}</p>}
      </div>
    </article>
  );
}

function Back({ onBack, label = "Feed" }: { onBack: () => void; label?: string }) {
  return (
    <Button variant="outline" size="sm" onClick={onBack}>
      <ArrowLeft />
      {label}
    </Button>
  );
}

/** The story's articles as compact tiles in one row that scrolls sideways. */
function Strip({ story, place, open }: { story: Story; place: Place; open: Open }) {
  const [all, setAll] = useState(false);
  // Each source's articles together; the tiles plus "+N more" add up to the count above.
  const items = bySource(story.items, story.sources);
  const shown = all ? items : items.slice(0, FIRST_TILES);
  const rest = items.slice(FIRST_TILES);
  return (
    <div role="list" aria-label="Articles" className="mx-auto mt-4 flex max-w-[54rem] snap-x gap-3 overflow-x-auto px-0.5 pt-5 pb-3">
      {shown.map((item) => (
        <Tile key={item.id} item={item} place={place} open={open} />
      ))}
      {!all && rest.length > 0 && (
        <div role="listitem" className="shrink-0">
          <button
            type="button"
            onClick={() => setAll(true)}
            className="flex h-full min-h-24 w-28 flex-col justify-between rounded-xl bg-muted/60 p-3 text-left text-sm text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SourceIcons sources={rest.map(itemIcon)} />
            <span>+{rest.length} more</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** One article: quiet at rest; its actions float over its corner on hover or focus. */
function Tile({ item, place, open }: { item: Item; place: Place; open: Open }) {
  const act = itemActions(item, place);
  const title = itemTitle(item);
  const { name, via } = itemSource(item);
  const tool = "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4";
  return (
    <div role="listitem" aria-label={title} data-feed-item={item.id} className="group/tile relative w-52 shrink-0 snap-start">
      <button
        type="button"
        onClick={() => open({ kind: "item", id: item.id, item, place })}
        className="flex h-full min-h-24 w-full items-start gap-3 rounded-xl bg-muted/60 p-3 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <SourceIcons sources={[itemIcon(item)]} size={14} />
            <span className="truncate">{via ? `${name} · via ${via}` : name}</span>
            {item.liked && <Heart aria-label="Liked" className="size-3 shrink-0 fill-current text-primary" />}
            {item.savedPath && <BookmarkCheck aria-label="Saved" className="size-3 shrink-0 text-primary" />}
          </span>
          <span className="mt-1.5 line-clamp-3 text-sm leading-snug font-medium text-pretty">{title}</span>
        </span>
        <Picture src={item.image} className="size-12 shrink-0 rounded-md" />
      </button>
      <div
        role="toolbar"
        aria-label={`Actions for ${title}`}
        className="pointer-events-none absolute -top-4 right-2 flex items-center gap-0.5 rounded-lg bg-popover p-0.5 opacity-0 shadow-md ring-1 ring-border/60 transition-opacity group-focus-within/tile:pointer-events-auto group-focus-within/tile:opacity-100 group-hover/tile:pointer-events-auto group-hover/tile:opacity-100"
      >
        <button type="button" className={tool} aria-label="Open" onClick={() => open({ kind: "item", id: item.id, item, place })}>
          <menuIcons.open />
        </button>
        <button type="button" className={cn(tool, item.liked && "text-foreground")} aria-label={item.liked ? "Liked" : "Like"} aria-pressed={item.liked} onClick={() => void act.like()}>
          <Heart className={cn(item.liked && "fill-current text-primary")} />
        </button>
        <button type="button" className={tool} aria-label={item.savedPath ? "Saved · Open" : "Save"} onClick={() => void act.save()}>
          {item.savedPath ? <BookmarkCheck className="text-primary" /> : <BookmarkPlus />}
        </button>
        <button type="button" className={tool} aria-label="Note" disabled={!!item.savedPath} onClick={() => open({ kind: "item", id: item.id, item, note: true, place })}>
          <menuIcons.note />
        </button>
        <button type="button" className={tool} aria-label="Discuss" onClick={act.discuss}>
          <menuIcons.discuss />
        </button>
        <button type="button" className={tool} aria-label="Not interested" onClick={() => void act.dismiss()}>
          <menuIcons.dismiss />
        </button>
      </div>
    </div>
  );
}
