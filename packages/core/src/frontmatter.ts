/** Just enough YAML frontmatter handling to read and set top-level scalar
 *  fields (`title`, `status`) without disturbing anything else in the block. */

type Line = { from: number; to: number; text: string };
type Block = { fields: Line[]; close: number };

export function frontmatter(text: string): Block | null {
  const fields: Line[] = [];
  let pos = 0;
  for (let index = 0; ; index++) {
    const nl = text.indexOf("\n", pos);
    const to = nl === -1 ? text.length : nl;
    const line = text.slice(pos, to).replace(/\r$/, "");
    if (index === 0) {
      if (line.trimEnd() !== "---") return null;
    } else if (line.trimEnd() === "---") {
      return { fields, close: pos };
    } else {
      fields.push({ from: pos, to, text: line });
    }
    if (nl === -1) return null;
    pos = nl + 1;
  }
}

const keyOf = (line: string) => /^([A-Za-z0-9_-]+):/.exec(line)?.[1];

export function field(text: string, key: string): string | null {
  const line = frontmatter(text)?.fields.find((l) => keyOf(l.text) === key);
  if (!line) return null;
  const value = line.text.slice(key.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  return value || null;
}

/** A CodeMirror-style change that sets `key: value`, adding the field (or the
 *  whole block) when it is missing. */
export function setField(text: string, key: string, value: string) {
  const insert = `${key}: ${value}`;
  const block = frontmatter(text);
  if (!block) return { from: 0, to: 0, insert: `---\n${insert}\n---\n\n` };
  const line = block.fields.find((l) => keyOf(l.text) === key);
  if (line) return { from: line.from, to: line.from + line.text.length, insert };
  return { from: block.close, to: block.close, insert: insert + "\n" };
}

/** The body after the frontmatter, for word counts. */
export function body(text: string): string {
  const block = frontmatter(text);
  if (!block) return text;
  const after = text.indexOf("\n", block.close);
  return after === -1 ? "" : text.slice(after + 1);
}

export function wordCount(text: string): number {
  return body(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

/** The frontmatter block plus the blank line after it, and the writing
 *  below. `head + body` is always the original text. */
export function splitFrontmatter(text: string): { head: string; body: string } {
  const block = frontmatter(text);
  if (!block) return { head: "", body: text };
  const nl = text.indexOf("\n", block.close);
  if (nl === -1) return { head: text, body: "" };
  const end = text[nl + 1] === "\n" ? nl + 2 : nl + 1;
  return { head: text.slice(0, end), body: text.slice(end) };
}

/** Puts a head and body back together, adding the blank line a head
 *  without a body may be missing. */
export function joinFrontmatter(head: string, body: string): string {
  if (!head || !body || head.endsWith("\n\n")) return head + body;
  return head + (head.endsWith("\n") ? "\n" : "\n\n") + body;
}
