import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { cn } from "@kintsugi/ui/lib/utils";
import { KinAvatar } from "@/kin/Avatar";
import {
  ageLabel,
  clipsFor,
  drafts,
  freshness,
  frontmatter,
  slugify,
  unique,
  type ClipRef,
  type Idea,
} from "./fixtures";
import type { DismissReason, IdeasModel } from "./model";

export const serif = "font-[family-name:var(--font-prose)]";

/** The gold seam: the one accent, used only where Kin's own thinking sits.
 *  Values mirror KI-23's Kin gold (--kin / --kin-ink in experiment/kin-look),
 *  copied rather than imported so this entry doesn't depend on another's CSS. */
export function Frame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      aria-label={label}
      className="min-h-svh bg-background text-foreground [--seam-ink:oklch(0.5_0.1_68)] [--seam:oklch(0.66_0.125_76)] dark:[--seam-ink:oklch(0.83_0.11_85)] dark:[--seam:oklch(0.79_0.12_84)]"
    >
      {children}
    </div>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase", className)}>
      {children}
    </p>
  );
}

/** Placeholder identity: the product's current avatar. KI-23 replaces it. */
export function KinMark({ size = "sm", children }: { size?: "xs" | "sm" | "md"; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <KinAvatar className={size === "xs" ? "size-3.5" : size === "sm" ? "size-4" : "size-7"} />
      {children ?? "Kin"}
    </span>
  );
}

export function Age({ idea, className }: { idea: Idea; className?: string }) {
  return (
    <span className={cn("text-xs whitespace-nowrap text-muted-foreground tabular-nums", className)}>
      {ageLabel(idea.age)}
    </span>
  );
}

/** Opacity for ageing ideas; text thins, it never jumps away. Adopted ideas stop ageing. */
export const fade = (idea: Idea, model: IdeasModel) =>
  model.state.adopted[idea.id] ? undefined : { opacity: freshness(idea.age) || 0.45 };

/** The one quiet status a collapsed idea carries: adopted, or how old it is. */
export function Status({ idea, model, className }: { idea: Idea; model: IdeasModel; className?: string }) {
  if (model.state.adopted[idea.id])
    return <span className={cn("text-xs whitespace-nowrap text-[var(--seam-ink)]", className)}>Adopted</span>;
  if (idea.age === 0) return null;
  return <Age idea={idea} className={className} />;
}

export function Observed({ idea, className }: { idea: Idea; className?: string }) {
  return (
    <section className={cn("space-y-2", className)} aria-label="Observed">
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

export function Hunch({ idea, signed = true, className }: { idea: Idea; signed?: boolean; className?: string }) {
  return (
    <section className={cn("space-y-2", className)} aria-label="Hunch">
      <div className="flex items-center gap-2">
        <Label>Hunch</Label>
        {signed && <KinMark size="xs">Kin's guess, not a fact</KinMark>}
      </div>
      <p className={cn(serif, "border-l-2 border-[var(--seam)] pl-4 text-[17px] leading-relaxed")}>
        {idea.hunch}
      </p>
    </section>
  );
}

/** Quotes stay verbatim; wikilinks inside them read as links, not brackets. */
function withLinks(text: string): ReactNode[] {
  return text.split(/(\[\[[^\]]+\]\])/).map((part, i) =>
    part.startsWith("[[") ? (
      <span key={i} className="underline decoration-muted-foreground/40 underline-offset-2">
        {part.slice(2, -2).split("/").pop()}
      </span>
    ) : (
      part
    ),
  );
}

export function ClipQuote({ clip, compact = false, onOpen }: { clip: ClipRef; compact?: boolean; onOpen: (c: ClipRef) => void }) {
  return (
    <figure className={cn("group", compact ? "space-y-1" : "space-y-1.5")}>
      <blockquote className={cn(serif, compact ? "text-[15px]" : "text-base", "leading-relaxed")}>
        “{withLinks(clip.quote)}”
      </blockquote>
      <figcaption>
        <button
          type="button"
          onClick={() => onOpen(clip)}
          className="text-left text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {clip.title}
          <span aria-hidden> · </span>
          {clip.own ? <span>Your writing</span> : clip.source}
          <span aria-hidden> ↗</span>
          <span className="sr-only"> Open {clip.path}</span>
        </button>
      </figcaption>
    </figure>
  );
}

export function Evidence({ idea, onOpen, grid = false }: { idea: Idea; onOpen: (c: ClipRef) => void; grid?: boolean }) {
  return (
    <section className="space-y-3" aria-label="Evidence">
      <Label>In your vault · {idea.clips.length}</Label>
      <div className={cn(grid ? "grid gap-3 sm:grid-cols-2" : "space-y-4")}>
        {idea.clips.map((clip) => (
          <div key={clip.path + clip.quote} className={cn(grid && "rounded-lg border p-3.5")}>
            <ClipQuote clip={clip} onOpen={onOpen} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** Stream of thought, collapsed: what Kin did, in order, and what it cost. */
export function HowIGotHere({ idea, defaultOpen = false }: { idea: Idea; defaultOpen?: boolean }) {
  return (
    <details className="group text-sm" open={defaultOpen}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="inline-block text-[10px] transition-transform group-open:rotate-90 motion-reduce:transition-none">▸</span>
        How I got here
      </summary>
      <ol className="mt-3 ml-1 space-y-2 border-l pl-4">
        {idea.steps.map((step) => (
          <li key={step.did} className="relative leading-snug">
            <span aria-hidden className="absolute top-[0.5em] -left-[19px] size-[5px] rounded-full bg-muted-foreground/50" />
            {step.did}
            {step.found && <span className="text-muted-foreground"> — {step.found}</span>}
          </li>
        ))}
      </ol>
      <p className="mt-3 ml-5 text-xs text-muted-foreground tabular-nums">{idea.footprint}</p>
    </details>
  );
}

/** "Why this?" is the steering wheel: remove a reason, or fix a line in About you. */
export function WhyThis({ idea, model }: { idea: Idea; model: IdeasModel }) {
  const { state } = model;
  const open = state.whyOpen === idea.id;
  const removed = state.removed[idea.id] ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
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
          <p className="text-xs text-muted-foreground">
            Kin offered this because of the reasons below. Remove one that's wrong, and it stops counting.
          </p>
          <ul className="space-y-2.5">
            {idea.reasons.map((reason) => {
              const gone = removed.includes(reason.id);
              const key = `${idea.id}:${reason.id}`;
              const line = state.fixes[key] ?? reason.profileLine;
              return (
                <li key={reason.id} className={cn("space-y-1.5", gone && "opacity-50")}>
                  <div className="flex items-start justify-between gap-3">
                    <span className={cn(gone && "line-through")}>{reason.text}</span>
                    {!gone && (
                      <button
                        type="button"
                        onClick={() => model.removeReason(idea.id, reason.id, reason.text)}
                        className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                        aria-label={`Not a reason: ${reason.text}`}
                      >
                        Not a reason
                      </button>
                    )}
                  </div>
                  {line && !gone && (
                    editing === key ? (
                      <form
                        className="flex gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (draft.trim()) model.fixLine(idea.id, reason.id, draft.trim());
                          setEditing(null);
                        }}
                      >
                        <input
                          autoFocus
                          aria-label="About you line"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        />
                        <Button size="sm" type="submit">Save</Button>
                      </form>
                    ) : (
                      <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                        <span>
                          About you: <q className={cn(serif, "text-[13px] text-foreground")}>{line}</q>
                        </span>
                        <button
                          type="button"
                          className="underline underline-offset-2 hover:text-foreground"
                          onClick={() => {
                            setDraft(line);
                            setEditing(key);
                          }}
                        >
                          Fix
                        </button>
                      </p>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Actions({ idea, model, className }: { idea: Idea; model: IdeasModel; className?: string }) {
  const { state } = model;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <Button size="sm" aria-expanded={state.adopting === idea.id} onClick={() => model.startAdopt(idea.id)}>
        Adopt
      </Button>
      <Button size="sm" variant="outline" onClick={() => model.discuss(idea.id)}>
        Discuss with Kin
      </Button>
      <Button size="sm" variant="ghost" aria-expanded={state.refining === idea.id} onClick={() => model.startRefine(idea.id)}>
        Refine
      </Button>
      <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => model.dismiss(idea.id)}>
        Dismiss
      </Button>
    </div>
  );
}

/** Adopt asks one question: a new empty draft, or one already started. */
export function AdoptChooser({ idea, model }: { idea: Idea; model: IdeasModel }) {
  if (model.state.adopting !== idea.id) return null;
  const clips = unique(idea.clips).length;
  return (
    <div className="space-y-3 rounded-lg border p-4" role="group" aria-label="Adopt this idea">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">
            New draft: <span className={serif}>“{idea.draftTitle}”</span>
          </p>
          <p className="text-xs text-muted-foreground">
            The body starts empty. The idea and {clips} clips sit beside it and in its frontmatter, never in the prose.
          </p>
        </div>
        <Button size="sm" onClick={() => model.adopt(idea.id)}>
          Create draft
        </Button>
      </div>
      <div className="space-y-1 border-t pt-3">
        <p className="text-xs text-muted-foreground">Or add it to a draft you've started</p>
        <ul>
          {drafts.map((d) => (
            <li key={d.path}>
              <button
                type="button"
                onClick={() => model.adopt(idea.id, d.path)}
                className="flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <span className="truncate">{d.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">edited {d.edited}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function RefineBox({ idea, model }: { idea: Idea; model: IdeasModel }) {
  const [ask, setAsk] = useState(idea.refined?.asked ?? "");
  const [pending, setPending] = useState(false);
  if (model.state.refining !== idea.id) return null;
  const chips = ["Narrower", "Argue the other side", "A short post, not an essay"];
  return (
    <form
      className="space-y-2.5 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (idea.refined && !model.state.refined.includes(idea.id)) model.refine(idea.id);
        else setPending(true);
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
          <button
            key={c}
            type="button"
            onClick={() => setAsk(c)}
            className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {c}
          </button>
        ))}
        <Button size="sm" type="submit" className="ml-auto" disabled={!ask.trim()}>
          Refine
        </Button>
      </div>
      {pending && (
        <p role="status" className="text-xs text-muted-foreground">
          Kin is reworking it in the background. The new version replaces this one when it's ready.
        </p>
      )}
    </form>
  );
}

/** A dismissed idea keeps its place for a moment, asking why — optionally. */
export function DismissedRow({ idea, model, className }: { idea: Idea; model: IdeasModel; className?: string }) {
  const reason = model.state.dismissed[idea.id];
  const reasons: DismissReason[] = ["Not for me", "Already on it", "Wrong about me"];
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground", className)} role="status">
      <span className="min-w-0 truncate">
        <span className="line-through decoration-muted-foreground/50">{idea.title}</span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {reason ? (
          <span className="text-xs">
            Dismissed · {reason}.{" "}
            {reason === "Not for me"
              ? "Kin will offer fewer like it."
              : reason === "Already on it"
                ? "Kin will leave this one to you."
                : "Fix what it believed in About you."}
          </span>
        ) : (
          <>
            <span className="text-xs">Dismissed. Tell Kin why?</span>
            {reasons.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => model.reason(idea.id, r)}
                className="rounded-full border px-2 py-0.5 text-xs hover:bg-muted hover:text-foreground"
              >
                {r}
              </button>
            ))}
          </>
        )}
        <button type="button" onClick={() => model.undismiss(idea.id)} className="text-xs underline underline-offset-2 hover:text-foreground">
          Undo
        </button>
      </span>
    </div>
  );
}

export function Notice({ model }: { model: IdeasModel }) {
  const n = model.state.notice;
  if (!n) return null;
  return (
    <div role="status" className="fixed inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <div className="flex max-w-md items-center gap-3 rounded-full border bg-popover px-4 py-2 text-sm shadow-sm">
        <span className="min-w-0">{n.text}</span>
        <button type="button" onClick={n.undo} className="shrink-0 font-medium underline-offset-2 hover:underline">
          Undo
        </button>
      </div>
    </div>
  );
}

export function FadedList({ model }: { model: IdeasModel }) {
  if (!model.faded.length) return null;
  const n = model.faded.length;
  return (
    <div className="space-y-2 text-sm">
      <button type="button" aria-expanded={model.state.showFaded} onClick={model.toggleFaded} className="text-muted-foreground hover:text-foreground">
        {n} faded this week {model.state.showFaded ? "▴" : "▾"}
      </button>
      {model.state.showFaded && (
        <ul className="space-y-1.5">
          {model.faded.map((idea) => (
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

/** In the product this opens the clip at the quoted passage; here it only says so. */
export function useOpenClip() {
  const onOpen = (clip: ClipRef) =>
    toast(`Opens ${clip.title} at the quoted passage`, { description: clip.path });
  return { onOpen, status: null as ReactNode };
}

/** Shown on an idea once acted on, so the list remembers what happened. */
export function Provenance({ idea, model }: { idea: Idea; model: IdeasModel }) {
  const adopted = model.state.adopted[idea.id];
  const refined = model.state.refined.includes(idea.id);
  const was = model.original(idea.id);
  if (!adopted && !refined) return null;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {refined && was && (
        <span>
          Refined · was <q>{was.title}</q>
        </span>
      )}
      {adopted && (
        <button type="button" onClick={() => model.openDraft(idea.id)} className="underline underline-offset-2 hover:text-foreground">
          Adopted · open draft
        </button>
      )}
    </p>
  );
}

/** The full engaged body, in Kin's order: facts, guess, evidence, then the workings. */
export function Detail({ idea, model, onOpen, sideBySide = false, gridClips = false }: {
  idea: Idea;
  model: IdeasModel;
  onOpen: (c: ClipRef) => void;
  sideBySide?: boolean;
  gridClips?: boolean;
}) {
  return (
    <div className="space-y-6">
      <Provenance idea={idea} model={model} />
      <div className={cn(sideBySide ? "grid gap-6 md:grid-cols-2 md:gap-8" : "space-y-5")}>
        <Observed idea={idea} />
        <Hunch idea={idea} />
      </div>
      <Evidence idea={idea} onOpen={onOpen} grid={gridClips} />
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

export function BackBar({ onBack, children }: { onBack: () => void; children?: ReactNode }) {
  return (
    <div className="flex h-12 items-center gap-3 border-b px-3 md:px-5">
      <Button size="sm" variant="ghost" onClick={onBack}>
        ‹ Ideas
      </Button>
      <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{children}</div>
    </div>
  );
}

/** Adopt's result: the writer's page is empty; Kin's material waits beside it. */
export function DraftView({ idea, attachTo, model }: { idea: Idea; attachTo?: string; model: IdeasModel }) {
  const existing = drafts.find((d) => d.path === attachTo);
  const [title, setTitle] = useState(existing?.title ?? idea.draftTitle);
  const [panel, setPanel] = useState(false);
  const { onOpen, status } = useOpenClip();
  const file = existing ? `${existing.path}.md` : `drafts/${slugify(idea.draftTitle)}.md`;
  const beside = clipsFor(idea, attachTo);
  const aside = (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <Label>The idea</Label>
        <KinMark size="xs">from Kin · today</KinMark>
      </div>
      <p className={cn(serif, "border-l-2 border-[var(--seam)] pl-3.5 text-[15px] leading-relaxed")}>{idea.hunch}</p>
      <div className="space-y-4">
        <Label>Clips · {beside.length}</Label>
        {idea.clips.filter((c) => c.path !== attachTo).map((c) => (
          <ClipQuote key={c.path + c.quote} clip={c} compact onOpen={onOpen} />
        ))}
      </div>
      <details className="group text-xs" open>
        <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          In the file <span aria-hidden className="group-open:hidden">▾</span>
          <span aria-hidden className="hidden group-open:inline">▴</span>
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {frontmatter(idea, title, attachTo)}
        </pre>
        <p className="mt-2 text-muted-foreground">Clips are wikilinks, so each one shows this draft under “Used in”.</p>
      </details>
      <div className="flex gap-2 border-t pt-4">
        <Button size="sm" variant="ghost" onClick={() => model.discuss(idea.id)}>Discuss with Kin</Button>
        <Button size="sm" variant="ghost" className="text-muted-foreground">Detach idea</Button>
      </div>
    </div>
  );
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <BackBar onBack={model.back}>
        {file} · {existing ? "idea added" : "new draft"}
      </BackBar>
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-[680px] px-6 pt-10 pb-24 md:pt-16">
            <button
              type="button"
              onClick={() => setPanel(!panel)}
              aria-expanded={panel}
              className="mb-6 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs text-muted-foreground lg:hidden"
            >
              <KinMark size="xs">
                Idea · {beside.length} {beside.length === 1 ? "clip" : "clips"} beside this draft
              </KinMark>
              <span aria-hidden>{panel ? "▴" : "▾"}</span>
            </button>
            {panel && <div className="mb-8 rounded-lg border p-4 lg:hidden">{aside}</div>}
            <textarea
              aria-label="Title"
              rows={1}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={cn(serif, "field-sizing-content w-full resize-none bg-transparent text-[28px] leading-tight font-semibold outline-none md:text-[32px]")}
            />
            {existing ? (
              <p className={cn(serif, "mt-6 text-[19px] leading-[1.7]")}>{existing.excerpt}</p>
            ) : (
              <div
                role="textbox"
                aria-multiline
                aria-label="Body"
                contentEditable
                suppressContentEditableWarning
                data-placeholder="Your first sentence."
                className={cn(
                  serif,
                  "mt-6 min-h-[40vh] text-[19px] leading-[1.7] outline-none empty:before:text-muted-foreground/60 empty:before:content-[attr(data-placeholder)]",
                )}
              />
            )}
          </div>
        </main>
        <aside className="hidden w-[320px] shrink-0 overflow-auto border-l px-5 py-6 lg:block" aria-label="Idea beside the draft">
          {aside}
        </aside>
      </div>
      {status}
    </div>
  );
}

export function DiscussView({ idea, model }: { idea: Idea; model: IdeasModel }) {
  const prompts = ["What's the strongest counterexample?", "Which clip is weakest?", "Is this one essay or two?"];
  const [text, setText] = useState("");
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <BackBar onBack={model.back}>Discuss</BackBar>
      <div className="mx-auto flex w-full max-w-[640px] min-h-0 flex-1 flex-col px-5 pb-5">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <KinAvatar className="size-9" />
          <p className="max-w-sm text-sm text-muted-foreground">
            Kin has the idea, its reasons and its {unique(idea.clips).length} clips. It won't write the piece; ask it to push back.
          </p>
          <div className="flex flex-wrap justify-center gap-1.5 pt-2">
            {prompts.map((p) => (
              <button key={p} type="button" onClick={() => setText(p)} className="rounded-full border px-3 py-1 text-xs hover:bg-muted">
                {p}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-xl border p-2.5">
          <div className="flex flex-wrap gap-1.5 pb-2">
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs">
              <span className="text-muted-foreground">Idea</span>
              <span className="truncate">{idea.title}</span>
              <button type="button" aria-label="Remove idea from context" className="text-muted-foreground hover:text-foreground">×</button>
            </span>
          </div>
          <textarea
            aria-label="Message Kin"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask Kin about this idea"
            className="w-full resize-none bg-transparent px-1 text-sm outline-none"
          />
        </div>
      </div>
    </div>
  );
}

/** Shared routing: adopted drafts and discussion look the same in every variant. */
export function Routed({ model, children }: { model: IdeasModel; children: ReactNode }) {
  const r = model.state.route;
  if (r.view === "draft") {
    const idea = model.byId(r.id);
    if (idea) return <DraftView idea={idea} attachTo={r.attachTo} model={model} />;
  }
  if (r.view === "discuss") {
    const idea = model.byId(r.id);
    if (idea) return <DiscussView idea={idea} model={model} />;
  }
  return (
    <>
      {children}
      <Notice model={model} />
    </>
  );
}
