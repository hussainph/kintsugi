import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import type { Range } from "./anchors.ts";

/**
 * An inline card (KI-109): a small block under a paragraph of the draft,
 * drawn by a host, so it never covers the line it's about and never
 * re-wraps one; it only pushes the lines below down. Kin's marks use it for
 * their `‹ 1 of N ›` card; KI-111's version switcher uses it at the end of
 * the cursor's span (`align`). `revealRange` brings what a card is about
 * into view on the card's eased scroll.
 */

/** One card. */
export type CardSpec = {
  /** The card redraws when this changes; the same key keeps its DOM. */
  key: string;
  /** The words it's about: it goes under the paragraph `anchor.to` is in. */
  anchor: Range;
  /** Draws the card into `dom` (a React portal, or plain DOM) and returns a cleanup. */
  render: (dom: HTMLElement, view: EditorView) => () => void;
  /** Extra classes on the block, beside `cm-step-card`. */
  className?: string;
  /** Data attributes on the block (`{ kind: "cut" }` → `data-kind="cut"`). */
  data?: Record<string, string>;
  /** Height before it's drawn, in px. */
  estimatedHeight?: number;
  /** Starts the card under this position's x (the end of the span it's
   *  about), as far right as it fits in the column. Default: the text's left edge. */
  align?: number;
  /** Cards with the same slot redraw into the same block when their key
   *  changes, so the card doesn't blink as it steps in place. */
  slot?: string;
};

const fence = /^\s*(```|~~~)/;

/** The end of the paragraph `pos` is in: a card goes under it. */
export function paragraphEnd(state: EditorState, pos: number): number {
  const doc = state.doc;
  let line = doc.lineAt(Math.max(0, Math.min(pos, doc.length)));
  while (line.number < doc.lines) {
    const next = doc.line(line.number + 1);
    if (!next.text.trim() || fence.test(next.text)) break;
    line = next;
  }
  return line.to;
}

const cleanups = new WeakMap<HTMLElement, () => void>();
const drawn = new WeakMap<HTMLElement, CardSpec>();

/** Puts each aligned card under its position's x, once the layout is known. */
function alignCards(view: EditorView) {
  view.requestMeasure({
    key: alignCards,
    read(view) {
      const out: { dom: HTMLElement; x: number }[] = [];
      for (const dom of view.contentDOM.querySelectorAll<HTMLElement>(".cm-step-card[data-card-align]")) {
        const pos = Number(dom.dataset.cardAlign);
        if (!(pos >= 0 && pos <= view.state.doc.length)) continue;
        const at = view.coordsAtPos(pos, -1);
        if (!at) continue;
        const box = dom.getBoundingClientRect();
        const start = box.left + (parseFloat(getComputedStyle(dom).paddingLeft) || 0);
        out.push({ dom, x: Math.max(0, Math.round(at.left - start)) });
      }
      return out;
    },
    write(out) {
      for (const { dom, x } of out) dom.style.setProperty("--card-x", `${x}px`);
    },
  });
}

/** Re-aligns cards when lines re-wrap or move. */
const aligner = ViewPlugin.fromClass(class {
  update(update: ViewUpdate) {
    if (update.geometryChanged || update.docChanged || update.viewportChanged) alignCards(update.view);
  }
});

class CardBlock extends WidgetType {
  readonly spec: CardSpec;
  constructor(spec: CardSpec) {
    super();
    this.spec = spec;
  }
  eq(other: CardBlock) {
    return this.spec.key === other.spec.key && this.spec.align === other.spec.align;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.contentEditable = "false";
    // Keep the editor's focus and selection.
    dom.addEventListener("mousedown", (event) => event.preventDefault());
    this.draw(dom, view);
    return dom;
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    const before = drawn.get(dom);
    if (!this.spec.slot || before?.slot !== this.spec.slot) return false;
    cleanups.get(dom)?.();
    for (const key of Object.keys(before.data ?? {})) delete dom.dataset[key];
    this.draw(dom, view);
    return true;
  }
  private draw(dom: HTMLElement, view: EditorView) {
    dom.className = `cm-step-card${this.spec.className ? ` ${this.spec.className}` : ""}`;
    for (const [key, value] of Object.entries(this.spec.data ?? {})) dom.dataset[key] = value;
    if (this.spec.align === undefined) {
      delete dom.dataset.cardAlign;
      dom.style.removeProperty("--card-x");
    } else dom.dataset.cardAlign = String(this.spec.align);
    drawn.set(dom, this.spec);
    cleanups.set(dom, this.spec.render(dom, view));
    if (this.spec.align !== undefined) alignCards(view);
  }
  destroy(dom: HTMLElement) {
    cleanups.get(dom)?.();
    cleanups.delete(dom);
  }
  ignoreEvent() {
    return true;
  }
  get estimatedHeight() {
    return this.spec.estimatedHeight ?? 64;
  }
}

/** Shows the card `compute` returns (or none), recomputed when `deps` change. */
export function inlineCard(compute: (state: EditorState) => CardSpec | null, deps: Parameters<typeof EditorView.decorations.compute>[0]): Extension {
  return [
    EditorView.decorations.compute(deps, (state) => {
      const spec = compute(state);
      if (!spec) return Decoration.none;
      const at = paragraphEnd(state, spec.anchor.to);
      return Decoration.set([Decoration.widget({ widget: new CardBlock(spec), block: true, side: 1 }).range(at)]);
    }),
    aligner,
    theme,
  ];
}

/** cubic-bezier(x1, y1, x2, y2) as a function of time, 0–1. */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const curve = (t: number, p1: number, p2: number) => ((1 - 3 * p2 + 3 * p1) * t + (3 * p2 - 6 * p1)) * t * t + 3 * p1 * t;
  const slope = (t: number, p1: number, p2: number) => 3 * (1 - 3 * p2 + 3 * p1) * t * t + 2 * (3 * p2 - 6 * p1) * t + 3 * p1;
  return (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = curve(t, x1, x2) - x;
      const d = slope(t, x1, x2);
      if (Math.abs(dx) < 1e-5 || Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    return curve(Math.max(0, Math.min(1, t)), y1, y2);
  };
}

/** The app's panel curve (KI-96's motion notes). */
const ease = bezier(0.25, 1, 0.5, 1);
const glides = new WeakMap<Element, number>();

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Scrolls `el` to `to` in 240–320 ms, longer for longer hops. More than a
 *  window away it first jumps to one window short, so the glide stays short
 *  and still shows the direction. Under reduced motion it jumps. */
function glide(el: HTMLElement, to: number) {
  cancelAnimationFrame(glides.get(el) ?? 0);
  glides.delete(el);
  let from = el.scrollTop;
  const page = el.clientHeight || 1;
  if (reducedMotion() || Math.abs(to - from) < 2) {
    el.scrollTop = to;
    return;
  }
  if (Math.abs(to - from) > page) {
    from = to - Math.sign(to - from) * page;
    el.scrollTop = from;
  }
  const ms = 240 + 80 * Math.min(1, Math.abs(to - from) / page);
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    el.scrollTop = from + (to - from) * ease(t);
    if (t < 1) glides.set(el, requestAnimationFrame(step));
    else glides.delete(el);
  };
  glides.set(el, requestAnimationFrame(step));
}

function scrollParent(view: EditorView): HTMLElement {
  for (let el: HTMLElement | null = view.scrollDOM; el; el = el.parentElement) {
    if (el === document.scrollingElement || el === document.body) break;
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight + 1) return el;
  }
  return (document.scrollingElement as HTMLElement | null) ?? view.scrollDOM;
}

/** Brings `range` a third of the way down the window on the eased scroll,
 *  unless it and a card under its paragraph are already comfortably in view. */
export function revealRange(view: EditorView, range: Range) {
  view.requestMeasure({
    key: revealRange,
    read(view) {
      const length = view.state.doc.length;
      if (range.from > length || range.to > length) return null;
      const scroller = scrollParent(view);
      const whole = scroller === document.scrollingElement;
      const box = whole ? { top: 0, height: window.innerHeight } : scroller.getBoundingClientRect();
      const y = (view.coordsAtPos(range.from)?.top ?? view.documentTop + view.lineBlockAt(range.from).top) - box.top;
      const end = view.documentTop + view.lineBlockAt(paragraphEnd(view.state, range.to)).bottom - box.top + 72;
      if (y >= box.height * 0.12 && end <= box.height - 16) return null;
      const max = scroller.scrollHeight - scroller.clientHeight;
      return { scroller, to: Math.max(0, Math.min(max, scroller.scrollTop + y - box.height / 3)) };
    },
    write(result) {
      if (result) glide(result.scroller, result.to);
    },
  });
}

const theme = EditorView.theme({
  // Padding, not margins: the editor measures a block's height without them.
  // The sides match a line's, so the card starts at the text's left edge.
  ".cm-step-card": {
    padding: "var(--space-xxs, 4px) calc(var(--editor-gutter, 0px) + 2px) var(--space-s, 12px) calc(var(--editor-gutter, 0px) + 6px)",
    cursor: "default", userSelect: "none",
    fontFamily: "var(--font-ui, var(--font-sans))", fontSize: "var(--size-xs, 13px)", lineHeight: "var(--line-xs, 18px)",
  },
  // An aligned card starts at `--card-x`, or as far right as it fits: the
  // first track takes what's left beside the card, up to that x.
  ".cm-step-card[data-card-align]": { display: "grid", gridTemplateColumns: "minmax(0, var(--card-x, 0px)) minmax(0, max-content)" },
  ".cm-step-card[data-card-align]::before": { content: "''" },
});
