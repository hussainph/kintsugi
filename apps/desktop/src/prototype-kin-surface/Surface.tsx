// PROTOTYPE (KI-96), throwaway. Not for main.
//
// Question: how should Kin and the writing surface fit together, so chat,
// references, versions, the stash and Kin's suggestions share the screen
// without crowding the draft or re-wrapping it? Three whole-system
// candidates on the real app shell, switchable with ?variant=A|B|C or the
// bar at the top. Kin's own chat is the real one (mock model under
// KINTSUGI_HEADLESS_KIN=mock); the inline asks, threads and suggestions are
// scripted here so their timing can be judged. Nothing is saved.
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Editor } from "@kintsugi/editor/Editor";
import { useSidebar } from "@kintsugi/ui/components/sidebar";
import { ArrowDown, ArrowLeft, Check, Headphones, MessageCircle, Minus, PanelLeft, PanelRight, Plus, Search, X } from "@kintsugi/ui/icons";
import { KinAvatar } from "@/kin/Avatar";
import { useKinChat, type KinChatState } from "@/kin/useKinChat";
import { KinComposer, KinLog } from "@/kin/Conversation";
import { ANSWERS, ASKS, CHATS, DRAFT, DRAFT_PATH, REFERENCES, STASH, SUGGESTIONS, VARIANTS, VERSIONS, type Chat, type StashItem, type Variant, type VersionSet } from "./data";
import { dropPara, dropSpan, marks, resetMarks, onPaneHost, paneHosts, setCurrent, setPara, setShow, setSpan, spanAt, spanById, suggestions } from "./marks";
import { factor, fly, reduced, setSpeed, teleport, type Speed } from "./motion";
import "./proto.css";

export const PROTO = import.meta.env.DEV && new URLSearchParams(location.search).get("proto") === "kin-surface";

type Ask = { from: number; to: number; stage: "pill" | "working" | "answered"; question?: string; chat?: string };
type Tab = "kin" | "refs" | "stash";
type State = {
  /** A: the margin's tab when it is open for something other than Kin. */
  tab: Tab | null;
  /** B: the left panel. */
  left: "versions" | "stash" | null;
  /** C: the stash shelf and the versions popover. */
  shelf: boolean;
  popover: boolean;
  on: boolean;
  current: string | null;
  stash: StashItem[];
  chats: Chat[];
  /** The chat showing in the Kin panel; null shows the list. */
  open: string | null;
  /** B and C: a paragraph's chat, opened at its paragraph. */
  pane: string | null;
  ask: Ask | null;
  sets: VersionSet[];
  set: string;
  strip: number;
  streaming: string | null;
};

const initial = (): State => ({
  tab: null, left: null, shelf: false, popover: false, on: false, current: null,
  stash: STASH, chats: CHATS, open: "c-draft", pane: null, ask: null,
  sets: VERSIONS.map((s) => ({ ...s, versions: [...s.versions] })), set: "v-decision", strip: 0, streaming: null,
});

type Api = ReturnType<typeof useApi>;
const Ctx = createContext<Api | null>(null);
const useProto = () => useContext(Ctx)!;

const readVariant = (): Variant => {
  const v = new URLSearchParams(location.search).get("variant");
  return v === "B" || v === "C" ? v : "A";
};

let uid = 0;
const id = (p: string) => `${p}-${++uid}`;
const words = (text: string) => text.split(/(?<=\s)/);

function useApi() {
  const [variant, setVariantState] = useState<Variant>(readVariant);
  const [s, setS] = useState<State>(initial);
  const [tick, setTick] = useState(0);
  const sRef = useRef(s);
  sRef.current = s;
  const viewRef = useRef<EditorView | null>(null);
  const chat = useKinChat();
  const chatRef = useRef<KinChatState>(chat);
  chatRef.current = chat;
  const set = useCallback((f: (s: State) => Partial<State>) => setS((old) => ({ ...old, ...f(old) })), []);

  const setVariant = useCallback((v: Variant) => {
    const url = new URL(location.href);
    url.searchParams.set("variant", v);
    history.replaceState(history.state, "", url);
    setVariantState(v);
    setS(initial());
    chatRef.current.hide();
    const view = viewRef.current;
    if (view) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: DRAFT }, effects: resetMarks.of(null), selection: EditorSelection.cursor(DRAFT.indexOf("The first time")) });
      placeAll(view, initial());
      view.scrollDOM.scrollTop = 0;
    }
  }, []);

  const dispatch = (spec: Parameters<EditorView["dispatch"]>[0]) => viewRef.current?.dispatch(spec);
  const view = () => viewRef.current;

  /** Kin's reply, word by word, into a scripted chat. */
  const stream = useCallback((chatId: string, text: string, stashable = false) => {
    set((s) => ({ streaming: chatId, chats: s.chats.map((c) => (c.id === chatId ? { ...c, messages: [...c.messages, { by: "kin", text: "", stashable }] } : c)) }));
    const parts = words(text);
    let i = 0;
    const timer = window.setInterval(() => {
      i++;
      set((s) => ({
        streaming: i >= parts.length ? null : chatId,
        chats: s.chats.map((c) => {
          if (c.id !== chatId) return c;
          const messages = [...c.messages];
          messages[messages.length - 1] = { ...messages[messages.length - 1], text: parts.slice(0, i).join("") };
          return { ...c, messages };
        }),
      }));
      if (i >= parts.length) window.clearInterval(timer);
    }, 45 * factor());
  }, [set]);

  /** Opens a chat where this candidate shows it. */
  const openChat = useCallback((chatId: string) => {
    const c = sRef.current.chats.find((x) => x.id === chatId);
    if (!c) return;
    if (c.kind === "paragraph" && variant !== "A") {
      set(() => ({ pane: chatId }));
      const v = viewRef.current;
      const at = c.paragraph ? v?.state.doc.toString().indexOf(c.paragraph) ?? -1 : -1;
      if (v && at >= 0) {
        if (variant === "B") v.dispatch({ effects: setPara.of({ id: `pane:${chatId}`, kind: "pane", at }) });
        void teleport(v, at);
      }
      return;
    }
    set(() => ({ open: chatId, tab: null }));
    if (!chatRef.current.open) chatRef.current.show();
    const v = viewRef.current;
    const at = c.paragraph ? v?.state.doc.toString().indexOf(c.paragraph) ?? -1 : -1;
    if (v && at >= 0) {
      void teleport(v, at);
      v.dispatch({ effects: setSpan.of({ id: "flash", kind: "flash", from: at, to: v.state.doc.lineAt(at).to }) });
      window.setTimeout(() => viewRef.current?.dispatch({ effects: dropSpan.of("flash") }), 900 * factor());
    }
  }, [variant, set]);

  const closePane = useCallback(() => {
    const pane = sRef.current.pane;
    if (!pane) return;
    const host = paneHosts.get(`pane:${pane}`);
    const done = () => { set(() => ({ pane: null })); viewRef.current?.dispatch({ effects: dropPara.of(`pane:${pane}`) }); };
    if (host && !reduced()) {
      host.classList.add("kp-closing");
      window.setTimeout(done, 220 * factor());
    } else done();
    viewRef.current?.focus();
  }, [set]);

  /** A paragraph chat about `quote`, made on the spot (Discuss, an ask). */
  const paragraphChat = useCallback((quote: string, title: string, messages: Chat["messages"] = []) => {
    const v = viewRef.current!;
    const at = v.state.doc.toString().indexOf(quote);
    const line = v.state.doc.lineAt(Math.max(0, at));
    const paragraph = line.text.slice(0, 40);
    const chatId = id("c");
    const c: Chat = { id: chatId, title, group: "draft", kind: "paragraph", when: "now", paragraph, messages };
    set((s) => ({ chats: [s.chats[0], c, ...s.chats.slice(1)] }));
    v.dispatch({ effects: setPara.of({ id: chatId, kind: "thread", at: line.from }) });
    sRef.current = { ...sRef.current, chats: [sRef.current.chats[0], c, ...sRef.current.chats.slice(1)] };
    return chatId;
  }, [set]);

  const send = useCallback((chatId: string, text: string) => {
    set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? { ...c, messages: [...c.messages, { by: "owner", text }] } : c)) }));
    window.setTimeout(() => stream(chatId, ANSWERS[text] ?? (text === "Why?" ? ANSWERS.why : ANSWERS.default), true), 700 * factor());
  }, [set, stream]);

  // Suggestions ----------------------------------------------------------
  const toggleSuggestions = useCallback(() => {
    const on = !sRef.current.on;
    set((s) => ({
      on,
      current: on ? s.current : null,
      stash: on
        ? [...SUGGESTIONS.filter((g) => g.kind === "rewrite" && viewRef.current && spanById(viewRef.current.state, g.id)).map((g) => ({ id: `st-${g.id}`, by: "kin" as const, text: g.replacement!, suggestion: g.id, fresh: true })), ...s.stash.filter((i) => !i.suggestion)]
        : s.stash.filter((i) => !i.suggestion),
    }));
    dispatch({ effects: [setShow.of(on), setCurrent.of(null)] });
  }, [set]);

  const focusSuggestion = useCallback((sid: string | null) => {
    set(() => ({ current: sid }));
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ effects: setCurrent.of(sid) });
    const span = sid && spanById(v.state, sid);
    if (span) void teleport(v, span.from);
  }, [set]);

  const step = useCallback((dir: 1 | -1) => {
    const v = viewRef.current;
    if (!v) return;
    if (!sRef.current.on) toggleSuggestions();
    const list = suggestions(v.state);
    if (!list.length) return;
    const at = list.findIndex((x) => x.id === sRef.current.current);
    const next = at < 0 ? (dir === 1 ? 0 : list.length - 1) : (at + dir + list.length) % list.length;
    focusSuggestion(list[next].id);
  }, [toggleSuggestions, focusSuggestion]);

  const settle = useCallback((sid: string, apply: boolean) => {
    const v = viewRef.current;
    if (!v) return;
    const list = suggestions(v.state);
    const at = list.findIndex((x) => x.id === sid);
    const span = list[at];
    if (!span) return;
    const g = SUGGESTIONS.find((x) => x.id === sid)!;
    const nextId = list.length > 1 ? list[(at + 1) % list.length].id : null;
    const finish = () => {
      const view = viewRef.current!;
      const live = spanById(view.state, sid);
      if (!live) return;
      if (apply) {
        const insert = g.kind === "rewrite" ? g.replacement! : "";
        view.dispatch({ changes: { from: live.from, to: live.to, insert }, effects: dropSpan.of(sid), userEvent: "input.kin" });
        if (insert) {
          view.dispatch({ effects: setSpan.of({ id: "flash", kind: "flash", from: live.from, to: live.from + insert.length }) });
          window.setTimeout(() => viewRef.current?.dispatch({ effects: dropSpan.of("flash") }), 600 * factor());
        }
      } else view.dispatch({ effects: dropSpan.of(sid) });
      set((s) => ({ stash: s.stash.filter((i) => i.suggestion !== sid) }));
      if (nextId) window.setTimeout(() => focusSuggestion(nextId), 120 * factor());
      else set(() => ({ current: null }));
    };
    // Dismissed and cut text fades out before it goes.
    if (!reduced() && (!apply || g.kind === "cut")) {
      v.dispatch({ effects: setSpan.of({ ...span, id: `${sid}-leaving`, kind: "leaving" }) });
      window.setTimeout(() => { viewRef.current?.dispatch({ effects: dropSpan.of(`${sid}-leaving`) }); finish(); }, 180 * factor());
    } else finish();
  }, [set, focusSuggestion]);

  const discuss = useCallback((sid: string) => {
    const v = viewRef.current;
    const span = v && spanById(v.state, sid);
    if (!v || !span) return;
    const quote = v.state.sliceDoc(span.from, span.to).trim();
    const chatId = paragraphChat(quote, `“${quote.length > 36 ? quote.slice(0, 34) + "…" : quote}”`, [{ by: "owner", text: `About “${quote}”` }]);
    set(() => ({ current: null }));
    v.dispatch({ effects: setCurrent.of(null) });
    openChat(chatId);
  }, [paragraphChat, openChat, set]);

  // Inline asks ----------------------------------------------------------
  const openAsk = useCallback(() => {
    const v = viewRef.current;
    if (!v) return false;
    const { from, to } = v.state.selection.main;
    if (from === to) return false;
    set(() => ({ ask: { from, to, stage: "pill" } }));
    v.dispatch({ effects: setSpan.of({ id: "asked", kind: "asked", from, to }) });
    return true;
  }, [set]);
  const closeAsk = useCallback(() => {
    const a = sRef.current.ask;
    if (!a) return;
    if (a.stage === "pill") { viewRef.current?.dispatch({ effects: dropSpan.of("asked") }); set(() => ({ ask: null })); }
    else set((s) => ({ ask: s.ask && { ...s.ask, stage: s.ask.stage === "working" ? "working" : "answered" } }));
    viewRef.current?.focus();
  }, [set]);
  const chooseAsk = useCallback((question: string) => {
    const v = viewRef.current;
    const a = sRef.current.ask;
    if (!v || !a) return;
    const span = spanById(v.state, "asked");
    const from = span?.from ?? a.from;
    const to = span?.to ?? a.to;
    const quote = v.state.sliceDoc(from, to);
    v.dispatch({ effects: dropSpan.of("asked") });
    // Kin works on the span; he keeps writing. B shows it in the gutter.
    const line = v.state.doc.lineAt(from);
    if (variant === "B") v.dispatch({ effects: setPara.of({ id: "rule", kind: "rule", at: line.from }) });
    v.dispatch({ effects: setSpan.of({ id: "working", kind: "working", from, to }) });
    set(() => ({ ask: { from, to, stage: "working", question } }));
    if (variant !== "C") v.focus();
    window.setTimeout(() => {
      const view = viewRef.current;
      if (!view) return;
      const live = spanById(view.state, "working");
      const chatId = paragraphChat(quote, question, [{ by: "owner", text: question }]);
      view.dispatch({ effects: [dropSpan.of("working"), dropPara.of("rule"), setSpan.of({ id: chatId, kind: "reply", from: live?.to ?? to, to: live?.to ?? to, label: "Kin replied" })] });
      set((s) => ({ ask: s.ask && { ...s.ask, stage: "answered", chat: chatId } }));
      stream(chatId, ANSWERS[question] ?? ANSWERS.default, true);
    }, 2600 * factor());
  }, [variant, set, paragraphChat, stream]);

  // Versions (KI-86) -------------------------------------------------------
  const activeSet = useCallback(() => {
    const v = viewRef.current;
    const st = sRef.current;
    if (!v) return st.sets[0];
    const head = v.state.selection.main.head;
    const spans = v.state.field(marks).spans.filter((x) => x.kind === "version");
    const under = spans.find((x) => head >= x.from && head <= x.to);
    return st.sets.find((x) => x.id === (under?.id ?? st.set)) ?? st.sets[0];
  }, []);

  const pick = useCallback((setId: string, index: number, strip = false) => {
    const v = viewRef.current;
    const vs = sRef.current.sets.find((x) => x.id === setId);
    const span = v && spanById(v.state, setId);
    if (!v || !vs || !span) return;
    const text = vs.versions[index].text;
    v.dispatch({
      changes: { from: span.from, to: span.to, insert: text },
      effects: [setSpan.of({ ...span, to: span.from + text.length, n: vs.versions.length, at: index }), setSpan.of({ id: "flash", kind: "flash", from: span.from, to: span.from + text.length })],
      userEvent: "input.alternative",
    });
    window.setTimeout(() => viewRef.current?.dispatch({ effects: dropSpan.of("flash") }), 500 * factor());
    set((s) => ({ set: setId, sets: s.sets.map((x) => (x.id === setId ? { ...x, current: index } : x)), strip: strip ? s.strip + 1 : s.strip }));
  }, [set]);

  const cycle = useCallback((dir: 1 | -1) => {
    const vs = activeSet();
    const v = viewRef.current;
    const span = v && spanById(v.state, vs.id);
    if (!v || !span) return;
    const head = v.state.selection.main.head;
    if (head < span.from || head > span.to) {
      v.dispatch({ selection: EditorSelection.cursor(span.from) });
      void teleport(v, span.from);
    }
    pick(vs.id, (vs.current + dir + vs.versions.length) % vs.versions.length, true);
  }, [activeSet, pick]);

  const addVersion = useCallback((setId: string, text: string, by: "owner" | "kin" = "owner") => {
    set((s) => ({ sets: s.sets.map((x) => (x.id === setId ? { ...x, versions: [...x.versions, { text, by, fresh: true }] } : x)) }));
    const v = viewRef.current;
    const span = v && spanById(v.state, setId);
    const vs = sRef.current.sets.find((x) => x.id === setId);
    if (v && span && vs) v.dispatch({ effects: setSpan.of({ ...span, n: vs.versions.length + 1 }) });
  }, [set]);

  const askVersions = useCallback((setId: string) => {
    const v = viewRef.current;
    const span = v && spanById(v.state, setId);
    const vs = sRef.current.sets.find((x) => x.id === setId);
    if (!v || !span || !vs || !vs.ask.length) return;
    v.dispatch({ effects: setSpan.of({ id: "working", kind: "working", from: span.from, to: span.to }) });
    if (variant === "B") v.dispatch({ effects: setPara.of({ id: "rule", kind: "rule", at: v.state.doc.lineAt(span.from).from }) });
    window.setTimeout(() => {
      viewRef.current?.dispatch({ effects: [dropSpan.of("working"), dropPara.of("rule")] });
      const asked = vs.ask;
      set((s) => ({ sets: s.sets.map((x) => (x.id === setId ? { ...x, versions: [...x.versions, ...asked.map((a) => ({ ...a, fresh: true }))], ask: [] } : x)) }));
      const live = viewRef.current && spanById(viewRef.current.state, setId);
      if (live) viewRef.current!.dispatch({ effects: setSpan.of({ ...live, n: vs.versions.length + asked.length }) });
    }, 1800 * factor());
  }, [variant, set]);

  // The stash (KI-89) -----------------------------------------------------
  const stashTarget = () => document.querySelector("[data-stash-target]");
  const stashSelection = useCallback(() => {
    const v = viewRef.current;
    if (!v) return;
    let { from, to } = v.state.selection.main;
    if (from === to) { const line = v.state.doc.lineAt(from); from = line.from; to = line.to; }
    const text = v.state.sliceDoc(from, to).trim();
    if (!text) return;
    const start = v.coordsAtPos(from);
    const rect = start ? new DOMRect(start.left, start.top, 360, 24) : null;
    if (variant === "A") set(() => ({ tab: "stash" }));
    if (variant === "B") set(() => ({ left: "stash" }));
    if (variant === "C") set(() => ({ shelf: true }));
    if (variant === "A") chatRef.current.hide();
    requestAnimationFrame(() => fly(text, rect, stashTarget()));
    v.dispatch({ changes: { from, to }, userEvent: "delete.stash" });
    window.setTimeout(() => set((s) => ({ stash: [{ id: id("st"), by: "owner", text, fresh: true }, ...s.stash] })), 300 * factor());
  }, [variant, set]);

  const stashReply = useCallback((text: string, from: DOMRect | null) => {
    if (variant === "C") set(() => ({ shelf: true }));
    if (variant === "B") set(() => ({ left: "stash" }));
    requestAnimationFrame(() => fly(text, from, stashTarget() ?? document.querySelector("[data-stash-button]")));
    window.setTimeout(() => set((s) => ({ stash: [{ id: id("st"), by: "kin", text, fresh: true }, ...s.stash] })), 300 * factor());
  }, [variant, set]);

  const insertStash = useCallback((itemId: string) => {
    const v = viewRef.current;
    const item = sRef.current.stash.find((i) => i.id === itemId);
    if (!v || !item) return;
    if (item.suggestion) { settle(item.suggestion, true); return; }
    const at = v.state.selection.main.head;
    const line = v.state.doc.lineAt(at);
    const insert = line.text.trim() ? `\n\n${item.text}` : item.text;
    const pos = line.text.trim() ? line.to : at;
    v.dispatch({ changes: { from: pos, insert }, effects: setSpan.of({ id: "flash", kind: "flash", from: pos + (insert.length - item.text.length), to: pos + insert.length }), selection: EditorSelection.cursor(pos + insert.length), userEvent: "input.stash" });
    window.setTimeout(() => viewRef.current?.dispatch({ effects: dropSpan.of("flash") }), 600 * factor());
    set((s) => ({ stash: s.stash.filter((i) => i.id !== itemId) }));
    v.focus();
  }, [set, settle]);

  const dismissStash = useCallback((itemId: string) => {
    const item = sRef.current.stash.find((i) => i.id === itemId);
    if (item?.suggestion) settle(item.suggestion, false);
    else set((s) => ({ stash: s.stash.filter((i) => i.id !== itemId) }));
  }, [set, settle]);

  const highlight = useCallback((sid: string | null) => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ effects: setCurrent.of(sid ?? sRef.current.current) });
  }, []);

  return {
    variant, setVariant, s, set, tick, setTick, viewRef, chat, openChat, closePane, send, stream,
    toggleSuggestions, step, focusSuggestion, settle, discuss, openAsk, closeAsk, chooseAsk,
    activeSet, pick, cycle, addVersion, askVersions, stashSelection, stashReply, insertStash, dismissStash, highlight, view,
  };
}

/** Puts every scripted mark in the draft. */
function placeAll(view: EditorView, s: State) {
  const doc = view.state.doc.toString();
  const effects = [setShow.of(false), setCurrent.of(null)];
  for (const g of SUGGESTIONS) {
    const at = doc.indexOf(g.quote);
    if (at >= 0) effects.push(setSpan.of({ id: g.id, kind: g.kind, from: at, to: at + g.quote.length }) as never);
  }
  for (const vs of s.sets) {
    const at = doc.indexOf(vs.quote);
    if (at >= 0) effects.push(setSpan.of({ id: vs.id, kind: "version", from: at, to: at + vs.quote.length, n: vs.versions.length, at: vs.current }) as never);
  }
  for (const c of s.chats) {
    if (c.kind !== "paragraph" || !c.paragraph) continue;
    const at = doc.indexOf(c.paragraph);
    if (at >= 0) effects.push(setPara.of({ id: c.id, kind: "thread", at: view.state.doc.lineAt(at).from }) as never);
  }
  view.dispatch({ effects });
}

// ---------------------------------------------------------------------------
// The provider, keys and the switcher

export function ProtoProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  return (
    <Ctx.Provider value={api}>
      <Keys />
      {children}
      <Switcher />
    </Ctx.Provider>
  );
}

const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA");

function Keys() {
  const api = useProto();
  const ref = useRef(api);
  ref.current = api;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const a = ref.current;
      const run = (f: () => void) => { e.preventDefault(); e.stopImmediatePropagation(); f(); };
      const inEditor = !!a.viewRef.current?.hasFocus;
      const cmdAlt = e.metaKey && e.altKey && !e.ctrlKey;
      if (cmdAlt && e.code === "KeyK") return run(a.toggleSuggestions);
      if (e.metaKey && !e.altKey && e.code === "Quote") return run(() => a.step(e.shiftKey ? -1 : 1));
      if (cmdAlt && e.code === "BracketRight") return run(() => a.cycle(1));
      if (cmdAlt && e.code === "BracketLeft") return run(() => a.cycle(-1));
      if (cmdAlt && e.code === "KeyX") return run(a.stashSelection);
      if (cmdAlt && e.code === "KeyA") return run(() => openVersions(a));
      if (e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyJ" && inEditor && a.openAsk()) return run(() => {});
      const card = a.s.current;
      if (card && e.altKey && !e.metaKey && e.key === "Enter") return run(() => a.settle(card, true));
      if (card && cmdAlt && e.key === "Backspace") return run(() => a.settle(card, false));
      if (card && e.metaKey && e.shiftKey && e.code === "KeyJ") return run(() => a.discuss(card));
      if (e.key === "Escape") {
        if (a.s.ask?.stage === "pill") return run(a.closeAsk);
        if (a.s.popover) return run(() => a.set(() => ({ popover: false })));
        if (card) return run(() => { a.focusSuggestion(null); });
        if (a.s.left && a.variant === "B") return run(() => closeLeft(a));
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  return null;
}

function openVersions(a: Api) {
  const vs = a.activeSet();
  a.set(() => ({ set: vs.id }));
  if (a.variant === "A") { a.set(() => ({ tab: "stash" })); a.chat.hide(); }
  if (a.variant === "B") openLeft(a, "versions");
  if (a.variant === "C") a.set((s) => ({ popover: !s.popover }));
  const v = a.viewRef.current;
  const span = v && spanById(v.state, vs.id);
  if (v && span) void teleport(v, span.from);
}
function openLeft(a: Api, which: "versions" | "stash") {
  a.set(() => ({ left: which }));
  const v = a.viewRef.current;
  if (!v) return;
  const vs = a.activeSet();
  const span = spanById(v.state, vs.id);
  if (which === "versions" && span) v.dispatch({ effects: setPara.of({ id: "focus", kind: "focus", at: v.state.doc.lineAt(span.from).from }) });
  else v.dispatch({ effects: dropPara.of("focus") });
}
function closeLeft(a: Api) {
  a.set(() => ({ left: null }));
  a.viewRef.current?.dispatch({ effects: dropPara.of("focus") });
  a.viewRef.current?.focus();
}

function Switcher() {
  const { variant, setVariant } = useProto();
  const [dark, setDark] = useState(() => new URLSearchParams(location.search).get("theme") === "dark" || document.documentElement.classList.contains("dark"));
  const [speed, setSpeedState] = useState<Speed>(() => (new URLSearchParams(location.search).get("motion") as Speed) || "normal");
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  useEffect(() => { setSpeed(speed); }, [speed]);
  const at = VARIANTS.findIndex((v) => v.key === variant);
  const go = (d: number) => setVariant(VARIANTS[(at + d + VARIANTS.length) % VARIANTS.length].key);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (editable(e.target) || e.metaKey || e.altKey || e.ctrlKey) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    <div className="kp-switcher" data-prototype>
      <button type="button" onClick={() => go(-1)} aria-label="Previous candidate">‹</button>
      <span className="kp-switcher-name">{variant} · {VARIANTS[at].name}</span>
      <button type="button" onClick={() => go(1)} aria-label="Next candidate">›</button>
      <span className="kp-switcher-sep" />
      <button type="button" onClick={() => setDark((d) => !d)}>{dark ? "Dark" : "Light"}</button>
      <button type="button" onClick={() => setSpeedState((s) => (s === "normal" ? "slow" : s === "slow" ? "reduced" : "normal"))}>
        {speed === "normal" ? "Motion" : speed === "slow" ? "Slow ×3" : "Reduced"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The writing surface

export function ProtoWriting({ footer }: { footer: (extra: ReactNode) => ReactNode }) {
  const a = useProto();
  const { variant, s, chat } = a;
  const handlers = useRef(a);
  handlers.current = a;
  const extensions = useMemo(() => [
    marks,
    EditorView.domEventHandlers({
      mousedown(e, view) {
        const sid = spanAt(view, e.target);
        if (!sid) return false;
        const h = handlers.current;
        if (SUGGESTIONS.some((g) => g.id === sid) && h.s.on) { window.setTimeout(() => h.focusSuggestion(sid), 0); }
        if (h.s.sets.some((x) => x.id === sid)) h.set(() => ({ set: sid }));
        return false;
      },
      click(e) {
        const dots = (e.target as HTMLElement).closest?.("[data-version]") as HTMLElement | null;
        if (dots) { handlers.current.set(() => ({ set: dots.dataset.version! })); openVersions(handlers.current); }
        return false;
      },
    }),
    EditorView.updateListener.of((u) => { if (u.docChanged || u.selectionSet || u.geometryChanged || u.viewportChanged) handlers.current.setTick((t) => t + 1); }),
  ], []);

  // Mount: the marks, and a layer that scrolls with the text for cards.
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const v = a.viewRef.current;
    if (!v) return;
    placeAll(v, a.s);
    // For the recordings (record.mjs): select a quote, place the cursor.
    Object.assign(window, { __kp: {
      select: (quote: string) => { const at = v.state.doc.toString().indexOf(quote); v.focus(); v.dispatch({ selection: EditorSelection.range(at, at + quote.length) }); },
      cursorAfter: (quote: string) => { const at = v.state.doc.toString().indexOf(quote) + quote.length; v.focus(); v.dispatch({ selection: EditorSelection.cursor(at) }); },
    } });
    const el = document.createElement("div");
    el.className = "kp-layer";
    v.scrollDOM.append(el);
    setLayer(el);
    return () => el.remove();
    // Once per editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A thread dot or a "Kin replied" chip in the text opens that chat.
  useEffect(() => {
    const open = (e: Event) => {
      const h = handlers.current;
      const chatId = (e as CustomEvent<string>).detail;
      if (h.s.pane === chatId) { h.closePane(); return; }
      if (h.s.ask?.chat === chatId) h.set(() => ({ ask: null }));
      h.openChat(chatId);
    };
    window.addEventListener("kp:chat", open);
    return () => window.removeEventListener("kp:chat", open);
  }, []);

  // Kin is open: A shows the margin on its Kin tab.
  const kinOpen = chat.open;
  const marginTab: Tab | null = variant === "A" ? (kinOpen ? "kin" : s.tab) : null;
  const open = a.viewRef.current ? suggestions(a.viewRef.current.state) : [];
  const index = open.findIndex((x) => x.id === s.current);

  const extra = (
    <div className="kp-footer-extra">
      <button type="button" className="kp-toggle" aria-pressed={s.on} onClick={a.toggleSuggestions} title="Suggestions (⌥⌘K)">
        <span className="kp-toggle-dot" />Suggestions{s.on && open.length > 0 ? <span className="kp-count">{open.length}</span> : null}
      </button>
      {s.on && open.length > 0 && (
        <span className="kp-stepper">
          <button type="button" aria-label="Previous suggestion" title="Previous (⇧⌘')" onClick={() => a.step(-1)}>‹</button>
          <span>{index < 0 ? `${open.length}` : `${index + 1} of ${open.length}`}</span>
          <button type="button" aria-label="Next suggestion" title="Next (⌘')" onClick={() => a.step(1)}>›</button>
        </span>
      )}
      <button type="button" className="kp-stash-button" data-stash-button onClick={() => {
        if (variant === "A") { a.chat.hide(); a.set((x) => ({ tab: x.tab === "stash" ? null : "stash" })); }
        if (variant === "B") { if (s.left === "stash") closeLeft(a); else openLeft(a, "stash"); }
        if (variant === "C") a.set((x) => ({ shelf: !x.shelf }));
      }}>Stash <span className="kp-count">{s.stash.length}</span></button>
    </div>
  );

  // B: the column slides as a whole to make room; it never re-wraps.
  const [shift, setShift] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (variant !== "B") { setShift(0); return; }
    const measure = () => {
      const box = host.current?.getBoundingClientRect();
      const line = a.viewRef.current?.contentDOM.querySelector(".cm-line:not(.cm-frontmatter)") as HTMLElement | null;
      if (!box || !line) return;
      const width = line.getBoundingClientRect().width;
      const centred = (box.width - width) / 2;
      const left = s.left ? 280 + 24 : 24;
      const right = kinOpen ? 360 + 24 : 24;
      const room = box.width - left - right;
      const x = room >= width ? Math.min(Math.max(centred, left), box.width - right - width) : left + (room - width) / 2;
      setShift(x - centred);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (host.current?.parentElement) observer.observe(host.current.parentElement);
    return () => observer.disconnect();
  }, [variant, s.left, kinOpen, a.viewRef]);

  // B with both gutters open needs the whole window: the file sidebar folds
  // to icons, and comes back when one closes.
  const sidebar = useSidebar();
  const folded = useRef(false);
  useEffect(() => {
    if (variant !== "B") return;
    if (s.left && kinOpen && sidebar.open) { folded.current = true; sidebar.setOpen(false); }
    else if ((!s.left || !kinOpen) && folded.current) { folded.current = false; sidebar.setOpen(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, s.left, kinOpen]);

  return (
    <div className={`kp-writing kp-${variant}${s.on ? " kp-on" : ""}${variant === "B" && s.left === "versions" ? " kp-dim-others" : ""}`}>
      <div className="kp-stage">
        <div className="kp-editor" ref={host} style={{ transform: shift ? `translateX(${shift}px)` : undefined }}>
          <Editor path={DRAFT_PATH} text={DRAFT} viewRef={a.viewRef} extensions={extensions} />
        </div>
        {layer && createPortal(<Overlay />, layer)}
        <PaneMount />
        {variant === "A" && <MarginA tab={marginTab} />}
        {variant === "B" && <PanelsB kinOpen={kinOpen} />}
        {variant === "C" && <SheetC kinOpen={kinOpen} />}
      </div>
      {footer(extra)}
    </div>
  );
}

/** Cards, the ask pill and the cycle strip, drawn in the text's own layer. */
function Overlay() {
  const a = useProto();
  const v = a.viewRef.current;
  const layer = v?.scrollDOM.querySelector(".kp-layer") as HTMLElement | null;
  if (!v || !layer) return null;
  const base = layer.getBoundingClientRect();
  const line = v.contentDOM.querySelector(".cm-line:not(.cm-frontmatter)") as HTMLElement | null;
  const col = line?.getBoundingClientRect();
  const colLeft = (col?.left ?? 0) - base.left;
  const colRight = (col?.right ?? 600) - base.left;
  const at = (pos: number, side: "below" | "above" = "below") => {
    const c = v.coordsAtPos(Math.min(pos, v.state.doc.length));
    if (!c) return null;
    return { x: c.left - base.left, y: (side === "below" ? c.bottom : c.top) - base.top };
  };
  const { s, variant } = a;
  const current = s.current ? spanById(v.state, s.current) : null;
  const g = current && SUGGESTIONS.find((x) => x.id === current.id);
  const list = suggestions(v.state);
  const index = list.findIndex((x) => x.id === s.current);
  const cardAt = current && at(current.to);
  const askSpan = s.ask && (spanById(v.state, s.ask.stage === "pill" ? "asked" : "working") ?? (s.ask.chat ? spanById(v.state, s.ask.chat) : null));
  const askAt = askSpan && at(askSpan.to);
  const vs = a.activeSet();
  const vspan = spanById(v.state, vs.id);
  const vAt = vspan && at(vspan.from, "above");
  const vBelow = vspan && at(vspan.from);
  const askChat = s.ask?.chat ? s.chats.find((c) => c.id === s.ask!.chat) : null;
  const paneChat = variant === "C" && s.pane ? s.chats.find((c) => c.id === s.pane) : null;
  const paneTop = (() => {
    if (!paneChat?.paragraph) return null;
    const p = v.state.doc.toString().indexOf(paneChat.paragraph);
    return p >= 0 ? at(p, "above") : null;
  })();
  return (
    <>
      {g && cardAt && s.on && (
        <div className="kp-card" style={{ transform: `translate(${Math.max(colLeft, Math.min(cardAt.x - 40, colRight - (g.kind === "rewrite" ? 340 : 196)))}px, ${cardAt.y + 6}px)` }} key="card" role="dialog" aria-label="Kin's suggestion">
          {g.kind === "rewrite" && <p className="kp-card-text">{g.replacement}</p>}
          <div className="kp-card-row">
            <span className="kp-card-step">
              <button type="button" aria-label="Previous suggestion" onClick={() => a.step(-1)}>‹</button>
              <span>{index + 1} of {list.length}</span>
              <button type="button" aria-label="Next suggestion" onClick={() => a.step(1)}>›</button>
            </span>
            <span className="kp-card-actions">
              <IconButton label="Accept (⌥↵)" onClick={() => a.settle(g.id, true)}><Icon.check /></IconButton>
              <IconButton label="Dismiss (⌥⌘⌫)" onClick={() => a.settle(g.id, false)}><Icon.x /></IconButton>
              <IconButton label="Discuss (⇧⌘J)" onClick={() => a.discuss(g.id)}><Icon.chat /></IconButton>
            </span>
          </div>
        </div>
      )}
      {s.ask && askAt && (s.ask.stage === "pill" || (variant === "C" && askChat)) && (
        <div className="kp-pill" style={{ transform: `translate(${Math.max(colLeft, Math.min(askAt.x - 120, colRight - 380))}px, ${askAt.y + 8}px)` }}>
          {s.ask.stage === "pill" ? (
            <AskField />
          ) : askChat && (
            <div className="kp-pill-answer">
              <KinAvatar className="kp-avatar" talking={a.s.streaming === askChat.id} />
              <p>{askChat.messages.at(-1)?.by === "kin" ? askChat.messages.at(-1)!.text : ""}</p>
              <div className="kp-pill-actions">
                <button type="button" onClick={(e) => a.stashReply(askChat.messages.at(-1)?.text ?? "", (e.currentTarget.closest(".kp-pill") as HTMLElement).getBoundingClientRect())}>Stash</button>
                <button type="button" onClick={() => { a.set(() => ({ ask: null })); a.openChat(askChat.id); }}>Open as chat</button>
                <button type="button" onClick={() => a.set(() => ({ ask: null }))}>Close</button>
              </div>
            </div>
          )}
        </div>
      )}
      {s.ask?.stage === "working" && variant === "C" && askAt && (
        <div className="kp-pill kp-pill-working" style={{ transform: `translate(${Math.max(colLeft, Math.min(askAt.x - 120, colRight - 380))}px, ${askAt.y + 8}px)` }}>
          <KinAvatar className="kp-avatar" talking /><span className="kp-typing"><i /><i /><i /></span>
        </div>
      )}
      {vAt && s.strip > 0 && <Strip key={s.strip} x={vAt.x} y={vAt.y} label={`${vs.current + 1} of ${vs.versions.length}`} />}
      {variant === "C" && s.popover && vBelow && (
        <div className="kp-popover" style={{ transform: `translate(${Math.max(colLeft, Math.min(vBelow.x - 20, colRight - 300))}px, ${vBelow.y + 8}px)` }}>
          <Versions />
        </div>
      )}
      {paneChat && paneTop && (
        <div className="kp-beside" style={{ transform: `translate(${Math.min(colRight + 24, base.width - 256)}px, ${paneTop.y - 4}px)` }}>
          <ChatPane chat={paneChat} onClose={a.closePane} compact />
        </div>
      )}
    </>
  );
}

function Strip({ x, y, label }: { x: number; y: number; label: string }) {
  return <div className="kp-strip" style={{ left: x, top: y - 34 }}><span>⌥⌘[</span>{label}<span>⌥⌘]</span></div>;
}

function AskField() {
  const a = useProto();
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <form className="kp-ask" onSubmit={(e) => { e.preventDefault(); if (text.trim()) a.chooseAsk(text.trim()); }}>
      <div className="kp-ask-row">
        <KinAvatar className="kp-avatar" />
        <input ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about this…" aria-label="Ask Kin about the selection" />
      </div>
      <div className="kp-ask-chips">
        {ASKS.map((q) => <button type="button" key={q} onClick={() => a.chooseAsk(q)}>{q}</button>)}
      </div>
    </form>
  );
}

/** B: a paragraph's chat, opened under its paragraph. */
function PaneMount() {
  const a = useProto();
  const [, bump] = useState(0);
  useEffect(() => { const off = onPaneHost(() => bump((n) => n + 1)); return () => { off(); }; }, []);
  if (a.variant !== "B" || !a.s.pane) return null;
  const host = paneHosts.get(`pane:${a.s.pane}`);
  const c = a.s.chats.find((x) => x.id === a.s.pane);
  if (!host || !c) return null;
  return createPortal(<div className="kp-under"><ChatPane chat={c} onClose={a.closePane} compact /></div>, host);
}

// ---------------------------------------------------------------------------
// Candidate A: one margin, tabs (A's tabs, C's stash with versions)

function MarginA({ tab }: { tab: Tab | null }) {
  const a = useProto();
  const setTab = (t: Tab | null) => {
    if (t === "kin") { a.set(() => ({ tab: null })); if (!a.chat.open) a.chat.show(); return; }
    a.chat.hide();
    a.set(() => ({ tab: t }));
  };
  return (
    <>
      <button type="button" className="kp-panel-toggle kp-right-toggle" aria-pressed={!!tab} aria-label="Margin" title="Margin" onClick={() => setTab(tab ? null : "kin")}><Icon.panelRight /></button>
      <aside className="kp-margin" data-open={!!tab || undefined} aria-label="Margin" inert={!tab}>
        <div className="kp-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "kin"} onClick={() => setTab("kin")}>Kin</button>
          <button role="tab" aria-selected={tab === "refs"} onClick={() => setTab("refs")}>References</button>
          <button role="tab" aria-selected={tab === "stash"} onClick={() => setTab("stash")} data-stash-target={tab === "stash" || undefined}>Stash <span className="kp-count">{a.s.stash.length}</span></button>
        </div>
        <div className="kp-margin-body">
          {tab === "kin" && <KinPanel />}
          {tab === "refs" && <References />}
          {tab === "stash" && (
            <div className="kp-stack">
              <Versions />
              <Stash />
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// Candidate B: two gutters. His words on the left, Kin on the right.

function PanelsB({ kinOpen }: { kinOpen: boolean }) {
  const a = useProto();
  const { left } = a.s;
  return (
    <>
      <button type="button" className="kp-panel-toggle kp-left-toggle" aria-pressed={!!left} aria-label="Versions and stash" title="Versions and stash (⌥⌘A)" onClick={() => (left ? closeLeft(a) : openLeft(a, "versions"))}><Icon.panelLeft /></button>
      <button type="button" className="kp-panel-toggle kp-right-toggle" aria-pressed={kinOpen} aria-label="Kin" title="Kin (⌘J)" onClick={() => (kinOpen ? a.chat.hide() : a.chat.show())}><Icon.panelRight /></button>
      <aside className="kp-left" data-open={!!left || undefined} aria-label="Versions and stash" inert={!left}>
        <div className="kp-tabs" role="tablist">
          <button role="tab" aria-selected={left === "versions"} onClick={() => openLeft(a, "versions")}>Versions</button>
          <button role="tab" aria-selected={left === "stash"} onClick={() => openLeft(a, "stash")} data-stash-target={left === "stash" || undefined}>Stash <span className="kp-count">{a.s.stash.length}</span></button>
        </div>
        <div className="kp-margin-body">{left === "versions" ? <Versions /> : left === "stash" ? <Stash /> : null}</div>
        {left === "versions" && <p className="kp-foot-keys">↵ adds · esc closes</p>}
      </aside>
      <aside className="kp-right" data-open={kinOpen || undefined} aria-label="Kin" inert={!kinOpen}>
        <div className="kp-along">
          <h3>Along this paragraph</h3>
          <div className="kp-along-row">
            {REFERENCES.along.concat(REFERENCES.here.slice(2)).slice(0, 3).map((r) => <span key={r.title} className="kp-along-card"><strong>{r.title}</strong><small>{r.meta}</small></span>)}
          </div>
        </div>
        <KinPanel />
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// Candidate C: Kin comes to the text. Nothing sits beside the page; Kin is a
// floating sheet, versions a popover at the word, the stash a shelf.

function SheetC({ kinOpen }: { kinOpen: boolean }) {
  const a = useProto();
  return (
    <>
      <aside className="kp-sheet" data-open={kinOpen || undefined} aria-label="Kin" inert={!kinOpen}>
        <KinPanel floating />
      </aside>
      {!kinOpen && (
        <button type="button" className="kp-launcher" aria-label="Kin" title="Kin (⌘J)" onClick={() => a.chat.show()}>
          <KinAvatar className="kp-launcher-avatar" talking={!!a.s.streaming} />
        </button>
      )}
      <section className="kp-shelf" data-open={a.s.shelf || undefined} aria-label="Stash" inert={!a.s.shelf} data-stash-target={a.s.shelf || undefined}>
        <header><h3>Stash</h3><button type="button" className="kp-link" onClick={() => a.set(() => ({ shelf: false }))}>Close</button></header>
        <Stash horizontal />
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared parts

function KinPanel({ floating = false }: { floating?: boolean }) {
  const a = useProto();
  const { s } = a;
  const [query, setQuery] = useState("");
  const current = s.chats.find((c) => c.id === s.open);
  if (!current) {
    const q = query.toLocaleLowerCase();
    const shown = s.chats.filter((c) => !q || c.title.toLocaleLowerCase().includes(q) || c.messages.some((m) => m.text.toLocaleLowerCase().includes(q)));
    return (
      <div className="kp-kin" data-floating={floating || undefined}>
        <header className="kp-kin-head">
          <div className="kp-search"><Icon.search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a chat" aria-label="Find a chat" /></div>
          <IconButton label="New chat" onClick={() => a.set(() => ({ open: "c-general" }))}><Icon.plus /></IconButton>
        </header>
        <div className="kp-chats">
          {(["draft", "else"] as const).map((group) => {
            const rows = shown.filter((c) => c.group === group);
            if (!rows.length) return null;
            return (
              <section key={group}>
                <h3>{group === "draft" ? "This draft" : "Everything else"}</h3>
                {rows.map((c) => (
                  <button type="button" key={c.id} className="kp-chat-row" onClick={() => a.openChat(c.id)}>
                    <span className="kp-chat-icon" data-kind={c.kind}>{c.kind === "paragraph" ? "¶" : c.kind === "feed" ? "◎" : c.kind === "idea" ? "✦" : c.kind === "clip" ? "❏" : "•"}</span>
                    <span className="kp-chat-main"><strong>{c.title}</strong><small>{c.messages.at(-1)?.text ?? (c.real ? (c.kind === "draft" ? "This draft's chat" : "Anything else") : "")}</small></span>
                    <span className="kp-chat-when">{c.when}</span>
                  </button>
                ))}
              </section>
            );
          })}
        </div>
      </div>
    );
  }
  return (
    <div className="kp-kin" data-floating={floating || undefined}>
      <header className="kp-kin-head">
        <button type="button" className="kp-chat-title" onClick={() => a.set(() => ({ open: null }))} aria-label="All chats">
          <Icon.back /><span>{current.title}</span>
        </button>
        <IconButton label="Call Kin (later, KI-99)" disabled><Icon.headphones /></IconButton>
        <IconButton label="Hide (⌘J)" onClick={() => a.chat.hide()}><Icon.minus /></IconButton>
      </header>
      {current.real ? <RealChat /> : <ChatPane chat={current} bare />}
    </div>
  );
}

/** The real chat, on the mock model. */
function RealChat() {
  const { chat } = useProto();
  return (
    <div className="kp-real">
      <KinLog chat={chat} />
      <div className="kp-real-composer"><KinComposer chat={chat} onManage={() => chat.hide()} /></div>
    </div>
  );
}

/** A scripted chat: a paragraph's, or one Discuss started. */
function ChatPane({ chat, onClose, compact = false, bare = false }: { chat: Chat; onClose?: () => void; compact?: boolean; bare?: boolean }) {
  const a = useProto();
  const [text, setText] = useState("");
  const asked = chat.messages.some((m) => m.by === "owner" && m.text === "Why?");
  return (
    <div className={`kp-pane${compact ? " kp-pane-compact" : ""}${bare ? " kp-pane-bare" : ""}`}>
      {!bare && (
        <header className="kp-pane-head">
          <KinAvatar className="kp-avatar" talking={a.s.streaming === chat.id} />
          <strong>{chat.title}</strong>
          {a.variant !== "A" && <IconButton label="Open in the Kin panel" onClick={() => { onClose?.(); a.set(() => ({ open: chat.id })); a.chat.show(); }}><Icon.panelRight /></IconButton>}
          {onClose && <IconButton label="Fold" onClick={onClose}><Icon.minus /></IconButton>}
        </header>
      )}
      <div className="kp-messages">
        {chat.messages.map((m, i) => (
          <div key={i} className="kp-message" data-by={m.by}>
            {m.by === "kin" && <KinAvatar className="kp-avatar" />}
            <p>{m.text}</p>
            {m.by === "kin" && m.stashable && m.text && a.s.streaming !== chat.id && (
              <button type="button" className="kp-link" onClick={(e) => a.stashReply(m.text, (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect())}>Stash</button>
            )}
          </div>
        ))}
      </div>
      {!asked && chat.messages.length === 1 && chat.messages[0].text.startsWith("About") && (
        <div className="kp-ask-chips"><button type="button" onClick={() => a.send(chat.id, "Why?")}>Why?</button><button type="button" onClick={() => a.send(chat.id, "Another way?")}>Another way?</button></div>
      )}
      <form className="kp-pane-composer" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { a.send(chat.id, text.trim()); setText(""); } }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" aria-label="Reply to Kin" />
      </form>
    </div>
  );
}

function Versions() {
  const a = useProto();
  const vs = a.s.sets.find((x) => x.id === a.s.set) ?? a.s.sets[0];
  const [adding, setAdding] = useState("");
  const levels: VersionSet["level"][] = ["word", "sentence", "paragraph"];
  const forLevel = (l: VersionSet["level"]) => a.s.sets.find((x) => x.level === l);
  return (
    <section className="kp-versions" aria-label="Versions">
      <div className="kp-levels">
        <h3>Versions</h3>
        {levels.map((l) => (
          <button key={l} type="button" aria-pressed={vs.level === l} disabled={!forLevel(l)} onClick={() => { const x = forLevel(l); if (x) a.set(() => ({ set: x.id })); }}>{l[0].toUpperCase() + l.slice(1)}</button>
        ))}
      </div>
      <ul>
        {vs.versions.map((v, i) => (
          <li key={i} data-by={v.by} data-current={i === vs.current || undefined} data-fresh={v.fresh || undefined}>
            <button type="button" onClick={() => a.pick(vs.id, i)}>
              <span className="kp-bullet" />{v.text}
            </button>
          </li>
        ))}
      </ul>
      <form className="kp-add" onSubmit={(e) => { e.preventDefault(); if (adding.trim()) { a.addVersion(vs.id, adding.trim()); setAdding(""); } }}>
        <span className="kp-bullet kp-bullet-empty" />
        <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Add a version" aria-label="Add a version" />
        {vs.ask.length > 0 && <button type="button" className="kp-link kp-kin-link" onClick={() => a.askVersions(vs.id)}>Ask Kin</button>}
      </form>
    </section>
  );
}

function Stash({ horizontal = false }: { horizontal?: boolean }) {
  const a = useProto();
  return (
    <section className={`kp-stash${horizontal ? " kp-stash-row" : ""}`} aria-label="Stash">
      {!horizontal && <h3 className="kp-stash-title">Stash</h3>}
      {a.s.stash.length === 0 && <p className="kp-empty">Nothing stashed. ⌥⌘X moves a selection here.</p>}
      <ul>
        {a.s.stash.map((item) => (
          <li key={item.id} data-by={item.by} data-fresh={item.fresh || undefined} data-suggestion={item.suggestion ? true : undefined}
            onMouseEnter={() => item.suggestion && a.highlight(item.suggestion)} onMouseLeave={() => item.suggestion && a.highlight(null)}>
            <button type="button" className="kp-stash-text" onClick={() => {
              if (item.suggestion) { a.focusSuggestion(item.suggestion); return; }
              a.insertStash(item.id);
            }}>
              {item.by === "kin" && <KinAvatar className="kp-avatar" />}
              <span>{item.text}</span>
            </button>
            <span className="kp-stash-actions">
              <IconButton label={item.suggestion ? "Accept" : "Insert at the cursor"} onClick={() => a.insertStash(item.id)}>{item.suggestion ? <Icon.check /> : <Icon.insert />}</IconButton>
              <IconButton label="Dismiss" onClick={() => a.dismissStash(item.id)}><Icon.x /></IconButton>
              {item.suggestion && <IconButton label="Discuss" onClick={() => a.discuss(item.suggestion!)}><Icon.chat /></IconButton>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function References() {
  return (
    <div className="kp-refs">
      <h3>Referenced here</h3>
      {REFERENCES.here.map((r) => <article key={r.title}><strong>{r.title}</strong><small>{r.meta}</small><p>{r.summary}</p></article>)}
      <h3>Along this paragraph</h3>
      {REFERENCES.along.map((r) => <article key={r.title}><strong>{r.title}</strong><small>{r.meta}</small><p>{r.summary}</p></article>)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kin off the editor: Feed, a story, Ideas, Inspiration, Settings

export function ProtoElsewhere({ on }: { on: boolean }) {
  const a = useProto();
  if (!on) return null;
  const open = a.chat.open;
  const kind = a.variant === "A" ? "kp-else-margin" : a.variant === "B" ? "kp-else-box" : "kp-sheet kp-else-sheet";
  return (
    <>
      <aside className={kind} data-open={open || undefined} aria-label="Kin" inert={!open}>
        <KinPanel floating={a.variant !== "A"} />
      </aside>
      {!open && (
        <button type="button" className="kp-launcher kp-fixed" aria-label="Kin" title="Kin (⌘J)" onClick={() => { a.set(() => ({ open: "c-general" })); a.chat.show(); }}>
          <KinAvatar className="kp-launcher-avatar" />
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function IconButton({ label, onClick, children, disabled }: { label: string; onClick?: () => void; children: ReactNode; disabled?: boolean }) {
  return <button type="button" className="kp-icon" aria-label={label} title={label} onClick={onClick} disabled={disabled} onMouseDown={(e) => e.preventDefault()}>{children}</button>;
}

const Icon = {
  check: () => <Check aria-hidden />,
  x: () => <X aria-hidden />,
  chat: () => <MessageCircle aria-hidden />,
  panelRight: () => <PanelRight aria-hidden />,
  panelLeft: () => <PanelLeft aria-hidden />,
  search: () => <Search aria-hidden />,
  plus: () => <Plus aria-hidden />,
  minus: () => <Minus aria-hidden />,
  back: () => <ArrowLeft aria-hidden />,
  headphones: () => <Headphones aria-hidden />,
  insert: () => <ArrowDown aria-hidden />,
};
