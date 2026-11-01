import { Undo2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@kintsugi/ui/components/badge";
import { Button } from "@kintsugi/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@kintsugi/ui/components/dialog";
import { Input } from "@kintsugi/ui/components/input";
import { cn } from "@kintsugi/ui/lib/utils";
import { memory, MemoryEdit, MemoryFile, MemorySource, MemoryView, Origin } from "@/lib/kin";

type Change = MemoryView["changes"][number];

/** Who made a change, in a few words. */
export function sourceLabel(source: MemorySource) {
  switch (source.kind) {
    case "chat":
      return `Chat: “${source.about}”`;
    case "review":
      return `Background review: “${source.about}”`;
    case "owner":
      return "You, in About you";
    case "outside":
      return "Edited outside Kintsugi";
  }
}

const when = (at: string) => {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const times = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** What a change did, line by line. */
function ChangeLines({ change }: { change: Change }) {
  if (change.skill) {
    return <p className="text-muted-foreground">{change.skill.action[0].toUpperCase() + change.skill.action.slice(1)} skill <code>{change.skill.name}</code></p>;
  }
  return (
    <ul className="space-y-0.5">
      {change.ops.map((op, i) => (
        <li key={i} className="flex gap-1.5">
          <span aria-hidden className={cn("w-3 shrink-0 font-mono", op.op === "remove" ? "text-destructive" : "text-primary")}>
            {{ add: "+", remove: "−", patch: "~" }[op.op]}
          </span>
          {op.op === "patch" ? (
            <span>
              <span className="text-muted-foreground line-through">{op.old}</span> → {op.new}
            </span>
          ) : (
            <span className={op.op === "remove" ? "text-muted-foreground line-through" : ""}>{op.text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** About you: what Kin remembers, where each line came from, how often it's
 *  used, every change, and undo. Opens on the `kintsugi:open-about-you` event. */
export function AboutYou() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MemoryView | null>(null);
  const [adding, setAdding] = useState<Record<MemoryFile, string>>({ user: "", notes: "" });
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
    else setFocus(null);
  }, [open, run]);

  const edit = (file: MemoryFile, edits: MemoryEdit[], done: string) => run(() => memory.edit(file, edits), done);

  const add = async (file: MemoryFile) => {
    const text = adding[file].trim();
    if (!text) return;
    if (await edit(file, [{ op: "add", text }], "Added.")) setAdding((a) => ({ ...a, [file]: "" }));
  };

  const showChange = (origin: Origin) => {
    setFocus(origin.change);
    document.getElementById(`change-${origin.change}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const provenance = (origin: Origin | null, uses: number, verb: string) => (
    <span className="text-xs text-muted-foreground">
      {origin ? (
        <button className="hover:text-foreground hover:underline" onClick={() => showChange(origin)} title="Show this change">
          {sourceLabel(origin.source)} · {when(origin.at)}
        </button>
      ) : (
        "Origin unknown"
      )}
      {" · "}
      {uses ? `${verb} ${times(uses, "time")}` : `not ${verb.toLowerCase()} yet`}
    </span>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl" aria-label="About you">
        <DialogHeader>
          <DialogTitle>About you</DialogTitle>
          <DialogDescription>
            What Kin remembers, kept small on purpose. Kin updates it on its own as you talk; every change is listed below and can be undone. Mark
            a chat “don’t remember this” and nothing from it is saved.
          </DialogDescription>
        </DialogHeader>

        {view?.files.map((file) => (
          <section key={file.file} className="space-y-2 text-sm" aria-label={file.label}>
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-medium">
                {file.label} <span className="font-normal text-muted-foreground">{file.name}</span>
              </h3>
              <span className="text-xs text-muted-foreground tabular-nums">
                {file.used.toLocaleString()} / {file.cap.toLocaleString()} characters
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full", file.used >= file.cap * 0.9 ? "bg-destructive" : "bg-primary")} style={{ width: `${Math.min(100, (file.used / file.cap) * 100)}%` }} />
            </div>
            {file.entries.length === 0 && (
              <p className="text-muted-foreground">{file.file === "user" ? "Nothing yet. Kin learns your taste as you talk." : "Nothing yet. Kin notes where things are as it finds them."}</p>
            )}
            <ul className="divide-y">
              {file.entries.map((entry) => (
                <li key={entry.text} className="group flex items-start gap-2 py-1.5">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="break-words">
                      {entry.text}
                      {entry.blocked && (
                        <Badge variant="destructive" className="ml-2 align-middle" title={entry.blocked}>
                          Not loaded
                        </Badge>
                      )}
                    </p>
                    {provenance(entry.origin, entry.uses, "Loaded")}
                  </div>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={`Forget “${entry.text}”`}
                    title="Forget this"
                    onClick={() => edit(file.file, [{ op: "remove", old: entry.text }], "Forgotten.")}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void add(file.file);
              }}
            >
              <Input
                className="h-7"
                placeholder={file.file === "user" ? "Tell Kin something about you…" : "Add a note about where things are…"}
                value={adding[file.file]}
                onChange={(e) => setAdding((a) => ({ ...a, [file.file]: e.target.value }))}
                aria-label={`Add to ${file.label}`}
              />
              <Button size="sm" variant="outline" type="submit" disabled={!adding[file.file].trim()}>
                Add
              </Button>
            </form>
          </section>
        ))}

        {view && (
          <section className="space-y-2 text-sm" aria-label="Skills">
            <h3 className="font-medium">
              Skills <span className="font-normal text-muted-foreground">.kintsugi/agent/skills/</span>
            </h3>
            {view.skills.length === 0 ? (
              <p className="text-muted-foreground">
                No skills yet. Kin writes one when you keep asking for the same thing; you can add your own as <code>skills/&lt;name&gt;/SKILL.md</code>.
              </p>
            ) : (
              <ul className="divide-y">
                {view.skills.map((skill) => (
                  <li key={skill.name} className="space-y-0.5 py-1.5">
                    <p className="flex flex-wrap items-center gap-2">
                      <code className="font-medium">{skill.command ? `/${skill.name}` : skill.name}</code>
                      {skill.command && <Badge variant="outline">/ menu</Badge>}
                      {skill.blocked && <Badge variant="destructive" title={skill.blocked}>Not loaded</Badge>}
                      <span className="text-muted-foreground">{skill.description}</span>
                    </p>
                    {provenance(skill.origin, skill.uses, "Used")}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {view && (
          <section className="space-y-2 text-sm" aria-label="Changes">
            <h3 className="font-medium">Changes</h3>
            {view.changes.length === 0 && <p className="text-muted-foreground">No changes yet.</p>}
            <ol className="space-y-2">
              {view.changes.map((change) => (
                <li
                  key={change.id}
                  id={`change-${change.id}`}
                  className={cn("flex gap-3 rounded-md px-2 py-1.5 transition-colors", focus === change.id ? "bg-primary/10" : "bg-muted/40")}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-xs text-muted-foreground">
                      {when(change.at)} · {change.path} · {change.undoes ? "Undo" : sourceLabel(change.source)}
                    </p>
                    <ChangeLines change={change} />
                  </div>
                  {change.undoneBy ? (
                    <span className="self-center text-xs text-muted-foreground">Undone</span>
                  ) : (
                    <Button size="xs" variant="ghost" className="self-center" onClick={() => run(() => memory.undo(change.id), "Undone.")}>
                      <Undo2 data-icon="inline-start" />
                      Undo
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
