import { save as pickSavePath } from "@tauri-apps/plugin-dialog";
import { BookUser, Browser, Download, Newspaper, Podcast as PodcastIcon, RotateCw, Rss, Search, Trash2, Upload, XLogo, YouTube, type IconComponent } from "@kintsugi/ui/icons";
import { Tabs } from "@kintsugi/ui/graphical";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@kintsugi/ui/components/sheet";
import { Switch } from "@kintsugi/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@kintsugi/ui/components/tooltip";
import { cn } from "@kintsugi/ui/lib/utils";
import { feed, HN_LISTS, type HnList, type Podcast, type Source, type SourceKind, type Subscribe } from "./api";
import { health, sourceLogos, sourceName } from "./model";
import { CatalogueControl } from "./CatalogueControl";
import { GroupingControl } from "./GroupingControl";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: Source[];
  onChanged: () => void;
};

type Tab = "url" | "hn" | "youtube" | "podcast" | "x" | "page" | "author";

const KIND_ICON: Record<SourceKind, IconComponent> = {
  feed: Rss,
  hn: Newspaper,
  youtube: YouTube,
  podcast: PodcastIcon,
  x: XLogo,
  page: Browser,
  author: BookUser,
};

const TABS: [Tab, string, IconComponent][] = [
  ["url", "Link", KIND_ICON.feed],
  ["hn", "HN", KIND_ICON.hn],
  ["youtube", "YouTube", KIND_ICON.youtube],
  ["podcast", "Podcast", KIND_ICON.podcast],
  ["x", "X", KIND_ICON.x],
  ["page", "Page", KIND_ICON.page],
  ["author", "Author", KIND_ICON.author],
];

/** A source's artwork or favicon, falling back to its type icon. */
function SourceLogo({ source }: { source: Source }) {
  const [failed, setFailed] = useState<string[]>([]);
  const logo = sourceLogos(source).find((url) => !failed.includes(url));
  const Icon = KIND_ICON[source.kind];
  return (
    <span aria-hidden className="mt-px flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-sm text-muted-foreground">
      {logo ? (
        <img key={logo} src={logo} alt="" referrerPolicy="no-referrer" loading="lazy" className="size-full object-cover" onError={() => setFailed((urls) => [...urls, logo])} />
      ) : (
        <Icon className="size-4" />
      )}
    </span>
  );
}

/** Following: add sources, see each one's health, mute, and move them in and out as OPML. */
export function Sources({ open, onOpenChange, sources, onChanged }: Props) {
  const [tab, setTab] = useState<Tab>("url");
  const [url, setUrl] = useState("");
  const [channel, setChannel] = useState("");
  const [account, setAccount] = useState("");
  const [page, setPage] = useState("");
  const [author, setAuthor] = useState("");
  const [list, setList] = useState<HnList>("frontpage");
  const [points, setPoints] = useState("");
  const [term, setTerm] = useState("");
  const [podcasts, setPodcasts] = useState<Podcast[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const follow = async (input: Subscribe, label: string) => {
    setBusy(label);
    try {
      const result = await feed.subscribe(input);
      const name = sourceName(result.source);
      if (result.error) toast.error(`Following ${name}, but it didn’t load: ${result.error}`);
      else toast(`Following ${name}`, { description: result.added ? `${result.added} new ${result.added === 1 ? "item" : "items"} in your feed.` : "Nothing new right now." });
      setUrl("");
      setChannel("");
      setAccount("");
      setPage("");
      setAuthor("");
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (tab === "url" && url.trim()) void follow({ kind: "url", url: url.trim() }, "url");
    if (tab === "youtube" && channel.trim()) void follow({ kind: "youtube", channel: channel.trim() }, "youtube");
    if (tab === "x" && account.trim()) void follow({ kind: "x", account: account.trim() }, "x");
    if (tab === "page" && page.trim()) void follow({ kind: "page", url: page.trim() }, "page");
    if (tab === "author" && author.trim()) void follow({ kind: "author", name: author.trim() }, "author");
    if (tab === "hn") {
      const min = Number.parseInt(points, 10);
      void follow({ kind: "hn", list, ...(min > 0 ? { points: min } : {}) }, "hn");
    }
    if (tab === "podcast" && term.trim()) void searchPodcasts();
  };

  const searchPodcasts = async () => {
    setBusy("search");
    try {
      setPodcasts(await feed.podcasts(term.trim()));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const mute = async (source: Source, muted: boolean) => {
    try {
      await feed.mute(source.id, muted);
      onChanged();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const refresh = async (source: Source) => {
    setBusy(`refresh:${source.id}`);
    try {
      const [polled] = await feed.refresh(source.id);
      if (polled?.error) toast.error(`${sourceName(source)}: ${polled.error}`);
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (source: Source) => {
    if (confirmRemove !== source.id) return setConfirmRemove(source.id);
    setConfirmRemove(null);
    try {
      await feed.unsubscribe(source.id);
      toast(`Unfollowed ${sourceName(source)}`, { description: "What you liked, noted or saved from it is kept." });
      onChanged();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const importOpml = async (chosen: File | undefined) => {
    if (!chosen) return;
    try {
      const result = await feed.importOpml(await chosen.text());
      const parts = [`${result.added} new`];
      if (result.existing) parts.push(`${result.existing} already followed`);
      if (result.invalid) parts.push(`${result.invalid} skipped`);
      toast(`Imported subscriptions`, { description: `${parts.join(", ")}. New sources fetch in the background.` });
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      if (file.current) file.current.value = "";
    }
  };

  const exportOpml = async () => {
    try {
      const path = await pickSavePath({ title: "Export subscriptions", defaultPath: "kintsugi-subscriptions.opml", filters: [{ name: "OPML", extensions: ["opml"] }] });
      if (!path) return;
      const count = await feed.exportOpml(path);
      toast(`Exported ${count} ${count === 1 ? "subscription" : "subscriptions"}`, { description: path });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const placeholder = { url: "A blog, site or feed URL", youtube: "Channel URL, @handle or channel ID", podcast: "Search podcasts by name", x: "@handle or x.com profile URL", page: "A page URL to watch for changes", author: "An author’s name", hn: "" }[tab];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col gap-0 data-[side=right]:w-full data-[side=right]:max-w-[420px] data-[side=right]:sm:max-w-[420px]" aria-describedby={undefined}>
        <SheetHeader className="pb-2">
          <SheetTitle>Following</SheetTitle>
        </SheetHeader>

        <form onSubmit={submit} className="space-y-3 px-4 pb-5" aria-label="Follow something">
          <Tabs.Root value={tab} onValueChange={(value) => setTab(value as Tab)}>
            <Tabs.List aria-label="Kind of source" className="flex w-full">
              {TABS.map(([key, label, Icon]) => {
                const active = tab === key;
                const trigger = (
                  <Tabs.Tab key={key} value={key} aria-label={label} className={cn("min-w-0 gap-1.5 px-2 text-xs", active ? "flex-none" : "flex-1")}>
                    <Icon className="size-4 shrink-0" />
                    {active && <span className="truncate">{label}</span>}
                  </Tabs.Tab>
                );
                return active ? trigger : (
                  <Tooltip key={key}>
                    <TooltipTrigger asChild>{trigger}</TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </Tabs.List>
          </Tabs.Root>
          {tab === "hn" ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Hacker News list">
                {HN_LISTS.map(([key, label]) => (
                  <button key={key} type="button" role="radio" aria-checked={list === key} onClick={() => setList(key)} className={cn("rounded-full px-3 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring", list === key ? "bg-foreground text-background" : "bg-muted/60 text-muted-foreground hover:text-foreground")}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <Input aria-label="Minimum points" inputMode="numeric" placeholder="Minimum points (optional)" value={points} onChange={(e) => setPoints(e.target.value.replace(/\D/g, ""))} className="h-9" />
                <Button type="submit" disabled={!!busy}>{busy === "hn" ? "Following…" : "Follow"}</Button>
              </div>
              <p className="text-xs text-muted-foreground">Through hnrss.org.</p>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                aria-label={placeholder}
                placeholder={placeholder}
                value={{ url, youtube: channel, x: account, page, author, podcast: term, hn: "" }[tab]}
                onChange={(e) => ({ url: setUrl, youtube: setChannel, x: setAccount, page: setPage, author: setAuthor, podcast: setTerm, hn: setTerm }[tab])(e.target.value)}
                className="h-9"
              />
              <Button type="submit" disabled={!!busy}>
                {tab === "podcast" ? (busy === "search" ? "Searching…" : <><Search />Search</>) : busy === tab ? "Following…" : "Follow"}
              </Button>
            </div>
          )}
          {tab === "url" && <p className="text-xs text-muted-foreground">RSS, Atom, JSON Feed, or a page that links to one.</p>}
          {tab === "youtube" && <p className="text-xs text-muted-foreground">YouTube’s feeds sometimes stall; Kintsugi keeps trying.</p>}
          {tab === "x" && <p className="text-xs text-muted-foreground">Through FxTwitter, best-effort. No X account needed.</p>}
          {tab === "page" && <p className="text-xs text-muted-foreground">Checked every few hours. Dates and counters are ignored.</p>}
          {tab === "author" && <p className="text-xs text-muted-foreground">Weekly, through Google Books and Open Library.</p>}
          {tab === "podcast" && podcasts && (
            <ul className="max-h-60 space-y-1 overflow-y-auto" aria-label="Podcasts found">
              {podcasts.length === 0 && <li className="py-2 text-xs text-muted-foreground">No podcasts with a public feed matched.</li>}
              {podcasts.map((podcast) => (
                <li key={podcast.feedUrl} className="flex items-center gap-3 rounded-md px-1 py-1.5">
                  {podcast.artwork ? <img src={podcast.artwork} alt="" referrerPolicy="no-referrer" className="size-9 rounded bg-muted object-cover" /> : <div className="size-9 rounded bg-muted" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{podcast.title}</p>
                    {podcast.author && <p className="truncate text-xs text-muted-foreground">{podcast.author}</p>}
                  </div>
                  <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => void follow({ kind: "podcast", feedUrl: podcast.feedUrl, title: podcast.title }, `podcast:${podcast.feedUrl}`)}>
                    {busy === `podcast:${podcast.feedUrl}` ? "Following…" : "Follow"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/60 px-4 py-3">
          {sources.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Not following anything yet.</p>
          ) : (
            <ul aria-label="Sources" className="space-y-1">
              {sources.map((source) => {
                const state = health(source);
                const name = sourceName(source);
                return (
                  <li key={source.id} aria-label={name} className={cn("group/source rounded-md py-2", source.muted && "opacity-60")}>
                    <div className="flex items-start gap-3">
                    <SourceLogo source={source} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm" title={source.url}>{name}</p>
                      <p className={cn("mt-0.5 flex items-center gap-1.5 text-xs", state.tone === "error" ? "text-destructive" : "text-muted-foreground")} data-health={state.tone}>
                        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", { ok: "bg-[var(--success)]", waiting: "bg-muted-foreground/40", error: "bg-destructive", muted: "bg-muted-foreground/30" }[state.tone])} />
                        <span className="line-clamp-2">{state.label}</span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button variant="ghost" size="icon-xs" aria-label={`Fetch ${name} now`} title="Fetch now" disabled={source.muted || busy === `refresh:${source.id}`} onClick={() => void refresh(source)}>
                        <RotateCw className={cn(busy === `refresh:${source.id}` && "animate-spin")} />
                      </Button>
                      <Switch size="sm" checked={!source.muted} aria-label={`${source.muted ? "Unmute" : "Mute"} ${name}`} title={source.muted ? "Muted" : "Showing in your feed"} onCheckedChange={(on) => void mute(source, !on)} />
                      <Button variant="ghost" size={confirmRemove === source.id ? "xs" : "icon-xs"} aria-label={`Unfollow ${name}`} className={cn(confirmRemove === source.id && "text-destructive")} onClick={() => void remove(source)} onBlur={() => setConfirmRemove(null)}>
                        {confirmRemove === source.id ? "Unfollow" : <Trash2 />}
                      </Button>
                    </div>
                    </div>
                    <CatalogueControl source={source} onChanged={onChanged} />
                    <GroupingControl source={source} onChanged={onChanged} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border/60 px-4 py-3">
          <input ref={file} type="file" accept=".opml,.xml,text/x-opml,text/xml,application/xml" aria-label="OPML file to import" className="hidden" onChange={(e) => void importOpml(e.target.files?.[0])} />
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => file.current?.click()}>
            <Upload />Import OPML
          </Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={!sources.length} onClick={() => void exportOpml()}>
            <Download />Export OPML
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
