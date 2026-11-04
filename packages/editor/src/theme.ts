import { HighlightStyle, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** The editor's type (KI-65): the editorial face, sized for long reading
 *  rather than at the Graphical `l` role, which reads large and dense in a
 *  long draft. Everything scales with `--editor-text-scale` (Settings ›
 *  Appearance, ⌘− ⌘= ⌘0 on the Mac). The phone sets its own size, scale
 *  and leading in phone.css and has no Graphical tokens, so the `calc()`s
 *  that use them fall back there. */
const tokens = {
  "--editor-size": "calc(var(--size-m) * 1.2 * var(--editor-text-scale, 1))",
  "--editor-leading": "1.7",
  "--editor-tracking": "0.012em",
  // Between paragraphs: the blank line, plus this.
  "--editor-paragraph-gap": "calc(var(--editor-size) * 0.35)",
  "--editor-measure": "58ch",
  // Line padding; gutter controls use it to keep their place beside the text.
  "--editor-gutter": "var(--space-xxl)",
  // KI-83: an opaque blue range, separate from ink version marks, dimmed
  // prose and Kin's gold. Owned here so Mac and phone use the same fill.
  "--editor-selection": "#a9cef7",
};
const body = {
  fontFamily: "var(--font-editorial)",
  fontWeight: "var(--weight-editorial-regular)",
  fontSize: "var(--editor-size)",
  lineHeight: "var(--editor-leading)",
  letterSpacing: "var(--editor-tracking)",
};
/** Headings, as a multiple of the body size, set tighter than it. */
const heading = (scale: number) => ({
  fontFamily: "var(--font-editorial)",
  fontWeight: "var(--weight-editorial-heavy)",
  fontSize: `calc(var(--editor-size) * ${scale})`,
  lineHeight: "1.25",
  letterSpacing: "0",
});
const data = (scale: number) => ({
  fontFamily: "var(--font-data)",
  fontWeight: "var(--weight-data-regular)",
  fontSize: `calc(var(--editor-size) * ${scale})`,
  letterSpacing: "0",
});
export const theme = EditorView.theme({
  "&": { ...tokens, height: "100%", ...body, color: "var(--neutral-10)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  '[data-color-mode="dark"] &, .dark &': { "--editor-selection": "#264b73" },
  ".cm-scroller": { ...body, textWrap: "wrap" },
  ".cm-content": {
    width: "100%",
    maxWidth: "calc(var(--editor-measure) + 2 * var(--space-xxl))",
    margin: "0 auto",
    padding: "calc(var(--space-xxl) + var(--space-l)) 0 40vh",
    caretColor: "var(--neutral-10)",
  },
  // drawSelection measures the content box and subtracts line padding, not
  // content padding. Keep the gutter on each line (and CodeMirror's 6/2 px
  // insets) so wrapped ranges and the final newline stay in the text column.
  ".cm-line": { paddingLeft: "calc(var(--editor-gutter) + 6px)", paddingRight: "calc(var(--editor-gutter) + 2px)" },
  ".cm-line.cm-blank": { paddingBottom: "var(--editor-paragraph-gap)" },
  ".cm-line.cm-heading": { paddingTop: "calc(var(--editor-size) * 0.5)" },
  ".cm-underline": { textDecoration: "underline", textUnderlineOffset: "0.15em" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "var(--border-l) solid var(--neutral-10)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--editor-selection)",
  },
  // Native selection (notably iOS). drawSelection deliberately hides this
  // background with !important where it paints the range itself; don't
  // override that or the two fills stack. Keep syntax and dim colours intact.
  ".cm-content::selection, .cm-content ::selection": { backgroundColor: "var(--editor-selection)" },
  ".cm-line.cm-frontmatter": { ...data(0.72), lineHeight: "calc(var(--editor-size) * 1.15)", color: "var(--neutral-7)", paddingBottom: "0" },
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
  { tag: t.heading1, ...heading(1.7) },
  { tag: t.heading2, ...heading(1.4) },
  { tag: t.heading3, ...heading(1.18) },
  { tag: [t.heading4, t.heading5, t.heading6], ...heading(1) },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "var(--weight-editorial-heavy)" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--neutral-10)", textDecoration: "underline" },
  { tag: t.url, color: "var(--neutral-7)" },
  { tag: t.monospace, ...data(0.85) },
  { tag: t.quote, color: "var(--neutral-8)", fontStyle: "italic" },
  // Markdown's own marks: `#`, `*`, `_`, `` ` ``, `>`, list bullets.
  { tag: [t.processingInstruction, t.contentSeparator, t.meta, t.comment], color: "var(--neutral-7)" },
  // Inline HTML such as `<u>`, the underline's marks.
  { tag: [t.angleBracket, t.tagName], color: "var(--neutral-7)" },
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

const blankLine = Decoration.line({ class: "cm-blank" });
const headingLine = Decoration.line({ class: "cm-heading" });

/** Blank lines (the gap between paragraphs) and headings, for spacing. */
function spacingDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      if (!line.text.trim()) builder.add(line.from, line.from, blankLine);
      else if (line.text.startsWith("#")) {
        for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(line.from, 1); node; node = node.parent) {
          if (node.name.startsWith("ATXHeading")) { builder.add(line.from, line.from, headingLine); break; }
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const spacingLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = spacingDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) this.decorations = spacingDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
