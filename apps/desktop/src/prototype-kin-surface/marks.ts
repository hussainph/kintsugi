// PROTOTYPE (KI-96), throwaway: the marks every candidate draws in the
// draft, as one CodeMirror field. It maps through edits, so he can keep
// typing while Kin works or while suggestions are showing.
import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export type SpanKind = "cut" | "rewrite" | "version" | "working" | "asked" | "flash" | "reply" | "leaving";
export type Span = { id: string; kind: SpanKind; from: number; to: number; n?: number; at?: number; label?: string };
/** Paragraph-level marks: a chat on the paragraph, Kin working on it (the
 *  gutter rule), the paragraph in focus while versions are open, and a
 *  chat pane opened under it (candidate B). */
export type Para = { id: string; kind: "thread" | "rule" | "focus" | "pane"; at: number };

type Marks = { spans: Span[]; paras: Para[]; show: boolean; current: string | null; deco: DecorationSet };

export const setSpan = StateEffect.define<Span>();
export const dropSpan = StateEffect.define<string>();
export const setPara = StateEffect.define<Para>();
export const dropPara = StateEffect.define<string>();
export const setShow = StateEffect.define<boolean>();
export const setCurrent = StateEffect.define<string | null>();
export const resetMarks = StateEffect.define<null>();

const SUGGESTION = new Set<SpanKind>(["cut", "rewrite"]);

export const marks = StateField.define<Marks>({
  create: () => ({ spans: [], paras: [], show: false, current: null, deco: Decoration.none }),
  update(value, tr) {
    let { spans, paras, show, current } = value;
    if (tr.docChanged) {
      spans = spans
        .map((s) => ({ ...s, from: tr.changes.mapPos(s.from, 1), to: tr.changes.mapPos(s.to, -1) }))
        // An edit inside a suggestion means he rewrote it himself: drop it.
        .filter((s) => s.to > s.from || s.kind === "reply");
      paras = paras.map((p) => ({ ...p, at: tr.changes.mapPos(p.at, -1) }));
    }
    for (const e of tr.effects) {
      if (e.is(resetMarks)) { spans = []; paras = []; show = false; current = null; }
      else if (e.is(setSpan)) spans = [...spans.filter((s) => s.id !== e.value.id), e.value];
      else if (e.is(dropSpan)) spans = spans.filter((s) => s.id !== e.value);
      else if (e.is(setPara)) paras = [...paras.filter((p) => p.id !== e.value.id), e.value];
      else if (e.is(dropPara)) paras = paras.filter((p) => p.id !== e.value);
      else if (e.is(setShow)) show = e.value;
      else if (e.is(setCurrent)) current = e.value;
    }
    if (!tr.docChanged && spans === value.spans && paras === value.paras && show === value.show && current === value.current) return value;
    const next = { spans, paras, show, current, deco: Decoration.none };
    next.deco = draw(tr.state, next);
    return next;
  },
  provide: (f) => EditorView.decorations.from(f, (m) => m.deco),
});

/** The positions of a suggestion, in document order, while they show. */
export function suggestions(state: EditorState) {
  const m = state.field(marks);
  return m.spans.filter((s) => SUGGESTION.has(s.kind)).sort((a, b) => a.from - b.from);
}
export const spanById = (state: EditorState, id: string) => state.field(marks).spans.find((s) => s.id === id);

class Dots extends WidgetType {
  constructor(readonly id: string, readonly n: number, readonly at: number) { super(); }
  eq(o: Dots) { return o.id === this.id && o.n === this.n && o.at === this.at; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "kp-dots";
    el.setAttribute("aria-label", `Version ${this.at + 1} of ${this.n}`);
    el.dataset.version = this.id;
    const inner = document.createElement("span");
    for (let i = 0; i < this.n; i++) {
      const d = document.createElement("i");
      if (i === this.at) d.className = "on";
      inner.append(d);
    }
    el.append(inner);
    return el;
  }
  ignoreEvent() { return false; }
}

class Reply extends WidgetType {
  constructor(readonly id: string, readonly label: string) { super(); }
  eq(o: Reply) { return o.id === this.id && o.label === this.label; }
  toDOM() {
    const el = document.createElement("button");
    el.className = "kp-reply";
    el.type = "button";
    el.dataset.chat = this.id;
    el.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="19" fill="currentColor"/><path d="M11 9 L17 17 L14 22 L21 27 L19 33" fill="none" stroke="#d4a53c" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span></span>`;
    el.querySelector("span")!.textContent = this.label;
    el.addEventListener("mousedown", (e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("kp:chat", { detail: this.id })); });
    return el;
  }
  ignoreEvent() { return true; }
}

class Thread extends WidgetType {
  constructor(readonly id: string) { super(); }
  eq(o: Thread) { return o.id === this.id; }
  toDOM() {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "kp-thread";
    el.dataset.chat = this.id;
    el.setAttribute("aria-label", "Open this paragraph's chat");
    el.addEventListener("mousedown", (e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("kp:chat", { detail: this.id })); });
    return el;
  }
  ignoreEvent() { return true; }
}

/** Where candidate B's chat pane mounts, under its paragraph. */
export const paneHosts = new Map<string, HTMLElement>();
const paneListeners = new Set<() => void>();
export const onPaneHost = (f: () => void) => { paneListeners.add(f); return () => paneListeners.delete(f); };
class PaneHost extends WidgetType {
  constructor(readonly id: string) { super(); }
  eq(o: PaneHost) { return o.id === this.id; }
  toDOM() {
    const el = document.createElement("div");
    el.className = "kp-pane-host";
    el.dataset.pane = this.id;
    paneHosts.set(this.id, el);
    queueMicrotask(() => paneListeners.forEach((f) => f()));
    return el;
  }
  destroy(el: HTMLElement) {
    if (paneHosts.get(this.id) === el) paneHosts.delete(this.id);
    queueMicrotask(() => paneListeners.forEach((f) => f()));
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 0; }
}

function draw(state: EditorState, m: Marks): DecorationSet {
  const out: Range<Decoration>[] = [];
  for (const s of m.spans) {
    if (SUGGESTION.has(s.kind) && !m.show) continue;
    const current = s.id === m.current ? " kp-current" : "";
    if (s.kind === "reply") { out.push(Decoration.widget({ widget: new Reply(s.id, s.label ?? "Kin replied"), side: 1 }).range(s.to)); continue; }
    if (s.to <= s.from) continue;
    const cls = { cut: "kp-cut", rewrite: "kp-anchor", version: "kp-version", working: "kp-working", asked: "kp-asked", flash: "kp-flash", leaving: "kp-leaving" }[s.kind];
    out.push(Decoration.mark({ class: cls + current, attributes: { "data-span": s.id } }).range(s.from, s.to));
    if (s.kind === "version" && s.n) out.push(Decoration.widget({ widget: new Dots(s.id, s.n, s.at ?? 0), side: 1 }).range(s.to));
  }
  for (const p of m.paras) {
    if (p.at < 0 || p.at > state.doc.length) continue;
    const line = state.doc.lineAt(p.at);
    if (p.kind === "thread") out.push(Decoration.widget({ widget: new Thread(p.id), side: -1 }).range(line.from));
    else if (p.kind === "rule") out.push(Decoration.line({ class: "kp-rule-line" }).range(line.from));
    else if (p.kind === "focus") out.push(Decoration.line({ class: "kp-focus" }).range(line.from));
    else if (p.kind === "pane") out.push(Decoration.widget({ widget: new PaneHost(p.id), side: 1, block: true }).range(line.to));
  }
  return Decoration.set(out, true);
}

/** A span's id under a click, for opening its card. */
export function spanAt(_view: EditorView, target: EventTarget | null): string | null {
  const el = (target as HTMLElement | null)?.closest?.("[data-span]") as HTMLElement | null;
  return el?.dataset.span ?? null;
}
