// One reader for every Feed item (KI-105): the item's Markdown from the
// ingest engine, rendered faithfully with the app's typography. Headings,
// paragraphs, quotes, lists, figures with captions, code, tables, links and
// footnotes. It never renders HTML: `@kintsugi/core/markdown` drops raw HTML
// while parsing, and every node here is a React element with text children.
import type { Block, Inline } from "@kintsugi/core/markdown";
import { cn } from "@kintsugi/ui/lib/utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { plain } from "@kintsugi/core/markdown";
import { footnoteLink, readerDocument, readerHref, type ReaderDocument } from "./model";
import { serif } from "./parts";

const mono = "font-[family-name:var(--font-data)]";

export function Reader({ markdown, title, base, className }: { markdown: string; title: string; base: string | null; className?: string }) {
  const doc = useMemo(() => readerDocument(markdown, title), [markdown, title]);
  return (
    <div className={cn(serif, "ki-reader text-[1.0625rem] leading-[1.75] text-pretty", className)}>
      <Blocks blocks={doc.blocks} base={base} doc={doc} />
      {doc.notes.length > 0 && (
        <ol aria-label="Footnotes" className="mt-10 list-decimal space-y-2 border-t border-border/60 pt-5 pl-6 text-[0.9375rem] leading-relaxed text-muted-foreground">
          {doc.notes.map((note) => (
            <li key={note.id} id={`fn-${note.id}`}>
              <Inlines content={note.content} base={base} doc={doc} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Blocks({ blocks, base, doc }: { blocks: Block[]; base: string | null; doc: ReaderDocument }) {
  return (
    <div className="space-y-4">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} base={base} doc={doc} />
      ))}
    </div>
  );
}

function BlockView({ block, base, doc }: { block: Block; base: string | null; doc: ReaderDocument }) {
  const inl = (c: Inline[]) => <Inlines content={c} base={base} doc={doc} />;
  switch (block.t) {
    case "p":
      return <p>{inl(block.c)}</p>;
    case "h": {
      const size = block.level <= 2 ? "text-[1.5rem] leading-snug" : block.level === 3 ? "text-[1.25rem] leading-snug" : "text-[1.0625rem] font-semibold";
      const Tag = (`h${Math.min(6, block.level + 1)}` as "h2");
      return <Tag className={cn("pt-3 text-foreground", size)}>{inl(block.c)}</Tag>;
    }
    case "quote":
    case "callout":
      return (
        <blockquote className="border-l-2 border-border pl-5 text-muted-foreground italic">
          <Blocks blocks={block.c} base={base} doc={doc} />
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i} className="pl-1">
          {item.task !== null && <input type="checkbox" disabled checked={item.task} aria-label={item.task ? "Done" : "Not done"} className="mr-2 align-middle" />}
          {item.c.length === 1 && item.c[0].t === "p" ? inl(item.c[0].c) : <Blocks blocks={item.c} base={base} doc={doc} />}
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start} className="list-decimal space-y-1.5 pl-6">{items}</ol>
      ) : (
        <ul className="list-disc space-y-1.5 pl-6">{items}</ul>
      );
    }
    case "code":
      return (
        <pre className={cn(mono, "overflow-x-auto rounded-lg bg-muted/60 px-4 py-3 text-[0.8125rem] leading-relaxed")}>
          <code>{block.v}</code>
        </pre>
      );
    case "hr":
      return <hr className="mx-auto my-8 w-16 border-border" />;
    case "figure":
      return <Figure src={block.src} alt={block.alt} caption={block.caption} base={base} />;
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-sans text-sm">
            {block.head.length > 0 && (
              <thead>
                <tr>
                  {block.head.map((cell, i) => (
                    <th key={i} style={{ textAlign: block.align[i] ?? undefined }} className="border-b border-border px-2 py-1.5 text-left font-medium">
                      {inl(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} style={{ textAlign: block.align[i] ?? undefined }} className="border-b border-border/60 px-2 py-1.5 align-top">
                      {inl(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** A picture alone in its paragraph, with its caption. It gets out of the way when it can't load. */
function Figure({ src, alt, caption, base }: { src: string; alt: string; caption: string | null; base: string | null }) {
  const [failed, setFailed] = useState(false);
  const url = readerHref(src, base);
  if (!url || failed) return null;
  return (
    <figure className="my-6">
      <img src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="mx-auto max-h-[32rem] rounded-lg bg-muted object-contain" />
      {caption && <figcaption className="mt-2 text-center font-sans text-xs leading-relaxed text-muted-foreground">{caption}</figcaption>}
    </figure>
  );
}

function Inlines({ content, base, doc }: { content: Inline[]; base: string | null; doc: ReaderDocument }): ReactNode {
  return content.map((node, i) => <InlineView key={i} node={node} base={base} doc={doc} />);
}

function InlineView({ node, base, doc }: { node: Inline; base: string | null; doc: ReaderDocument }): ReactNode {
  const inner = (c: Inline[]) => <Inlines content={c} base={base} doc={doc} />;
  switch (node.t) {
    case "text":
      return <Text text={node.v} doc={doc} />;
    case "em":
      return <em>{inner(node.c)}</em>;
    case "strong":
      return <strong className="font-semibold">{inner(node.c)}</strong>;
    case "del":
      return <del>{inner(node.c)}</del>;
    case "code":
      return <code className={cn(mono, "rounded bg-muted/70 px-1 py-0.5 text-[0.85em]")}>{node.v}</code>;
    case "br":
      return <br />;
    case "image": {
      const url = readerHref(node.src, base);
      return url ? <img src={url} alt={node.alt} loading="lazy" referrerPolicy="no-referrer" className="inline max-h-[1.5em] align-text-bottom" /> : null;
    }
    case "link": {
      // A footnote's number is a superscript; its way back is left out.
      const note = footnoteLink(node.href, plain(node.c));
      if (note === "back") return null;
      if (note === "ref") return <sup className="ml-px font-sans text-[0.7em] text-muted-foreground">{plain(node.c)}</sup>;
      const url = readerHref(node.href, base);
      // An in-page anchor (a footnote's back link) or another scheme: just its words.
      if (!url) return <span>{inner(node.c)}</span>;
      return (
        <a
          href={url}
          className="underline decoration-muted-foreground/60 decoration-1 underline-offset-[0.2em] hover:decoration-foreground"
          onClick={(e) => {
            e.preventDefault();
            void openUrl(url).catch((error) => toast.error(String(error)));
          }}
        >
          {inner(node.c)}
        </a>
      );
    }
  }
}

/** Text, with footnote references (`[^1]`) as superscript links to their note. */
function Text({ text, doc }: { text: string; doc: ReaderDocument }) {
  if (!doc.notes.length || !text.includes("[^")) return <>{text}</>;
  const parts = text.split(/\[\^([^\]\s]+)\]/);
  return parts.map((part, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;
    const n = doc.notes.findIndex((note) => note.id === part);
    if (n < 0) return <Fragment key={i}>{`[^${part}]`}</Fragment>;
    return (
      <sup key={i} className="ml-px font-sans text-[0.7em]">
        <a
          href={`#fn-${part}`}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById(`fn-${part}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
          }}
          className="text-muted-foreground no-underline hover:text-foreground"
        >
          {n + 1}
        </a>
      </sup>
    );
  });
}
