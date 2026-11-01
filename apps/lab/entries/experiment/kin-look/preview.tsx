import { useState, type ReactNode } from "react";
import { KinAvatar } from "@/kin/Avatar";
import {
  KinMark,
  directionNames,
  directions,
  expressions,
  forms,
  glazeKeys,
  glazes,
  stateNames,
  states,
  type Direction,
  type Expression,
  type Form,
  type Glaze,
  type KinState,
  type MarkProps,
} from "./marks";

export type Look = Pick<MarkProps, "glaze" | "form" | "seed" | "expression"> & {
  direction: Direction;
  reducedMotion: boolean;
};

const notes: Record<Direction, { why: string; risk: string }> = {
  seam: {
    why: "The product's own metaphor in one line of gold across a glazed bowl. Each seam is seeded, so every Kin breaks its own way and is yours.",
    risk: "A single line has to carry every state; the glint and the bead do that work.",
  },
  shards: {
    why: "Three mended pieces: fragments joined by gold, which is literally what Kin does. Thinking lets the pieces breathe apart.",
    risk: "Busier at 16px, and the motion reads as 'breaking' if pushed.",
  },
  orb: {
    why: "Calm and abstract, a glazed pearl with a gold rim light. Familiar from assistants.",
    risk: "Generic: close to every AI orb on the market and carries little of Kintsugi.",
  },
  portrait: {
    why: "Notion-style ink drawing, with a mended cheek. Warm, and expressions are easy to customize.",
    risk: "A face invites persona and mascot. Illegible at nav size; it fights 'helps, never ghostwrites'.",
  },
  monogram: {
    why: "A lowercase k whose leg is the gold repair. Typographic and quiet.",
    risk: "A letter is a logo, not a presence; states feel bolted on.",
  },
};

export function Themed({ theme, children, className = "" }: { theme: "light" | "dark"; children: ReactNode; className?: string }) {
  return (
    <div className={theme === "dark" ? "dark h-full" : "h-full"}>
      <div className={`h-full bg-background text-foreground ${className}`} data-theme-panel={theme}>
        {children}
      </div>
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{children}</p>;
}

/** Story: five directions side by side, every state, light and dark. */
export function DirectionsStory({ look }: { look: Look }) {
  return (
    <div className="grid gap-px bg-border xl:grid-cols-2" aria-label="Kin directions">
      {(["light", "dark"] as const).map((theme) => (
        <Themed key={theme} theme={theme} className="space-y-1 p-6">
          <Caption>{theme}</Caption>
          <div className="grid grid-cols-[minmax(0,1.3fr)_repeat(4,56px)_44px] items-center gap-x-3 gap-y-5 pt-3">
            <span />
            {states.map((s) => (
              <span key={s} className="text-center text-[10px] leading-tight text-muted-foreground">
                {stateNames[s]}
              </span>
            ))}
            <span className="text-center text-[10px] text-muted-foreground">nav</span>
            {directions.map((direction) => (
              <Row key={direction} direction={direction} look={look} />
            ))}
            <div className="min-w-0">
              <p className="text-sm font-medium">Current placeholder</p>
              <p className="text-xs text-muted-foreground">KI-31's bowl with one seam, for reference.</p>
            </div>
            {states.map((s) => (
              <div key={s} className="grid place-items-center">
                <KinAvatar className="size-10" talking={s === "thinking"} />
              </div>
            ))}
            <div className="grid place-items-center">
              <KinAvatar className="size-[18px]" />
            </div>
          </div>
        </Themed>
      ))}
    </div>
  );
}

function Row({ direction, look }: { direction: Direction; look: Look }) {
  return (
    <>
      <div className="min-w-0" data-direction={direction}>
        <p className="text-sm font-medium">
          {directionNames[direction]}
          {direction === "seam" && (
            <span className="ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-normal" style={{ background: "var(--kin-wash)", color: "var(--kin-ink)" }}>
              recommended
            </span>
          )}
        </p>
        <p className="text-xs leading-snug text-muted-foreground">{notes[direction].why}</p>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground/80">Risk: {notes[direction].risk}</p>
      </div>
      {states.map((s) => (
        <div key={s} className="grid place-items-center">
          <KinMark {...look} direction={direction} state={s} size={40} label={`${directionNames[direction]}, ${stateNames[s]}`} />
        </div>
      ))}
      <div className="grid place-items-center">
        <KinMark {...look} direction={direction} size={18} />
      </div>
    </>
  );
}

const stateMeaning: Record<KinState, string> = {
  idle: "Present, quiet. Nothing moves.",
  thinking: "A glint of light travels the seam while Kin works. Reduced motion: the seam is half drawn, still being mended.",
  "has-something": "A drop of gold settles on the rim: a reply, a finished helper, an idea. No count, no bounce.",
  listening: "A gold ring breathes around the mark while you type or speak; Kin waits for the burst to finish.",
};

/** Story: one direction large, each state with its motion and its still form. */
export function StatesStory({ look }: { look: Look }) {
  return (
    <div className="grid gap-px bg-border md:grid-cols-2">
      {(["light", "dark"] as const).map((theme) => (
        <Themed key={theme} theme={theme} className="space-y-6 p-6">
          <Caption>
            {directionNames[look.direction]} · {theme}
          </Caption>
          {states.map((s) => (
            <div key={s} className="flex items-center gap-5" data-state={s}>
              <KinMark {...look} state={s} size={88} label={stateNames[s]} />
              <div className="flex shrink-0 items-center gap-3">
                <KinMark {...look} state={s} size={40} />
                <KinMark {...look} state={s} size={24} />
                <KinMark {...look} state={s} size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium">{stateNames[s]}</p>
                <p className="text-xs leading-snug text-muted-foreground">{stateMeaning[s]}</p>
                <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <KinMark {...look} state={s} size={24} reducedMotion />
                  still form (reduced motion)
                </div>
              </div>
            </div>
          ))}
        </Themed>
      ))}
    </div>
  );
}

function MentionChip({ look }: { look: Look }) {
  return (
    <span
      className="mx-0.5 inline-flex items-center gap-1 rounded-full py-px pr-2 pl-0.5 align-[-0.1em] font-sans text-[0.78em] font-medium"
      style={{ background: "var(--kin-wash)", color: "var(--kin-ink)", boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--kin) 35%, transparent)" }}
      data-kin-mention
    >
      <KinMark {...look} size={15} />
      Kin
    </span>
  );
}

function KinSigned({ look, children, state = "idle" }: { look: Look; children?: ReactNode; state?: KinState }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium" style={{ color: "var(--kin-ink)" }}>
      <KinMark {...look} size={14} state={state} />
      {children ?? "Kin"}
    </span>
  );
}

function Sidebar({ look, state }: { look: Look; state: KinState }) {
  return (
    <aside className="flex w-48 shrink-0 flex-col gap-0.5 border-r bg-sidebar p-2 text-sm text-sidebar-foreground">
      <p className="px-2 py-1.5 font-medium">Kintsugi</p>
      {["Feed", "Inspiration", "Ideas", "Writing"].map((p) => (
        <span key={p} className={`rounded-md px-2 py-1 ${p === "Writing" ? "bg-sidebar-accent" : ""}`}>
          {p}
        </span>
      ))}
      <div className="mt-auto flex items-center gap-2 rounded-md px-2 py-1.5" data-size="nav">
        <KinMark {...look} size={18} state={state} />
        <span>Your Kin</span>
        <span className="ml-auto text-[10px] text-muted-foreground">⌘J</span>
      </div>
    </aside>
  );
}

function ChatHeader({ look, state }: { look: Look; state: KinState }) {
  return (
    <header className="flex items-center gap-2 border-b px-3 py-2" data-size="chat-header">
      <KinMark {...look} size={24} state={state} label={`Kin, ${stateNames[state]}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">On craft and repair</p>
        <p className="truncate text-[11px] text-muted-foreground">{state === "thinking" ? "Reading 3 clips…" : state === "listening" ? "Listening…" : "Your Kin"}</p>
      </div>
    </header>
  );
}

function Phone({ look, state }: { look: Look; state: KinState }) {
  return (
    <div className="w-[300px] shrink-0 overflow-hidden rounded-[2.2rem] border-[6px] border-foreground/85 bg-background shadow-lg" data-size="phone">
      <div className="flex items-center justify-between px-6 pt-3 pb-1 text-[11px] font-medium">
        <span>9:41</span>
        <span className="h-4 w-16 rounded-full bg-foreground/85" />
        <span>100%</span>
      </div>
      <div className="space-y-3 px-5 pt-4 pb-6" style={{ fontFamily: "var(--font-prose)" }}>
        <p className="text-xl">Things that mend</p>
        <p className="text-[15px] leading-relaxed">
          The crack is the record of what happened to it. Ask <MentionChip look={look} /> what I saved about this last spring.
        </p>
      </div>
      <div className="mx-3 mb-3 rounded-2xl border bg-card p-3 font-sans">
        <div className="flex items-center gap-2">
          <KinMark {...look} size={28} state={state} />
          <p className="text-sm">Kin</p>
          <span className="ml-auto text-[11px] text-muted-foreground">Mac reachable</span>
        </div>
        <p className="kin-made mt-2 text-[13px] leading-snug">Two clips from April: Bartlett on visible repair, and your note on the Hokusai bowl.</p>
      </div>
      <nav className="flex items-center justify-around border-t px-4 pt-2 pb-5 text-[10px] text-muted-foreground">
        {["Feed", "Library", "Ideas", "Write"].map((t) => (
          <span key={t}>{t}</span>
        ))}
        <span className="grid place-items-center gap-0.5" style={{ color: "var(--kin-ink)" }}>
          <KinMark {...look} size={26} state={state} />
          Kin
        </span>
      </nav>
    </div>
  );
}

/** Story: every size Kin appears at, in context. */
export function SizesStory({ look, state }: { look: Look; state: KinState }) {
  return (
    <div className="grid gap-px bg-border">
      {(["light", "dark"] as const).map((theme) => (
        <Themed key={theme} theme={theme} className="flex flex-wrap items-start gap-6 p-6">
          <div className="flex min-w-[560px] flex-1 overflow-hidden rounded-xl border">
            <Sidebar look={look} state={state} />
            <div className="relative min-h-[340px] flex-1 p-6" style={{ fontFamily: "var(--font-prose)" }}>
              <p className="text-2xl">On craft and repair</p>
              <p className="mt-3 max-w-prose text-[17px] leading-relaxed">
                A mended bowl doesn't hide the break. <MentionChip look={look} /> which of my posts argued the opposite?
              </p>
              <div className="kin-made mt-4 max-w-sm rounded-r-md py-1 font-sans" data-kin-comment>
                <KinSigned look={look} state={state === "has-something" ? "idle" : state} />
                <p className="mt-1 text-[13px] leading-snug">“Against seamless” (March) says the opposite in its second section.</p>
              </div>
              <button
                type="button"
                className="absolute right-4 bottom-4 grid size-11 place-items-center rounded-full bg-background shadow-md ring-1 ring-foreground/10"
                aria-label="Open Kin"
                data-size="floating"
              >
                <KinMark {...look} size={40} state={state} />
              </button>
            </div>
          </div>
          <div className="w-[300px] overflow-hidden rounded-xl border bg-popover">
            <ChatHeader look={look} state={state} />
            <div className="space-y-3 p-3 text-sm">
              <p className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3 py-2">What did I save about repair?</p>
              <div className="flex gap-2">
                <KinMark {...look} size={20} />
                <p className="kin-made text-[13px] leading-snug">Seven clips. The strongest two disagree about whether the seam should be seen.</p>
              </div>
            </div>
          </div>
          <Phone look={look} state={state} />
        </Themed>
      ))}
    </div>
  );
}

/** Story: what marks anything Kin produced, in one colour. */
export function MadeByKinStory({ look }: { look: Look }) {
  return (
    <div className="grid gap-px bg-border md:grid-cols-2">
      {(["light", "dark"] as const).map((theme) => (
        <Themed key={theme} theme={theme} className="space-y-5 p-6">
          <Caption>Kin gold · {theme}</Caption>
          <div className="flex items-center gap-3">
            <span className="size-8 rounded-full" style={{ background: "var(--kin)" }} />
            <span className="size-8 rounded-full" style={{ background: "var(--kin-ink)" }} />
            <span className="size-8 rounded-full ring-1 ring-border" style={{ background: "var(--kin-wash)" }} />
            <p className="text-xs text-muted-foreground">
              <code>--kin</code> marks · <code>--kin-ink</code> text · <code>--kin-wash</code> fills. Gold appears nowhere else in the app.
            </p>
          </div>
          <section className="space-y-1">
            <Caption>Chat reply</Caption>
            <div className="kin-made text-sm leading-relaxed">
              <KinSigned look={look} />
              <p>Your March post and this clip disagree about the seam. Want the two passages side by side?</p>
            </div>
          </section>
          <section className="space-y-1">
            <Caption>Comment thread on a paragraph</Caption>
            <div className="rounded-lg border p-3">
              <p className="text-[15px] leading-relaxed" style={{ fontFamily: "var(--font-prose)" }}>
                The crack is the record of what happened to it.
              </p>
              <div className="kin-made mt-2 text-[13px]">
                <KinSigned look={look}>Kin · comment</KinSigned>
                <p>Bartlett makes the same point with the opposite conclusion. Worth a counterexample?</p>
              </div>
            </div>
          </section>
          <section className="space-y-1">
            <Caption>Edit you asked for (⌘K), until accepted</Caption>
            <p className="text-[15px] leading-relaxed" style={{ fontFamily: "var(--font-prose)" }}>
              Repair is <span className="kin-suggested">a kind of attention</span>, not a cover-up.
            </p>
          </section>
          <section className="space-y-1">
            <Caption>Machine-made text on a clip, and an idea</Caption>
            <div className="rounded-lg border p-3 text-[13px]">
              <p className="font-medium">The beauty of repair</p>
              <div className="kin-made mt-1.5">
                <KinSigned look={look}>Summary by Kin</KinSigned>
                <p className="text-muted-foreground">Kintsugi treats breakage as part of an object's history, not something to disguise.</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg border p-3 text-[13px]">
              <KinMark {...look} size={16} state="has-something" />
              <p className="min-w-0 flex-1 truncate">You've saved seven things about repair and never written about it.</p>
              <span className="text-[11px]" style={{ color: "var(--kin-ink)" }}>Idea</span>
            </div>
          </section>
        </Themed>
      ))}
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange, names }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void; names?: Record<string, string> }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs text-muted-foreground">{label}</legend>
      <div className="inline-flex rounded-lg bg-muted p-0.5" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={value === o}
            onClick={() => onChange(o)}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors duration-150 ${value === o ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            {names?.[o] ?? o[0].toUpperCase() + o.slice(1)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Story: the owner's settings panel, "Your Kin". Interactive; starts from the Lab controls. */
export function CustomizeStory({ initial }: { initial: Look }) {
  const [look, setLook] = useState(initial);
  const [preview, setPreview] = useState<KinState>("idle");
  const set = (patch: Partial<Look>) => setLook((l) => ({ ...l, ...patch }));
  const usesForm = look.direction !== "orb" && look.direction !== "portrait";
  const usesSeed = look.direction === "seam" || look.direction === "shards";
  return (
    <div className="grid gap-px bg-border lg:grid-cols-[minmax(0,1fr)_320px]">
      <Themed theme="light" className="p-6">
        <Panel look={look} set={set} preview={preview} setPreview={setPreview} usesForm={usesForm} usesSeed={usesSeed} />
      </Themed>
      <Themed theme="dark" className="flex flex-col items-center gap-5 p-6">
        <Caption>Same Kin, dark</Caption>
        <KinMark {...look} size={96} state={preview} />
        <div className="flex items-end gap-4">
          <KinMark {...look} size={40} state={preview} />
          <KinMark {...look} size={24} state={preview} />
          <KinMark {...look} size={18} state={preview} />
          <MentionChip look={look} />
        </div>
      </Themed>
    </div>
  );
}

function Panel({ look, set, preview, setPreview, usesForm, usesSeed }: { look: Look; set: (p: Partial<Look>) => void; preview: KinState; setPreview: (s: KinState) => void; usesForm: boolean; usesSeed: boolean }) {
  return (
    <section className="mx-auto max-w-xl space-y-6" aria-label="Your Kin settings">
      <div>
        <h2 className="text-lg font-medium">Your Kin</h2>
        <p className="text-sm text-muted-foreground">How Kin looks on every screen. Gold always means Kin, so it stays gold.</p>
      </div>
      <div className="flex items-center gap-6 rounded-xl border p-5">
        <KinMark {...look} size={96} state={preview} label="Your Kin" />
        <div className="space-y-3">
          <div className="flex items-end gap-4">
            <KinMark {...look} size={40} state={preview} />
            <KinMark {...look} size={24} state={preview} />
            <KinMark {...look} size={18} state={preview} />
          </div>
          <Segmented label="Preview state" value={preview} options={states} onChange={setPreview} names={{ "has-something": "Has something for you" }} />
        </div>
      </div>
      <Segmented label="Style" value={look.direction} options={directions} onChange={(direction) => set({ direction })} names={directionNames} />
      <fieldset className="space-y-1.5">
        <legend className="text-xs text-muted-foreground">Glaze</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Glaze">
          {glazeKeys.map((g) => (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={look.glaze === g}
              aria-label={glazes[g].name}
              title={glazes[g].name}
              onClick={() => set({ glaze: g })}
              className={`size-8 rounded-full ring-1 ring-foreground/15 ring-offset-2 ring-offset-background transition-shadow duration-150 ${look.glaze === g ? "ring-2 ring-foreground/70" : ""}`}
              style={{ background: `radial-gradient(circle at 34% 28%, ${glazes[g].hi}, ${glazes[g].body} 65%)` }}
            />
          ))}
          <span className="ml-1 self-center text-xs text-muted-foreground">{glazes[look.glaze ?? "ink"].name}</span>
        </div>
      </fieldset>
      {usesForm && <Segmented<Form> label="Form" value={look.form ?? "round"} options={forms} onChange={(form) => set({ form })} />}
      {look.direction === "portrait" && <Segmented<Expression> label="Expression at rest" value={look.expression ?? "calm"} options={expressions} onChange={(expression) => set({ expression })} />}
      {usesSeed && (
        <div className="flex items-center gap-3">
          <button type="button" className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted" onClick={() => set({ seed: ((look.seed ?? 1) * 48271) % 9973 })}>
            Break anew
          </button>
          <p className="text-xs text-muted-foreground">
            Seam no. {String(look.seed).padStart(4, "0")}. Every Kin breaks its own way; keep the one you like.
          </p>
        </div>
      )}
      <Segmented<"calm" | "still"> label="Motion" value={look.reducedMotion ? "still" : "calm"} options={["calm", "still"]} onChange={(m) => set({ reducedMotion: m === "still" })} />
    </section>
  );
}

export function lookFrom(values: Record<string, unknown>, reducedMotion: boolean): Look {
  return {
    direction: values.direction as Direction,
    glaze: values.glaze as Glaze,
    form: values.form as Form,
    seed: Number(values.seed),
    expression: values.expression as Expression,
    reducedMotion,
  };
}
