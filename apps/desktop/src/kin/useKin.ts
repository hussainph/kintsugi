import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  anchorOf,
  type Anchor,
  type ChatEvent,
  type Entry,
  type Job,
  jobs,
  onDiscuss,
  onOpenKin,
  onOpenThread,
  onScreenChanged,
  screenChips,
  type Start,
  type Thread,
  type ThreadList,
  threads as api,
  type ThreadView,
} from "@/lib/chat";
import { type Chip, chipKey, mergeChips, throttle } from "@/lib/chips";
import type { WebCall } from "@/lib/web";

export const ACTIVE: Job["status"][] = ["queued", "running", "waiting"];

/** One tool call of the turn under way. */
export type LiveStep = { id: string; name: string; args: unknown; status: "running" | "done" | "error" };

/** A turn under way: what Kin has done and said so far. */
export type Live = { turn: string; text: string; steps: LiveStep[]; web: WebCall[]; started: number };

/** What the Kin tab shows. */
export type Mode =
  /** This draft's threads (in the editor), else the screen's, then recent ones. */
  | { kind: "list" }
  /** Every thread in the vault, searchable. */
  | { kind: "all" }
  | { kind: "thread"; id: string }
  /** A thread not started yet: his first message starts it. */
  | { kind: "new"; anchor: Anchor | null; origin: NonNullable<Start["origin"]> };

export type KinState = {
  mode: Mode;
  /** The Kin tab is on screen. */
  visible: boolean;
  /** What's on screen, as chips. */
  screen: Chip[];
  /** What Discuss brought in. */
  pinned: Chip[];
  /** Chips he took off. */
  removed: ReadonlySet<string>;
  draft: string;
  /** The screen's threads, and which are running. */
  list: ThreadList;
  /** Away from the editor: recent threads about other things. */
  recent: Thread[];
  /** All threads, or a search's matches. */
  all: Thread[] | null;
  query: string;
  /** The thread open, with its messages. */
  view: ThreadView | null;
  /** Turns under way, by thread. */
  live: Record<string, Live>;
  helpers: Job[];
  /** Threads with a reply he hasn't seen. */
  unread: ReadonlySet<string>;
  /** Bumped when another vault opens: its threads have their own picks. */
  vaultSeq: number;
  /** Entries after this one arrived while the thread was showing. */
  seenThrough: number | null;
  /** Bumped to focus the composer. */
  focus: number;
};

const EMPTY: ThreadList = { threads: [], running: [], reviewing: [] };

let state: KinState = {
  mode: { kind: "list" },
  visible: false,
  screen: [],
  pinned: [],
  removed: new Set(),
  draft: "",
  list: EMPTY,
  recent: [],
  all: null,
  query: "",
  view: null,
  live: {},
  helpers: [],
  unread: new Set(),
  vaultSeq: 0,
  seenThrough: null,
  focus: 0,
};
const listeners = new Set<() => void>();

function set(change: Partial<KinState> | ((s: KinState) => Partial<KinState>)) {
  const next = typeof change === "function" ? change(state) : change;
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** What a list is about: the screen's subject (a paragraph is about its document). */
export function subject(screen: Chip[]): Anchor | null {
  for (const chip of screen) {
    const anchor = anchorOf(chip);
    if (!anchor) continue;
    // A passage's document is named by the document's own chip.
    if (anchor.kind === "doc" && !anchor.label) anchor.label = screen.find((c) => c.kind === "doc" && c.path === anchor.path)?.label;
    return anchor;
  }
  return null;
}

/** The chips a message sent now carries. */
export const chipsOf = (s: KinState) => mergeChips(s.pinned, s.screen, s.removed);

// --- Loading ------------------------------------------------------------------

let listSeq = 0;
async function loadList() {
  const seq = ++listSeq;
  const about = subject(state.screen);
  try {
    if (about?.kind === "doc") {
      const list = await api.list({ about: about.path });
      if (seq === listSeq) set({ list, recent: [] });
      return;
    }
    const [mine, recent] = await Promise.all([about ? api.list({ about: about.path }) : Promise.resolve(EMPTY), api.list({ limit: 40 })]);
    if (seq !== listSeq) return;
    const shown = new Set(mine.threads.map((t) => t.id));
    set({ list: { ...recent, threads: mine.threads }, recent: recent.threads.filter((t) => !shown.has(t.id)).slice(0, 20) });
  } catch (error) {
    if (seq === listSeq) console.warn("threads unavailable", error);
  }
}

let allSeq = 0;
async function loadAll() {
  const seq = ++allSeq;
  try {
    const found = await api.list({ query: state.query.trim() || undefined, resolved: true, limit: 200 });
    if (seq === allSeq) set({ all: found.threads });
  } catch (error) {
    if (seq === allSeq) toast.error(String(error));
  }
}

let viewSeq = 0;
async function loadView(id: string, fresh = false) {
  const seq = ++viewSeq;
  try {
    const view = await api.get(id);
    if (seq !== viewSeq || state.mode.kind !== "thread" || state.mode.id !== id) return;
    set((s) => ({ view, seenThrough: fresh || s.seenThrough === null ? (view.entries.at(-1)?.seq ?? 0) : s.seenThrough }));
  } catch (error) {
    if (seq === viewSeq) {
      toast.error(String(error));
      set({ mode: { kind: "list" }, view: null });
    }
  }
}

let reloadTimer: number | undefined;
/** Lists follow changes, a little behind a burst of them. */
function reloadLists() {
  window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    if (!state.visible) return;
    if (state.mode.kind === "all") void loadAll();
    else void loadList();
  }, 120);
}

function readScreen() {
  const next = screenChips();
  if (JSON.stringify(next) === JSON.stringify(state.screen)) return false;
  const before = subject(state.screen);
  set({ screen: next });
  const after = subject(next);
  return before?.kind !== after?.kind || before?.path !== after?.path;
}

// --- Events -------------------------------------------------------------------

function onEvent(event: ChatEvent) {
  switch (event.type) {
    case "entry": {
      const entry = event.entry;
      const open = state.mode.kind === "thread" && state.mode.id === entry.thread;
      if (entry.role !== "owner" && !(state.visible && open)) set((s) => ({ unread: new Set(s.unread).add(entry.thread) }));
      // Kin's reply lands in the same frame its live turn ends.
      if (open && state.view?.thread.id === entry.thread)
        set((s) => (s.view && !s.view.entries.some((e) => e.seq === entry.seq) ? { view: { ...s.view, entries: [...s.view.entries, entry], pending: entry.role === "owner" ? [...s.view.pending, entry.seq] : s.view.pending } } : {}));
      if (open) void loadView(entry.thread);
      return reloadLists();
    }
    case "thread": {
      const thread = event.thread;
      set((s) => ({
        view: s.view?.thread.id === thread.id ? { ...s.view, thread } : s.view,
        list: { ...s.list, threads: s.list.threads.map((t) => (t.id === thread.id ? thread : t)) },
      }));
      return reloadLists();
    }
    case "threads":
      if (state.mode.kind === "thread") void loadView(state.mode.id);
      return reloadLists();
    case "turnStarted":
      set((s) => ({ live: { ...s.live, [event.thread]: { turn: event.turn, text: "", steps: [], web: [], started: Date.now() } } }));
      if (state.mode.kind === "thread" && state.mode.id === event.thread) void loadView(event.thread);
      return reloadLists();
    case "turn": {
      const e = event.event;
      const live = state.live[event.thread];
      if (!live || live.turn !== event.turn) return;
      let next = live;
      if (e.type === "text") next = { ...live, text: live.text + e.delta };
      // Text before a tool call was thinking aloud.
      else if (e.type === "toolCall") next = { ...live, text: "", steps: [...live.steps, { id: e.id, name: e.name, args: e.arguments, status: "running" }] };
      else if (e.type === "toolResult")
        next = { ...live, steps: live.steps.map((s) => (s.id === e.id ? { ...s, status: e.isError ? "error" : "done" } : s)), web: e.web ? [...live.web, e.web] : live.web };
      if (next !== live) set((s) => ({ live: { ...s.live, [event.thread]: next } }));
      return;
    }
    case "turnEnded":
      set((s) => {
        if (s.live[event.thread]?.turn !== event.turn) return {};
        const { [event.thread]: _, ...rest } = s.live;
        return { live: rest };
      });
      if (state.mode.kind === "thread" && state.mode.id === event.thread) void loadView(event.thread);
      return reloadLists();
    case "reviewStarted":
    case "reviewEnded":
      return reloadLists();
    case "job":
      return set((s) => ({ helpers: [event.job, ...s.helpers.filter((j) => j.id !== event.job.id)] }));
    case "switched":
      // Each vault has its own threads, and its own picks.
      set((s) => ({ live: {}, unread: new Set(), vaultSeq: s.vaultSeq + 1, mode: { kind: "list" }, view: null, all: null }));
      return reloadLists();
  }
}

let started = false;
/** Listens once, for the app's lifetime: the tab comes and goes, Kin doesn't. */
function start() {
  if (started) return;
  started = true;
  void listen<ChatEvent>("kin:chat", ({ payload }) => onEvent(payload));
  jobs.list().then((helpers) => set({ helpers })).catch(() => {});
  onDiscuss(({ chips, text, send: now, anchor, origin }) => {
    readScreen();
    set((s) => ({ pinned: mergeChips(chips, s.pinned, new Set()), removed: new Set([...s.removed].filter((k) => !chips.some((c) => chipKey(c) === k))) }));
    const subjectOf = anchor ?? anchorOf(chips[0]) ?? null;
    newThread(subjectOf, origin ?? "discuss");
    if (text && now) void sendNew(text, mergeChips(chips, state.screen, new Set()));
    else if (text) set({ draft: text });
  });
  onOpenThread((id) => openThread(id));
  // Opening Kin afresh (the avatar, ⌘J) starts from the screen: what Discuss
  // brought goes, and a new thread he never wrote in isn't kept waiting.
  onOpenKin((show) => {
    readScreen();
    set((s) => ({ pinned: [], removed: new Set(), ...(s.mode.kind === "new" && !s.draft.trim() ? { mode: { kind: "list" } as Mode } : {}) }));
    if (show === "list") showList();
    else if (state.mode.kind === "list") void loadList();
    set((s) => ({ focus: s.focus + 1 }));
  });
  onScreenChanged(() => {
    if (readScreen() && state.visible && state.mode.kind === "list") void loadList();
  });
  let timer: number | undefined;
  document.addEventListener("selectionchange", () => {
    if (!state.visible) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(readScreen, 150);
  });
}

// --- Actions ------------------------------------------------------------------

/** The tab came into view, or went. */
export function setVisible(visible: boolean) {
  if (visible === state.visible) return;
  set({ visible });
  if (!visible) return;
  readScreen();
  if (state.mode.kind === "thread") {
    const id = state.mode.id;
    set((s) => ({ unread: without(s.unread, id) }));
    void loadView(id, true);
  } else if (state.mode.kind === "all") void loadAll();
  void loadList();
}

const without = (set: ReadonlySet<string>, id: string) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

export function showList() {
  set({ mode: { kind: "list" }, view: null, draft: "", pinned: [] });
  void loadList();
}

export function showAll() {
  set({ mode: { kind: "all" }, view: null, query: "", all: null });
  void loadAll();
}

let searchTimer: number | undefined;
export function search(query: string) {
  set({ query });
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void loadAll(), 160);
}

export function openThread(id: string) {
  if (state.mode.kind !== "thread" || state.mode.id !== id) set({ mode: { kind: "thread", id }, view: null, draft: "", seenThrough: null });
  set((s) => ({ unread: without(s.unread, id), focus: s.focus + 1 }));
  void loadView(id, true);
}

/** A new thread's composer, about `anchor` (null: nothing in particular). */
export function newThread(anchor: Anchor | null, origin: NonNullable<Start["origin"]> = "chat") {
  set((s) => ({ mode: { kind: "new", anchor, origin }, view: null, draft: "", seenThrough: 0, focus: s.focus + 1 }));
}

export function setDraft(text: string) {
  set({ draft: text });
  if (text.trim() && state.mode.kind === "thread") ping();
}

const ping = throttle(() => {
  if (state.mode.kind === "thread") void api.typing(state.mode.id).catch(() => {});
}, 400);

export function removeChip(chip: Chip) {
  set((s) => ({ removed: new Set(s.removed).add(chipKey(chip)), pinned: s.pinned.filter((p) => chipKey(p) !== chipKey(chip)) }));
}

/** What a new thread would be about now: Discuss's or the paragraph's
 *  anchor, else the first chip's subject. */
export function newAnchor(s: KinState): Anchor | null {
  if (s.mode.kind !== "new") return null;
  const chips = chipsOf(s);
  const anchor = s.mode.anchor;
  if (anchor?.kind === "paragraph") return anchor;
  // A subject whose chip he took off is no longer what it's about.
  if (anchor && chips.some((c) => anchorOf(c)?.path === anchor.path)) return anchor;
  return subject(chips);
}

async function sendNew(text: string, chips: Chip[]) {
  const mode = state.mode;
  const anchor = newAnchor(state);
  const origin = mode.kind === "new" ? mode.origin : "chat";
  try {
    const sent = await api.send(null, text, chips, { anchor, origin });
    set({ mode: { kind: "thread", id: sent.thread.id }, view: { thread: sent.thread, entries: [sent.entry], pending: [sent.entry.seq], running: null }, seenThrough: 0, pinned: [] });
    void loadView(sent.thread.id);
    reloadLists();
    return true;
  } catch (error) {
    toast.error(String(error));
    return false;
  }
}

/** Sends the composer's message: in the thread open, or as a new thread. */
export async function send(text = state.draft) {
  const message = text.trim();
  if (!message) return;
  const chips = chipsOf(state);
  set({ draft: "" });
  let ok: boolean;
  if (state.mode.kind === "thread") {
    try {
      await api.send(state.mode.id, message, chips);
      ok = true;
    } catch (error) {
      toast.error(String(error));
      ok = false;
    }
  } else {
    if (state.mode.kind !== "new") newThread(subject(chips));
    ok = await sendNew(message, chips);
  }
  if (!ok && !state.draft) set({ draft: message });
}

export function stop() {
  if (state.mode.kind === "thread") void api.stop(state.mode.id).catch((e) => toast.error(String(e)));
}

export function again(thread: string) {
  void api.again(thread).catch((e) => toast.error(String(e)));
}

export function setStatus(thread: Thread, status: Thread["status"]) {
  void api
    .update(thread.id, { status })
    .then(() => {
      // Resolving puts it away, as in any comments UI.
      if (status === "resolved" && state.mode.kind === "thread" && state.mode.id === thread.id) showList();
    })
    .catch((e) => toast.error(String(e)));
}

export function rename(thread: Thread, title: string) {
  void api.update(thread.id, { title }).catch((e) => toast.error(String(e)));
}

export function stopHelper(job: Job) {
  void jobs.cancel(job.id).catch((e) => toast.error(String(e)));
}

// --- Reading ------------------------------------------------------------------

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Kin's state, for the Kin tab and the avatar. */
export function useKin(): KinState {
  return useSyncExternalStore(subscribe, () => state);
}

/** For the avatar and the margin's tab: Kin talking, a reply unseen, a helper at work. */
export function useKinStatus() {
  const s = useKin();
  return {
    talking: Object.keys(s.live).length > 0,
    unread: s.unread.size > 0,
    busy: s.helpers.some((j) => j.status === "running"),
  };
}

/** The thread a reply answered, again, for Try again. */
export const answeredBy = (view: ThreadView, reply: Entry) => view.entries.filter((e) => reply.answers?.includes(e.seq));
