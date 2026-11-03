import { EditorView } from "@codemirror/view";
import { element } from "./menu.ts";
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
};

export type PanelActions = {
  pick: (index: number) => void;
  add: (text: string) => void;
  remove: (index: number) => void;
  move: (delta: number) => void;
  level: (level: SpanLevel) => void;
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
  dom.append(levels, list, input);
  let model: PanelModel | null = null;

  input.addEventListener("keydown", (event) => {
    if (!model || event.isComposing) return;
    const empty = input.value === "";
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    if (event.metaKey && event.altKey && (event.code === "BracketRight" || event.code === "BracketLeft")) {
      handled();
      actions.cycle(event.code === "BracketRight" ? 1 : -1);
    } else if (event.metaKey && event.altKey && event.code === "KeyA") {
      handled();
      actions.close();
    } else if (event.key === "Escape") {
      handled();
      actions.close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
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
      row.append(element("span", "cm-alt-option-mark"), element("span", "cm-alt-option-text", flat(entry.text)));
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
  "@media (pointer: coarse)": { ".cm-alt-option": { minHeight: "36px" } },
});
