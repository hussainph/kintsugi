// The four clip shapes under study. Lab-only: nothing here is product code.
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { byline, displayTitle, paragraphs, shortDate, unescape, type Clip, type Note, type Passage } from "./clips";
import { Markdown, blocks, inline } from "./markdown";

function passageBlock(clip: Clip): number {
  const first = clip.passages[0];
  if (!first) return 0;
  const wanted = first.text.replace(/\s+/g, " ").slice(0, 40);
  const index = blocks(clip.file.source).findIndex(
    (b) => b.type === "para" && unescape(b.text).replace(/\s+/g, " ").includes(wanted),
  );
  return Math.max(0, index);
}

export interface ShapeProps {
  clip: Clip;
  notes: Note[];
  onNote: (text: string) => void;
  reducedMotion: boolean;
  /** Start expanded (B and A→B), for screenshots and the compare grid. */
  open?: boolean;
}

const prose = "font-[family-name:var(--font-prose)]";

function Arrow({ className = "size-3" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden>
      <path d="M5 11 11 5M6 5h5v5" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={`size-3 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
      aria-hidden
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

function verb(clip: Clip, passage: Passage): string {
  if (/^\d/.test(passage.anchor)) return `${clip.type === "podcast" ? "Listen" : "Watch"} from ${passage.anchor}`;
  if (passage.anchor === "passage") return "Open the passage";
  if (passage.anchor === "post") return "Open the post";
  if (clip.type === "paper") return "Open the PDF";
  if (clip.type === "hn-thread" || clip.type === "reddit") return "Open the thread";
  return "Open the page";
}

function SourceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
    >
      {children}
      <Arrow />
    </a>
  );
}

function Byline({ clip }: { clip: Clip }) {
  return (
    <p className="flex items-baseline justify-between gap-3 text-[11px] text-muted-foreground">
      <span className="truncate">{byline(clip)}</span>
      <time dateTime={clip.captured} className="shrink-0 tabular-nums">
        {shortDate(clip.captured)}
      </time>
    </p>
  );
}

/** Curly quotes around a passage; quotes inside it become single ones. */
function quoted(text: string): string {
  const body = text.replace(/^[a-z]/, (c) => c.toUpperCase()).replace(/“/g, "‘").replace(/”/g, "’");
  return `“${body}”`;
}

/** The quote on a card: the writer's passage, verbatim, linked to its place. */
function Pull({ clip, passage, size = "card" }: { clip: Clip; passage: Passage; size?: "card" | "list" }) {
  const caption = size === "list" && passage.href;
  return (
    <figure className="space-y-2">
      <blockquote className={`${prose} ${size === "card" ? "text-[17px]" : "text-base"} leading-relaxed text-pretty`}>
        {quoted(passage.text)}
      </blockquote>
      {passage.who && <p className="text-xs text-muted-foreground">— {passage.who}, in the comments</p>}
      {caption && (
        <figcaption>
          <SourceLink href={passage.href!}>{verb(clip, passage)}</SourceLink>
        </figcaption>
      )}
    </figure>
  );
}

function CardBody({ clip }: { clip: Clip }) {
  if (clip.type === "note")
    return <p className={`${prose} text-[17px] leading-relaxed text-pretty`}>{clip.file.own}</p>;
  if (clip.image && (clip.type === "screenshot" || clip.type === "youtube"))
    return (
      <div className="space-y-3">
        <img
          src={clip.image}
          alt={clip.title ?? "Saved image"}
          className={`w-full rounded-xl bg-muted object-cover ${clip.type === "youtube" ? "aspect-video" : "max-h-96"}`}
        />
        {clip.passages[0] && <Pull clip={clip} passage={clip.passages[0]} />}
      </div>
    );
  if (clip.passages[0]) return <Pull clip={clip} passage={clip.passages[0]} />;
  const first = paragraphs(clip.file.source)[0];
  return first ? <p className="line-clamp-3 text-sm text-muted-foreground">{inline(first)}</p> : null;
}

/** Cover art and first pages are recognition, not content: a small thumbnail. */
function Title({ clip }: { clip: Clip }) {
  if (clip.type === "note" || (!clip.title && clip.image)) return null;
  const thumb = clip.image && clip.type !== "screenshot" && clip.type !== "youtube";
  const title = <h3 className="text-[15px] font-medium leading-snug text-balance">{displayTitle(clip)}</h3>;
  if (!thumb) return title;
  return (
    <div className="flex items-center gap-3">
      <img src={clip.image!} alt="" className="size-11 shrink-0 rounded-md border object-cover object-top" />
      {title}
    </div>
  );
}

/** The card's last line: where the passage (or the source) lives, and any toggle. */
function Footer({ clip, children }: { clip: Clip; children?: ReactNode }) {
  const passage = clip.passages[0];
  const href = passage?.href ?? clip.url;
  if (!href && !children) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      {href ? <SourceLink href={href}>{passage?.href ? verb(clip, passage) : "Original"}</SourceLink> : <span />}
      {children}
    </div>
  );
}

const time = (at: string) => at.slice(11, 16);

export function Thread({ notes, onNote, label }: { notes: Note[]; onNote: (text: string) => void; label: string }) {
  const [draft, setDraft] = useState("");
  const id = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim()) onNote(draft.trim());
    setDraft("");
  };
  return (
    <div className="ml-5 border-l border-border pl-4 sm:ml-6" aria-label={`Notes on ${label}`} role="group">
      <ol className="space-y-0.5">
        {notes.map((note, i) => (
          <li key={i} className="relative py-1.5">
            <span className="absolute top-[0.85rem] -left-[1.2rem] size-1.5 rounded-full bg-border" aria-hidden />
            <p className="text-[11px] text-muted-foreground tabular-nums">
              <time dateTime={note.at}>
                {shortDate(note.at)} · {time(note.at)}
              </time>
            </p>
            <p className="text-sm leading-relaxed text-pretty">{note.text}</p>
          </li>
        ))}
      </ol>
      <form onSubmit={submit} className="relative py-1.5">
        <span className="absolute top-[1.1rem] -left-[1.2rem] size-1.5 rounded-full border border-border bg-background" aria-hidden />
        <label htmlFor={id} className="sr-only">
          Add a note
        </label>
        <input
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note…"
          maxLength={280}
          className="h-8 w-full rounded-md bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:bg-muted/40 focus-visible:px-2"
        />
      </form>
    </div>
  );
}

/** A: tweet-sized card, the writer's thoughts as a thread of dated replies. */
export function CardWithThread({ clip, notes, onNote }: ShapeProps) {
  return (
    <div className="space-y-1">
      <article className="space-y-3 rounded-2xl border bg-card p-4 sm:p-5" data-clip={clip.type}>
        <Byline clip={clip} />
        <Title clip={clip} />
        <CardBody clip={clip} />
        <Footer clip={clip} />
      </article>
      <Thread notes={notes} onNote={onNote} label={displayTitle(clip)} />
    </div>
  );
}

function Label({ children, machine }: { children: ReactNode; machine?: boolean }) {
  return (
    <h4 className="text-[11px] text-muted-foreground">
      {children}
      {machine && <span className="ml-1.5 rounded-sm border border-dashed border-border px-1 py-px text-[10px]">machine-made</span>}
    </h4>
  );
}

/** An image or a thought has nothing behind it: no "More" that opens onto nothing. */
const deep = (clip: Clip) => Boolean(clip.summary || clip.file.source || clip.passages.length > 1);

/** The depth B and A→B open to: summary, the passages, and the source itself. */
function Depth({ clip }: { clip: Clip }) {
  const [all, setAll] = useState(false);
  const source = clip.file.source;
  const more = clip.passages.slice(1);
  // The preview opens where the card's passage sits, not at the top.
  const around = Math.max(0, passageBlock(clip) - 1);
  return (
    <div className="space-y-5 pt-1">
      {clip.summary && (
        <section className="space-y-1.5">
          <Label machine>Summary</Label>
          <p className="text-sm leading-relaxed text-pretty">{clip.summary}</p>
        </section>
      )}
      {more.length > 0 && (
        <section className="space-y-3">
          <Label>More passages</Label>
          <ul className="space-y-3">
            {more.map((passage, i) => (
              <li key={i} className="border-l border-border pl-3">
                <Pull clip={clip} passage={passage} size="list" />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-2">
        <Label>
          {all || !around ? "Source" : "Source, around the passage"}
          {source && <span className="tabular-nums"> · {clip.sourceChars.toLocaleString()} characters kept</span>}
        </Label>
        {source ? (
          <>
            <div
              className={`relative overflow-hidden rounded-xl bg-muted/40 px-4 py-3 text-[13px] leading-relaxed ${all ? "max-h-[60vh] overflow-y-auto" : "max-h-56"}`}
              tabIndex={all ? 0 : undefined}
            >
              <Markdown source={source} from={all ? 0 : around} limit={all ? undefined : 6} />
              {!all && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[color-mix(in_oklch,var(--muted)_40%,var(--card))]" />}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" onClick={() => setAll(!all)} className="text-xs text-muted-foreground hover:text-foreground">
                {all ? "Show less" : "Read the whole source"}
              </button>
              {clip.url && <SourceLink href={clip.url}>Original</SourceLink>}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{clip.type === "note" ? "Your own thought: there is no source." : "Nothing was extracted. Kin sees only the image and your notes."}</p>
        )}
      </section>
    </div>
  );
}

function Reveal({ open, reducedMotion, children, id }: { open: boolean; reducedMotion: boolean; children: ReactNode; id: string }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          id={id}
          key="depth"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.2, ease: [0.2, 0, 0, 1] }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Toggle({ open, onClick, controls, children }: { open: boolean; onClick: () => void; controls: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-controls={controls}
      className="inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <Chevron open={open} />
    </button>
  );
}

/** Today's single note field, as B keeps it. */
function SingleNote({ notes }: { notes: Note[] }) {
  if (!notes.length) return null;
  return (
    <section className="space-y-1.5">
      <Label>Your words</Label>
      <p className={`${prose} whitespace-pre-line rounded-xl bg-muted/35 px-4 py-3 text-[15px] leading-relaxed`}>
        {notes.map((n) => n.text).join("\n\n")}
      </p>
    </section>
  );
}

/** B: a card that expands to the summary and the extracted source. */
export function Expandable({ clip, notes, reducedMotion, open: initial = false }: ShapeProps) {
  const [open, setOpen] = useState(initial);
  const id = useId();
  return (
    <article className="space-y-3 rounded-2xl border bg-card p-4 sm:p-5" data-clip={clip.type}>
      <Byline clip={clip} />
      <Title clip={clip} />
      <CardBody clip={clip} />
      <SingleNote notes={notes} />
      <Footer clip={clip}>
        {deep(clip) && (
          <Toggle open={open} onClick={() => setOpen(!open)} controls={id}>
            {open ? "Less" : clip.summary ? "Summary and source" : "Source"}
          </Toggle>
        )}
      </Footer>
      {deep(clip) && (
        <Reveal open={open} reducedMotion={reducedMotion} id={id}>
          <Depth clip={clip} />
        </Reveal>
      )}
    </article>
  );
}

/** A→B: A by default, B one tap away; the thread stays the writer's voice. */
export function Hybrid({ clip, notes, onNote, reducedMotion, open: initial = false }: ShapeProps) {
  const [open, setOpen] = useState(initial);
  const id = useId();
  return (
    <div className="space-y-1">
      <article className="space-y-3 rounded-2xl border bg-card p-4 sm:p-5" data-clip={clip.type}>
        <Byline clip={clip} />
        <Title clip={clip} />
        <CardBody clip={clip} />
        <Footer clip={clip}>
          {deep(clip) && (
            <Toggle open={open} onClick={() => setOpen(!open)} controls={id}>
              {open ? "Less" : "More"}
            </Toggle>
          )}
        </Footer>
        {deep(clip) && (
          <Reveal open={open} reducedMotion={reducedMotion} id={id}>
            <div className="border-t pt-4">
              <Depth clip={clip} />
            </div>
          </Reveal>
        )}
      </article>
      <Thread notes={notes} onNote={onNote} label={displayTitle(clip)} />
    </div>
  );
}

const kindLabel: Record<string, string> = {
  link: "Link",
  post: "Post",
  video: "Video",
  image: "Image",
  quote: "Quote",
  note: "Note",
  document: "Document",
  book: "Book",
  podcast: "Podcast",
};

/** C: the long page, wiki-ish, everything at once. */
export function LongPage({ clip, notes }: ShapeProps) {
  const facts: [string, ReactNode][] = [
    ["Type", `${clip.label} (kind: ${kindLabel[clip.kind] ?? clip.kind})`],
    ["Site", clip.site],
    ["Author", clip.author],
    ["Saved", `${shortDate(clip.captured)} · ${time(clip.captured)} · via ${clip.file.fields.via}`],
    ["Tags", clip.tags.join(", ")],
    ["Source", clip.file.source ? `${clip.sourceChars.toLocaleString()} characters` : "None"],
  ];
  return (
    <article className="mx-auto grid max-w-[760px] gap-8 lg:max-w-[1040px] lg:grid-cols-[minmax(0,1fr)_240px] lg:gap-12" data-clip={clip.type}>
      <div className="min-w-0 space-y-8">
        <header className="space-y-3">
          <p className="text-xs text-muted-foreground">{byline(clip)}</p>
          <h2 className={`${prose} text-[28px] leading-tight text-balance sm:text-[32px]`}>{displayTitle(clip)}</h2>
          {clip.summary && (
            <p className="text-[15px] leading-relaxed text-muted-foreground text-pretty">
              {clip.summary} <span className="ml-1 rounded-sm border border-dashed border-border px-1 py-px align-middle text-[10px]">machine-made</span>
            </p>
          )}
        </header>
        {clip.image && <img src={clip.image} alt={clip.title ?? "Saved image"} className="w-full rounded-xl bg-muted object-contain" />}
        {clip.type === "note" && <p className={`${prose} text-xl leading-relaxed`}>{clip.file.own}</p>}
        {clip.passages.length > 0 && (
          <section className="space-y-4">
            <h3 className="border-b pb-2 text-sm font-medium">Passages</h3>
            {clip.passages.map((passage, i) => (
              <Pull key={i} clip={clip} passage={passage} size="list" />
            ))}
          </section>
        )}
        <section className="space-y-3">
          <h3 className="border-b pb-2 text-sm font-medium">Your words</h3>
          <p className={`${prose} whitespace-pre-line text-[17px] leading-relaxed`}>{notes.map((n) => n.text).join("\n\n")}</p>
        </section>
        {clip.file.source && (
          <section className="space-y-3">
            <h3 className="border-b pb-2 text-sm font-medium">Source</h3>
            <div className={`${prose} text-[16px] leading-relaxed`}>
              <Markdown source={clip.file.source} />
            </div>
          </section>
        )}
      </div>
      <aside className="order-first lg:order-none">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-xl bg-muted/40 p-4 text-xs lg:sticky lg:top-6">
          {facts
            .filter(([, value]) => value)
            .map(([term, value]) => (
              <div key={term} className="contents">
                <dt className="text-muted-foreground">{term}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </div>
            ))}
          {clip.url && (
            <div className="col-span-2 pt-1">
              <SourceLink href={clip.url}>Original</SourceLink>
            </div>
          )}
        </dl>
      </aside>
    </article>
  );
}
