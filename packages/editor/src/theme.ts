import { HighlightStyle } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** Complete Graphical type roles, kept live in both color modes. Editing and
 * preformatted content deliberately retain stable wrapping rather than pretty. */
const editorial = (size: "m" | "l" | "xl" | "xxl", weight: "regular" | "medium" | "heavy" = "regular") => ({
  fontFamily: "var(--font-editorial)",
  fontWeight: `var(--weight-editorial-${weight})`,
  fontSize: `calc(var(--size-${size}) * var(--editor-text-scale, 1))`,
  lineHeight: `calc(var(--line-${size}) * var(--editor-text-scale, 1))`,
  letterSpacing: `var(--letter-spacing-${size})`,
});
const data = (size: "xs" | "s") => ({
  fontFamily: "var(--font-data)",
  fontWeight: "var(--weight-data-regular)",
  fontSize: `calc(var(--size-${size}) * var(--editor-text-scale, 1))`,
  lineHeight: `calc(var(--line-${size}) * var(--editor-text-scale, 1))`,
  letterSpacing: `var(--letter-spacing-${size})`,
});
export const theme = EditorView.theme({
  "&": { height: "100%", ...editorial("l"), color: "var(--neutral-10)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { ...editorial("l"), textWrap: "wrap" },
  ".cm-content": {
    width: "100%",
    maxWidth: "calc(68ch + 2 * var(--space-xl))",
    margin: "0 auto",
    padding: "var(--space-xxl) var(--space-xl) 40vh",
    caretColor: "var(--neutral-10)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "var(--border-l) solid var(--neutral-10)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--neutral-5-transparent)",
  },
  ".cm-line.cm-frontmatter": { ...data("xs"), color: "var(--neutral-7)" },
  ".cm-placeholder": { color: "var(--neutral-7)", fontStyle: "italic" },
  ".cm-panels": {
    backgroundColor: "var(--neutral-2)", color: "var(--neutral-10)",
    fontFamily: "var(--font-ui)", fontWeight: "var(--weight-ui-regular)",
    fontSize: "var(--size-s)", lineHeight: "var(--line-s)", letterSpacing: "var(--letter-spacing-s)",
  },
  ".cm-panels.cm-panels-top": { borderBottomWidth: "0", boxShadow: "inset 0 calc(-1 * var(--border-s)) 0 var(--neutral-4)" },
  ".cm-searchMatch": { backgroundColor: "var(--color-3-transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { outline: "var(--border-l) solid var(--neutral-10)" },
});

export const highlight = HighlightStyle.define([
  { tag: t.heading1, ...editorial("xxl", "heavy") },
  { tag: t.heading2, ...editorial("xl", "heavy") },
  { tag: t.heading3, ...editorial("l", "heavy") },
  { tag: [t.heading4, t.heading5, t.heading6], ...editorial("m", "heavy") },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "var(--weight-editorial-heavy)" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--neutral-10)", textDecoration: "underline" },
  { tag: t.url, color: "var(--neutral-7)" },
  { tag: t.monospace, ...data("s") },
  { tag: t.quote, color: "var(--neutral-8)", fontStyle: "italic" },
  // Markdown's own marks: `#`, `*`, `_`, `` ` ``, `>`, list bullets.
  { tag: [t.processingInstruction, t.contentSeparator, t.meta, t.comment], color: "var(--neutral-7)" },
  { tag: [t.keyword, t.string, t.number, t.bool, t.atom, t.propertyName], color: "var(--neutral-8)" },
]);

const frontmatterLine = Decoration.line({ class: "cm-frontmatter" });

function frontmatterDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  if (doc.line(1).text.trimEnd() !== "---") return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    builder.add(line.from, line.from, frontmatterLine);
    if (n > 1 && line.text.trimEnd() === "---") return builder.finish();
  }
  return Decoration.none; // unclosed: it's not frontmatter yet
}

export const frontmatterLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = frontmatterDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = frontmatterDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
