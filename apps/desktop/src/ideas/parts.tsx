/**
 * The pieces of an engaged idea, shared by every layout (KI-22): the idea
 * and its takeaways with inline citations, the actions, Adopt, Refine and
 * the dismissed row. A layout (Ledger today) only arranges them.
 */
import { useState, type ReactNode } from "react";
import { Button } from "@kintsugi/ui/components/button";
import { Popover } from "@kintsugi/ui/graphical";
import { cn } from "@kintsugi/ui/lib/utils";
import { KinAvatar } from "@/kin/Avatar";
import type { Idea, Listed, Quote } from "./api";
import { ageLabel, cite, DISMISS_REASONS, uncited, uniqueSources } from "./model";
import type { IdeasModel } from "./useIdeas";

export const serif = "font-[family-name:var(--font-prose)]";

/** The gold seam's values, from KI-23's Kin gold: the one accent, used only
 *  where Kin's own thinking sits. */
export const seam =
  "[--seam-ink:var(--kin-ink)] [--seam:var(--kin)]";

/** A section's name: a plain sentence-case heading, never a small-caps label. */
export function Heading({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("text-sm font-medium", className)}>{children}</h3>;
}

/** Kin's mark: the product's placeholder avatar (KI-41 applies the chosen look). */
export function KinMark({ size = "sm", children }: { size?: "xs" | "sm" | "md"; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <KinAvatar className={size === "xs" ? "size-3.5" : size === "sm" ? "size-4" : "size-7"} />
      {children ?? "Kin"}
    </span>
  );
}

/** The one status a collapsed idea carries. */
export function Status({ idea, className }: { idea: Listed; className?: string }) {
  if (idea.adopted) return <span className={cn("text-xs whitespace-nowrap text-[var(--seam-ink)]", className)}>Adopted</span>;
  if (idea.refining) return <span className={cn("text-xs whitespace-nowrap text-muted-foreground", className)}>Refining…</span>;
  if (idea.age === 0) return null;
  return <span className={cn("text-xs whitespace-nowrap text-muted-foreground tabular-nums", className)}>{ageLabel(idea.age)}</span>;
}

/** Quotes stay verbatim; wikilinks inside them read as links, not brackets. */
function withLinks(text: string): ReactNode[] {
  return text.split(/(\[\[[^\]]+\]\])/).map((part, i) =>
    part.startsWith("[[") ? (
      <span key={i} className="underline decoration-muted-foreground/40 underline-offset-2">
        {part.slice(2, -2).split("|").pop()!.split("/").pop()}
      </span>
    ) : (
      part
    ),
  );
}

export function ClipQuote({ quote, compact = false, onOpen }: { quote: Quote; compact?: boolean; onOpen: (q: Quote) => void }) {
  return (
    <figure className={compact ? "space-y-1" : "space-y-1.5"}>
      <blockquote className={cn(serif, compact ? "text-base" : "text-base", "leading-relaxed")}>“{withLinks(quote.text)}”</blockquote>
      <figcaption>
        <button
          type="button"
          onClick={() => onOpen(quote)}
          className="text-left text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {quote.title}
          <span aria-hidden> · </span>
          {quote.origin}
          <span aria-hidden> ↗</span>
          <span className="sr-only"> Open {quote.source}</span>
        </button>
      </figcaption>
    </figure>
  );
}

export function Actions({ idea, model }: { idea: Listed; model: IdeasModel }) {
  const { state } = model;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" aria-expanded={state.adopting === idea.id} onClick={() => model.startAdopt(idea.id)}>
        Adopt
      </Button>
      <Button size="sm" variant="outline" onClick={() => model.discuss(idea)}>
        Discuss with Kin
      </Button>
      <Button size="sm" variant="ghost" aria-expanded={state.refining === idea.id} disabled={!!idea.refining} onClick={() => model.startRefine(idea.id)}>
        Refine
      </Button>
      {!idea.adopted && (
        <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => model.dismiss(idea)}>
          Dismiss
        </Button>
      )}
    </div>
  );
}

/** Adopt asks one question: a new empty draft, or one already started. */
export function AdoptChooser({ idea, model }: { idea: Listed; model: IdeasModel }) {
  const [title, setTitle] = useState(idea.draftTitle);
  if (model.state.adopting !== idea.id) return null;
  const clips = uniqueSources(idea.quotes).filter((q) => !q.source.startsWith("feed:")).length;
  return (
    <div className="space-y-3 rounded-lg border p-4" role="group" aria-label="Adopt this idea">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void model.adopt(idea, { title: title.trim() || idea.draftTitle });
        }}
      >
        <label className="block text-sm font-medium" htmlFor={`adopt-${idea.id}`}>
          New draft
        </label>
        <div className="flex gap-2">
          <input
            id={`adopt-${idea.id}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={cn(serif, "h-8 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50")}
          />
          <Button size="sm" type="submit">
            Create draft
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The body starts empty. The idea and {clips} {clips === 1 ? "clip" : "clips"} go in the frontmatter.
        </p>
      </form>
      {model.drafts.length > 0 && (
        <div className="space-y-1 border-t pt-3">
          <p className="text-xs text-muted-foreground">Or add it to a draft you've started</p>
          <ul className="max-h-48 overflow-y-auto">
            {model.drafts.map((d) => (
              <li key={d.path}>
                <button
                  type="button"
                  onClick={() => void model.adopt(idea, { into: d.path })}
                  className="flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <span className="truncate">{d.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{d.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function RefineBox({ idea, model }: { idea: Listed; model: IdeasModel }) {
  const [ask, setAsk] = useState("");
  if (model.state.refining !== idea.id) return null;
  const chips = ["Narrower", "Argue the other side", "A short post, not an essay"];
  return (
    <form
      className="space-y-2.5 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ask.trim()) model.refine(idea, ask.trim());
      }}
    >
      <label className="block text-sm font-medium" htmlFor={`refine-${idea.id}`}>
        How should Kin change it?
      </label>
      <input
        id={`refine-${idea.id}`}
        value={ask}
        onChange={(e) => setAsk(e.target.value)}
        placeholder="Say what's off, in a few words"
        className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((c) => (
          <button key={c} type="button" onClick={() => setAsk(c)} className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            {c}
          </button>
        ))}
        <Button size="sm" type="submit" className="ml-auto" disabled={!ask.trim()}>
          Refine
        </Button>
      </div>
    </form>
  );
}

/** A dismissed idea keeps its place for a moment, asking why — optionally. */
export function DismissedRow({ idea, model }: { idea: Listed; model: IdeasModel }) {
  const reason = idea.dismissed?.reasons[0];
  const effect = DISMISS_REASONS.find((r) => r.text === reason)?.effect;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground" role="status">
      <span className="min-w-0 truncate">
        <span className="line-through decoration-muted-foreground/50">{idea.title}</span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {reason ? (
          <span className="text-xs">
            Dismissed · {reason}. {effect}
          </span>
        ) : (
          <>
            <span className="text-xs">Dismissed. Tell Kin why?</span>
            {DISMISS_REASONS.map((r) => (
              <button key={r.text} type="button" onClick={() => model.dismissWhy(idea, r.text)} className="rounded-full border px-2 py-0.5 text-xs hover:bg-muted hover:text-foreground">
                {r.text}
              </button>
            ))}
          </>
        )}
        <button type="button" onClick={() => model.undismiss(idea)} className="text-xs underline underline-offset-2 hover:text-foreground">
          Undo
        </button>
      </span>
    </div>
  );
}

/** What happened to an idea: refined (with undo), adopted (open the draft). */
export function Provenance({ idea, model, onOpenDoc }: { idea: Listed; model: IdeasModel; onOpenDoc: (path: string) => void }) {
  const was = idea.versions[idea.versions.length - 1];
  if (!idea.adopted && !was && !idea.refining && !idea.refineError) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" role="status">
      {idea.refining && <span>Kin is reworking it.</span>}
      {idea.refineError && !idea.refining && <span className="text-destructive">Refine didn't work: {idea.refineError}</span>}
      {was && (
        <span>
          Refined · was <q>{was.content.title}</q>{" "}
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => model.undoRefine(idea)}>
            Undo
          </button>
        </span>
      )}
      {idea.adopted && (
        <button type="button" onClick={() => onOpenDoc(idea.adopted!.path)} className="underline underline-offset-2 hover:text-foreground">
          Adopted · open draft
        </button>
      )}
    </div>
  );
}

/** `[1]`: the quote and its source on hover or click. */
export function Citation({ n, quote, onOpen }: { n: number; quote: Quote; onOpen: (q: Quote) => void }) {
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={150}
        render={
          <button
            type="button"
            aria-label={`Quote ${n}: ${quote.title}`}
            className="mx-px inline-flex -translate-y-[0.35em] items-center rounded border-0! px-0.5 shadow-none! before:hidden align-baseline font-sans text-xxs leading-none text-[var(--seam-ink)] tabular-nums hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring data-[popup-open]:bg-muted"
          />
        }
      >
        [{n}]
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={6} align="start">
          <Popover.Popup className="w-max max-w-80 p-3.5">
            <ClipQuote quote={quote} compact onOpen={onOpen} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Kin's text with its `[n]` markers as citations; `extra` cites more at the end. */
function Cited({ text, idea, onOpen, extra = [] }: { text: string; idea: Idea; onOpen: (q: Quote) => void; extra?: number[] }) {
  const pieces = cite(text, idea.quotes.length);
  return (
    <>
      {pieces.map((p, i) =>
        "text" in p ? p.text : <Citation key={i} n={p.quote + 1} quote={idea.quotes[p.quote]} onOpen={onOpen} />,
      )}
      {extra.map((q) => (
        <Citation key={`x${q}`} n={q + 1} quote={idea.quotes[q]} onOpen={onOpen} />
      ))}
    </>
  );
}

/**
 * The engaged body: the idea, a few takeaways, the actions. Each claim
 * cites its quote inline; quotes nothing cites (all of them, for ideas
 * from before citations) hang off the end of the idea.
 */
export function Detail({ idea, model, onOpenDoc }: { idea: Listed; model: IdeasModel; onOpenDoc: (path: string) => void }) {
  return (
    <div className="space-y-5">
      <Provenance idea={idea} model={model} onOpenDoc={onOpenDoc} />
      <p className={cn(serif, "border-l-2 border-[var(--seam)] pl-4 text-base leading-relaxed text-pretty")}>
        <Cited text={idea.hunch} idea={idea} onOpen={model.openQuote} extra={uncited(idea)} />
      </p>
      {idea.observed.length > 0 && (
        <ul className="space-y-1.5 text-sm leading-relaxed" aria-label="Takeaways">
          {idea.observed.map((fact) => (
            <li key={fact} className="flex gap-2.5">
              <span aria-hidden className="mt-[0.6em] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
              <span className="text-pretty">
                <Cited text={fact} idea={idea} onOpen={model.openQuote} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <Actions idea={idea} model={model} />
      <AdoptChooser idea={idea} model={model} />
      <RefineBox idea={idea} model={model} />
    </div>
  );
}

/** Ideas about one draft, on demand (the editor's "Ideas for this draft"). */
export function FindForDraft({ model }: { model: IdeasModel }) {
  if (!model.filter) return null;
  return (
    <Button size="sm" variant="outline" disabled={model.busy} onClick={() => model.generate()}>
      Find ideas for this draft
    </Button>
  );
}

/** Faded this week: unused ideas, each a faint "no". */
export function FadedList({ model }: { model: IdeasModel }) {
  const faded = model.groups.faded;
  if (!faded.length) return null;
  return (
    <div className="space-y-2 text-sm">
      <button type="button" aria-expanded={model.state.showFaded} onClick={model.toggleFaded} className="text-muted-foreground hover:text-foreground">
        {faded.length} faded this week {model.state.showFaded ? "▴" : "▾"}
      </button>
      {model.state.showFaded && (
        <ul className="space-y-1.5">
          {faded.map((idea) => (
            <li key={idea.id} className="flex items-baseline justify-between gap-3 text-muted-foreground/80">
              <span className={cn(serif, "truncate")}>{idea.title}</span>
              <span className="shrink-0 text-xs">Unused, so Kin counts it as a weak no</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Where the newest batch stands: looking, waiting at the cap, or failed. */
export function JobLine({ model }: { model: IdeasModel }) {
  const job = model.job;
  if (!job) return null;
  if (job.status === "queued" || job.status === "running")
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <KinMark size="xs">
          <span className="motion-safe:animate-pulse">Kin is looking for ideas…</span>
        </KinMark>
      </p>
    );
  if (job.status === "waiting")
    return (
      <p role="status" className="text-sm text-muted-foreground">
        This month's AI spending cap is reached. Kin looks again next month, or sooner if you raise the cap.
      </p>
    );
  const recent = job.finished && Date.now() - Date.parse(job.finished) < 6 * 3600_000;
  if (job.status === "failed" && recent)
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        The last search for ideas didn't finish: {job.error}
      </p>
    );
  return null;
}

