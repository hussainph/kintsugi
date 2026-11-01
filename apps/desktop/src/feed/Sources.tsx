import { save as pickSavePath } from "@tauri-apps/plugin-dialog";
import { AtSign, Download, Headphones, Newspaper, RotateCw, Rss, Search, Trash2, Upload, Video } from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@kintsugi/ui/components/sheet";
import { Switch } from "@kintsugi/ui/components/switch";
import { cn } from "@kintsugi/ui/lib/utils";
import { feed, HN_LISTS, type HnList, type Podcast, type Source, type SourceKind, type Subscribe } from "./api";
import { health, sourceName } from "./model";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: Source[];
  onChanged: () => void;
};

type Tab = "url" | "hn" | "youtube" | "podcast" | "x";
const TABS: [Tab, string][] = [["url", "Link"], ["hn", "Hacker News"], ["youtube", "YouTube"], ["podcast", "Podcast"], ["x", "X"]];

const KIND_ICON: Record<SourceKind, ReactNode> = {
  feed: <Rss className="size-3.5" />,
  hn: <Newspaper className="size-3.5" />,
  youtube: <Video className="size-3.5" />,
  podcast: <Headphones className="size-3.5" />,
  x: <AtSign className="size-3.5" />,
};

/** Following: add sources, see each one's health, mute, and move them in and out as OPML. */
export function Sources({ open, onOpenChange, sources, onChanged }: Props) {
  const [tab, setTab] = useState<Tab>("url");
  const [url, setUrl] = useState("");
  const [channel, setChannel] = useState("");
  const [account, setAccount] = useState("");
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

  const placeholder = { url: "A blog, site or feed URL", youtube: "Channel URL, @handle or channel ID", podcast: "Search podcasts by name", x: "@handle or x.com profile URL", hn: "" }[tab];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[420px] flex-col gap-0 sm:max-w-[420px]" aria-describedby={undefined}>
        <SheetHeader className="pb-2">
          <SheetTitle>Following</SheetTitle>
          <SheetDescription>Everything here fills your feed. Nothing is kept unless you save it.</SheetDescription>
        </SheetHeader>

        <form onSubmit={submit} className="space-y-3 px-4 pb-5" aria-label="Follow something">
          <div role="tablist" aria-label="Kind of source" className="flex gap-1 rounded-lg bg-muted/60 p-1">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={cn("flex-1 rounded-md px-2 py-1 text-xs whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring", tab === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {label}
              </button>
            ))}
          </div>
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
              <p className="text-[11px] text-muted-foreground">Through hnrss.org. A points threshold keeps it to the stories people stayed for.</p>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                aria-label={placeholder}
                placeholder={placeholder}
                value={tab === "url" ? url : tab === "youtube" ? channel : tab === "x" ? account : term}
                onChange={(e) => (tab === "url" ? setUrl : tab === "youtube" ? setChannel : tab === "x" ? setAccount : setTerm)(e.target.value)}
                className="h-9"
              />
              <Button type="submit" disabled={!!busy}>
                {tab === "podcast" ? (busy === "search" ? "Searching…" : <><Search />Search</>) : busy === tab ? "Following…" : "Follow"}
              </Button>
            </div>
          )}
          {tab === "url" && <p className="text-[11px] text-muted-foreground">RSS, Atom or JSON Feed. A page that links to its feed works too.</p>}
          {tab === "youtube" && <p className="text-[11px] text-muted-foreground">New uploads arrive through the channel’s feed. YouTube sometimes stalls; Kintsugi keeps trying.</p>}
          {tab === "x" && <p className="text-[11px] text-muted-foreground">Their own posts and threads, through FxTwitter. No X account needed; it’s best-effort.</p>}
          {tab === "podcast" && podcasts && (
            <ul className="max-h-60 space-y-1 overflow-y-auto" aria-label="Podcasts found">
              {podcasts.length === 0 && <li className="py-2 text-xs text-muted-foreground">No podcasts with a public feed matched.</li>}
              {podcasts.map((podcast) => (
                <li key={podcast.feedUrl} className="flex items-center gap-3 rounded-md px-1 py-1.5">
                  {podcast.artwork ? <img src={podcast.artwork} alt="" referrerPolicy="no-referrer" className="size-9 rounded bg-muted object-cover" /> : <div className="size-9 rounded bg-muted" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{podcast.title}</p>
                    {podcast.author && <p className="truncate text-[11px] text-muted-foreground">{podcast.author}</p>}
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
                  <li key={source.id} aria-label={name} className={cn("group/source flex items-start gap-3 rounded-md py-2", source.muted && "opacity-60")}>
                    <span className="mt-0.5 text-muted-foreground" aria-hidden>{KIND_ICON[source.kind]}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm" title={source.url}>{name}</p>
                      <p className={cn("mt-0.5 flex items-center gap-1.5 text-[11px]", state.tone === "error" ? "text-destructive" : "text-muted-foreground")} data-health={state.tone}>
                        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", { ok: "bg-emerald-500/80", waiting: "bg-muted-foreground/40", error: "bg-destructive", muted: "bg-muted-foreground/30" }[state.tone])} />
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
