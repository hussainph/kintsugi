/** Dimmed text (KI-88): a passage set aside in place, stored as a comment so
 *  the file stays plain Markdown/MDX and other tools hide it too. Kintsugi
 *  writes `<!-- … -->` in `.md` and `{/* … *\/}` in `.mdx`, and treats every
 *  comment form it knows as dimmed: those two and Obsidian's `%%…%%`. The
 *  editor shows them faded, word counts skip them, and Publish and Export
 *  leave them out. */

export type Span = { from: number; to: number };

/** A comment. `from`/`to` include its markers; `inner`/`innerTo` are the
 *  text between them, without one space of padding on each side (what
 *  dimming adds). `closed` is false for an `<!--` that never ends, which
 *  runs to the end of the text, as it does in HTML. */
export type Dimmed = Span & { inner: number; innerTo: number; closed: boolean };

export type DimSyntax = { open: string; close: string };

/** What dimming writes in a file with this path. */
export function dimSyntax(path: string): DimSyntax {
  return /\.mdx$/i.test(path) ? { open: "{/* ", close: " */}" } : { open: "<!-- ", close: " -->" };
}

const MDX_OPEN = /\{[ \t]*\/\*/y;
const MDX_CLOSE = /\*\/[ \t]*\}/g;

function comment(text: string, from: number, openLength: number, closeAt: number, closeLength: number): Dimmed {
  const closed = closeAt !== -1;
  const to = closed ? closeAt + closeLength : text.length;
  let inner = from + openLength;
  let innerTo = closed ? closeAt : text.length;
  if (inner < innerTo && text[inner] === " ") inner++;
  if (closed && innerTo > inner && text[innerTo - 1] === " ") innerTo--;
  return { from, to, inner, innerTo, closed };
}

/** Code (fenced and inline) and comments in a Markdown body, in order. Code
 *  is never a comment, and nothing inside a comment is code. */
export function scanSpans(body: string): { code: Span[]; comments: Dimmed[] } {
  const fences: Span[] = [];
  let fence: { marker: string; from: number } | null = null;
  let pos = 0;
  for (const line of body.split("\n")) {
    const end = pos + line.length + 1;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line.replace(/^(\s*>\s?)+/, ""))?.[1];
    if (fence) {
      if (marker && marker[0] === fence.marker[0] && marker.length >= fence.marker.length) {
        fences.push({ from: fence.from, to: Math.min(end, body.length) });
        fence = null;
      }
    } else if (marker) fence = { marker, from: pos };
    pos = end;
  }
  if (fence) fences.push({ from: fence.from, to: body.length });

  const code: Span[] = [];
  const comments: Dimmed[] = [];
  let next = 0;
  for (let i = 0; i < body.length; i++) {
    while (next < fences.length && fences[next].to <= i) code.push(fences[next++]);
    if (next < fences.length && i >= fences[next].from) {
      i = fences[next].to - 1;
      continue;
    }
    const c = body[i];
    if (c === "<" && body.startsWith("<!--", i)) {
      const close = body.indexOf("-->", i + 4);
      const span = comment(body, i, 4, close, 3);
      comments.push(span);
      i = span.to - 1;
    } else if (c === "{" && (MDX_OPEN.lastIndex = i, MDX_OPEN.test(body))) {
      const open = MDX_OPEN.lastIndex - i;
      MDX_CLOSE.lastIndex = i + open;
      const close = MDX_CLOSE.exec(body);
      if (!close) continue;
      const span = comment(body, i, open, close.index, close[0].length);
      comments.push(span);
      i = span.to - 1;
    } else if (c === "%" && body[i + 1] === "%") {
      const close = body.indexOf("%%", i + 2);
      if (close === -1) { i++; continue; }
      const span = comment(body, i, 2, close, 2);
      comments.push(span);
      i = span.to - 1;
    } else if (c === "`" && body[i - 1] !== "\\") {
      let run = i;
      while (body[run] === "`") run++;
      const ticks = body.slice(i, run);
      const close = body.indexOf(ticks, run);
      if (close !== -1 && !body.slice(run, close).includes("\n\n")) {
        code.push({ from: i, to: close + ticks.length });
        i = close + ticks.length - 1;
      } else i = run - 1;
    }
  }
  while (next < fences.length) code.push(fences[next++]);
  code.sort((a, b) => a.from - b.from);
  return { code, comments };
}

/** The comments in a body. */
export function dimmedSpans(body: string): Dimmed[] {
  return scanSpans(body).comments;
}

/** Where to cut a comment out: a comment alone on its line takes the line
 *  (and its newline) with it, so no blank line or empty item is left. */
export function cutRange(body: string, span: Span): Span {
  const lineStart = body.lastIndexOf("\n", span.from - 1) + 1;
  const nl = body.indexOf("\n", span.to);
  const lineEnd = nl === -1 ? body.length : nl;
  if (/^[ \t]*$/.test(body.slice(lineStart, span.from)) && /^[ \t]*$/.test(body.slice(span.to, lineEnd))) {
    return { from: lineStart, to: nl === -1 ? body.length : nl + 1 };
  }
  return span;
}

/** The body without its comments. */
export function withoutDimmed(body: string): string {
  const spans = dimmedSpans(body).map((span) => cutRange(body, span));
  let out = "";
  let at = 0;
  for (const span of spans) {
    if (span.from < at) continue;
    out += body.slice(at, span.from);
    at = span.to;
  }
  return out + body.slice(at);
}
