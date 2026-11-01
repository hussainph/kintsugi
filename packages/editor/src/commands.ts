import { isolateHistory } from "@codemirror/commands";
import { EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip } from "@codemirror/view";
import { isReferenceContext } from "@kintsugi/core/references";
import { element, hint, menuTheme, reveal } from "./menu.ts";
import { paragraphNear } from "./references.ts";

/** A skill flagged `command: true` (Kin's skills, KI-30). */
export type CommandSkill = { name: string; description: string };

export type Commands = {
  skills?: CommandSkill[];
  /**
   * Runs a skill on the paragraph the `/` was typed in (or, on a blank line,
   * the one above): `null` when there's no text to run it on. The editor
   * writes nothing; the host shows the result as a reviewable edit (⌘K).
   */
  onSkill?: (skill: CommandSkill, range: { from: number; to: number } | null) => void;
};

/** What a block turns the line into. `content` is the line's own text,
 *  without the `/command` and any block marker it already had; `at` is
 *  where the `/` was in it, where the cursor stays when the text does. */
type Shape = { text: string; cursor: number };
export type Block = {
  id: string;
  label: string;
  /** A short glyph for the row, and the Markdown it writes. */
  icon: string;
  keywords: string[];
  shape: (content: string, at: number) => Shape;
  /** Needs a blank line before (a `---` under prose is a heading) or after
   *  (prose under a table or quote continues it). */
  apart?: { before?: boolean; after?: boolean };
};

const prefixed = (prefix: string) => (content: string, at: number): Shape => ({ text: prefix + content, cursor: prefix.length + at });

/** Markdown and MDX blocks, in the order the menu shows them. */
export const BLOCKS: Block[] = [
  { id: "text", label: "Text", icon: "¶", keywords: ["paragraph", "plain"], shape: prefixed("") },
  { id: "h1", label: "Heading 1", icon: "#", keywords: ["title", "h1"], shape: prefixed("# ") },
  { id: "h2", label: "Heading 2", icon: "##", keywords: ["subtitle", "h2"], shape: prefixed("## ") },
  { id: "h3", label: "Heading 3", icon: "###", keywords: ["h3"], shape: prefixed("### ") },
  { id: "bullets", label: "Bulleted list", icon: "-", keywords: ["unordered", "ul", "list"], shape: prefixed("- ") },
  { id: "numbers", label: "Numbered list", icon: "1.", keywords: ["ordered", "ol", "list"], shape: prefixed("1. ") },
  { id: "todo", label: "To-do", icon: "[ ]", keywords: ["task", "checkbox", "check"], shape: prefixed("- [ ] ") },
  { id: "quote", label: "Quote", icon: ">", keywords: ["blockquote", "citation"], shape: prefixed("> "), apart: { after: true } },
  {
    id: "callout", label: "Callout", icon: "!", keywords: ["note", "aside", "admonition", "tip", "warning"], apart: { after: true },
    shape: prefixed("> [!NOTE]\n> "),
  },
  {
    id: "code", label: "Code block", icon: "```", keywords: ["snippet", "fence", "pre"],
    shape: (content, at) => ({ text: `\`\`\`\n${content}\n\`\`\``, cursor: 4 + at }),
  },
  {
    id: "divider", label: "Divider", icon: "—", keywords: ["rule", "hr", "separator", "line"], apart: { before: true },
    shape: (content) => { const text = content ? `${content}\n\n---\n` : "---\n"; return { text, cursor: text.length }; },
  },
  {
    id: "table", label: "Table", icon: "|", keywords: ["grid", "columns"], apart: { before: true, after: true },
    shape: (content) => {
      const before = content ? `${content}\n\n` : "";
      return { text: `${before}| Column | Column |\n| --- | --- |\n|  |  |`, cursor: before.length + 2 };
    },
  },
  {
    id: "image", label: "Image", icon: "img", keywords: ["picture", "photo", "figure"],
    shape: (content) => ({ text: `![${content}]()`, cursor: content.length + 4 }),
  },
  {
    id: "footnote", label: "Footnote", icon: "[^]", keywords: ["note", "reference", "citation"],
    shape: (content) => { const text = `${content}[^1]\n\n[^1]: `; return { text, cursor: text.length }; },
  },
  {
    id: "component", label: "MDX component", icon: "</>", keywords: ["jsx", "embed", "mdx"], apart: { before: true, after: true },
    shape: (content) => {
      const before = content ? `${content}\n\n` : "";
      return { text: `${before}<Component />`, cursor: before.length + 1 };
    },
  },
];

type Item = { kind: "block"; block: Block } | { kind: "skill"; skill: CommandSkill };
type Menu = { from: number; to: number; query: string; items: Item[]; index: number };

const setMenu = StateEffect.define<Menu | null>();
const dismissMenu = StateEffect.define<number>();

/** How well `query` names an item: lower is better, null is no match. */
function rank(query: string, label: string, keywords: string[]): number | null {
  if (!query) return 0;
  const q = query.toLocaleLowerCase();
  const l = label.toLocaleLowerCase();
  if (l.startsWith(q) || l.replace(/\s+/g, "").startsWith(q)) return 0;
  if (l.split(/[\s-]+/).some((word) => word.startsWith(q))) return 1;
  if (keywords.some((keyword) => keyword.startsWith(q))) return 2;
  if (l.includes(q)) return 3;
  return null;
}

export function menuItems(query: string, skills: readonly CommandSkill[]): Item[] {
  const scored = <T>(list: readonly T[], score: (item: T) => number | null) =>
    list.map((item, order) => ({ item, order, score: score(item) })).filter((x) => x.score !== null)
      .sort((a, b) => a.score! - b.score! || a.order - b.order).map((x) => x.item);
  const blockRank = (block: Block) => rank(query, block.label, [block.id, ...block.keywords]);
  const skillRank = (skill: CommandSkill) => rank(query, skill.name.replace(/[-_]/g, " "), [skill.name, ...skill.description.toLocaleLowerCase().split(/\W+/)]);
  const blocks = scored(BLOCKS, blockRank).map((block) => ({ kind: "block" as const, block }));
  const matched = scored(skills, skillRank).map((skill) => ({ kind: "skill" as const, skill }));
  // Blocks lead, unless a skill is named better ("/plain" for plain-words).
  const best = (items: Item[]) => items.length ? Math.min(...items.map((i) => (i.kind === "block" ? blockRank(i.block) : skillRank(i.skill))!)) : Infinity;
  return best(matched) < best(blocks) ? [...matched, ...blocks] : [...blocks, ...matched];
}

/** `/` at a line start or after a space, outside YAML and code. The query is
 *  one word; a space or a query matching nothing closes the menu. */
function menuAt(state: EditorState, commands: Commands | undefined, dismissed: number | null): Menu | null {
  if (!state.selection.main.empty) return null;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const before = state.sliceDoc(line.from, head);
  const match = /(?:^|\s)\/([\p{L}\p{N}-]{0,32})$/u.exec(before);
  // Inside an unfinished [[link]] the reference picker is open instead.
  if (!match || /\[\[[^\]]*$/.test(before)) return null;
  const from = head - match[1].length - 1;
  if (from === dismissed || !isReferenceContext(state.doc.toString(), from)) return null;
  const items = menuItems(match[1], commands?.skills ?? []);
  return items.length ? { from, to: head, query: match[1], items, index: 0 } : null;
}

const MARKER = /^(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d{1,9}[.)]\s+|>\s?(?:\[![A-Za-z]+\]\s*)?)/;

/** Turns the `/command`'s line into `block`, as one undoable change. */
export function applyBlock(view: EditorView, block: Block, from: number, to: number) {
  const { state } = view;
  const line = state.doc.lineAt(from);
  const before = state.sliceDoc(line.from, from);
  const after = state.sliceDoc(to, line.to);
  const indent = /^\s*/.exec(before)![0];
  const lead = before.slice(indent.length).replace(MARKER, "").replace(/^\s+/, "");
  const content = (lead + after).replace(/\s+$/, "");
  const shape = block.shape(content, Math.min(lead.length, content.length));
  let { text, cursor } = shape;
  const previous = line.number > 1 ? state.doc.line(line.number - 1).text : "";
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : "";
  if (block.apart?.before && !content && previous.trim()) { text = `\n${text}`; cursor += 1; }
  if (block.apart?.after && next.trim() && !text.endsWith("\n")) text += "\n";
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: indent + text },
    selection: EditorSelection.cursor(line.from + indent.length + cursor),
    effects: setMenu.of(null),
    annotations: isolateHistory.of("full"),
    userEvent: "input.block",
    scrollIntoView: true,
  });
  view.focus();
}

/** The `/` menu: Markdown/MDX blocks, then Kin's skills flagged for it. */
export function commandExtensions(getCommands: () => Commands | undefined): Extension {
  const dismissedField = StateField.define<number | null>({
    create: () => null,
    update(value, tr) {
      if (value !== null && tr.docChanged) value = tr.changes.mapPos(value, -1);
      for (const effect of tr.effects) if (effect.is(dismissMenu)) value = effect.value;
      if (value !== null && (value >= tr.state.doc.length || tr.state.doc.lineAt(value).number !== tr.state.doc.lineAt(tr.state.selection.main.head).number)) value = null;
      return value;
    },
  });

  const menuField = StateField.define<Menu | null>({
    create: () => null,
    update(value, tr) {
      if (tr.docChanged || tr.selection) {
        const previous = value;
        value = menuAt(tr.state, getCommands(), tr.state.field(dismissedField));
        if (value && previous && value.from === previous.from && value.query === previous.query) value = { ...value, index: Math.min(previous.index, value.items.length - 1) };
      }
      for (const effect of tr.effects) if (effect.is(setMenu)) value = effect.value;
      return value;
    },
    provide: (field) => showTooltip.from(field, (menu) => menu ? { pos: menu.from, above: false, create: createMenu } : null),
  });

  function choose(view: EditorView, item?: Item): boolean {
    const menu = view.state.field(menuField);
    if (!menu) return false;
    item ??= menu.items[menu.index];
    if (!item) return false;
    if (item.kind === "block") {
      applyBlock(view, item.block, menu.from, menu.to);
      return true;
    }
    view.dispatch({ changes: { from: menu.from, to: menu.to }, selection: EditorSelection.cursor(menu.from), effects: setMenu.of(null), userEvent: "delete.command" });
    getCommands()?.onSkill?.(item.skill, paragraphNear(view.state, menu.from));
    return true;
  }

  function createMenu(view: EditorView) {
    const dom = element("div", "cm-kintsugi-menu cm-command-menu");
    dom.setAttribute("aria-label", "Insert a block or run a skill");
    dom.setAttribute("role", "dialog");
    const list = element("div", "cm-kintsugi-menu-options");
    list.id = `kintsugi-commands-${Math.random().toString(36).slice(2)}`;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Blocks and skills");
    const hintRow = element("div", "cm-kintsugi-menu-hint");
    dom.append(list, hintRow);
    dom.addEventListener("mousedown", (event) => event.preventDefault());
    function render() {
      const menu = view.state.field(menuField);
      if (!menu) return;
      list.replaceChildren();
      let group: Item["kind"] | null = null;
      menu.items.forEach((item, index) => {
        if (item.kind !== group) {
          group = item.kind;
          const heading = element("div", "cm-kintsugi-menu-group", item.kind === "block" ? "Blocks" : "Kin skills");
          heading.setAttribute("role", "presentation");
          list.append(heading);
        }
        const row = element("div", "cm-kintsugi-menu-option cm-command-option");
        row.id = `${list.id}-${index}`;
        row.dataset.command = item.kind === "block" ? item.block.id : `skill:${item.skill.name}`;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(index === menu.index));
        const labels = element("div", "cm-kintsugi-menu-labels");
        if (item.kind === "block") {
          row.append(element("span", "cm-kintsugi-menu-icon", item.block.icon));
          labels.append(element("div", "cm-kintsugi-menu-title", item.block.label));
        } else {
          row.append(element("span", "cm-kintsugi-menu-icon", "✦"));
          labels.append(element("div", "cm-kintsugi-menu-title", item.skill.name), element("div", "cm-kintsugi-menu-meta", item.skill.description));
        }
        row.append(labels);
        row.addEventListener("click", () => choose(view, item));
        list.append(row);
      });
      const selected = menu.items[menu.index];
      if (selected?.kind === "skill") hint(hintRow, "↑↓ Choose · Enter Run on this paragraph, then review · Esc Close", "Tap to run on this paragraph; you review the edit first");
      else hint(hintRow, "↑↓ Choose · Enter Insert · Esc Close", "Tap a block to insert it");
      view.contentDOM.setAttribute("aria-controls", list.id);
      view.contentDOM.setAttribute("aria-expanded", "true");
      if (selected) view.contentDOM.setAttribute("aria-activedescendant", `${list.id}-${menu.index}`);
      reveal(list, list.querySelector<HTMLElement>(`#${list.id}-${menu.index}`) ?? undefined);
    }
    render();
    return {
      dom,
      update: render,
      destroy() {
        view.contentDOM.removeAttribute("aria-controls");
        view.contentDOM.removeAttribute("aria-expanded");
        view.contentDOM.removeAttribute("aria-activedescendant");
      },
    };
  }

  function move(view: EditorView, direction: number) {
    const menu = view.state.field(menuField);
    if (!menu) return false;
    const length = menu.items.length;
    view.dispatch({ effects: setMenu.of({ ...menu, index: (menu.index + direction + length) % length }) });
    return true;
  }

  return [
    dismissedField, menuField,
    Prec.highest(keymap.of([
      { key: "ArrowDown", run: (view) => move(view, 1) },
      { key: "ArrowUp", run: (view) => move(view, -1) },
      { key: "Enter", run: (view) => choose(view) },
      { key: "Tab", run: (view) => choose(view) },
      { key: "Escape", run: (view) => { const menu = view.state.field(menuField); if (!menu) return false; view.dispatch({ effects: [setMenu.of(null), dismissMenu.of(menu.from)] }); return true; } },
    ])),
    menuTheme,
  ];
}
