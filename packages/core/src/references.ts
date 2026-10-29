/** `image` is a safe display URL supplied by the desktop, not a vault path.
 *  Clip `text` is its own passage/note, never its extracted source. */
export type ReferenceSource = {
  kind: "document" | "clip";
  path: string;
  title: string;
  status?: string | null;
  site?: string | null;
  summary?: string | null;
  image?: string | null;
  text?: string;
};

export type Wikilink = { from: number; to: number; target: string; alias?: string };

const sansExtension = (path: string) => path.replace(/\.mdx?$/i, "");
const basename = (path: string) => sansExtension(path).split("/").pop()!;

function targetOf(link: string): string {
  const [destination, ...alias] = link.trim().replace(/^\[\[|\]\]$/g, "").split("|");
  return (alias.length ? destination.replace(/\\$/, "") : destination).split("#")[0].trim().replace(/^\.\//, "");
}

/** Exact vault paths win; otherwise documents take precedence over clips.
 *  Ambiguous same-kind basenames remain unresolved rather than opening the
 *  wrong file. Aliases and heading/block fragments do not affect resolution. */
export function resolveReference(target: string, sources: readonly ReferenceSource[]): ReferenceSource | null {
  const raw = targetOf(target);
  if (!raw || /[\\\0]/.test(raw) || raw.split("/").some((part) => !part || part === "." || part === "..")) return null;
  const path = sansExtension(raw);
  if (raw.includes("/") || /\.mdx?$/i.test(raw)) {
    return sources.find((source) => source.path === raw)
      ?? sources.find((source) => sansExtension(source.path) === path)
      ?? null;
  }
  const matches = sources.filter((source) => basename(source.path) === path);
  const documents = matches.filter((source) => source.kind === "document");
  const preferred = documents.length ? documents : matches;
  return preferred.find((source) => sansExtension(source.path) === path)
    ?? (preferred.length === 1 ? preferred[0] : null);
}

/** Obsidian-compatible, short when unambiguous. A document keeps its short
 *  name when a clip collides; the clip uses e.g. [[inspiration/on-craft]]. */
export function linkFor(source: ReferenceSource, sources: readonly ReferenceSource[]): string {
  const name = basename(source.path);
  const candidates = sources.some((candidate) => candidate.path === source.path) ? sources : [...sources, source];
  const resolved = resolveReference(name, candidates);
  return `[[${resolved?.path === source.path ? name : sansExtension(source.path)}]]`;
}

/** Simple lexical matches for the picker/margin. Full-source search can add
 *  results from the desktop without putting extracted text in this model. */
export function searchReferences(query: string, sources: readonly ReferenceSource[]): ReferenceSource[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return sources.filter((source) => {
    const haystack = [source.title, source.path, source.status, source.site, source.summary, source.text].join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).sort((a, b) => Number(a.kind === "clip") - Number(b.kind === "clip") || a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
}

type Span = { from: number; to: number };

/** Leading YAML is not prose, even while its closing delimiter is unfinished.
 *  Keep offsets in the original text (including an optional UTF-8 BOM). */
function yamlEnd(text: string): number {
  const lines = text.split("\n");
  if (lines[0].replace(/^\uFEFF/, "").trimEnd() !== "---") return 0;
  let offset = lines[0].length + 1;
  for (let index = 1; index < lines.length; index++) {
    offset += lines[index].length + 1;
    if (["---", "..."].includes(lines[index].trimEnd())) return Math.min(offset, text.length);
  }
  return text.length;
}

const escaped = (text: string, pos: number) => {
  let count = 0;
  while (pos > 0 && text[--pos] === "\\") count++;
  return count % 2 === 1;
};

/** Markdown regions that must not become references. Offsets are UTF-16,
 *  shared by JavaScript strings and CodeMirror. */
function ignoredSpans(text: string): Span[] {
  const spans: Span[] = [];
  const pos = yamlEnd(text);
  if (pos) spans.push({ from: 0, to: pos });
  let fence: { char: string; length: number; from: number } | null = null;
  for (let start = pos; start < text.length;) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl + 1;
    const line = text.slice(start, nl === -1 ? end : nl).replace(/\r$/, "");
    const marker = /^ {0,3}(?:> ? {0,3})*(?:[-*+] +)?(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence && !(marker[1][0] === "`" && marker[2].includes("`"))) {
        fence = { char: marker[1][0], length: marker[1].length, from: start };
      } else if (fence && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        spans.push({ from: fence.from, to: end });
        fence = null;
      }
    }
    start = end;
  }
  if (fence) spans.push({ from: fence.from, to: text.length });
  // Inline code delimiters must match in length. An unmatched backtick is
  // ordinary prose, and a code span may continue across a line break.
  const blocks = [...spans];
  let region = 0;
  for (let i = pos; i < text.length;) {
    while (region < blocks.length && i >= blocks[region].to) region++;
    if (region < blocks.length && i >= blocks[region].from) { i = blocks[region].to; continue; }
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      const to = end === -1 ? text.length : end + 3;
      spans.push({ from: i, to });
      i = to;
      continue;
    }
    if (text[i] !== "`" || escaped(text, i)) { i++; continue; }
    let end = i + 1;
    while (text[end] === "`") end++;
    const delimiter = text.slice(i, end);
    let close = end;
    let found = false;
    const limit = region < blocks.length ? blocks[region].from : text.length;
    while ((close = text.indexOf(delimiter, close)) !== -1 && close < limit) {
      if (text[close - 1] !== "`" && text[close + delimiter.length] !== "`") { found = true; break; }
      while (text[close] === "`") close++;
    }
    if (found) {
      spans.push({ from: i, to: close + delimiter.length });
      i = close + delimiter.length;
    } else i = end;
  }
  return spans.sort((a, b) => a.from - b.from);
}

/** Whether a new [[ picker can open at this position (outside code/YAML). */
export function isReferenceContext(text: string, position: number): boolean {
  return !ignoredSpans(text).some((span) => position >= span.from && position < span.to);
}

/** Only real prose links: not YAML, fenced/inline code, HTML comments or
 *  escaped brackets. `target` retains a heading; resolution strips it. */
export function parseWikilinks(text: string): Wikilink[] {
  const ignored = ignoredSpans(text);
  const links: Wikilink[] = [];
  const pattern = /\[\[([^\[\]\r\n]+)\]\]/g;
  let region = 0;
  for (const match of text.matchAll(pattern)) {
    const from = match.index;
    const to = from + match[0].length;
    while (region < ignored.length && ignored[region].to <= from) region++;
    if (escaped(text, from) || escaped(text, to - 2) || (region < ignored.length && ignored[region].from < to)) continue;
    const [destination, ...alias] = match[1].split("|");
    const target = (alias.length ? destination.replace(/\\$/, "") : destination).trim();
    if (target && target !== "#") links.push({ from, to, target, ...(alias.length ? { alias: alias.join("|").trim() } : {}) });
  }
  return links;
}

/** clip_read.text is already own text, where ## Source is a legitimate note
 *  heading. Only complete legacy files use that heading as a source boundary;
 *  modern files use the reserved comment and preserve headings before it. */
function ownText(text: string): string {
  const start = yamlEnd(text);
  const raw = text.slice(start);
  const boundary = raw.indexOf("<!-- kintsugi:source -->");
  const content = boundary === -1 ? raw : raw.slice(0, boundary);
  if (!start || boundary !== -1) return content;
  let fence: { char: string; length: number } | null = null;
  let offset = 0;
  for (const line of content.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (!fence && /^## Source\s*$/.test(line.replace(/\r$/, ""))) return content.slice(0, offset);
    offset += line.length + 1;
  }
  return content;
}

/** A passage plus attribution, never the extracted source. Empty own text
 *  returns an empty string so callers can omit/disable the quote action. */
export function attributedQuote(text: string, link: string): string {
  const passage = ownText(text).split(/\r?\n/).map((line) => line.replace(/^\s*(?:>\s*)+/, "")).join("\n").trim();
  if (!passage) return "";
  const attribution = link.startsWith("[[") ? link : `[[${link}]]`;
  return passage.split("\n").map((line) => line ? `> ${line}` : ">").join("\n") + `\n>\n> ${attribution}`;
}
