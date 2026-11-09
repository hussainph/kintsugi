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
  // CommonMark drops orphan/skip-level markers into CodeBlock or paragraph
  // text. They are still editable list items here. Fenced examples, HTML and
  // frontmatter remain literal; indented list-looking text uses list semantics.
  const excluded: { from: number; to: number }[] = [];
  tree(state).iterate({ enter(node) {
    if (["FencedCode", "HTMLBlock", "Frontmatter"].includes(node.name)) {
      excluded.push({ from: node.from, to: node.to });
      return false;
    }
  } });
  // A fence inside an orphan item's indentation can itself be parsed as
  // indented code. Protect its literal examples independently of that parse.
  let fence: { char: string; size: number; from: number } | null = null;
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const match = /^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (!match) continue;
    if (!fence) fence = { char: match[1][0], size: match[1].length, from: line.from };
    else if (match[1][0] === fence.char && match[1].length >= fence.size && !match[2].trim()) {
      excluded.push({ from: fence.from, to: line.to });
      fence = null;
    }
  }
  if (fence) excluded.push({ from: fence.from, to: state.doc.length });
  let prior: number | null = null;
  const stack: number[] = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (excluded.some((range) => line.from >= range.from && line.from < range.to)) {
      prior = null;
      stack.length = 0;
      continue;
    }
    const prefix = /^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(line.text)![0];
    const raw = line.text.slice(prefix.length);
    if (!/^([-+*]|\d+[.)])(?:[ \t]+.*|)$/.test(raw) || /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,})$/.test(raw)) {
      if (raw.trim() && !/^[ \t>]/.test(line.text)) { prior = null; stack.length = 0; }
      continue;
    }
    const from = line.from + prefix.length;
    const quotes = quoteDepth(state, from);
    while (stack.length) {
      const top = found.get(stack[stack.length - 1])!;
      if (top.quotes === quotes && column(state, top.from) < column(state, from)) break;
      stack.pop();
    }
    if (!found.has(n)) {
      // `2024. ...` cannot interrupt a prose paragraph. Don't silently turn
      // its continuation into a list and renumber it. A lazy marker inside
      // an actual list, however, can be a skip-level child that we must keep.
      let paragraphLine = n;
      let insideList = false;
      const parsed = syntaxTree(state);
      for (let node: ReturnType<typeof parsed.resolveInner> | null = parsed.resolveInner(from, 1); node; node = node.parent) {
        if (node.name === "Paragraph") paragraphLine = state.doc.lineAt(node.from).number;
        if (node.name === "ListItem") insideList = true;
      }
      if (paragraphLine < n && !insideList) continue;
      const parent = stack.at(-1) ?? null;
      const previous = prior && found.get(prior)!;
      const sibling = previous && previous.quotes === quotes && column(state, previous.from) === column(state, from) &&
        /^\d/.test(state.doc.sliceString(previous.from, previous.from + 1)) === /^\d/.test(raw) ? prior : null;
      found.set(n, { from, to: line.to, quotes, parent, previous: sibling, list: sibling ? found.get(sibling)!.list : from });
    }
    stack.push(n);
    prior = n;
  }
  // Include descendants and continuation lines even when the Markdown parser
  // stopped recognizing their over-indented marker as a list.
  for (const [n, item] of found) {
    for (let i = state.doc.lineAt(item.to).number + 1; i <= state.doc.lines; i++) {
      const line = state.doc.line(i);
      if (!line.text.trim()) continue;
      const end = quoteEnd(line.text, item.quotes);
      if (quoteDepth(state, line.from + end) !== item.quotes) break;
      const whitespace = /^[ \t]*/.exec(line.text.slice(end))![0];
      if (column(state, line.from + end + whitespace.length) <= column(state, item.from)) break;
      item.to = line.to;
    }
    // A parser's lazy paragraph can include a shallower raw marker. Don't
    // accidentally move that sibling with this item.
    for (let i = n + 1; i <= state.doc.lineAt(item.to).number; i++) {
      const next = found.get(i);
      if (next && next.quotes === item.quotes && column(state, next.from) <= column(state, item.from)) {
        item.to = state.doc.line(i - 1).to;
        break;
      }
    }
  }
  return new Map([...found].sort(([a], [b]) => a - b));
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
        let previous = item.previous ? listItems.get(item.previous) : undefined;
        if (!previous && !outdent) {
          let above = n - 1;
          while (above > 0) {
            const text = state.doc.line(above).text;
            const end = quoteEnd(text, item.quotes);
            if (text.trim() && (quoteDepth(state, state.doc.line(above).from + end) !== item.quotes || text.slice(end).trim())) break;
            above--;
          }
          // A different list directly above may be the destination (e.g. an
          // ordered sublist under a bullet). Don't jump across prose or quotes.
          const candidates = [...listItems.entries()].filter(([line, candidate]) => line < n && candidate.quotes === item.quotes &&
            state.doc.lineAt(candidate.to).number >= above && column(state, candidate.from) >= column(state, item.from));
          previous = candidates.at(-1)?.[1];
          while (previous?.parent && column(state, listItems.get(previous.parent)!.from) >= column(state, item.from)) previous = listItems.get(previous.parent);
        }
        if (outdent) {
          const parent = item.parent && listItems.get(item.parent);
          const current = column(state, item.from);
          const base = column(state, state.doc.lineAt(item.from).from + quoteEnd(state.doc.lineAt(item.from).text, item.quotes));
          step = parent ? current > contentColumn(state, parent)
            ? Math.min(step, current - contentColumn(state, parent))
            : current - column(state, parent.from)
            // Up to three spaces can still be a top-level CommonMark item.
            // Clear that last level, including its optional alignment space.
            : current - base < step * 2 ? current - base : step;
        } else if (item.previous && destinations.has(item.previous)) {
          step = destinations.get(item.previous)! - column(state, item.from);
        } else if (previous) {
          step = contentColumn(state, previous) - column(state, item.from);
        } else {
          // First children and orphan items can always move another level.
          step = getIndentUnit(state);
        }
        if (!outdent && step <= 0) step = getIndentUnit(state);
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
      // Re-read after moving, including markers CommonMark calls code, so a
      // newly nested ordered list starts at one at every indentation level.
      for (const item of items(indented).values()) {
        if (!/^\d/.test(indented.doc.sliceString(item.from, item.from + 1))) continue;
        const list = lists.get(item.list) ?? [];
        list.push({ from: item.from, to: item.to, quotes: item.quotes });
        lists.set(item.list, list);
      }
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
