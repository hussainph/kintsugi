import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ArrowUpRight, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { Clip, ClipChanged, ClipEdit } from "@kintsugi/core/clips";
import { Button } from "@kintsugi/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@kintsugi/ui/components/dialog";
import { Input } from "@kintsugi/ui/components/input";
import { Textarea } from "@kintsugi/ui/components/textarea";
import { clipLabel, clips, clipSite, sourceUrl } from "./api";
import { parseTags } from "./capture";
import { ClipImage } from "./ClipImage";

type Patch = Omit<ClipEdit, "path">;
type Draft = { title: string; note: string; tags: string };

type Props = {
  path: string;
  onClose: () => void;
  onChanged: () => void;
  /** KI-8 supplies the shared backlink index here. No second index in the library. */
  renderUsedIn?: (clip: Clip) => ReactNode;
};

export function Detail({ path, onClose, onChanged, renderUsedIn }: Props) {
  const [clip, setClip] = useState<Clip>();
  const [draft, setDraft] = useState<Draft>({ title: "", note: "", tags: "" });
  const [status, setStatus] = useState("Saved");
  const [error, setError] = useState<string>();
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const edits = useRef<Patch>({});
  const queue = useRef(Promise.resolve());
  const mounted = useRef(true);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const receive = useCallback((next: Clip) => {
    setClip(next);
    setDraft((old) => ({
      title: edits.current.title === undefined ? next.title ?? "" : old.title,
      note: edits.current.note === undefined ? next.text : old.note,
      tags: edits.current.tags === undefined ? next.tags.join(", ") : old.tags,
    }));
  }, []);

  const save = useCallback(() => {
    queue.current = queue.current.then(async () => {
      const patch = { ...edits.current };
      if (!Object.keys(patch).length) return;
      if (mounted.current) setStatus("Saving…");
      try {
        const next = await clips.update({ path, ...patch });
        for (const key of Object.keys(patch) as (keyof Patch)[]) {
          if (JSON.stringify(edits.current[key]) === JSON.stringify(patch[key])) delete edits.current[key];
        }
        if (mounted.current) {
          receive(next);
          setStatus(Object.keys(edits.current).length ? "Editing" : "Saved");
        }
        changed.current();
      } catch (e) {
        if (mounted.current) setStatus("Not saved — try again");
        toast.error(`Could not save clip: ${String(e)}`);
      }
    });
    return queue.current;
  }, [path, receive]);

  const load = useCallback(() => {
    setError(undefined);
    clips.read(path).then((next) => { if (mounted.current) receive(next); }).catch((e) => {
      if (mounted.current) setError(String(e));
    });
  }, [path, receive]);

  useEffect(() => {
    mounted.current = true;
    load();
    const off = listen<ClipChanged>("clips:changed", ({ payload }) => { if (payload.path === path) load(); });
    const blur = () => { void save(); };
    window.addEventListener("blur", blur);
    return () => {
      mounted.current = false;
      void save(); // Sidebar navigation must not discard a field still being edited.
      off.then((stop) => stop());
      window.removeEventListener("blur", blur);
    };
  }, [path, load, save]);

  const edit = (key: keyof Draft, value: string) => {
    setDraft((old) => ({ ...old, [key]: value }));
    if (key === "tags") edits.current.tags = parseTags(value);
    else edits.current[key] = value;
    setStatus("Editing");
  };

  if (!clip) return <div className="flex flex-1 flex-col items-center justify-center gap-4 text-sm text-muted-foreground">
    <p role={error ? "alert" : "status"}>{error || "Opening inspiration…"}</p>
    <div className="flex gap-2"><Button variant="ghost" onClick={onClose}>Back to library</Button>{error && <Button variant="outline" onClick={load}>Try again</Button>}</div>
  </div>;

  const source = sourceUrl(clip.url);
  return (
    <div className="inspiration-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain pb-12">
      <div className="mb-8 flex items-center justify-between gap-3">
        <Button variant="ghost" className="-ml-2 text-muted-foreground" onClick={async () => { await save(); if (!Object.keys(edits.current).length) onClose(); }}><ArrowLeft />All inspiration</Button>
        <span className={`text-xs ${status.startsWith("Not saved") ? "text-destructive" : "text-muted-foreground"}`} role="status">{status}</span>
      </div>
      {error && <p className="mb-4 text-sm text-destructive" role="alert">{error}</p>}
      <div className={`grid gap-10 ${clip.image ? "xl:grid-cols-[minmax(0,1.3fr)_minmax(280px,1fr)]" : "mx-auto max-w-2xl"}`}>
        {clip.image && <div className="flex min-h-48 items-start justify-center rounded-xl bg-muted/40 p-2"><ClipImage path={clip.path} image={clip.image} alt={clipLabel(clip)} className="max-h-[68vh] w-full rounded-lg object-contain" /></div>}
        <div className="min-w-0 space-y-8 select-text">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{clipSite(clip)} <span className="px-1.5 opacity-40">·</span> {clip.captured.slice(0, 10)}</p>
            <Input aria-label="Clip title" placeholder="Untitled" value={draft.title} onChange={(e) => edit("title", e.target.value)} onBlur={() => void save()} className="h-auto rounded-none border-0 px-0 py-1 text-xl! font-medium shadow-none focus-visible:ring-0" />
            {clip.summary && <p className="text-sm leading-relaxed text-muted-foreground">{clip.summary}</p>}
            {source && <button className="inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground" onClick={() => openUrl(source).catch((e) => toast.error(String(e)))} title={source}><span className="truncate">Open source</span><ArrowUpRight className="size-3" /></button>}
          </div>
          <div className="space-y-3">
            <label htmlFor="clip-note" className="text-xs text-muted-foreground">Your words</label>
            <Textarea id="clip-note" value={draft.note} onChange={(e) => edit("note", e.target.value)} onBlur={() => void save()} placeholder="A passage to remember, or a thought of your own…" className="min-h-48 resize-y border-0 bg-muted/35 px-4 py-3 font-[family-name:var(--font-prose)] text-base! leading-relaxed shadow-none focus-visible:ring-1" />
            <p className="text-[11px] text-muted-foreground">Quote and note, in Markdown. The source text stays untouched.</p>
          </div>
          <div className="space-y-2">
            <label htmlFor="clip-tags" className="text-xs text-muted-foreground">Tags</label>
            <Input id="clip-tags" placeholder="attention, craft, things to revisit" value={draft.tags} onChange={(e) => edit("tags", e.target.value)} onBlur={() => void save()} className="border-0 bg-muted/35 shadow-none" />
            <p className="text-[11px] text-muted-foreground">Separate tags with commas.</p>
          </div>
          <section aria-labelledby="used-in-heading" data-clip-used-in={clip.path} className="space-y-3 border-t pt-6">
            <h2 id="used-in-heading" className="text-xs text-muted-foreground">Used in</h2>
            {renderUsedIn ? renderUsedIn(clip) : <p className="text-sm text-muted-foreground/70">References from your writing will appear here.</p>}
          </section>
          <div className="flex items-center justify-between gap-4">
            <Button variant="ghost" size="sm" onClick={() => setConfirmTrash(true)} className="text-muted-foreground"><Trash2 />Move to Trash</Button>
            <Button variant="outline" size="sm" onClick={() => void save()} disabled={status === "Saved" || status === "Saving…"}>Save changes</Button>
          </div>
        </div>
      </div>
      <Dialog open={confirmTrash} onOpenChange={(next) => { if (!trashing) setConfirmTrash(next); }}>
        <DialogContent className="motion-reduce:animate-none">
          <DialogHeader><DialogTitle>Move this clip to Trash?</DialogTitle><DialogDescription>Its saved image goes with it. You can recover both from the Mac’s Trash.</DialogDescription></DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={trashing} onClick={() => setConfirmTrash(false)}>Keep it</Button>
            <Button variant="destructive" disabled={trashing} onClick={async () => {
              setTrashing(true);
              await save();
              if (Object.keys(edits.current).length) { setTrashing(false); return; }
              try { await clips.trash(path); onClose(); changed.current(); }
              catch (e) { toast.error(String(e)); setTrashing(false); }
            }}>{trashing ? "Moving…" : "Move to Trash"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
