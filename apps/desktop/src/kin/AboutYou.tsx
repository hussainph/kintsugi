import { Pencil, Plus, Redo2, Undo2, X } from "@kintsugi/ui/icons";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@kintsugi/ui/components/badge";
import { Button } from "@kintsugi/ui/components/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@kintsugi/ui/components/dialog";
import { Input } from "@kintsugi/ui/components/input";
import { Meter, Tabs } from "@kintsugi/ui/graphical";
import { cn } from "@kintsugi/ui/lib/utils";
import { memory, MemoryEdit, MemoryFile, MemorySource, MemoryView, Origin } from "@/lib/kin";

type Change = MemoryView["changes"][number];
type Entry = MemoryView["files"][number]["entries"][number];
type Tab = "you" | "vault" | "skills" | "history";

/** Each memory file's tab. The file names stay out of the UI. */
const TABS: { tab: Tab; label: string; file?: MemoryFile }[] = [
  { tab: "you", label: "You", file: "user" },
  { tab: "vault", label: "Vault", file: "notes" },
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
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            autoFocus
            className="h-8"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
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
    <li className="group flex items-start gap-(--space-s) border-b border-border py-(--space-xs) last:border-b-0">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="break-words text-pretty">
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
      className="flex items-center gap-(--space-xs)"
      onSubmit={async (e) => {
        e.preventDefault();
        const text = draft.trim();
        if (text && (await onAdd(text))) setDraft(null);
      }}
    >
      <Input
        autoFocus
        className="h-8"
        placeholder={PLACEHOLDER[file]}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
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
      <p>
        {action} the skill <span className="font-medium">{change.skill.name}</span>
      </p>
    );
  }
  return (
    <ul className="space-y-0.5">
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
    const show = () => setOpen(true);
    window.addEventListener("kintsugi:open-about-you", show);
    return () => window.removeEventListener("kintsugi:open-about-you", show);
  }, []);

  useEffect(() => {
    if (open) void run(memory.view);
    else {
      setFocus(null);
      setTab("you");
    }
  }, [open, run]);

  // A line's origin opens History at its change.
  useEffect(() => {
    if (tab === "history" && focus) document.getElementById(`change-${focus}`)?.scrollIntoView({ block: "nearest" });
  }, [tab, focus]);

  const edit = (file: MemoryFile, edits: MemoryEdit[], done: string) => run(() => memory.edit(file, edits), done);

  const showChange = (origin: Origin) => {
    setFocus(origin.change);
    setTab("history");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        aria-describedby={undefined}
        aria-label="About you"
        className="ki-about h-[min(40rem,85svh)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-2xl"
        // Escape in a line being edited cancels the edit, not the dialog.
        onEscapeKeyDown={(e) => (e.target as Element | null)?.closest?.("[data-editing]") && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>About you</DialogTitle>
        </DialogHeader>

        <Tabs.Root value={tab} onValueChange={(value) => setTab(value as Tab)} className="flex min-h-0 flex-col gap-(--space-xs)">
          <Tabs.List className="self-start">
            {TABS.map(({ tab, label }) => (
              <Tabs.Tab key={tab} value={tab}>
                {label}
              </Tabs.Tab>
            ))}
          </Tabs.List>

          {view?.files.map((file) => {
            const tab = TABS.find((t) => t.file === file.file)!.tab;
            return (
              <Tabs.Panel key={file.file} value={tab} className="flex min-h-0 flex-col gap-(--space-s) overflow-y-auto">
                <Meter.Root value={Math.min(file.used, file.cap)} max={file.cap} aria-label="Characters used" data-high={file.used >= file.cap * 0.9 || undefined}>
                  <Meter.Heading>
                    <span className="ki-text-s ki-muted">{times(file.entries.length, "line")}</span>
                    <Meter.Value>{() => `${file.used.toLocaleString()} / ${file.cap.toLocaleString()} characters`}</Meter.Value>
                  </Meter.Heading>
                  <Meter.Track>
                    <Meter.Indicator />
                  </Meter.Track>
                </Meter.Root>
                {file.entries.length === 0 ? (
                  <p className="ki-muted">{EMPTY[file.file]}</p>
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
            <Tabs.Panel value="skills" className="min-h-0 overflow-y-auto">
              {view.skills.length === 0 ? (
                <p className="ki-muted">No skills yet. Kin makes one when you repeat a request.</p>
              ) : (
                <ul aria-label="Skills">
                  {view.skills.map((skill) => (
                    <li key={skill.name} className="space-y-0.5 border-b border-border py-(--space-xs) last:border-b-0">
                      <p className="flex flex-wrap items-baseline gap-x-(--space-xs)">
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
            <Tabs.Panel value="history" className="min-h-0 overflow-y-auto">
              {view.changes.length === 0 ? (
                <p className="ki-muted">No changes yet.</p>
              ) : (
                <ol aria-label="History" className="-mx-(--space-xs)">
                  {view.changes.map((change) => (
                    <li
                      key={change.id}
                      id={`change-${change.id}`}
                      data-focus={focus === change.id || undefined}
                      className="flex items-start gap-(--space-s) rounded-(--radius-s) border-b border-border px-(--space-xs) py-(--space-xs) last:border-b-0 data-focus:border-transparent data-focus:bg-muted"
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
        </Tabs.Root>
      </DialogContent>
    </Dialog>
  );
}
