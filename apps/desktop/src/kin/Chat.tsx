import { listen } from "@tauri-apps/api/event";
import { Bookmark, ChevronDown, FileText, Lightbulb, Loader2, Pilcrow, Rss, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@kintsugi/ui/components/popover";
import { Textarea } from "@kintsugi/ui/components/textarea";
import { cn } from "@kintsugi/ui/lib/utils";
import { chat, type ChatEvent, type Entry, type Job, jobs, onDiscuss, onOpenKin, onScreenChanged, type Page, screenChips, type Topic } from "@/lib/chat";
import { type Chip, chipKey, chipTitle, mergeChips, snippet, throttle } from "@/lib/chips";
import { KinAvatar } from "./Avatar";

const EMPTY: Page = { entries: [], threads: [], pending: [], running: null };
const ACTIVE: Job["status"][] = ["queued", "running", "waiting"];

type Live = { turn: string; text: string; looking: string[] };

const chipIcon = (kind: string) =>
  kind === "clip" ? Bookmark : kind === "feed" ? Rss : kind === "idea" ? Lightbulb : kind === "paragraph" || kind === "selection" ? Pilcrow : FileText;

/** "Searched “kiln”", "Read drafts/x.md": what Kin is doing, briefly. */
function describe(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name === "search") return `Searched “${String(a.query ?? "")}”`;
  if (name === "read") return `Read ${String(a.path ?? "")}`;
  if (name === "list") return `Looked in ${String(a.path || "the vault")}`;
  if (name === "tool") {
    const inner = (a.args ?? {}) as Record<string, unknown>;
    if (a.name === "history") return inner.query ? `Searched our history for “${String(inner.query)}”` : "Read our history";
    return `Used ${String(a.name ?? "a tool")}`;
  }
  return name;
}

function ChipView({ chip, onRemove }: { chip: Chip; onRemove?: () => void }) {
  const Icon = chipIcon(chip.kind);
  const title = chipTitle(chip);
  return (
    <span
      data-chip={chipKey(chip)}
      title={`${chip.kind} · ${chip.path}${chip.lines ? ` · lines ${chip.lines[0]}–${chip.lines[1]}` : ""}`}
      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{title}</span>
      {onRemove && (
        <button type="button" aria-label={`Remove ${title}`} onClick={onRemove} className="-mr-0.5 rounded-full p-0.5 hover:bg-foreground/10 hover:text-foreground">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

function Message({ entry, waiting }: { entry: Entry; waiting: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (entry.role === "owner") {
    return (
      <div className="flex flex-col items-end gap-1" data-entry={entry.seq} data-role="owner">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3 py-2 text-sm whitespace-pre-wrap select-text">{entry.text}</p>
        {(entry.chips?.length || waiting) && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
            {entry.chips?.map((c) => <ChipView key={chipKey(c)} chip={c} />)}
            {waiting && <span className="text-[11px] text-muted-foreground">waiting</span>}
          </div>
        )}
      </div>
    );
  }
  if (entry.role === "helper") {
    return (
      <button
        type="button"
        data-entry={entry.seq}
        data-role="helper"
        onClick={() => setExpanded((e) => !e)}
        className="w-full rounded-lg border border-dashed px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/40"
      >
        <span className="mb-1 block text-[10px] tracking-wide uppercase">Helper report</span>
        <span className={cn("block whitespace-pre-wrap select-text", !expanded && "line-clamp-3")}>{entry.text}</span>
      </button>
    );
  }
  return (
    <div className="flex gap-2" data-entry={entry.seq} data-role="kin">
      <KinAvatar className="mt-0.5 size-5 shrink-0" />
      {entry.error ? (
        <p className="text-sm text-destructive" role="alert">Kin couldn’t answer: {entry.error}</p>
      ) : (
        <p className="min-w-0 text-sm leading-relaxed whitespace-pre-wrap select-text">
          {entry.text}
          {entry.interrupted && <span className="ml-1 text-xs text-muted-foreground" data-interrupted>— interrupted</span>}
        </p>
      )}
    </div>
  );
}

/**
 * Kin everywhere: one avatar on every screen, opening one chat. Whatever is
 * on screen comes along as removable chips; the conversation shown is the
 * thread for what's on screen (a view of the one log), resumable later.
 * ⌘J toggles it; `discuss()` opens it with an item attached.
 */
export function KinChat() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<string | null>(null);
  /** What a message sent now would be about (names a thread not yet started). */
  const [topic, setTopic] = useState<Topic | null>(null);
  const [page, setPage] = useState<Page>(EMPTY);
  const [live, setLive] = useState<Live | null>(null);
  const [helpers, setHelpers] = useState<Job[]>([]);
  const [pinned, setPinned] = useState<Chip[]>([]);
  const [screen, setScreen] = useState<Chip[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState("");
  const [unread, setUnread] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const openRef = useRef(open);
  openRef.current = open;
  const liveRef = useRef(live);
  liveRef.current = live;
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const loadSeq = useRef(0);

  const chips = useMemo(() => mergeChips(pinned, screen, removed), [pinned, screen, removed]);

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const next = await chat.log(viewRef.current);
      if (seq === loadSeq.current) setPage(next);
    } catch (e) {
      if (seq === loadSeq.current) toast.error(String(e));
    }
  }, []);

  /** Shows the thread for these chips: where he left off with this item. */
  const follow = useCallback(async (with_: Chip[]) => {
    try {
      const next = await chat.topic(with_);
      setTopic(next);
      setView(next.key);
    } catch {
      // The log view stays where it is.
    }
  }, []);

  const readScreen = useCallback(() => {
    const next = screenChips();
    setScreen((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
    return next;
  }, []);

  useEffect(() => {
    if (open) void reload();
  }, [open, view, reload]);

  // The conversation's events: new entries, Kin streaming, helpers.
  useEffect(() => {
    const off = listen<ChatEvent>("kin:chat", ({ payload: event }) => {
      switch (event.type) {
        case "entry":
          if (event.entry.role !== "owner" && !openRef.current) setUnread(true);
          return void reload();
        case "turnStarted":
          setLive({ turn: event.turn, text: "", looking: [] });
          return void reload();
        case "turn": {
          const e = event.event;
          return setLive((l) => {
            if (!l || l.turn !== event.turn) return l;
            if (e.type === "text") return { ...l, text: l.text + e.delta };
            if (e.type === "toolCall") return { ...l, text: "", looking: [...l.looking, describe(e.name, e.arguments)] };
            return l;
          });
        }
        case "turnEnded":
          setLive((l) => (l?.turn === event.turn ? null : l));
          return void reload();
        case "thread":
          return void reload();
        case "job":
          return setHelpers((list) => [event.job, ...list.filter((j) => j.id !== event.job.id)]);
      }
    });
    jobs.list().then(setHelpers).catch(() => {});
    return () => {
      off.then((stop) => stop());
    };
  }, [reload]);

  const show = useCallback(() => {
    const now = readScreen();
    setOpen(true);
    setUnread(false);
    void follow(mergeChips(pinned, now, removed));
    requestAnimationFrame(() => input.current?.focus());
  }, [readScreen, follow, pinned, removed]);

  const showRef = useRef(show);
  showRef.current = show;

  /** Closing ends what Discuss brought in; next time starts from the screen. */
  const close = useCallback(() => {
    setOpen(false);
    setPinned([]);
    setRemoved(new Set());
  }, []);

  // ⌘J, the avatar, openKin() and discuss() all open the one chat.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        e.stopPropagation();
        if (openRef.current) close();
        else showRef.current();
      }
    };
    window.addEventListener("keydown", key, true);
    const offOpen = onOpenKin(() => showRef.current());
    const offDiscuss = onDiscuss(({ chips: brought, text, send: sendNow }) => {
      setPinned((old) => mergeChips(brought, old, new Set()));
      setRemoved((old) => {
        const next = new Set(old);
        for (const c of brought) next.delete(chipKey(c));
        return next;
      });
      const now = readScreen();
      const attached = mergeChips(brought, now, new Set());
      if (text && sendNow) {
        chat.send(text, attached).then((entry) => {
          if (entry.topic !== viewRef.current) setView(entry.topic);
          else void reload();
        }).catch((e) => {
          setDraft(text);
          toast.error(String(e));
        });
      } else if (text) setDraft(text);
      setOpen(true);
      setUnread(false);
      void follow(attached);
      requestAnimationFrame(() => input.current?.focus());
    });
    return () => {
      window.removeEventListener("keydown", key, true);
      offOpen();
      offDiscuss();
    };
  }, [readScreen, follow, close, reload]);

  // While open, follow the screen: another document brings its own thread;
  // a new selection becomes a chip.
  useEffect(() => {
    if (!open) return;
    const offScreen = onScreenChanged(() => {
      const now = readScreen();
      void follow(mergeChips(pinned, now, removed));
    });
    let timer: number | undefined;
    const selection = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(readScreen, 150);
    };
    document.addEventListener("selectionchange", selection);
    return () => {
      offScreen();
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", selection);
    };
  }, [open, readScreen, follow, pinned, removed]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [page.entries.length, live?.text, live?.looking.length, open]);

  const ping = useMemo(() => throttle(() => void chat.typing().catch(() => {}), 400), []);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      const entry = await chat.send(text, chips);
      if (entry.topic !== viewRef.current) setView(entry.topic);
      else void reload();
    } catch (e) {
      setDraft(text);
      toast.error(String(e));
    }
  };

  const thread = page.threads.find((t) => t.key === view);
  const threadLabel = view === null ? "Everything" : thread?.label ?? (topic?.key === view ? topic.label : "Anything");
  const working = helpers.filter((j) => ACTIVE.includes(j.status));
  const answering = new Set(page.running?.answers ?? []);
  const talking = !!live;

  let lastTopic: string | null = null;
  return (
    <>
      <button
        type="button"
        aria-label={open ? "Close Kin" : "Ask Kin"}
        title="Kin (⌘J)"
        aria-expanded={open}
        onClick={() => (open ? close() : show())}
        className="fixed right-4 bottom-4 z-40 rounded-full shadow-md ring-1 ring-foreground/10 transition-transform outline-none hover:scale-105 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none"
      >
        <KinAvatar talking={talking} />
        {(unread || working.some((j) => j.status === "running")) && (
          <span aria-hidden data-kin-unread={unread || undefined} className={cn("absolute -top-0.5 -right-0.5 size-3 rounded-full ring-2 ring-background", unread ? "bg-[#d4a53c]" : "bg-muted-foreground motion-safe:animate-pulse")} />
        )}
      </button>

      {open && (
        <section
          role="dialog"
          aria-label="Kin"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
          className="fixed right-4 bottom-17 z-40 flex h-[min(620px,calc(100svh-6rem))] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-xl ring-1 ring-foreground/10"
        >
          <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
            <KinAvatar className="size-6" talking={talking} />
            <Popover open={threadsOpen} onOpenChange={setThreadsOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start gap-1 px-1.5 font-normal" aria-label="Conversation">
                  <span className="truncate text-sm" data-thread={view ?? "*"}>
                    {view === null ? "Everything" : `About ${threadLabel}`}
                  </span>
                  <ChevronDown className="shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="max-h-80 w-72 overflow-y-auto p-1">
                <button type="button" className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => { setView(null); setThreadsOpen(false); }}>
                  Everything <span className="text-xs text-muted-foreground">· the whole conversation</span>
                </button>
                {page.threads.map((t) => (
                  <button key={t.key || "*general"} type="button" className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => { setView(t.key); setThreadsOpen(false); }}>
                    <span className="block truncate">{t.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">{t.summary ? snippet(t.summary, 70) : `${t.entries} message${t.entries === 1 ? "" : "s"}`}</span>
                  </button>
                ))}
              </PopoverContent>
            </Popover>
            <Button variant="ghost" size="icon-sm" aria-label="Close Kin" onClick={close}>
              <X />
            </Button>
          </header>

          {thread?.summary && (
            <button type="button" onClick={() => setSummaryOpen((s) => !s)} className="shrink-0 border-b bg-muted/30 px-3 py-2 text-left text-xs text-muted-foreground" aria-label="Thread summary">
              <span className="mr-1 font-medium text-foreground/70">So far:</span>
              <span className={cn(!summaryOpen && "line-clamp-2")}>{thread.summary}</span>
            </button>
          )}

          <div ref={scroller} className="inspiration-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-4" aria-label="Conversation" aria-live="polite">
            {!page.entries.length && !live && (
              <p className="pt-10 text-center text-sm text-muted-foreground">
                {view ? `Nothing said about ${threadLabel} yet. Ask away.` : "Ask Kin about what’s on screen, or anything."}
              </p>
            )}
            {page.entries.map((entry) => {
              const divider = view === null && entry.topic !== lastTopic;
              lastTopic = entry.topic;
              const label = page.threads.find((t) => t.key === entry.topic)?.label ?? "anything";
              return (
                <div key={entry.seq} className="space-y-4">
                  {divider && (
                    <p className="text-center text-[10px] tracking-wide text-muted-foreground uppercase">About {label}</p>
                  )}
                  <Message entry={entry} waiting={page.pending.includes(entry.seq) && !answering.has(entry.seq)} />
                </div>
              );
            })}
            {live && (
              <div className="flex gap-2" data-live>
                <KinAvatar className="mt-0.5 size-5 shrink-0" talking />
                <div className="min-w-0 space-y-1">
                  {live.looking.map((l, i) => (
                    <p key={i} className="text-xs text-muted-foreground">{l}</p>
                  ))}
                  <p className="text-sm leading-relaxed whitespace-pre-wrap select-text">
                    {live.text || <span className="text-muted-foreground">Thinking…</span>}
                    <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-foreground/50 motion-safe:animate-pulse" aria-hidden />
                  </p>
                </div>
              </div>
            )}
            {!live && page.pending.length > 0 && <p className="text-xs text-muted-foreground" data-listening>Kin is listening…</p>}
          </div>

          {working.length > 0 && (
            <div className="shrink-0 space-y-1 border-t px-3 py-1.5" aria-label="Helpers">
              {working.slice(0, 3).map((j) => (
                <p key={j.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground" data-job={j.status}>
                  {j.status === "running" ? <Loader2 className="size-3 motion-safe:animate-spin" /> : <span className="size-3" />}
                  <span className="truncate">
                    {j.status === "waiting" ? "Waiting for the monthly cap: " : j.status === "queued" ? "Queued: " : "Helper working: "}
                    {snippet(j.brief, 60)}
                  </span>
                </p>
              ))}
            </div>
          )}

          <div className="shrink-0 border-t p-2">
            {chips.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1" aria-label="Context">
                {chips.map((c) => (
                  <ChipView
                    key={chipKey(c)}
                    chip={c}
                    onRemove={() => {
                      setRemoved((old) => new Set(old).add(chipKey(c)));
                      setPinned((old) => old.filter((p) => chipKey(p) !== chipKey(c)));
                    }}
                  />
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <Textarea
                ref={input}
                rows={1}
                aria-label="Message Kin"
                placeholder={talking ? "Type to interrupt…" : "Ask Kin…"}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (e.target.value.trim()) ping();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                className="max-h-40 min-h-9 resize-none border-0 bg-muted/40 text-sm shadow-none focus-visible:ring-1"
              />
              {talking ? (
                <Button variant="outline" size="icon" aria-label="Stop Kin" onClick={() => void chat.stop()}>
                  <Square className="size-3 fill-current" />
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
