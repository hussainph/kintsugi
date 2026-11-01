/**
 * KI-22's A · Ledger: one quiet column. Today's ideas are numbered, each a
 * serif title and one muted line; a row opens in place so the rest of the
 * batch stays in view. Kin's name appears once, at the head of the batch.
 *
 * This file is the only layout-specific part of Ideas. To try Desk or
 * Letter instead, write a sibling that renders the same `IdeasModel` with
 * the pieces in `parts.tsx`, and swap it in `Ideas.tsx`.
 */
import { cn } from "@kintsugi/ui/lib/utils";
import type { Listed } from "./api";
import { count, opacity } from "./model";
import { AskForMore, Detail, DismissedRow, FadedList, JobLine, KinMark, Label, serif, Status } from "./parts";
import type { IdeasModel } from "./useIdeas";

function Row({ idea, model, n, onOpenDoc }: { idea: Listed; model: IdeasModel; n: number; onOpenDoc: (path: string) => void }) {
  if (idea.dismissed)
    return (
      <li className="py-3.5 pl-8 md:pl-9">
        <DismissedRow idea={idea} model={model} />
      </li>
    );
  const open = model.state.open === idea.id;
  return (
    <li style={open ? undefined : { opacity: opacity(idea) }} data-idea={idea.id} data-stage={idea.stage} data-adopted={idea.adopted ? "" : undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => model.toggle(idea.id)}
        className="grid w-full grid-cols-[1.5rem_1fr] gap-x-2 py-4 text-left md:grid-cols-[1.5rem_1fr_auto] md:gap-x-3"
      >
        <span className="pt-1 text-xs text-muted-foreground tabular-nums">{n}</span>
        <span className="min-w-0 space-y-1">
          <span className={cn(serif, "block text-[17px] leading-snug")}>{idea.title}</span>
          {!open && <span className="block truncate text-sm text-muted-foreground">{idea.snippet}</span>}
          <Status idea={idea} className="block md:hidden" />
        </span>
        <Status idea={idea} className="hidden pt-1 md:block" />
      </button>
      {open && (
        <div className="pb-8 pl-8 md:pl-9">
          <Detail idea={idea} model={model} onOpenDoc={onOpenDoc} />
        </div>
      )}
    </li>
  );
}

export function Ledger({ model, onOpenDoc, filterTitle }: { model: IdeasModel; onOpenDoc: (path: string) => void; filterTitle?: string }) {
  const { today, earlier } = model.groups;
  const live = today.filter((i) => !i.dismissed).length;
  return (
    <div className="mx-auto max-w-[680px] px-5 pt-14 pb-16 md:px-6">
      <header className="mb-8 space-y-2">
        <h1 className={cn(serif, "text-[28px] leading-tight font-semibold")}>{model.filter ? "Ideas for this draft" : "Ideas"}</h1>
        {model.filter ? (
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            <span className="truncate">{filterTitle ?? model.filter}</span>
            <button type="button" onClick={model.clearFilter} className="underline underline-offset-2 hover:text-foreground">
              Show all ideas
            </button>
          </p>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              <KinMark>
                {live ? `${count(live)} from Kin today` : "Nothing new from Kin today"} · {model.view?.today ?? ""}
              </KinMark>
            </p>
            <p className="text-sm text-muted-foreground">Ignore any of them. Unused ideas fade after a week.</p>
          </>
        )}
        <JobLine model={model} />
        {model.error && (
          <p role="alert" className="text-sm text-destructive">
            {model.error}
          </p>
        )}
      </header>

      {model.view && model.total === 0 && !model.busy && (
        <div className="space-y-2 border-y py-10 text-center">
          <p className={cn(serif, "text-xl")}>{model.filter ? "No ideas about this draft yet." : "No ideas yet."}</p>
          <p className="text-sm text-muted-foreground">
            {model.filter
              ? "Kin can look through your writing and collection for what bears on it."
              : "Kin offers a few each day, grounded in your writing and what you've saved."}
          </p>
        </div>
      )}

      {today.length > 0 && (
        <ol className="divide-y border-y" aria-label="Today">
          {today.map((idea, i) => (
            <Row key={idea.id} idea={idea} model={model} n={i + 1} onOpenDoc={onOpenDoc} />
          ))}
        </ol>
      )}
      {earlier.length > 0 && (
        <>
          <Label className="mt-10 mb-1">{today.length ? "Earlier" : "This week"}</Label>
          <ol className="divide-y border-y" aria-label="Earlier">
            {earlier.map((idea, i) => (
              <Row key={idea.id} idea={idea} model={model} n={today.length + i + 1} onOpenDoc={onOpenDoc} />
            ))}
          </ol>
        </>
      )}
      <div className="mt-6 space-y-6">
        <FadedList model={model} />
        <AskForMore model={model} />
      </div>
    </div>
  );
}
