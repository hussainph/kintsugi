import { ImageIcon, Info } from "lucide-react";
import type { ReactNode } from "react";

/** A reading of the post in the blog's terms: figures with numbered
 *  captions, callouts, code frames, and MDX islands as placeholders. An
 *  approximation of the site (its `pnpm dev` is the real thing), built from
 *  React elements, never HTML strings. */
export function Preview({ title, kind, date, tags, body, images }: {
  title: string | null;
  kind: "writing" | "note";
  date: string;
  tags: string[];
  body: string;
  /** Blog URL → vault path, for labelling copied images. */
  images: Map<string, string>;
}) {
  const words = body.replace(/```[\s\S]*?```/g, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  const counter = { figure: 0 };
  return (
    <article className="publish-preview" aria-label="Post preview">
      <header>
        <p className="publish-preview-kind">{kind === "note" ? "Note" : "Essay"}</p>
        {kind === "writing" && <h1>{title}</h1>}
        <p className="publish-preview-meta">
          <time>{formatDate(date)}</time>
          {kind === "writing" && <span>{Math.max(1, Math.round(words / 230))} min read</span>}
          {tags.map((tag) => <span key={tag}>#{tag}</span>)}
        </p>
      </header>
      {blocks(body, images, counter)}
    </article>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const formatDate = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

const LONE_IMAGE = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)$/;
const CALLOUT = /^\s*\[!(NOTE|TIP|INFO|IMPORTANT|WARNING|CAUTION)\]\s*/i;

function blocks(text: string, images: Map<string, string>, counter: { figure: number }): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => out.length;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)(?:\s+title="([^"]*)")?/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      i++;
      out.push(
        <figure className="publish-code" key={key()}>
          <figcaption>{fence[3] || fence[2] || "Code"}</figcaption>
          <pre><code>{code.join("\n")}</code></pre>
        </figure>,
      );
      continue;
    }
    if (!line.trim() || /^(import|export)\s/.test(line)) { i++; continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      const Tag = `h${Math.min(6, heading[1].length + (heading[1].length === 1 ? 1 : 0))}` as "h2";
      out.push(<Tag key={key()}>{inline(heading[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(<hr key={key()} />); i++; continue; }
    if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) quoted.push(lines[i++].replace(/^>\s?/, ""));
      if (CALLOUT.test(quoted[0] ?? "")) {
        quoted[0] = quoted[0].replace(CALLOUT, "");
        out.push(<aside className="publish-callout" key={key()}><Info size={16} /><div>{blocks(quoted.join("\n"), images, counter)}</div></aside>);
      } else out.push(<blockquote key={key()}>{blocks(quoted.join("\n"), images, counter)}</blockquote>);
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
    if (item.test(line)) {
      const ordered = /\d/.test(item.exec(line)![1]);
      const items: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        const m = item.exec(lines[i]);
        if (m) items.push(m[2].replace(/^\[( |x)\]\s*/i, (box) => (/x/i.test(box) ? "☑ " : "☐ ")));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      const List = ordered ? "ol" : "ul";
      out.push(<List key={key()}>{items.map((text, n) => <li key={n}>{inline(text)}</li>)}</List>);
      continue;
    }
    if (/^\s*<[A-Z]/.test(line)) {
      const name = /^\s*<([A-Z][\w.]*)/.exec(line)![1];
      while (i < lines.length && lines[i].trim() && !/\/>\s*$|<\/[A-Z][\w.]*>\s*$/.test(lines[i])) i++;
      i++;
      out.push(<div className="publish-island" key={key()}>&lt;{name} /&gt; · an MDX component, rendered by the blog</div>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|\s*(`{3,}|~{3,}))/.test(lines[i])) para.push(lines[i++]);
    const joined = para.join("\n");
    const image = LONE_IMAGE.exec(joined.trim());
    if (image) {
      const [, alt, src, caption] = image;
      counter.figure++;
      const from = images.get(src);
      out.push(
        <figure className="publish-figure" key={key()}>
          <div className="publish-figure-image" role="img" aria-label={alt}>
            <ImageIcon size={18} />
            <span>{alt || "Image"}</span>
            <small>{from ? `from ${from}` : src}</small>
          </div>
          {caption && <figcaption><strong>Fig. {counter.figure}</strong> {caption}</figcaption>}
        </figure>,
      );
      continue;
    }
    out.push(<p key={key()}>{inline(joined)}</p>);
  }
  return out;
}

const INLINE = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\([^)]*\)|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_|~~([\s\S]+?)~~/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index).replace(/\\([[\]{}*_`])/g, "$1"));
    const k = out.length;
    if (m[1]) out.push(<code key={k}>{m[2]}</code>);
    else if (m[3] !== undefined) out.push(<span key={k} className="publish-inline-image">[image: {m[3] || "untitled"}]</span>);
    else if (m[4]) out.push(<a key={k} title={m[5]} className={m[5].startsWith("/") ? "internal" : "external"}>{inline(m[4])}</a>);
    else if (m[6] || m[7]) out.push(<strong key={k}>{inline(m[6] ?? m[7])}</strong>);
    else if (m[8] || m[9]) out.push(<em key={k}>{inline(m[8] ?? m[9])}</em>);
    else if (m[10]) out.push(<del key={k}>{inline(m[10])}</del>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last).replace(/\\([[\]{}*_`])/g, "$1"));
  return out;
}
