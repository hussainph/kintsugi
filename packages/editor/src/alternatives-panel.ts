import { EditorView } from "@codemirror/view";
import { element } from "./menu.ts";
import { matches } from "./keys.ts";
import type { SpanLevel } from "./spans.ts";

/**
 * The alternatives panel (KI-86), as one component: it draws a model and
 * reports what he does through `actions`, and knows nothing about the
 * document or storage. Where it sits (a popover now) and how it looks can
 * change without touching `alternatives.ts`.
 *
 * Keys, all in its one text field: ↑/↓ move, Enter picks (or adds what he
 * typed), ⌫ on an empty field removes, ←/→ on an empty field switch between
 * word, sentence and paragraph, ⌥⌘]/⌥⌘[ cycle in place, Escape closes.
 */

export type PanelEntry = { text: string; by: "owner" | "kin"; current: boolean };

export type PanelModel = {
  level: SpanLevel;
  /** The levels he can switch to here, in order. */
  levels: SpanLevel[];
  entries: PanelEntry[];
  highlight: number;
  readOnly: boolean;
  canAsk: boolean;
  asking: boolean;
  askError: string | null;
};

export type PanelActions = {
  pick: (index: number) => void;
  add: (text: string) => void;
  remove: (index: number) => void;
  move: (delta: number) => void;
  level: (level: SpanLevel) => void;
  askKin: () => void;
  cycle: (direction: 1 | -1) => void;
  close: () => void;
};

export type AlternativesPanel = { dom: HTMLElement; update: (model: PanelModel) => void; focus: () => void };

const LEVEL_NAMES: Record<SpanLevel, string> = { word: "Word", phrase: "Selection", sentence: "Sentence", paragraph: "Paragraph" };

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

export function alternativesPanel(actions: PanelActions): AlternativesPanel {
  const dom = element("div", "cm-alt-panel");
  dom.setAttribute("role", "dialog");
  dom.setAttribute("aria-label", "Alternatives");
  const levels = element("div", "cm-alt-levels");
  levels.setAttribute("role", "tablist");
  const list = element("ul", "cm-alt-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Alternatives");
  const input = element("input", "cm-alt-input");
  input.type = "text";
  input.placeholder = "Add an alternative";
  input.setAttribute("aria-label", "Add an alternative");
  input.spellcheck = true;
  const ask = element("button", "cm-alt-ask", "Ask Kin");
  ask.type = "button";
  ask.addEventListener("mousedown", (event) => event.preventDefault());
  ask.addEventListener("click", () => actions.askKin());
  const status = element("div", "cm-alt-status");
  status.setAttribute("role", "status");
  dom.append(levels, list, input, ask, status);
  let model: PanelModel | null = null;

  // Common keys work from the Ask Kin button too, not only the text field.
  dom.addEventListener("keydown", (event) => {
    if (!model || event.isComposing) return;
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    if (matches(event, "Mod-Alt-]") || matches(event, "Mod-Alt-[")) {
      handled();
      actions.cycle(matches(event, "Mod-Alt-]") ? 1 : -1);
    } else if (matches(event, "Mod-Shift-Alt-a")) {
      handled();
      actions.askKin();
    } else if (matches(event, "Mod-Alt-a") || event.key === "Escape") {
      handled();
      actions.close();
    }
  });

  input.addEventListener("keydown", (event) => {
    if (!model || event.isComposing) return;
    const empty = input.value === "";
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      handled();
      actions.move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      handled();
      const text = input.value.trim();
      if (text) { input.value = ""; actions.add(text); }
      else actions.pick(model.highlight);
    } else if (event.key === "Backspace" && empty && !event.metaKey && !event.altKey) {
      handled();
      actions.remove(model.highlight);
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && empty && !event.metaKey && !event.altKey) {
      handled();
      const at = model.levels.indexOf(model.level);
      const next = model.levels[at + (event.key === "ArrowRight" ? 1 : -1)];
      if (next) actions.level(next);
    }
  });

  const update = (next: PanelModel) => {
    model = next;
    input.disabled = next.readOnly;
    ask.hidden = !next.canAsk;
    ask.disabled = next.readOnly || next.asking;
    ask.textContent = next.asking ? "Thinking…" : "Ask Kin";
    status.textContent = next.askError ?? "";
    status.hidden = !next.askError;
    list.setAttribute("aria-busy", String(next.asking));
    levels.replaceChildren(...next.levels.map((level) => {
      const tab = element("button", "cm-alt-level", LEVEL_NAMES[level]);
      tab.type = "button";
      tab.tabIndex = -1;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(level === next.level));
      tab.dataset.level = level;
      tab.addEventListener("mousedown", (event) => event.preventDefault());
      tab.addEventListener("click", () => actions.level(level));
      return tab;
    }));
    list.replaceChildren(...next.entries.map((entry, i) => {
      const row = element("li", "cm-alt-option");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === next.highlight));
      if (entry.current) row.setAttribute("aria-current", "true");
      row.dataset.by = entry.by;
      row.append(element("span", "cm-alt-option-mark"));
      if (entry.by === "kin") {
        const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        mark.setAttribute("viewBox", "0 0 24 24");
        mark.setAttribute("class", "cm-alt-kin-mark");
        mark.setAttribute("role", "img");
        mark.setAttribute("aria-label", "Kin");
        const path = document.createElementNS(mark.namespaceURI, "path");
        path.setAttribute("d", "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z");
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", "1.5");
        path.setAttribute("stroke-linejoin", "round");
        mark.append(path);
        row.append(mark);
      }
      row.append(element("span", "cm-alt-option-text", flat(entry.text)));
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("click", () => actions.pick(i));
      return row;
    }));
  };

  return { dom, update, focus: () => input.focus() };
}

export const panelTheme = EditorView.theme({
  ".cm-tooltip.cm-alt-panel": {
    width: "min(340px, calc(100vw - 16px))", boxSizing: "border-box", padding: "6px",
    border: "1px solid var(--border, var(--neutral-4))", borderRadius: "10px",
    backgroundColor: "var(--popover, var(--neutral-1))", color: "var(--foreground, var(--neutral-10))",
    boxShadow: "0 10px 28px #0003", fontFamily: "var(--font-sans, var(--font-ui))", fontSize: "13px", lineHeight: "1.45",
    fontStyle: "normal", fontWeight: "400", letterSpacing: "normal",
  },
  ".cm-alt-levels": { display: "flex", gap: "2px", padding: "0 0 6px" },
  ".cm-alt-level": {
    font: "inherit", fontSize: "12px", padding: "2px 8px", border: "none", borderRadius: "6px", cursor: "pointer",
    background: "none", color: "var(--muted-foreground, var(--neutral-7))",
  },
  ".cm-alt-level[aria-selected=true]": { backgroundColor: "var(--neutral-3, #8882)", color: "var(--foreground, var(--neutral-10))" },
  ".cm-alt-list": { listStyle: "none", margin: "0", padding: "0", maxHeight: "min(260px, 40vh)", overflowY: "auto" },
  ".cm-alt-option": {
    display: "flex", gap: "8px", alignItems: "baseline", padding: "5px 8px", borderRadius: "6px", cursor: "pointer",
    fontFamily: "var(--font-editorial, inherit)", fontSize: "14px",
  },
  ".cm-alt-option[aria-selected=true]": { backgroundColor: "var(--neutral-3, #8882)" },
  ".cm-alt-option-mark": { flex: "0 0 6px", width: "6px", height: "6px", borderRadius: "50%", alignSelf: "center" },
  ".cm-alt-option[aria-current=true] .cm-alt-option-mark": { backgroundColor: "var(--foreground, var(--neutral-10))" },
  ".cm-alt-option-text": { overflowWrap: "anywhere" },
  ".cm-alt-input": {
    width: "100%", boxSizing: "border-box", marginTop: "6px", font: "inherit", padding: "6px 8px", borderRadius: "6px",
    border: "1px solid var(--border, var(--neutral-4))", backgroundColor: "var(--background, transparent)", color: "inherit",
  },
  ".cm-alt-input:focus": { outline: "none", borderColor: "var(--neutral-7)" },
  ".cm-alt-kin-mark": { width: "1em", height: "1em", flexShrink: "0", alignSelf: "center", color: "var(--kin-ink)" },
  ".cm-alt-ask": {
    font: "inherit", marginTop: "var(--space-xs)", padding: "var(--space-xxs) var(--space-xs)",
    color: "var(--kin-ink)", background: "none", border: "none", borderRadius: "var(--radius-s)", cursor: "pointer",
  },
  ".cm-alt-ask:hover": { backgroundColor: "var(--neutral-3)" },
  ".cm-alt-ask:focus-visible": { outline: "var(--border-l) solid var(--kin-ink)", outlineOffset: "var(--space-xxs)" },
  ".cm-alt-ask:disabled": { color: "var(--neutral-7)", cursor: "default" },
  ".cm-alt-status": { padding: "var(--space-xs)", color: "var(--error)" },
  "@media (pointer: coarse)": { ".cm-alt-option": { minHeight: "36px" } },
});
