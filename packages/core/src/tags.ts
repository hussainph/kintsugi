/** Tags in a document's frontmatter. Mirrors `crates/vault/src/tags.rs`
 *  (the tree, search and enrichment read tags there), and adds the one write:
 *  `setTags`, a CodeMirror-style change, so the desktop editor and the phone
 *  edit the field without disturbing the rest of the block.
 *
 *  Accepted on read: `tags: [a, "b, c"]`, an Obsidian block list
 *  (`tags:` then `  - a` lines), or a lone scalar (`tags: a`). Written as an
 *  inline list, quoted only where YAML needs it. */

import { frontmatter } from "./frontmatter.ts";

/** `#Craft` and `  craft ` are the same tag: whitespace collapsed, `#`
 *  gone, lowercase, at most 64 characters. Null when nothing is left. */
export function normalTag(tag: string): string | null {
  const collapsed = [...tag.split(/\s+/).filter((w) => w && !/\p{Cc}/u.test(w)).join(" ")].slice(0, 64).join("");
  const out = collapsed.replace(/^#+/, "").trim().toLowerCase();
  return out || null;
}

type Line = { from: number; to: number; text: string };

/** The first top-level `tags:` line and the block-list lines under it. */
function tagsField(text: string): { key: Line; items: Line[] } | null {
  const block = frontmatter(text.startsWith("\ufeff") ? text.slice(1) : text);
  if (!block) return null;
  const shift = text.startsWith("\ufeff") ? 1 : 0;
  const lines = block.fields.map((l) => ({ ...l, from: l.from + shift, to: l.to + shift }));
  const index = lines.findIndex((l) => /^tags\s*:/.test(l.text));
  if (index === -1) return null;
  const items: Line[] = [];
  for (const line of lines.slice(index + 1)) {
    // Indented lines, and flush-left `- ` items, belong to the field.
    if (/^\s/.test(line.text) || line.text.startsWith("- ") || !line.text.trim()) items.push(line);
    else break;
  }
  while (items.length && !items[items.length - 1].text.trim()) items.pop();
  return { key: lines[index], items };
}

/** A document's tags, normalized and without duplicates, in written order. */
export function tags(text: string): string[] {
  const found = tagsField(text);
  if (!found) return [];
  const raw: string[] = [];
  const value = found.key.text.slice(found.key.text.indexOf(":") + 1).trim();
  if (!value) {
    for (const line of found.items) {
      const bare = line.text.trim();
      if (!bare || bare.startsWith("#") || !bare.startsWith("- ")) continue;
      const item = scalar(bare.slice(2));
      if (item !== null) raw.push(item);
    }
  } else if (value.startsWith("[")) {
    raw.push(...(list(value) ?? []));
  } else if (!value.startsWith("#")) {
    const item = scalar(value);
    if (item !== null) raw.push(item);
  }
  const out: string[] = [];
  for (const tag of raw) {
    const t = normalTag(tag);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** A change that sets the document's tags; an empty list removes the field.
 *  A block list is replaced by an inline one. Null when nothing changes. */
export function setTags(text: string, next: string[]): { from: number; to: number; insert: string } | null {
  const wanted: string[] = [];
  for (const tag of next) {
    const t = normalTag(tag);
    if (t && !wanted.includes(t)) wanted.push(t);
  }
  const current = tags(text);
  const found = tagsField(text);
  if (found && current.length === wanted.length && current.every((t, i) => t === wanted[i]) && wanted.length) {
    return null;
  }
  const line = wanted.length ? `tags: [${wanted.map(quote).join(", ")}]` : "";
  if (found) {
    const last = found.items[found.items.length - 1] ?? found.key;
    if (line) return { from: found.key.from, to: last.to, insert: line };
    // Remove the field with its line break.
    const end = text[last.to] === "\r" ? last.to + 2 : last.to + 1;
    return { from: found.key.from, to: end, insert: "" };
  }
  if (!line) return null;
  const block = frontmatter(text);
  if (!block) return { from: 0, to: 0, insert: `---\n${line}\n---\n\n` };
  return { from: block.close, to: block.close, insert: line + "\n" };
}

/** Applies a change from `setTags` (or returns the text unchanged). */
export function withTags(text: string, next: string[]): string {
  const change = setTags(text, next);
  return change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text;
}

/** Every tag in use, most used first, then alphabetical. */
export function vocabulary(tagLists: Iterable<readonly string[] | undefined>): string[] {
  const counts = new Map<string, number>();
  for (const list of tagLists) for (const tag of list ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([tag]) => tag);
}

/** Whether a document carries every wanted tag (an AND filter, as clip
 *  search filters tags). No wanted tags matches everything. */
export function hasTags(docTags: readonly string[] | undefined, wanted: readonly string[]): boolean {
  return wanted.every((tag) => docTags?.includes(tag));
}

/** Splits a jump-list query into `#tag` filters and the words left over:
 *  `#essay repair` is the `essay` tag and the text `repair`. A lone `#`, or
 *  a `#tag` still being typed at the end, stays in the text as `partial`. */
export function tagQuery(query: string): { tags: string[]; text: string; partial: string | null } {
  const words = query.split(/\s+/).filter(Boolean);
  const done = /\s$/.test(query);
  const out: string[] = [];
  const rest: string[] = [];
  let partial: string | null = null;
  words.forEach((word, i) => {
    if (!word.startsWith("#")) return void rest.push(word);
    if (i === words.length - 1 && !done) {
      partial = word.slice(1).toLowerCase();
      return;
    }
    const tag = normalTag(word);
    if (tag && !out.includes(tag)) out.push(tag);
  });
  return { tags: out, text: rest.join(" "), partial };
}

function quote(tag: string): string {
  return /^[\p{L}\p{N}_][\p{L}\p{N} _/.-]*$/u.test(tag) && !tag.endsWith(" ") ? tag : JSON.stringify(tag);
}

/** A quoted or plain scalar without its trailing comment; null for YAML we
 *  don't interpret, so nothing is invented. */
function scalar(raw: string): string | null {
  const value = raw.trim();
  const q = value[0];
  if (q === '"' || q === "'") {
    const end = quotedEnd(value, q);
    if (end === null) return null;
    const tail = value.slice(end).trim();
    if (tail && !tail.startsWith("#")) return null;
    if (q === "'") return value.slice(1, end - 1).replace(/''/g, "'");
    try {
      return JSON.parse(value.slice(0, end)) as string;
    } catch {
      return null;
    }
  }
  if (/^[|>{[&*!%@`]/.test(value)) return null;
  const hash = value.indexOf(" #");
  const plain = (hash === -1 ? value : value.slice(0, hash)).trim();
  return plain || null;
}

function quotedEnd(value: string, q: string): number | null {
  for (let i = 1; i < value.length; i++) {
    const c = value[i];
    if (q === '"' && c === "\\") i++;
    else if (c === q) {
      if (q === "'" && value[i + 1] === "'") i++;
      else return i + 1;
    }
  }
  return null;
}

function list(value: string): string[] | null {
  let rest = value.slice(1).trimStart();
  const items: string[] = [];
  for (;;) {
    if (rest.startsWith("]")) {
      const tail = rest.slice(1).trim();
      return !tail || tail.startsWith("#") ? items : null;
    }
    if (!rest) return null;
    let end: number | null;
    if (rest[0] === '"' || rest[0] === "'") end = quotedEnd(rest, rest[0]);
    else {
      const i = rest.search(/[,\]]/);
      end = i === -1 ? null : i;
    }
    if (!end) return null;
    const item = scalar(rest.slice(0, end));
    if (item === null) return null;
    items.push(item);
    rest = rest.slice(end).trimStart();
    if (rest.startsWith(",")) rest = rest.slice(1).trimStart();
    else if (!rest.startsWith("]")) return null;
  }
}
