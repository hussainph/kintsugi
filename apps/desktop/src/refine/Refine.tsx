import { EditorView } from "@codemirror/view";
import { diffWords } from "diff";
import { Sparkles } from "lucide-react";
import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@kintsugi/ui/components/command";
import { Kbd } from "@kintsugi/ui/components/kbd";
import { Popover, PopoverAnchor, PopoverContent } from "@kintsugi/ui/components/popover";
import { Cancelled, Message, stream } from "@/lib/ai";
import { modelFor } from "@/lib/models";
import { cn } from "@kintsugi/ui/lib/utils";
import { Action, ACTIONS, ask, choices, clean } from "./prompts";

type Props = { view: EditorView; from: number; to: number; onClose: () => void };

type Version = { text: string; done: boolean };

/** ⌘K on a selection: pick an edit, see it as a diff, accept or don't.
 *  Nothing reaches the document until the writer presses Enter. */
export function Refine({ view, from, to, onClose }: Props) {
  const original = view.state.sliceDoc(from, to);
  const [action, setAction] = useState<Action | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [index, setIndex] = useState(0);
  const [choice, setChoice] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const inflight = useRef<{ cancel: () => void } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => inflight.current?.cancel(), []);

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
        onOpenAutoFocus={(e) => action && e.preventDefault()}
      >
        {!action ? (
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
              <CommandGroup>
                {actions.map((a) => (
                  <CommandItem key={a.id} value={a.label} onSelect={() => run(a)}>
                    {a.label}
                  </CommandItem>
                ))}
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
