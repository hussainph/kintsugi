/**
 * The pieces of an engaged idea, shared by every layout (KI-22): observed
 * vs hunch, quoted evidence, how I got here, Why this?, the actions, Adopt,
 * Refine and the dismissed row. A layout (Ledger today) only arranges them.
 */
import { useState, type ReactNode } from "react";
import { Button } from "@kintsugi/ui/components/button";
import { cn } from "@kintsugi/ui/lib/utils";
import { KinAvatar } from "@/kin/Avatar";
import type { Idea, Listed, Quote } from "./api";
import { ageLabel, DISMISS_REASONS, footprint, uniqueSources } from "./model";
import type { IdeasModel } from "./useIdeas";

export const serif = "font-[family-name:var(--font-prose)]";

/** The gold seam's values, from KI-23's Kin gold: the one accent, used only
 *  where Kin's own thinking sits. */
export const seam =
  "[--seam-ink:oklch(0.5_0.1_68)] [--seam:oklch(0.66_0.125_76)] dark:[--seam-ink:oklch(0.83_0.11_85)] dark:[--seam:oklch(0.79_0.12_84)]";

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase", className)}>{children}</p>;
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

/** The one quiet status a collapsed idea carries. */
export function Status({ idea, className }: { idea: Listed; className?: string }) {
  if (idea.adopted) return <span className={cn("text-xs whitespace-nowrap text-[var(--seam-ink)]", className)}>Adopted</span>;
  if (idea.refining) return <span className={cn("text-xs whitespace-nowrap text-muted-foreground", className)}>Refining…</span>;
  if (idea.age === 0) return null;
  return <span className={cn("text-xs whitespace-nowrap text-muted-foreground tabular-nums", className)}>{ageLabel(idea.age)}</span>;
}

export function Observed({ idea }: { idea: Idea }) {
  return (
    <section className="space-y-2" aria-label="Observed">
      <Label>Observed</Label>
      <ul className="space-y-1.5 text-sm leading-relaxed">
        {idea.observed.map((fact) => (
          <li key={fact} className="flex gap-2.5">
            <span aria-hidden className="mt-[0.6em] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
            <span>{fact}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Hunch({ idea }: { idea: Idea }) {
  return (
    <section className="space-y-2" aria-label="Hunch">
      <div className="flex items-center gap-2">
        <Label>Hunch</Label>
        <KinMark size="xs">Kin's guess, not a fact</KinMark>
      </div>
      <p className={cn(serif, "border-l-2 border-[var(--seam)] pl-4 text-[17px] leading-relaxed")}>{idea.hunch}</p>
    </section>
  );
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
      <blockquote className={cn(serif, compact ? "text-[15px]" : "text-base", "leading-relaxed")}>“{withLinks(quote.text)}”</blockquote>
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

export function Evidence({ idea, onOpen }: { idea: Idea; onOpen: (q: Quote) => void }) {
  return (
    <section className="space-y-3" aria-label="Evidence">
      <Label>In your vault · {idea.quotes.length}</Label>
      <div className="space-y-4">
        {idea.quotes.map((quote) => (
          <ClipQuote key={quote.source + quote.text} quote={quote} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

/** Stream of thought, collapsed: what Kin did, in order, and what it cost. */
export function HowIGotHere({ idea }: { idea: Idea }) {
  return (
    <details className="group text-sm">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="inline-block text-[10px] transition-transform group-open:rotate-90 motion-reduce:transition-none">▸</span>
        How I got here
      </summary>
      {idea.steps.length > 0 && (
        <ol className="mt-3 ml-1 space-y-2 border-l pl-4">
          {idea.steps.map((step) => (
            <li key={step.did} className="relative leading-snug">
              <span aria-hidden className="absolute top-[0.5em] -left-[19px] size-[5px] rounded-full bg-muted-foreground/50" />
              {step.did}
              {step.found && <span className="text-muted-foreground"> — {step.found}</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 ml-5 text-xs text-muted-foreground tabular-nums">{footprint(idea.footprint)}</p>
    </details>
  );
}

/** "Why this?" is the steering wheel: remove a reason, or fix a line in About you. */
export function WhyThis({ idea, model }: { idea: Listed; model: IdeasModel }) {
  const open = model.state.whyOpen === idea.id;
  if (!idea.reasons.length) return null;
  return (
    <div className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => model.toggleWhy(idea.id)}
        className="text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
      >
        Why this?
      </button>
      {open && (
        <div className="mt-3 space-y-3 rounded-lg bg-muted/60 p-4">
          <p className="text-xs text-muted-foreground">Kin offered this because of the reasons below. Remove one that's wrong, and it stops counting.</p>
          <ul className="space-y-2.5">
            {idea.reasons.map((reason) => (
              <li key={reason.id} className={cn("space-y-1.5", reason.removed && "opacity-50")}>
                <div className="flex items-start justify-between gap-3">
                  <span className={cn(reason.removed && "line-through")}>{reason.text}</span>
                  <button
                    type="button"
                    onClick={() => (reason.removed ? model.restoreReason(idea, reason) : model.removeReason(idea, reason))}
                    className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                    aria-label={`${reason.removed ? "Count it again" : "Not a reason"}: ${reason.text}`}
                  >
                    {reason.removed ? "Count it again" : "Not a reason"}
                  </button>
                </div>
                {reason.profileLine && !reason.removed && (
                  <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                    <span>
                      About you: <q className={cn(serif, "text-[13px] text-foreground")}>{reason.profileLine}</q>
                    </span>
                    <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={model.fixProfile}>
                      Fix
                    </button>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
            className={cn(serif, "h-8 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-[15px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50")}
          />
          <Button size="sm" type="submit">
            Create draft
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The body starts empty. The idea and {clips} {clips === 1 ? "clip" : "clips"} sit beside it and in its frontmatter, never in the prose.
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
      {idea.refining && <span>Kin is reworking it. The new version replaces this one when it's ready.</span>}
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

/** The full engaged body, in Kin's order: facts, guess, evidence, then the workings. */
export function Detail({ idea, model, onOpenDoc }: { idea: Listed; model: IdeasModel; onOpenDoc: (path: string) => void }) {
  return (
    <div className="space-y-6">
      <Provenance idea={idea} model={model} onOpenDoc={onOpenDoc} />
      <div className="space-y-5">
        <Observed idea={idea} />
        <Hunch idea={idea} />
      </div>
      <Evidence idea={idea} onOpen={model.openQuote} />
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <HowIGotHere idea={idea} />
        <WhyThis idea={idea} model={model} />
      </div>
      <Actions idea={idea} model={model} />
      <AdoptChooser idea={idea} model={model} />
      <RefineBox idea={idea} model={model} />
    </div>
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
              <span className="shrink-0 text-xs">Unused · counts as a faint “no”</span>
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
        Waiting: this month's AI spending cap is reached. Kin looks again once spending allows.
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

/** Ideas on demand. */
export function AskForMore({ model }: { model: IdeasModel }) {
  const [focus, setFocus] = useState("");
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        model.generate(focus.trim() || undefined);
        setFocus("");
      }}
    >
      <input
        aria-label="What should the ideas be about?"
        value={focus}
        onChange={(e) => setFocus(e.target.value)}
        placeholder={model.filter ? "Anything in particular about this draft?" : "Anything in particular? (optional)"}
        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <Button size="sm" variant="outline" type="submit" disabled={model.busy}>
        {model.filter ? "Find ideas for this draft" : "Ask for more"}
      </Button>
    </form>
  );
}
