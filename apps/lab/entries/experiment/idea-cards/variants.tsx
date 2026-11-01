import { cn } from "@kintsugi/ui/lib/utils";
import { KinAvatar } from "@/kin/Avatar";
import { TODAY, ideas as fixtureIdeas, type Idea } from "./fixtures";
import { useIdeas, type IdeasModel, type IdeasState } from "./model";
import {
  Actions,
  AdoptChooser,
  Status,
  Detail,
  DismissedRow,
  Evidence,
  FadedList,
  fade,
  Frame,
  HowIGotHere,
  Hunch,
  KinMark,
  Label,
  Observed,
  RefineBox,
  Routed,
  serif,
  useOpenClip,
  WhyThis,
} from "./parts";

export type Layout = "ledger" | "desk" | "letter";

const count = (n: number) =>
  ["No", "One", "Two", "Three", "Four", "Five", "Six"][n] ?? String(n);

/* ------------------------------------------------------------------------ */
/* A · Ledger — one quiet column; a row opens in place.                     */

function LedgerRow({ idea, model, n }: { idea: Idea; model: IdeasModel; n: number }) {
  const { onOpen, status } = useOpenClip();
  if (model.isDismissed(idea.id))
    return (
      <li className="py-3.5 pl-8 md:pl-9">
        <DismissedRow idea={idea} model={model} />
      </li>
    );
  const open = model.state.open === idea.id;
  return (
    <li style={open ? undefined : fade(idea, model)}>
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
          <Status idea={idea} model={model} className="block md:hidden" />
        </span>
        <Status idea={idea} model={model} className="hidden pt-1 md:block" />
      </button>
      {open && (
        <div className="pb-8 pl-8 md:pl-9">
          <Detail idea={idea} model={model} onOpen={onOpen} />
        </div>
      )}
      {status}
    </li>
  );
}

function Ledger({ model }: { model: IdeasModel }) {
  return (
    <div className="mx-auto max-w-[680px] px-5 py-8 md:px-6 md:py-14">
      <header className="mb-8 space-y-2">
        <h1 className={cn(serif, "text-[28px] leading-tight font-semibold")}>Ideas</h1>
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <KinMark>
            {count(model.today.length)} from Kin · {TODAY}
          </KinMark>
        </p>
        <p className="text-sm text-muted-foreground">Ignore any of them. Unused ideas fade after a week.</p>
      </header>
      <ol className="divide-y border-y">
        {model.today.map((idea, i) => (
          <LedgerRow key={idea.id} idea={idea} model={model} n={i + 1} />
        ))}
      </ol>
      {model.earlier.length > 0 && (
        <>
          <Label className="mt-10 mb-1">Earlier this week</Label>
          <ol className="divide-y border-b">
            {model.earlier.map((idea, i) => (
              <LedgerRow key={idea.id} idea={idea} model={model} n={model.today.length + i + 1} />
            ))}
          </ol>
        </>
      )}
      <div className="mt-6">
        <FadedList model={model} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* B · Desk — a list beside a reading page; phone pushes the page.           */

function DeskCard({ idea, model }: { idea: Idea; model: IdeasModel }) {
  const open = model.state.open === idea.id;
  return (
    <button
      type="button"
      aria-current={open || undefined}
      onClick={() => model.toggle(idea.id)}
      style={fade(idea, model)}
      className={cn(
        "w-full space-y-1.5 rounded-lg px-3 py-3 text-left transition-colors motion-reduce:transition-none",
        open ? "bg-muted" : "hover:bg-muted/60",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <KinMark size="xs">Kin · {idea.kind}</KinMark>
        <Status idea={idea} model={model} />
      </span>
      <span className="block text-sm leading-snug font-medium">{idea.title}</span>
      <span className="block truncate text-xs text-muted-foreground">{idea.snippet}</span>
    </button>
  );
}

function Desk({ model }: { model: IdeasModel }) {
  const { onOpen, status } = useOpenClip();
  const idea = model.byId(model.state.open);
  return (
    <div className="flex h-svh min-h-0">
      <nav
        aria-label="Today's ideas"
        className={cn(
          "w-full shrink-0 overflow-auto px-3 py-5 md:block md:w-[330px] md:border-r",
          idea && "hidden",
        )}
      >
        <header className="mb-4 space-y-1 px-3">
          <h1 className="text-base font-semibold">Ideas</h1>
          <p className="text-xs text-muted-foreground">
            {count(model.today.length)} today · unused ones fade after a week
          </p>
        </header>
        {[
          { label: "Today", list: model.today },
          { label: "Earlier this week", list: model.earlier },
        ].map(({ label, list }) =>
          list.length ? (
            <section key={label} className="mb-4">
              <Label className="mb-1 px-3">{label}</Label>
              <ul className="space-y-0.5">
                {list.map((i) => (
                  <li key={i.id}>
                    {model.isDismissed(i.id) ? (
                      <DismissedRow idea={i} model={model} className="px-3 py-3" />
                    ) : (
                      <DeskCard idea={i} model={model} />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null,
        )}
        <div className="mt-5 px-3">
          <FadedList model={model} />
        </div>
      </nav>
      <main className={cn("min-w-0 flex-1 overflow-auto", !idea && "hidden md:block")}>
        {idea ? (
          <article className="mx-auto max-w-[760px] px-5 py-6 md:px-10 md:py-12">
            <button
              type="button"
              onClick={model.close}
              className="mb-6 text-sm text-muted-foreground hover:text-foreground md:hidden"
            >
              ‹ Ideas
            </button>
            <p className="mb-2 flex items-center gap-2">
              <KinMark size="xs">Kin · {idea.kind}</KinMark>
              <Status idea={idea} model={model} />
            </p>
            <h2 className={cn(serif, "mb-8 text-2xl leading-tight font-semibold md:text-[28px]")}>{idea.title}</h2>
            <Detail idea={idea} model={model} onOpen={onOpen} sideBySide gridClips />
          </article>
        ) : (
          <div className="flex h-full items-center justify-center p-10">
            <p className="max-w-xs text-center text-sm text-muted-foreground">
              Open an idea to see what Kin noticed and why. Or leave them; they'll fade on their own.
            </p>
          </div>
        )}
      </main>
      {status}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* C · Letter — Kin's batch as a short dated note; detail unfolds in stages. */

function LetterItem({ idea, model, index, quiet = false }: { idea: Idea; model: IdeasModel; index: number; quiet?: boolean }) {
  const { onOpen, status } = useOpenClip();
  const open = model.state.open === idea.id;
  const deep = model.state.whyOpen === `${idea.id}#evidence`;
  return (
    <li className="group" style={open ? undefined : fade(idea, model)}>
      <button type="button" aria-expanded={open} onClick={() => model.toggle(idea.id)} className="w-full text-left">
        <span className={cn(serif, "line-clamp-2 leading-relaxed", quiet ? "text-base" : "text-[18px]")}>
          <span className="text-muted-foreground tabular-nums">{index + 1}. </span>
          <span className="underline decoration-transparent underline-offset-4 group-hover:decoration-[var(--seam)]">
            {idea.title}.
          </span>{" "}
          {!open && <span className="text-muted-foreground">{idea.snippet}</span>}
        </span>
        {!open && <Status idea={idea} model={model} className="mt-0.5 block" />}
      </button>
      {open && (
        <div className="mt-4 mb-2 space-y-5 md:ml-5">
          <div className="grid gap-5 rounded-lg bg-muted/50 p-4 md:grid-cols-[1fr_1.2fr] md:gap-6">
            <Observed idea={idea} />
            <Hunch idea={idea} signed={false} />
          </div>
          {deep ? (
            <Evidence idea={idea} onOpen={onOpen} />
          ) : (
            <button
              type="button"
              onClick={() => model.toggleWhy(`${idea.id}#evidence`)}
              className="text-sm text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
            >
              Show the {idea.clips.length} clips this rests on
            </button>
          )}
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <HowIGotHere idea={idea} />
            <WhyThis idea={idea} model={model} />
          </div>
          <Actions idea={idea} model={model} />
          <AdoptChooser idea={idea} model={model} />
          <RefineBox idea={idea} model={model} />
        </div>
      )}
      {status}
    </li>
  );
}

function Letter({ model }: { model: IdeasModel }) {
  return (
    <div className="px-0 py-0 md:px-6 md:py-12">
      <article className="mx-auto max-w-[640px] px-5 py-8 md:rounded-xl md:border md:bg-card md:px-12 md:py-12 md:shadow-xs">
        <header className="mb-7 flex items-center gap-3">
          <KinAvatar className="size-8" />
          <div className="leading-tight">
            <p className="text-sm font-medium">From Kin</p>
            <p className="text-xs text-muted-foreground">{TODAY}</p>
          </div>
        </header>
        <p className={cn(serif, "mb-6 text-[18px] leading-relaxed")}>
          {count(model.today.length)} things I noticed in your writing and saves. Take any, or none.
        </p>
        <ol className="space-y-4">
          {model.today.map((idea, index) =>
            model.isDismissed(idea.id) ? (
              <li key={idea.id}>
                <DismissedRow idea={idea} model={model} />
              </li>
            ) : (
              <LetterItem key={idea.id} idea={idea} model={model} index={index} />
            ),
          )}
        </ol>
        <p className={cn(serif, "mt-6 text-muted-foreground")}>— Kin</p>
        <footer className="mt-8 space-y-4 border-t pt-5">
          <Label>Still open from earlier this week</Label>
          <ol className="space-y-3">
            {model.earlier.map((idea, index) =>
              model.isDismissed(idea.id) ? (
                <li key={idea.id}>
                  <DismissedRow idea={idea} model={model} />
                </li>
              ) : (
                <LetterItem key={idea.id} idea={idea} model={model} index={model.today.length + index} quiet />
              ),
            )}
          </ol>
          <FadedList model={model} />
        </footer>
      </article>
    </div>
  );
}

export function IdeasStudy({ layout, initial }: { layout: Layout; initial?: Partial<IdeasState> }) {
  const model = useIdeas(initial);
  const View = layout === "desk" ? Desk : layout === "letter" ? Letter : Ledger;
  return (
    <Frame label={`Ideas, ${layout} variant`}>
      <Routed model={model}>
        <View model={model} />
      </Routed>
    </Frame>
  );
}

/* ------------------------------------------------------------------------ */
/* Kin on a card: the same idea in three identity treatments.               */

export function IdentityStudy() {
  const idea = fixtureIdeas[0];
  const treatments = [
    {
      id: "batch",
      title: "Signed once, per batch",
      note: "The section says it's Kin's. Cards carry no avatar; the gold seam marks the hunch.",
      card: (
        <div className="space-y-3">
          <KinMark>Five from Kin · today</KinMark>
          <div className="border-t pt-3">
            <p className={cn(serif, "text-[17px] leading-snug")}>{idea.title}</p>
            <p className="truncate text-sm text-muted-foreground">{idea.snippet}</p>
          </div>
        </div>
      ),
    },
    {
      id: "byline",
      title: "A byline on every card",
      note: "Each card says who noticed it and what kind of noticing. Clear, but repeats five times.",
      card: (
        <div className="space-y-1.5">
          <KinMark size="xs">Kin · {idea.kind}</KinMark>
          <p className="text-sm leading-snug font-medium">{idea.title}</p>
          <p className="truncate text-xs text-muted-foreground">{idea.snippet}</p>
        </div>
      ),
    },
    {
      id: "hunch",
      title: "Only on the guess, once opened",
      note: "Facts are unsigned, since they're checkable. Kin appears where it's speculating.",
      card: (
        <div className="space-y-3">
          <p className={cn(serif, "text-[17px] leading-snug")}>{idea.title}</p>
          <Hunch idea={idea} />
        </div>
      ),
    },
  ];
  return (
    <Frame label="Kin on a card">
      <div className="mx-auto max-w-[1100px] space-y-6 px-5 py-8 md:px-8 md:py-12">
        <header className="max-w-2xl space-y-1.5">
          <Label>Placeholder avatar · KI-23 explores the real one</Label>
          <h1 className={cn(serif, "text-2xl font-semibold")}>How Kin shows up on an idea</h1>
        </header>
        <div className="grid gap-4 md:grid-cols-3">
          {treatments.map((t) => (
            <section key={t.id} className="space-y-3">
              <div className="rounded-xl border p-4">{t.card}</div>
              <div className="space-y-0.5 px-1">
                <p className="text-sm font-medium">{t.title}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{t.note}</p>
              </div>
            </section>
          ))}
        </div>
      </div>
    </Frame>
  );
}

