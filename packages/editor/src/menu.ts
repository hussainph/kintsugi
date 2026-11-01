import { EditorView } from "@codemirror/view";

/** Shared look for the editor's pop-up menus (`[[`/`@` references and `/`).
 *  They fit a phone's width, rows are tap targets, and keyboard hints give
 *  way to touch hints on a coarse pointer, so the phone's shared editor gets
 *  the same menus (KI-28 found the picker clipped at phone width). */

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const dom = document.createElement(tag);
  dom.className = className;
  if (text !== undefined) dom.textContent = text;
  return dom;
}

/** A hint row: what the keys do, or what a tap does on a touch screen. */
export function hint(dom: HTMLElement, keys: string, touch: string) {
  dom.replaceChildren(element("span", "cm-kintsugi-menu-keys", keys), element("span", "cm-kintsugi-menu-touch", touch));
}

/** Keeps the selected row in view inside a scrolling list. */
export function reveal(list: HTMLElement, row: HTMLElement | undefined) {
  if (!row) return;
  if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
  else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
}

export const menuTheme = EditorView.theme({
  ".cm-tooltip.cm-kintsugi-menu": {
    border: "1px solid var(--border)", borderRadius: "8px", backgroundColor: "var(--popover)", color: "var(--foreground)",
    boxShadow: "0 8px 24px #0002", overflow: "hidden", fontFamily: "var(--font-sans)", fontSize: "13px", fontWeight: "400",
    fontStyle: "normal", lineHeight: "1.45", letterSpacing: "normal",
    width: "min(380px, calc(100vw - 16px))", maxWidth: "calc(100vw - 16px)", boxSizing: "border-box",
  },
  ".cm-kintsugi-menu-options": { maxHeight: "min(300px, 45vh)", overflowY: "auto", padding: "4px", position: "relative", scrollbarWidth: "thin", scrollbarColor: "var(--border) transparent", overscrollBehavior: "contain" },
  ".cm-kintsugi-menu-option": { display: "flex", alignItems: "center", gap: "10px", padding: "8px", borderRadius: "4px", cursor: "pointer", minWidth: "0" },
  '.cm-kintsugi-menu-option[aria-selected="true"]': { backgroundColor: "var(--muted)" },
  "@media (hover: hover)": { ".cm-kintsugi-menu-option:hover": { backgroundColor: "var(--muted)" } },
  ".cm-kintsugi-menu-group": { padding: "8px 8px 4px", fontSize: "10px", fontWeight: "500", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--muted-foreground)" },
  ".cm-kintsugi-menu-icon": { width: "28px", height: "28px", flexShrink: "0", display: "grid", placeItems: "center", borderRadius: "5px", border: "1px solid var(--border)", color: "var(--muted-foreground)", fontSize: "11px", fontFamily: "var(--font-mono, ui-monospace, monospace)", backgroundColor: "var(--background)" },
  ".cm-kintsugi-menu-labels": { minWidth: "0", flex: "1" },
  ".cm-kintsugi-menu-title": { fontWeight: "500", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-kintsugi-menu-meta": { color: "var(--muted-foreground)", fontSize: "11px", marginTop: "2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-kintsugi-menu-hint": { padding: "8px 10px", borderTop: "1px solid var(--border)", fontSize: "10px", color: "var(--muted-foreground)", lineHeight: "1.5" },
  ".cm-kintsugi-menu-touch": { display: "none" },
  "@media (hover: none), (pointer: coarse)": {
    ".cm-kintsugi-menu-option": { minHeight: "44px" },
    ".cm-kintsugi-menu-keys": { display: "none" },
    ".cm-kintsugi-menu-touch": { display: "inline" },
  },
});
