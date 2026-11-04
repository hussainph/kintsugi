import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { chat, type ChatEvent, type Entry, type Job, jobs, onDiscuss, onOpenKin, onScreenChanged, type Page, screenChips, type Topic } from "@/lib/chat";
import { type Chip, chipKey, mergeChips, throttle } from "@/lib/chips";
import type { WebCall } from "@/lib/web";
import { hideMargin, showMargin, useMargin } from "@/margin/state";

const EMPTY: Page = { entries: [], threads: [], pending: [], running: null };
export const ACTIVE: Job["status"][] = ["queued", "running", "waiting"];

/** One tool call of the turn under way. */
export type LiveStep = { id: string; name: string; args: unknown; status: "running" | "done" | "error" };

/** The turn under way: what Kin has done and said so far. */
export type Live = { turn: string; text: string; steps: LiveStep[]; web: WebCall[]; started: number };

/**
 * Kin's one chat, as state: the conversation shown (a view of the open
 * vault's log), the turn under way, helpers, what's on screen as chips and
 * the draft. It shows in the margin's Kin tab (KI-103): `open` is whether
 * that tab is showing, and `show`/`hide` open and close the margin on it.
 */
export function useKinChat() {
  const open = useMargin().showing("kin");
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
  /** Bumped when another vault opens: its conversations have their own picks. */
  const [vaultSeq, setVaultSeq] = useState(0);
  /** Entries newer than this arrived while the chat was open. */
  const [seenThrough, setSeenThrough] = useState<number | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const openRef = useRef(open);
  openRef.current = open;
  const input = useRef<HTMLTextAreaElement>(null);
  const loadSeq = useRef(0);

  const chips = useMemo(() => mergeChips(pinned, screen, removed), [pinned, screen, removed]);

  /** The next load is a fresh view of the log: what it holds is "seen". */
  const markSeen = useRef(true);

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const next = await chat.log(viewRef.current);
      if (seq !== loadSeq.current) return;
      setPage(next);
      if (markSeen.current) {
        markSeen.current = false;
        setSeenThrough(next.entries.at(-1)?.seq ?? 0);
      }
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
    // What was already there when the log came into view doesn't animate in.
    markSeen.current = true;
    setSeenThrough(null);
    if (open) void reload();
  }, [open, view, reload]);

  // The conversation a message sent now belongs to: the thread shown, else
  // the one for what's on screen. Its model is picked per conversation.
  const conversation = view ?? topic?.key ?? "";

  const showRef = useRef<() => void>(() => {});

  // The conversation's events: new entries, Kin streaming, helpers.
  useEffect(() => {
    const off = listen<ChatEvent>("kin:chat", ({ payload: event }) => {
      switch (event.type) {
        case "entry": {
          const entry = event.entry;
          // Comment replies show in the margin, where he asked.
          if (entry.role !== "owner" && !entry.comment && !openRef.current) setUnread(true);
          // Kin's reply lands in the same frame its live turn ends, so the
          // log never shows neither.
          if (viewRef.current === null || entry.topic === viewRef.current)
            setPage((p) => (p.entries.some((e) => e.seq === entry.seq) ? p : { ...p, entries: [...p.entries, entry] }));
          return void reload();
        }
        case "turnStarted":
          setLive({ turn: event.turn, text: "", steps: [], web: [], started: Date.now() });
          return void reload();
        case "turn": {
          const e = event.event;
          return setLive((l) => {
            if (!l || l.turn !== event.turn) return l;
            if (e.type === "text") return { ...l, text: l.text + e.delta };
            // Text before a tool call was thinking aloud.
            if (e.type === "toolCall") return { ...l, text: "", steps: [...l.steps, { id: e.id, name: e.name, args: e.arguments, status: "running" }] };
            if (e.type === "toolResult")
              return {
                ...l,
                steps: l.steps.map((s) => (s.id === e.id ? { ...s, status: e.isError ? "error" : "done" } : s)),
                web: e.web ? [...l.web, e.web] : l.web,
              };
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
        case "switched":
          // Each vault has its own conversation.
          setLive(null);
          setUnread(false);
          // Model picks are per vault too.
          setVaultSeq((n) => n + 1);
          // The new vault's thread for what's on screen, else everything.
          if (openRef.current) appeared.current();
          else setView(null);
          return void reload();
      }
    });
    jobs.list().then(setHelpers).catch(() => {});
    return () => {
      off.then((stop) => stop());
    };
  }, [reload]);

  const focus = () => requestAnimationFrame(() => input.current?.focus());

  // However the tab comes into view (⌘J, the avatar, a tab, ⌥⌘\), it
  // shows the thread for what's on screen. Read through a ref, so only the
  // tab appearing runs it.
  const appeared = useRef<() => void>(() => {});
  appeared.current = () => {
    const now = readScreen();
    setUnread(false);
    void follow(mergeChips(pinned, now, removed));
  };
  useEffect(() => {
    if (open) appeared.current();
    else {
      // Hiding ends what Discuss brought in; next time starts from the
      // screen. The conversation stays, and so does Kin's turn.
      setPinned([]);
      setRemoved(new Set());
    }
  }, [open]);

  /** ⌘J, the avatar, openKin(): the Kin tab, ready to type in. */
  const show = useCallback(() => {
    showMargin("kin");
    focus();
  }, []);
  showRef.current = show;

  const hide = useCallback(() => hideMargin(), []);

  /** Sends `text` with `with_` (what's attached now, by default). */
  const sendText = useCallback(
    async (text: string, with_: Chip[]) => {
      try {
        const entry = await chat.send(text, with_);
        if (entry.topic !== viewRef.current) setView(entry.topic);
        else void reload();
        return true;
      } catch (e) {
        toast.error(String(e));
        return false;
      }
    },
    [reload],
  );

  // openKin() and discuss() open the one chat (⌘J and the avatar call
  // openKin(); the margin owns the key).
  useEffect(() => {
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
        void sendText(text, attached).then((ok) => {
          if (!ok) setDraft(text);
        });
      } else if (text) setDraft(text);
      showMargin("kin");
      setUnread(false);
      void follow(attached);
      focus();
    });
    return () => {
      offOpen();
      offDiscuss();
    };
  }, [readScreen, follow, sendText]);

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

  const ping = useMemo(() => throttle(() => void chat.typing().catch(() => {}), 400), []);

  const type = useCallback(
    (text: string) => {
      setDraft(text);
      if (text.trim()) ping();
    },
    [ping],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (!(await sendText(text, chips))) setDraft(text);
  }, [draft, chips, sendText]);

  /** Sends the messages a failed reply answered, again. */
  const retry = useCallback(
    (reply: Entry) => {
      const asked = page.entries.filter((e) => reply.answers?.includes(e.seq));
      if (!asked.length) return;
      void sendText(asked.map((e) => e.text).join("\n\n"), asked[asked.length - 1].chips ?? []);
    },
    [page.entries, sendText],
  );

  const removeChip = useCallback((chip: Chip) => {
    setRemoved((old) => new Set(old).add(chipKey(chip)));
    setPinned((old) => old.filter((p) => chipKey(p) !== chipKey(chip)));
  }, []);

  const thread = page.threads.find((t) => t.key === view);
  const threadLabel = view === null ? "Everything" : thread?.label ?? (topic?.key === view ? topic.label : "General");
  const working = helpers.filter((j) => ACTIVE.includes(j.status));

  return {
    open,
    show,
    hide,
    view,
    setView,
    page,
    thread,
    threadLabel,
    live,
    helpers: working,
    chips,
    removeChip,
    draft,
    type,
    send,
    sendText,
    retry,
    stop: () => void chat.stop().catch((e) => toast.error(String(e))),
    unread,
    vaultSeq,
    conversation,
    input,
    talking: !!live,
    /** Entries after this one arrived while the chat was showing. */
    seenThrough,
  };
}

export type KinChatState = ReturnType<typeof useKinChat>;
