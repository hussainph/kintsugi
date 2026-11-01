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
  /** A clip's passage attribution (see `QuoteOrigin`). */
  quoteBy?: string | null;
  quoteLink?: string | null;
};

/** Who said a clip's shared passage and where it is, as enrichment found
 *  them in the source: a commenter and their comment, a timestamp, a page. */
export type QuoteOrigin = { quoteBy?: string | null; quoteLink?: string | null };

export type Wikilink = { from: number; to: number; target: string; alias?: string };

const sansExtension = (path: string) => path.replace(/\.mdx?$/i, "");
const basename = (path: string) => sansExtension(path).split("/").pop()!;

function targetOf(link: string): string {
  const [destination, ...alias] = link.trim().replace(/^\[\[|\]\]$/g, "").split("|");
  return (alias.length ? destination.replace(/\\$/, "") : destination).split("#")[0].trim().replace(/^\.\//, "");
}

/** Exact vault paths win; otherwise documents take precedence over clips.
 *  Ambiguous stems and same-kind basenames remain unresolved rather than
 *  opening the wrong file. A single root name disambiguates a basename.
 *  Aliases and heading/block fragments do not affect resolution. */
export function resolveReference(target: string, sources: readonly ReferenceSource[]): ReferenceSource | null {
  const raw = targetOf(target);
  if (!raw || /[\\\0]/.test(raw) || raw.split("/").some((part) => !part || part === "." || part === "..")) return null;
  const path = sansExtension(raw);
  if (raw.includes("/") || /\.mdx?$/i.test(raw)) {
    const exact = sources.find((source) => source.path === raw);
    if (exact) return exact;
    const stems = sources.filter((source) => sansExtension(source.path) === path);
    return stems.length === 1 ? stems[0] : null;
  }
  const matches = sources.filter((source) => basename(source.path) === path);
  const documents = matches.filter((source) => source.kind === "document");
  const preferred = documents.length ? documents : matches;
  const roots = preferred.filter((source) => sansExtension(source.path) === path);
  return roots.length === 1 ? roots[0] : preferred.length === 1 ? preferred[0] : null;
}

/** Obsidian-compatible, short when unambiguous. A document keeps its short
 *  name when a clip collides; the clip uses e.g. [[inspiration/on-craft]]. */
export function linkFor(source: ReferenceSource, sources: readonly ReferenceSource[]): string {
  const name = basename(source.path);
  const candidates = sources.some((candidate) => candidate.path === source.path) ? sources : [...sources, source];
  for (const target of [name, sansExtension(source.path), source.path]) {
    if (resolveReference(target, candidates)?.path === source.path) return `[[${target}]]`;
  }
  return `[[${source.path}]]`;
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

/** Strip quote/list containers, allowing a list's continuation indentation
 *  on closing fences (ordered markers can be up to nine digits wide). */
function fenceLine(line: string, listIndent: number): { text: string; indent: number } {
  let spaces: number;
  for (;;) {
    const trimmed = line.replace(/^ +/, "");
    spaces = line.length - trimmed.length;
    if (spaces > 3 && !(listIndent > 0 && spaces >= listIndent && spaces <= listIndent + 3)) return { text: "", indent: 0 };
    line = trimmed;
    if (!line.startsWith(">")) break;
    line = line.slice(1).replace(/^ /, "");
  }
  const marker = /^(?:[-*+]|[0-9]{1,9}[.)]) +/.exec(line);
  return marker ? { text: line.slice(marker[0].length), indent: spaces + marker[0].length } : { text: line, indent: 0 };
}

/** Markdown regions that must not become references. Offsets are UTF-16,
 *  shared by JavaScript strings and CodeMirror. */
function ignoredSpans(text: string): Span[] {
  const spans: Span[] = [];
  const pos = yamlEnd(text);
  if (pos) spans.push({ from: 0, to: pos });
  let fence: { char: string; length: number; from: number; indent: number } | null = null;
  for (let start = pos; start < text.length;) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl + 1;
    const line = text.slice(start, nl === -1 ? end : nl).replace(/\r$/, "");
    const container = fenceLine(line, fence?.indent ?? 0);
    const marker = /^(`{3,}|~{3,})(.*)$/.exec(container.text);
    if (marker) {
      if (!fence && !(marker[1][0] === "`" && marker[2].includes("`"))) {
        fence = { char: marker[1][0], length: marker[1].length, from: start, indent: container.indent };
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

/** Accepts clip_read.text (own text only), not a raw clip file. Apparent
 *  frontmatter and Source headings are prose; only the reserved source boundary
 *  is guarded defensively. Empty own text lets callers disable quoting.
 *
 *  With an `origin` (the clip's `quoteBy`/`quoteLink`), only the clip's
 *  leading block quote is quoted, since that is the passage the origin
 *  describes, followed by `— speaker · [14:48](<link>)`. The writer's own
 *  note is never attributed to someone else. */
export function attributedQuote(ownText: string, link: string, origin?: QuoteOrigin | null): string {
  const boundary = ownText.indexOf("<!-- kintsugi:source -->");
  let content = boundary === -1 ? ownText : ownText.slice(0, boundary);
  const by = origin?.quoteBy?.replace(/\s+/g, " ").replace(/[\\`*_[\]<>|]/g, "").trim() || "";
  const deep = webLink(origin?.quoteLink);
  const leading = leadingQuote(content);
  const attributed = !!(by || deep) && !!leading;
  if (attributed) content = leading;
  const passage = content.split(/\r?\n/).map((line) => line.replace(/^\s*(?:>\s*)+/, "")).join("\n").trim();
  if (!passage) return "";
  const attribution = link.startsWith("[[") ? link : `[[${link}]]`;
  const quoted = passage.split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
  const origins = attributed ? [by, deep ? `[${quoteLinkLabel(deep)}](<${deep}>)` : ""].filter(Boolean).join(" · ") : "";
  return quoted + (origins ? `\n> — ${origins}` : "") + `\n>\n> ${attribution}`;
}

/** The leading block quote of a clip's own text, if it starts with one. */
function leadingQuote(text: string): string {
  const lines = text.replace(/^[\r\n]+/, "").split(/\r?\n/);
  const quoted = [];
  for (const line of lines) {
    if (!/^\s*>/.test(line)) break;
    quoted.push(line);
  }
  return quoted.join("\n").replace(/^\s*(?:>\s*)+/gm, "").trim() ? quoted.join("\n") : "";
}

function webLink(value: string | null | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return ["https:", "http:"].includes(url.protocol) ? url.href.replace(/[<>\s]/g, encodeURIComponent) : null;
  } catch { return null; }
}

/** How to show a passage's deep link: `14:48`, `p. 12`, `comment`, `passage`. */
export function quoteLinkLabel(link: string): string {
  const page = /#page=(\d+)/.exec(link);
  if (page) return `p. ${page[1]}`;
  const time = /[#?&]t=(\d+)s?(?:$|&)/.exec(link);
  if (time) {
    const total = Number(time[1]);
    const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }
  if (link.includes("#:~:text=")) return "passage";
  if (/news\.ycombinator\.com\/item|reddit\.com\/.*\/comments\//.test(link)) return "comment";
  return "source";
}
