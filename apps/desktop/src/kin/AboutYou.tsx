import { Pencil, Plus, Redo2, Undo2, X } from "@kintsugi/ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@kintsugi/ui/components/badge";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
import { Dialog, Meter, Tabs } from "@kintsugi/ui/graphical";
import { cn } from "@kintsugi/ui/lib/utils";
import { memory, MemoryEdit, MemoryFile, MemorySource, MemoryView, Origin } from "@/lib/kin";

type Change = MemoryView["changes"][number];
type Entry = MemoryView["files"][number]["entries"][number];
type Tab = "you" | "vault" | "skills" | "history";

/** A vertical section list. The file names stay out of the UI. */
const TABS: { tab: Tab; label: string; file?: MemoryFile }[] = [
  { tab: "you", label: "You", file: "user" },
  { tab: "vault", label: "This vault", file: "notes" },
  { tab: "skills", label: "Skills" },
  { tab: "history", label: "History" },
];

const EMPTY: Record<MemoryFile, string> = {
  user: "Nothing yet. Kin learns this as you talk.",
  notes: "Nothing yet. Kin notes where things are as it finds them.",
};

const PLACEHOLDER: Record<MemoryFile, string> = {
  user: "Something Kin should know about you",
  notes: "Where something is in this vault",
};

/** Who made a change, in a few words. */
export function sourceLabel(source: MemorySource) {
  switch (source.kind) {
    case "chat":
      return `Chat: “${source.about}”`;
    case "review":
      return `Background review: “${source.about}”`;
    case "owner":
      return "You";
    case "outside":
      return "Edited outside Kintsugi";
  }
}

const when = (at: string) => {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const day = (at: string) => {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const times = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Where a line or skill came from (a link to its change) and how often it's used. */
function Provenance({ origin, used, onShow }: { origin: Origin | null; used: string; onShow: (origin: Origin) => void }) {
  return (
    <p className="ki-text-xs ki-muted">
      {origin ? (
        <button type="button" className="hover:text-foreground hover:underline" onClick={() => onShow(origin)}>
          {sourceLabel(origin.source)} · {day(origin.at)}
        </button>
      ) : (
        "Origin unknown"
      )}
      {" · "}
      {used}
    </p>
  );
}

/** One remembered line: read it, fix it in place, or forget it. */
function Line({
  entry,
  onSave,
  onForget,
  onShow,
}: {
  entry: Entry;
  onSave: (text: string) => Promise<boolean>;
  onForget: () => void;
  onShow: (origin: Origin) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  if (draft !== null) {
    const save = async () => {
      const text = draft.trim();
      if (!text || text === entry.text) return setDraft(null);
      if (await onSave(text)) setDraft(null);
    };
    return (
      <li data-editing className="py-(--space-xs)">
        <form
          className="flex items-center gap-(--space-xs)"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDraft(null);
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            autoFocus
            className="h-8 ki-about-prose"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Edit line"
          />
          <Button size="sm" variant="ghost" type="button" onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <Button size="sm" type="submit" disabled={!draft.trim()}>
            Save
          </Button>
        </form>
      </li>
    );
  }

  return (
    <li className="ki-about-row group flex items-start gap-(--space-s)">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="ki-about-prose break-words text-pretty">
          {entry.text}
          {entry.blocked && (
            <Badge variant="destructive" className="ml-2 align-middle" title={entry.blocked}>
              Not loaded
            </Badge>
          )}
        </p>
        <Provenance origin={entry.origin} used={entry.uses ? `Used in ${times(entry.uses, "chat")}` : "Not used yet"} onShow={onShow} />
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <Button size="icon-xs" variant="ghost" aria-label={`Edit “${entry.text}”`} onClick={() => setDraft(entry.text)}>
          <Pencil />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label={`Forget “${entry.text}”`} onClick={onForget}>
          <X />
        </Button>
      </div>
    </li>
  );
}

/** A new line, behind a quiet button: adding is the rare case. */
function AddLine({ file, onAdd }: { file: MemoryFile; onAdd: (text: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <Button size="sm" variant="ghost" className="self-start" onClick={() => setDraft("")}>
        <Plus data-icon="inline-start" />
        Add a line
      </Button>
    );
  }
  return (
    <form
      data-editing
      className="ki-about-form flex items-center gap-(--space-xs)"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setDraft(null);
        }
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        const text = draft.trim();
        if (text && (await onAdd(text))) setDraft(null);
      }}
    >
      <Input
        autoFocus
        className="h-8 ki-about-prose"
        placeholder={PLACEHOLDER[file]}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="New line"
      />
      <Button size="sm" variant="ghost" type="button" onClick={() => setDraft(null)}>
        Cancel
      </Button>
      <Button size="sm" type="submit" disabled={!draft.trim()}>
        Add
      </Button>
    </form>
  );
}

/** What a change did, line by line. */
function ChangeLines({ change }: { change: Change }) {
  if (change.skill) {
    const action = change.skill.action[0].toUpperCase() + change.skill.action.slice(1);
    return (
      <p className="ki-about-prose">
        {action} the skill <span className="font-medium">{change.skill.name}</span>
      </p>
    );
  }
  return (
    <ul className="ki-about-prose space-y-0.5">
      {change.ops.map((op, i) => (
        <li key={i} className="flex gap-(--space-xs)">
          <span aria-hidden className={cn("w-3 shrink-0 ki-data leading-[inherit]", op.op === "remove" ? "text-destructive" : "text-(--success)")}>
            {{ add: "+", remove: "−", patch: "~" }[op.op]}
          </span>
          {op.op === "patch" ? (
            <span className="min-w-0 break-words">
              <span className="ki-muted line-through">{op.old}</span> → {op.new}
            </span>
          ) : (
            <span className={cn("min-w-0 break-words", op.op === "remove" && "ki-muted line-through")}>{op.text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** About you: what Kin believes about him and his vault, line by line with
 *  where each came from; the skills Kin has; and every change, with undo.
 *  Opens on the `kintsugi:open-about-you` event (`openAboutYou`). */
export function AboutYou() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MemoryView | null>(null);
  const [tab, setTab] = useState<Tab>("you");
  const [focus, setFocus] = useState<string | null>(null);
  const youTab = useRef<HTMLButtonElement>(null);
  const panels = useRef<HTMLDivElement>(null);

  const run = useCallback(async (action: () => Promise<MemoryView>, done?: string) => {
    try {
      setView(await action());
      if (done) toast(done);
      return true;
    } catch (e) {
      toast.error(String(e));
      return false;
    }
  }, []);

  useEffect(() => {
    const show = () => {
      setTab("you");
      setFocus(null);
      setOpen(true);
    };
    window.addEventListener("kintsugi:open-about-you", show);
    return () => window.removeEventListener("kintsugi:open-about-you", show);
  }, []);

  useEffect(() => {
    if (open) void run(memory.view);
  }, [open, run]);

  // A section starts at the top; a line's origin opens History at its change.
  useEffect(() => {
    panels.current?.scrollTo({ top: 0 });
    if (tab === "history" && focus) document.getElementById(`change-${focus}`)?.scrollIntoView({ block: "nearest" });
  }, [tab, focus, open]);

  const edit = (file: MemoryFile, edits: MemoryEdit[], done: string) => run(() => memory.edit(file, edits), done);

  const showChange = (origin: Origin) => {
    setFocus(origin.change);
    setTab("history");
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next, details) => {
        // Escape in a line being edited cancels the edit, not the dialog.
        if (details.reason === "escape-key" && (details.event.target as Element | null)?.closest?.("[data-editing]")) {
          details.cancel();
          return;
        }
        setOpen(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup aria-describedby={undefined} className="ki-about" initialFocus={youTab}>
          <Tabs.Root value={tab} onValueChange={(value) => setTab(value as Tab)} orientation="vertical" className="ki-about-layout">
            <div className="ki-about-nav">
              <Dialog.Title className="ki-about-title">About you</Dialog.Title>
              <Tabs.List activateOnFocus aria-label="About you sections" className="ki-about-sections">
                {TABS.map(({ tab, label, file: name }) => {
                  const file = view?.files.find((file) => file.file === name);
                  const count = file ? `${file.used.toLocaleString()} / ${file.cap.toLocaleString()}` :
                    view ? (tab === "skills" ? view.skills.length : view.changes.length).toLocaleString() : "…";
                  return (
                    <div key={tab} className="ki-about-section" data-memory={!!name || undefined}>
                      <Tabs.Tab
                        value={tab}
                        ref={tab === "you" ? youTab : undefined}
                        aria-label={label}
                        aria-describedby={`about-${tab}-count`}
                        className="ki-about-section-button"
                      >
                        <span>{label}</span>
                        <span id={`about-${tab}-count`} className="ki-about-count">{count}{file && <span className="sr-only"> characters</span>}</span>
                      </Tabs.Tab>
                      {file && (
                        <Meter.Root
                          className="ki-about-meter"
                          value={Math.min(file.used, file.cap)}
                          max={file.cap}
                          aria-label={`${label} characters used`}
                          aria-valuetext={`${count} characters`}
                          data-high={file.used >= file.cap * 0.9 || undefined}
                        >
                          <Meter.Track>
                            <Meter.Indicator />
                          </Meter.Track>
                        </Meter.Root>
                      )}
                    </div>
                  );
                })}
              </Tabs.List>
            </div>
            <div className="ki-about-detail">
              <header className="ki-about-header">
                <h3 className="ki-about-prose ki-about-heading">{TABS.find((section) => section.tab === tab)!.label}</h3>
              </header>
              <div ref={panels} className="ki-about-panels">
                {view?.files.map((file) => {
                  const tab = TABS.find((t) => t.file === file.file)!.tab;
                  return (
                    <Tabs.Panel key={file.file} value={tab} className="ki-about-panel flex flex-col gap-(--space-s)">
                      {file.entries.length === 0 ? (
                        <p className="ki-about-prose ki-muted">{EMPTY[file.file]}</p>
                      ) : (
                        <ul aria-label={TABS.find((t) => t.file === file.file)!.label}>
                          {file.entries.map((entry) => (
                            <Line
                              key={entry.text}
                              entry={entry}
                              onSave={(text) => edit(file.file, [{ op: "patch", old: entry.text, text }], "Saved.")}
                              onForget={() => void edit(file.file, [{ op: "remove", old: entry.text }], "Forgotten.")}
                              onShow={showChange}
                            />
                          ))}
                        </ul>
                      )}
                      <AddLine file={file.file} onAdd={(text) => edit(file.file, [{ op: "add", text }], "Added.")} />
                    </Tabs.Panel>
                  );
                })}

                {view && (
                  <Tabs.Panel value="skills" className="ki-about-panel">
                    {view.skills.length === 0 ? (
                      <p className="ki-about-prose ki-muted">No skills yet. Kin makes one when you repeat a request.</p>
                    ) : (
                      <ul aria-label="Skills">
                        {view.skills.map((skill) => (
                          <li key={skill.name} className="ki-about-row space-y-0.5">
                            <p className="ki-about-prose flex flex-wrap items-baseline gap-x-(--space-xs)">
                              <span className="font-medium">{skill.command ? `/${skill.name}` : skill.name}</span>
                              {skill.blocked && (
                                <Badge variant="destructive" className="self-center" title={skill.blocked}>
                                  Not loaded
                                </Badge>
                              )}
                              <span className="ki-muted">{skill.description}</span>
                            </p>
                            <Provenance origin={skill.origin} used={skill.uses ? `Used ${times(skill.uses, "time")}` : "Not used yet"} onShow={showChange} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </Tabs.Panel>
                )}

                {view && (
                  <Tabs.Panel value="history" className="ki-about-panel">
                    {view.changes.length === 0 ? (
                      <p className="ki-about-prose ki-muted">No changes yet.</p>
                    ) : (
                      <ol aria-label="History">
                        {view.changes.map((change) => (
                          <li
                            key={change.id}
                            id={`change-${change.id}`}
                            data-focus={focus === change.id || undefined}
                            className="ki-about-row flex items-start gap-(--space-s) rounded-(--radius-s) data-focus:bg-muted"
                          >
                            <div className="min-w-0 flex-1 space-y-1">
                              <p className="flex flex-wrap items-baseline gap-x-(--space-xs)">
                                <span className="font-medium">{change.undoes ? "Undo" : sourceLabel(change.source)}</span>
                                <span className="ki-text-xs ki-muted">{when(change.at)}</span>
                              </p>
                              <ChangeLines change={change} />
                            </div>
                            {change.undoneBy ? (
                              <span className="ki-text-xs ki-muted px-(--space-xs) py-1">Undone</span>
                            ) : (
                              <Button size="xs" variant="ghost" onClick={() => run(() => memory.undo(change.id), change.undoes ? "Redone." : "Undone.")}>
                                {change.undoes ? <Redo2 data-icon="inline-start" /> : <Undo2 data-icon="inline-start" />}
                                {change.undoes ? "Redo" : "Undo"}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </Tabs.Panel>
                )}
              </div>
              <Dialog.Close aria-label="Close" className="ki-about-close">
                <X />
              </Dialog.Close>
            </div>
          </Tabs.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
