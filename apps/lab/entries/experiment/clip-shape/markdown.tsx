// A small, display-only reader for the Markdown the ingest engine writes:
// paragraphs, headings, quotes (nested for Reddit replies), lists, rules,
// timestamp links and inline links. React elements only, never HTML strings;
// remote images are named, not loaded. HN's table-per-comment soup is shown
// as the paragraphs it contains, so the study judges shape, not extraction.
import { Fragment, type ReactNode } from "react";

const INLINE =
  /(\[(\d+(?::\d\d)+)\]\(<([^>]+)>\))|(!\[([^\]]*)\]\(<?([^)>]+)>?\))|(\[([^\]]+)\]\(<?([^)>\s]+)>?\))|(\*\*([^*]+)\*\*)|(<br>)|(\\([[\]<>*`|\\_#.-]))/g;

export function inline(text: string, key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const k = `${key}-${index++}`;
    if (match[1]) out.push(<Stamp key={k} label={match[2]} href={match[3]} />);
    else if (match[4])
      out.push(
        <span key={k} className="text-muted-foreground/70">
          [image{match[5] ? `: ${match[5]}` : ""}]
        </span>,
      );
    else if (match[7])
      out.push(
        <a
          key={k}
          href={match[9]}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-border underline-offset-4 hover:decoration-foreground/40"
        >
          {match[8]}
        </a>,
      );
    else if (match[10]) out.push(<strong key={k} className="font-medium">{match[11]}</strong>);
    else if (match[12]) out.push(<br key={k} />);
    else if (match[13]) out.push(match[14]);
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Stamp({ label, href }: { label: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="mr-1.5 inline-flex rounded bg-muted px-1 font-mono text-[0.78em] tabular-nums text-muted-foreground hover:text-foreground"
      title={`Open at ${label}`}
    >
      {label}
    </a>
  );
}

type Block =
  | { type: "heading"; text: string }
  | { type: "rule" }
  | { type: "quote"; body: string }
  | { type: "list"; items: string[] }
  | { type: "para"; text: string };

export function blocks(markdown: string): Block[] {
  const out: Block[] = [];
  for (const chunk of markdown.split(/\n{2,}/)) {
    const text = chunk.trim();
    if (!text) continue;
    if (/^#{1,6} /.test(text)) out.push({ type: "heading", text: text.replace(/^#+ /, "") });
    else if (/^(-{3,}|\*{3,})$/.test(text)) out.push({ type: "rule" });
    else if (text.startsWith(">"))
      out.push({ type: "quote", body: text.split("\n").map((l) => l.replace(/^> ?/, "")).join("\n") });
    else if (/^- /.test(text)) out.push({ type: "list", items: text.split(/\n- /).map((i) => i.replace(/^- /, "")) });
    else if (text.startsWith("|")) {
      // HN: | spacer gif | indent | comment | — keep the comment text only.
      for (const row of text.split("\n")) {
        const cells = row.split(/(?<!\\)\|/).map((c) => c.trim());
        const content = cells.filter((c) => c && !/^-+$/.test(c) && !/^!\[[^\]]*\]\([^)]*\)$/.test(c));
        for (const cell of content)
          for (const part of cell.split("<br>").filter((p) => p.trim()))
            out.push({ type: "para", text: part.trim() });
      }
    } else out.push({ type: "para", text });
  }
  return out;
}

export function Markdown({ source, from = 0, limit }: { source: string; from?: number; limit?: number }) {
  let all = blocks(source).slice(from);
  if (limit !== undefined) all = all.slice(0, limit);
  return (
    <div className="space-y-3">
      {all.map((block, i) => (
        <Fragment key={i}>{render(block, String(i))}</Fragment>
      ))}
    </div>
  );
}

function render(block: Block, key: string): ReactNode {
  switch (block.type) {
    case "heading":
      return <h4 className="pt-2 text-xs font-medium tracking-wide text-muted-foreground">{inline(block.text, key)}</h4>;
    case "rule":
      return <hr className="border-border/70" />;
    case "quote":
      return (
        <blockquote className="border-l border-border pl-3 text-muted-foreground">
          <Markdown source={block.body} />
        </blockquote>
      );
    case "list":
      return (
        <ul className="list-disc space-y-1 pl-5">
          {block.items.map((item, i) => (
            <li key={i}>{inline(item, `${key}-${i}`)}</li>
          ))}
        </ul>
      );
    case "para":
      return <p className="whitespace-pre-line">{inline(block.text, key)}</p>;
  }
}
