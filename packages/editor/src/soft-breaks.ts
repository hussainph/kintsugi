import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, StateField, Transaction, type ChangeDesc, type EditorState } from "@codemirror/state";
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

// The Markdown parser reads MDX modules and block JSX/expressions as prose.
// Match only code-shaped lines, so a wrapped line that happens to start with
// "import the" or "<em>word</em> and" still flows.
const esm = /^(?:import|export)\s*(?:[{*"']|(?:default|const|let|var|function|class|async)\b|[\w$]+\s*(?:,|from\s*["']))/;
// Flow JSX and expressions fill their line; an opener with no close yet spans lines.
const block = (line: string) => /^[<{]/.test(line) && (/[>}]$/.test(line) || !/[>}]/.test(line));
const mdx = (text: string) => text.split("\n").some((line) => esm.test(line.trim()) || block(line.trim()));

/** Whether a run of source lines looks machine-wrapped rather than typed.
 *
 *  Tools hard-wrap at a fixed width, 60 to 100 characters, so every line but
 *  the last fills most of it. The run's longest line must reach 60; each
 *  earlier line must then be 60 or more, within 15% of the longest, or be a
 *  line that couldn't take the next word (a long link pushed down). Typed
 *  short lines, a poem or an address, never reach the width. */
export function machineWrapped(lines: readonly string[]): boolean {
  if (lines.length < 2) return false;
  const lengths = lines.map((line) => line.trim().length);
  const longest = Math.max(...lengths);
  if (longest < 60) return false;
  return lengths.slice(0, -1).every((length, i) => {
    if (length >= 60 || length >= 0.85 * longest) return true;
    const next = lines[i + 1].trim().split(/\s+/)[0].length;
    return length >= longest / 2 && length + 1 + next > longest;
  });
}

/** Newline positions that flow: soft breaks inside machine-wrapped runs of
 *  top-level prose. Explicit hard breaks and newlines typed this session end
 *  a run and always show. Structured blocks keep their source lines. */
function flowing(state: EditorState, typed: ReadonlySet<number>) {
  const out: number[] = [];
  const hardBreaks = new Set<number>();
  const tree = syntaxTree(state);
  tree.iterate({
    enter(node) {
      if (["Frontmatter", "FencedCode", "CodeBlock", "HTMLBlock"].includes(node.name)) return false;
      if (node.name !== "Paragraph") return;
      // Quotes and lists have visible continuation markers/indentation.
      if (node.node.parent?.name !== "Document") return false;
      const text = state.sliceDoc(node.from, node.to);
      if (mdx(text)) return false;
      const lines = text.split("\n");
      const breaks: { pos: number; literal: boolean; hard: boolean }[] = [];
      for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
        const pos = node.from + at;
        let literal = false;
        let hard = typed.has(pos);
        for (let inner: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1); inner && inner.name !== "Paragraph"; inner = inner.parent) {
          if (inner.name === "HardBreak") hard = true;
          if (["HardBreak", "InlineCode", "HTMLTag"].includes(inner.name)) { literal = true; break; }
        }
        if (hard) hardBreaks.add(pos);
        breaks.push({ pos, literal, hard });
      }
      // Break i sits between lines i and i + 1; each run is judged alone.
      let start = 0;
      for (let i = 0; i <= breaks.length; i++) {
        if (i < breaks.length && !breaks[i].hard) continue;
        if (machineWrapped(lines.slice(start, i + 1))) {
          for (let j = start; j < i; j++) if (!breaks[j].literal) out.push(breaks[j].pos);
        }
        start = i + 1;
      }
      return false;
    },
  });
  return { flow: out, hard: hardBreaks };
}

type Range = { from: number; to: number };
type SoftBreaks = {
  decorations: DecorationSet;
  /** Newlines he typed with Enter in this editor; they never flow. */
  typed: ReadonlySet<number>;
  /** The paragraph he is editing: its layout holds until the cursor leaves. */
  held: Range | null;
};

function build(positions: number[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const pos of [...new Set(positions)].sort((a, b) => a - b)) builder.add(pos, pos + 1, space);
  return builder.finish();
}

/** The top-level prose paragraph holding the cursor, if any. */
function paragraphAt(state: EditorState, pos: number): Range | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === "Paragraph" && node.parent?.name === "Document") return { from: node.from, to: node.to };
    }
  }
  return null;
}

/** Map a newline's position; null once that newline is gone. */
function mapNewline(state: EditorState, changes: ChangeDesc, pos: number): number | null {
  const from = changes.mapPos(pos, 1);
  const to = changes.mapPos(pos + 1, -1);
  return to - from === 1 && state.sliceDoc(from, to) === "\n" ? from : null;
}

const typing = (tr: Transaction) => ["input", "input.type"].includes(tr.annotation(Transaction.userEvent) ?? "");

function create(state: EditorState): SoftBreaks {
  return { decorations: build(flowing(state, new Set()).flow), typed: new Set(), held: null };
}

function update(value: SoftBreaks, tr: Transaction): SoftBreaks {
  const treeChanged = syntaxTree(tr.state) !== syntaxTree(tr.startState);
  if (!tr.docChanged && !treeChanged && !tr.selection) return value;
  const { state, changes } = tr;

  let typed = value.typed;
  let held = value.held;
  const inserted = new Set<number>();
  if (tr.docChanged) {
    changes.iterChanges((_fromA, _toA, fromB, _toB, text) => {
      const str = text.toString();
      for (let at = str.indexOf("\n"); at !== -1; at = str.indexOf("\n", at + 1)) inserted.add(fromB + at);
    });
    const next = new Set<number>(typing(tr) ? inserted : []);
    for (const pos of typed) {
      const mapped = mapNewline(state, changes, pos);
      if (mapped !== null) next.add(mapped);
    }
    typed = next;
    if (held) held = { from: changes.mapPos(held.from, -1), to: changes.mapPos(held.to, 1) };
  }

  // Hold the paragraph he edits, so its other lines don't jump while he
  // types; let it go, and judge it afresh, once the cursor leaves.
  const here = paragraphAt(state, state.selection.main.head);
  let edited = false;
  if (here && tr.docChanged) changes.iterChangedRanges((_fromA, _toA, fromB, toB) => { edited ||= fromB <= here.to && toB >= here.from; });
  held = here && (edited || (held && here.from <= held.to && here.to >= held.from)) ? here : null;

  const { flow, hard } = flowing(state, typed);
  if (!held) return { decorations: build(flow), typed, held };
  // Inside the held paragraph, newlines that were there keep their layout;
  // pasted ones are judged now; typed ones and hard breaks always show.
  const h = held;
  const inside = (pos: number) => pos >= h.from && pos <= h.to;
  const kept = flow.filter((pos) => !inside(pos) || inserted.has(pos));
  value.decorations.map(changes).between(h.from, h.to, (from, to) => {
    if (to - from === 1 && state.sliceDoc(from, to) === "\n" && !hard.has(from) && !inserted.has(from)) kept.push(from);
  });
  return { decorations: build(kept), typed, held };
}

// A direct decoration source: replacing newlines changes the block layout,
// which CodeMirror deliberately forbids in viewport-driven ViewPlugins.
// Rebuild for background parser advances too, not just document edits.
export const softBreaks = StateField.define<SoftBreaks>({
  create,
  update,
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    // CodeMirror puts a zero-width <img> on each side of an inline widget,
    // and an image is a wrap point. Under the editor's break-spaces, a space
    // that lands at the measure then wraps alone to the next line's start.
    // pre-wrap lets it hang at the line's end, like any wrapped space.
    EditorView.baseTheme({ ".cm-soft-break": { whiteSpace: "pre-wrap" } }),
  ],
});

/** Positions of the newlines currently drawn as spaces. */
export function flowingBreaks(state: EditorState): number[] {
  const out: number[] = [];
  state.field(softBreaks).decorations.between(0, state.doc.length, (from) => { out.push(from); });
  return out;
}
