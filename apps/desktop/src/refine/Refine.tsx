import { EditorView } from "@codemirror/view";
import { diffWords } from "diff";
import { Bookmark, Lightbulb, MessageCircle, Search, Sparkles, Swords, Wand2 } from "lucide-react";
import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@kintsugi/ui/components/command";
import { Kbd } from "@kintsugi/ui/components/kbd";
import { Popover, PopoverAnchor, PopoverContent } from "@kintsugi/ui/components/popover";
import { Cancelled, Message, stream } from "@/lib/ai";
import { discuss } from "@/lib/chat";
import { memory, type Skill } from "@/lib/kin";
import { ideasForDraft } from "@/ideas/api";
import { modelFor } from "@/lib/models";
import { passageChips } from "@/kin/screen";
import { cn } from "@kintsugi/ui/lib/utils";
import { Action, ACTIONS, ask, choices, clean } from "./prompts";
import { type Found, KIN_ACTIONS, type KinAction, skillAction, supportingClips, WHO_DISAGREES } from "./kin";

type Props = {
  view: EditorView;
  from: number;
  to: number;
  /** The open document, for Kin's chips and unambiguous links. */
  path: string;
  docs: { path: string; title?: string | null }[];
  /** Start straight away (a skill from the `/` menu) instead of listing actions. */
  initial?: Action;
  onClose: () => void;
};

type Version = { text: string; done: boolean };

/** ⌘K on a selection: pick an edit, see it as a diff, accept or don't.
 *  Nothing reaches the document until the writer presses Enter. Kin's
 *  actions below the edits write nothing: they find clips or open the chat. */
export function Refine({ view, from, to, path, docs, initial, onClose }: Props) {
  const original = view.state.sliceDoc(from, to);
  const [action, setAction] = useState<Action | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [index, setIndex] = useState(0);
  const [choice, setChoice] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [found, setFound] = useState<{ clips: Found[] | null; error?: string } | null>(null);
  const inflight = useRef<{ cancel: () => void } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => inflight.current?.cancel(), []);
  useEffect(() => {
    memory.skills().then((all) => setSkills(all.filter((s) => s.command))).catch(() => {});
  }, []);
  // A skill from the `/` menu runs at once, shown like any other edit.
  const started = useRef(false);
  useEffect(() => {
    if (initial && !started.current) {
      started.current = true;
      void run(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const start = view.coordsAtPos(from);
  const end = view.coordsAtPos(to) ?? start;
  const words = original.trim().split(/\s+/).length;
  const actions = ACTIONS.filter((a) => a.shape !== "choices" || words <= 4);

  const run = async (next: Action, retry = false) => {
    inflight.current?.cancel();
    setAction(next);
    setError(null);
    const slot = retry ? versions.length : 0;
    const previous = retry ? versions.map((v) => v.text) : [];
    setVersions((vs) => [...(retry ? vs : []), { text: "", done: false }]);
    setIndex(slot);
    setChoice(0);
    requestAnimationFrame(() => resultRef.current?.focus());

    const request = ask(next, view.state.doc.toString(), from, to);
    // On a retry, show the model what it already offered so it tries something else.
    for (const text of previous) {
      request.messages.push({ role: "assistant", content: text } satisfies Message);
      request.messages.push({ role: "user", content: "Give me a different version." });
    }
    const update = (text: string, done: boolean) =>
      setVersions((vs) => vs.map((v, i) => (i === slot ? { text, done } : v)));
    try {
      const model = await modelFor("edit");
      const s = stream(model, request, (text) => update(text, false));
      inflight.current = s;
      update(await s.done, true);
    } catch (e) {
      if (!(e instanceof Cancelled)) setError(e instanceof Error ? e.message : String(e));
    }
  };

  const accept = (replacement: string) => {
    if (view.state.sliceDoc(from, to) !== original) {
      toast.error("The text changed while Kintsugi was thinking. Try again.");
      return onClose();
    }
    view.dispatch({
      changes: { from, to, insert: replacement },
      selection: { anchor: from + replacement.length },
      userEvent: "input.refine",
    });
    onClose();
  };

  const kinAction = (a: KinAction) => {
    const chips = passageChips(view, path, from, to);
    if (a.id === "ideas") {
      onClose();
      return ideasForDraft(path);
    }
    if (a.id === "discuss") {
      onClose();
      return discuss(chips);
    }
    if (a.id === "disagrees") {
      onClose();
      return discuss(chips, WHO_DISAGREES, { send: true });
    }
    setFound({ clips: null });
    supportingClips(original, docs).then((clips) => setFound({ clips })).catch((e) => setFound({ clips: [], error: String(e) }));
  };

  /** A reference to a supporting clip, after the passage: his choice, never prose. */
  const reference = (link: string) => {
    if (view.state.sliceDoc(from, to) !== original) {
      toast.error("The text changed. Try again.");
      return onClose();
    }
    // Right after the passage's last word, before any trailing whitespace.
    const at = to - /\s*$/.exec(original)![0].length;
    const insert = ` ${link}`;
    view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: "input.reference" });
    onClose();
  };

  const version = versions[index];
  const options = action?.shape === "choices" && version ? choices(version.text) : [];

  const onResultKey = (e: KeyboardEvent) => {
    const key = e.key;
    if (key === "Enter" && version?.done) {
      e.preventDefault();
      if (action?.shape === "choices") {
        if (options[choice]) accept(options[choice]);
      } else {
        accept(clean(version.text, original));
      }
    } else if (key === "r" && e.metaKey && action) {
      e.preventDefault();
      run(action, true);
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      e.preventDefault();
      setIndex((i) => Math.max(0, Math.min(versions.length - 1, i + (key === "ArrowLeft" ? -1 : 1))));
    } else if (key === "ArrowUp" || key === "ArrowDown") {
      e.preventDefault();
      setChoice((c) => Math.max(0, Math.min(options.length - 1, c + (key === "ArrowUp" ? -1 : 1))));
    } else if (/^[1-6]$/.test(key) && options[Number(key) - 1]) {
      e.preventDefault();
      accept(options[Number(key) - 1]);
    } else if (key === "Backspace") {
      e.preventDefault();
      inflight.current?.cancel();
      setAction(null);
      setVersions([]);
    }
  };

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor asChild>
        <div className="pointer-events-none fixed" style={{ left: start?.left ?? 0, top: end?.bottom ?? 0 }} />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[min(32rem,calc(100vw-2rem))] p-0"
        onOpenAutoFocus={(e) => (action || initial) && e.preventDefault()}
      >
        {found ? (
          <Supporting found={found} onReference={reference} onOpen={(clip) => {
            onClose();
            window.dispatchEvent(new CustomEvent("kintsugi:open-clip", { detail: { path: clip } }));
          }} onBack={() => setFound(null)} />
        ) : !action ? (
          <Command>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Edit the selection, or describe a change…"
              autoFocus
            />
            <CommandList>
              {query.trim() && (
                <CommandGroup>
                  {/* The typed text as an instruction, always offered first. */}
                  <CommandItem
                    forceMount
                    value={`custom ${query}`}
                    onSelect={() => {
                      const instruction = query.trim();
                      run({ id: "custom", label: instruction, shape: "rewrite", instruction });
                    }}
                  >
                    <Sparkles />
                    <span className="truncate">{query.trim()}</span>
                  </CommandItem>
                </CommandGroup>
              )}
              <CommandGroup heading="Edit">
                {actions.map((a) => (
                  <CommandItem key={a.id} value={a.label} onSelect={() => run(a)}>
                    {a.label}
                  </CommandItem>
                ))}
              </CommandGroup>
              {skills.length > 0 && (
                <CommandGroup heading="Skills">
                  {skills.map((skill) => (
                    <CommandItem key={skill.name} value={`skill ${skill.name} ${skill.description}`} onSelect={() => run(skillAction(skill))}>
                      <Wand2 />
                      <span className="truncate">{skill.name}</span>
                      <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">{skill.description}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              <CommandGroup heading="Kin">
                {KIN_ACTIONS.map((a) => {
                  const Icon = a.id === "supporting" ? Search : a.id === "disagrees" ? Swords : a.id === "ideas" ? Lightbulb : MessageCircle;
                  return (
                    <CommandItem key={a.id} value={a.label} onSelect={() => kinAction(a)}>
                      <Icon />
                      <span className="truncate">{a.label}</span>
                      <span className="ml-auto hidden truncate pl-2 text-xs text-muted-foreground sm:inline">{a.hint}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        ) : (
          <div ref={resultRef} tabIndex={-1} onKeyDown={onResultKey} className="outline-none">
            <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
              <Sparkles className="size-3.5" />
              <span className="truncate">{action.label}</span>
              {versions.length > 1 && (
                <span className="ml-auto tabular-nums">
                  {index + 1} / {versions.length}
                </span>
              )}
            </div>
            <div className="max-h-[50vh] overflow-y-auto px-4 py-3 font-[family-name:var(--font-prose)] text-[15px] leading-relaxed">
              {error ? (
                <p className="font-sans text-sm text-destructive">{error}</p>
              ) : !version?.text ? (
                <p className="font-sans text-sm text-muted-foreground">Thinking…</p>
              ) : action.shape === "choices" ? (
                <ol className="space-y-0.5">
                  {options.map((option, i) => (
                    <li key={i}>
                      <button
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-2 py-1 text-left",
                          i === choice && "bg-accent",
                        )}
                        onMouseEnter={() => setChoice(i)}
                        onClick={() => accept(option)}
                      >
                        <Kbd>{i + 1}</Kbd>
                        {option}
                      </button>
                    </li>
                  ))}
                </ol>
              ) : version.done ? (
                <Diff before={original} after={clean(version.text, original)} />
              ) : (
                <p className="whitespace-pre-wrap">{version.text}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
              <span>
                <Kbd>↵</Kbd> accept
              </span>
              <span>
                <Kbd>⌘R</Kbd> another
              </span>
              {versions.length > 1 && (
                <span>
                  <Kbd>←</Kbd>
                  <Kbd>→</Kbd> versions
                </span>
              )}
              <span>
                <Kbd>⌫</Kbd> back
              </span>
              <span className="ml-auto">
                <Kbd>esc</Kbd> discard
              </span>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Clips that share the passage's words. Choosing one adds its [[link]]
 *  after the passage; opening it shows the clip. */
function Supporting({ found, onReference, onOpen, onBack }: {
  found: { clips: Found[] | null; error?: string };
  onReference: (link: string) => void;
  onOpen: (path: string) => void;
  onBack: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus(), []);
  return (
    <Command ref={root} tabIndex={-1} className="outline-none" onKeyDown={(e) => { if (e.key === "Backspace") { e.preventDefault(); onBack(); } }}>
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <Search className="size-3.5" />
        <span>Supporting clips</span>
      </div>
      <CommandList>
        {found.error ? (
          <p className="px-3 py-4 text-sm text-destructive">{found.error}</p>
        ) : !found.clips ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">Searching your clips…</p>
        ) : !found.clips.length ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">No clips share this passage’s words.</p>
        ) : (
          <CommandGroup>
            {found.clips.map(({ source, link }) => (
              <CommandItem key={source.path} value={source.path} onSelect={() => onReference(link)} className="items-start">
                <Bookmark className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{source.title}</span>
                  {(source.site || source.summary) && (
                    <span className="line-clamp-2 text-xs text-muted-foreground">{[source.site, source.summary].filter(Boolean).join(" · ")}</span>
                  )}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded px-1.5 py-0.5 text-xs text-primary hover:underline"
                  onClick={(e) => { e.stopPropagation(); onOpen(source.path); }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  Open
                </button>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
        <span><Kbd>↵</Kbd> add its link after the passage</span>
        <span><Kbd>⌫</Kbd> back</span>
        <span className="ml-auto"><Kbd>esc</Kbd> close</span>
      </div>
    </Command>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  if (before === after) return <p className="font-sans text-sm text-muted-foreground">No changes suggested.</p>;
  return (
    <p className="whitespace-pre-wrap">
      {diffWords(before, after).map((part, i) =>
        part.added ? (
          <ins key={i} className="rounded-sm bg-emerald-500/15 text-foreground no-underline">
            {part.value}
          </ins>
        ) : part.removed ? (
          <del key={i} className="text-muted-foreground decoration-red-500/70">
            {part.value}
          </del>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </p>
  );
}
