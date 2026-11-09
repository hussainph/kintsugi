import { ensureSyntaxTree, getIndentUnit, indentUnit, syntaxTree } from "@codemirror/language";
import { countColumn, EditorSelection, EditorState, type ChangeSpec, type StateCommand } from "@codemirror/state";

// Markdown needs the parent's content column, not a fixed two spaces: `10. `
// needs four, while `- [ ] ` still nests at two (the checkbox is content).
const marker = /^([-+*]|\d+[.)])([ \t]*)/;
function quoteEnd(text: string, depth: number) {
  let end = 0;
  for (let i = 0; i < depth; i++) {
    const match = /^[ \t]*>[ \t]?/.exec(text.slice(end));
    if (!match) break;
    end += match[0].length;
  }
  return end;
}
const quoteDepth = (state: EditorState, pos: number) => (state.doc.sliceString(state.doc.lineAt(pos).from, pos).match(/>/g) ?? []).length;
type Item = { from: number; to: number; list: number; quotes: number; parent: number | null; previous: number | null };

// Finish parsing before a structural edit, even beyond the current viewport.
// A time-budget fallback could mistake a tail list for prose and corrupt it.
const tree = (state: EditorState) => ensureSyntaxTree(state, state.doc.length, Infinity) ?? syntaxTree(state);
const column = (state: EditorState, pos: number) => countColumn(state.doc.sliceString(state.doc.lineAt(pos).from, pos), 4);
function contentColumn(state: EditorState, item: Item) {
  const line = state.doc.lineAt(item.from);
  const match = marker.exec(state.doc.sliceString(item.from, line.to))!;
  const end = column(state, item.from + match[0].length);
  const markEnd = column(state, item.from + match[1].length);
  // CommonMark treats five or more padding columns as one separating space
  // followed by indented code, not as the item's content indentation.
  return end === markEnd || end - markEnd > 4 ? markEnd + 1 : end;
}

function items(state: EditorState) {
  const found = new Map<number, Item>();
  tree(state).iterate({ enter(node) {
    if (node.name !== "ListItem") return;
    const mark = node.node.getChild("ListMark");
    if (!mark) return;
    const line = state.doc.lineAt(mark.from);
    if (/[^ \t>]/.test(line.text.slice(0, mark.from - line.from))) return;
    const parent = node.node.parent!;
    let previous = node.node.prevSibling;
    while (previous && previous.name !== "ListItem") previous = previous.prevSibling;
    found.set(line.number, {
      from: mark.from, to: node.to, list: parent.from, quotes: quoteDepth(state, mark.from),
      parent: parent.parent?.name === "ListItem" ? state.doc.lineAt(parent.parent.from).number : null,
      previous: previous ? state.doc.lineAt(previous.from).number : null,
    });
  } });
  return found;
}

/** Indent selected lines, moving a list item's continuation and children with it.
 *  One transaction keeps numbering, selection, saving and undo together. */
function indentation(outdent: boolean): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const selected = new Set<number>();
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      for (let n = first; n <= last; n++) {
        if (n === last && n > first && range.to === state.doc.line(n).from) break;
        selected.add(n);
      }
    }
    const listItems = items(state);
    const changes: ChangeSpec[] = [];
    const moved = new Set<number>();
    const touched = new Set<number>();
    const visited = new Set<number>();
    const destinations = new Map<number, number>();
    for (const n of [...selected].sort((a, b) => a - b)) {
      if (visited.has(n)) continue;
      const item = listItems.get(n);
      let step = getIndentUnit(state);
      let end = n;
      if (item) {
        end = state.doc.lineAt(item.to).number;
        const previous = item.previous && listItems.get(item.previous);
        if (outdent) {
          const parent = item.parent && listItems.get(item.parent);
          step = parent ? column(state, item.from) - column(state, parent.from) : 0;
        } else if (item.previous && destinations.has(item.previous)) {
          step = destinations.get(item.previous)! - column(state, item.from);
        } else if (previous) {
          step = contentColumn(state, previous) - column(state, item.from);
        } else {
          // There is no preceding sibling to nest under.
          step = 0;
        }
        destinations.set(n, column(state, item.from) + step);
        if (step > 0) {
          moved.add(item.from);
          // Both the source list and the destination may need new numbers.
          for (const sibling of listItems.values()) {
            if (sibling.list === item.list || (item.parent && sibling.list === listItems.get(item.parent)?.list)) touched.add(sibling.from);
          }
          if (previous) touched.add(previous.from);
        }
      }
      if (step <= 0) end = n; // A no-op parent must not swallow a child's selection.
      for (let i = n; i <= end; i++) {
        visited.add(i);
        const current = state.doc.line(i);
        if (step <= 0) continue;
        const from = current.from + (item ? quoteEnd(current.text, item.quotes) : 0);
        if (outdent) {
          const whitespace = /^[ \t]*/.exec(current.text.slice(from - current.from))![0];
          const width = column(state, from + whitespace.length) - column(state, from);
          if (whitespace) changes.push({ from, to: from + whitespace.length, insert: " ".repeat(Math.max(0, width - step)) });
        } else {
          changes.push({ from, insert: item ? " ".repeat(step) : state.facet(indentUnit) });
        }
      }
    }
    let combined = state.changes(changes);
    if (moved.size) {
      const indented = state.update({ changes: combined }).state;
      const renumber: ChangeSpec[] = [];
      const lists = new Map<number, { from: number; to: number; quotes: number }[]>();
      const padding = new Map<string, { line: number; quotes: number; delta: number }>();
      // Use the reparsed tree so a newly nested item joins its destination list.
      tree(indented).iterate({ enter(node) {
        if (node.name !== "ListItem" || node.node.parent?.name !== "OrderedList") return;
        const parent = node.node.parent;
        const mark = node.node.getChild("ListMark");
        if (!mark) return;
        const list = lists.get(parent.from) ?? [];
        list.push({ from: mark.from, to: node.to, quotes: quoteDepth(indented, mark.from) });
        lists.set(parent.from, list);
      } });
      const mappedTouched = [...touched].map((pos) => combined.mapPos(pos, 1));
      const mappedMoved = new Set([...moved].map((pos) => combined.mapPos(pos, 1)));
      for (const list of lists.values()) {
        if (!list.some((item) => mappedTouched.some((pos) => pos >= item.from && pos <= item.to))) continue;
        const first = list[0];
        const firstMatch = /^(\d+)(?=[.)])/.exec(indented.doc.sliceString(first.from, first.to));
        if (!firstMatch) continue;
        let number = mappedMoved.has(first.from) ? 1 : Number(firstMatch[1]);
        for (const item of list) {
          const match = /^(\d+)(?=[.)])/.exec(indented.doc.sliceString(item.from, item.to));
          if (match && Number(match[1]) !== number) {
            const insert = String(number);
            renumber.push({ from: item.from, to: item.from + match[1].length, insert });
            // Crossing 9/10 (or 99/100) moves the content column too. Keep
            // continuation lines and child lists attached to the same item.
            const delta = insert.length - match[1].length;
            if (delta) for (let n = indented.doc.lineAt(item.from).number + 1; n <= indented.doc.lineAt(item.to).number; n++) {
              const key = `${n}:${item.quotes}`;
              padding.set(key, { line: n, quotes: item.quotes, delta: (padding.get(key)?.delta ?? 0) + delta });
            }
          }
          number++;
        }
      }
      for (const { line: n, quotes, delta } of padding.values()) {
        const line = indented.doc.line(n);
        if (!delta || !line.text.trim()) continue;
        const from = line.from + quoteEnd(line.text, quotes);
        if (delta > 0) renumber.push({ from, insert: " ".repeat(delta) });
        else {
          const whitespace = /^[ \t]*/.exec(line.text.slice(from - line.from))![0];
          const width = column(indented, from + whitespace.length) - column(indented, from);
          renumber.push({ from, to: from + whitespace.length, insert: " ".repeat(Math.max(0, width + delta)) });
        }
      }
      combined = combined.compose(indented.changes(renumber));
    }
    dispatch(state.update({ changes: combined, selection: EditorSelection.create(state.selection.ranges.map((range) => range.map(combined, 1)), state.selection.mainIndex), scrollIntoView: true, userEvent: outdent ? "delete.dedent" : "input.indent" }));
    return true;
  };
}

export const indentLines = indentation(false);
export const outdentLines = indentation(true);
