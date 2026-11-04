import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

class SoftBreak extends WidgetType {
  toDOM() {
    const space = document.createElement("span");
    space.className = "cm-soft-break";
    space.textContent = " ";
    return space;
  }
}

const space = Decoration.replace({ widget: new SoftBreak() });

/** Flow source-wrapped prose without changing a byte of the document.
 *  Leave structured blocks and explicit Markdown hard breaks alone. */
function decorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(state);
  tree.iterate({
    enter(node) {
      if (["Frontmatter", "FencedCode", "CodeBlock", "HTMLBlock"].includes(node.name)) return false;
      if (node.name !== "Paragraph") return;
      // Quotes and lists have visible continuation markers/indentation.
      if (node.node.parent?.name !== "Document") return false;
      const text = state.sliceDoc(node.from, node.to);
      // The Markdown parser treats MDX modules and block expressions as prose.
      if (/(^|\n)[ \t]*(?:import\b|export\b|\{|<)/.test(text)) return false;
      for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
        const pos = node.from + at;
        let literal = false;
        for (let inner: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1); inner && inner.name !== "Paragraph"; inner = inner.parent) {
          if (["HardBreak", "InlineCode", "HTMLTag"].includes(inner.name)) { literal = true; break; }
        }
        if (!literal) builder.add(pos, pos + 1, space);
      }
      return false;
    },
  });
  return builder.finish();
}

// A direct decoration source: replacing newlines changes the block layout,
// which CodeMirror deliberately forbids in viewport-driven ViewPlugins.
// Rebuild for background parser advances too, not just document edits.
export const softBreaks = StateField.define<DecorationSet>({
  create: decorations,
  update(value, tr) {
    return tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? decorations(tr.state) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
