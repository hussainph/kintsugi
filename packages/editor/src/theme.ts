import { HighlightStyle } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** Raw MDX, styled to read like the page it will become: markup marks fade,
 *  headings grow, frontmatter recedes into small monospace. */
export const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "19px", color: "var(--foreground)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-prose)", lineHeight: "1.7" },
  ".cm-content": {
    width: "100%",
    maxWidth: "calc(68ch + 64px)",
    margin: "0 auto",
    padding: "88px 32px 40vh",
    caretColor: "var(--primary)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--primary)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--editor-selection)",
  },
  ".cm-line.cm-frontmatter": {
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    lineHeight: "1.9",
    color: "var(--editor-faint)",
  },
  ".cm-placeholder": { color: "var(--editor-faint)", fontStyle: "italic" },
  ".cm-panels": { backgroundColor: "var(--popover)", color: "var(--foreground)", fontFamily: "var(--font-sans)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-searchMatch": { backgroundColor: "var(--editor-selection)" },
  ".cm-searchMatch.cm-searchMatch-selected": { outline: "1px solid var(--primary)" },
});

export const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.8em", fontWeight: "650", letterSpacing: "-0.01em" },
  { tag: t.heading2, fontSize: "1.4em", fontWeight: "650" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "650" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--primary)" },
  { tag: t.url, color: "var(--editor-faint)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.82em" },
  { tag: t.quote, color: "var(--muted-foreground)", fontStyle: "italic" },
  // Markdown's own marks: `#`, `*`, `_`, `` ` ``, `>`, list bullets.
  { tag: [t.processingInstruction, t.contentSeparator, t.meta, t.comment], color: "var(--editor-faint)" },
  { tag: [t.keyword, t.string, t.number, t.bool, t.atom, t.propertyName], color: "var(--muted-foreground)" },
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
