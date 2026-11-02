import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ArrowUpRight, BookOpen, FileText, MessageCircle, Trash2 } from "@kintsugi/ui/icons";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { toast } from "sonner";
import type { Clip, ClipChanged, ClipEdit } from "@kintsugi/core/clips";
import { Button } from "@kintsugi/ui/components/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@kintsugi/ui/components/dialog";
import { Input } from "@kintsugi/ui/components/input";
import { Textarea } from "@kintsugi/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@kintsugi/ui/components/tooltip";
import { quoteLinkLabel } from "@kintsugi/core/references";
import { discuss, useScreenContext } from "@/lib/chat";
import { clipFileLabel, clipLabel, clips, clipSite, sourceUrl } from "./api";
import { parseTags } from "./capture";
import { ClipImage } from "./ClipImage";

type Patch = Omit<ClipEdit, "path">;
type Draft = { title: string; note: string; tags: string };

export type DetailHandle = { flush: () => Promise<boolean> };

type Props = {
  ref?: Ref<DetailHandle>;
  path: string;
  onClose: () => void;
  onChanged: () => void;
  /** KI-8 supplies the shared backlink index here. No second index in the library. */
  renderUsedIn?: (clip: Clip) => ReactNode;
};

export function Detail({ ref, path, onClose, onChanged, renderUsedIn }: Props) {
  const [clip, setClip] = useState<Clip>();
  const [draft, setDraft] = useState<Draft>({ title: "", note: "", tags: "" });
  const [status, setStatus] = useState("Saved");
  const [error, setError] = useState<string>();
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const edits = useRef<Patch>({});
  const queue = useRef(Promise.resolve());
  const mounted = useRef(true);
  const readSeq = useRef(0);
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
        readSeq.current++; // A read started before this save cannot roll it back.
        for (const key of Object.keys(patch) as (keyof Patch)[]) {
          if (JSON.stringify(edits.current[key]) === JSON.stringify(patch[key])) delete edits.current[key];
        }
        if (mounted.current) {
          receive(next);
          setStatus(Object.keys(edits.current).length ? "Editing" : "Saved");
        }
        changed.current();
      } catch (e) {
        if (mounted.current) setStatus("Not saved. Try again.");
        toast.error(`Couldn’t save the clip: ${String(e)}`);
      }
    });
    return queue.current;
  }, [path, receive]);

  const load = useCallback(() => {
    setError(undefined);
    const seq = ++readSeq.current;
    clips.read(path).then((next) => { if (mounted.current && seq === readSeq.current) receive(next); }).catch((e) => {
      if (mounted.current && seq === readSeq.current) setError(String(e));
    });
  }, [path, receive]);

  useImperativeHandle(ref, () => ({ flush: async () => {
    await save();
    return !Object.keys(edits.current).length;
  } }), [save]);

  useEffect(() => {
    mounted.current = true;
    load();
    const off = listen<ClipChanged>("clips:changed", ({ payload }) => { if (payload.path === path) load(); });
    const blur = () => { void save(); };
    window.addEventListener("blur", blur);
    return () => {
      mounted.current = false;
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

  // Kin's chat picks up the open clip.
  const chip = clip && { kind: "clip", path: clip.path, label: clip.title || clipLabel(clip) };
  useScreenContext("clip", chip ? () => [chip] : null, [chip?.path, chip?.label]);

  if (!clip) return <div className="ki-text-s ki-muted flex flex-1 flex-col items-center justify-center gap-[var(--space-m)]">
    <p role={error ? "alert" : "status"}>{error || "Opening clip…"}</p>
    <div className="flex gap-[var(--space-xs)]"><Button variant="ghost" onClick={onClose}>Back to library</Button>{error && <Button variant="outline" onClick={load}>Try again</Button>}</div>
  </div>;

  const source = sourceUrl(clip.url);
  const fileLabel = clipFileLabel(clip);
  // Only web links open; a saved PDF's page link stays in the file.
  const quoteAt = sourceUrl(clip.quoteLink ?? null);
  return (
    <div className="inspiration-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[var(--space-xxl)]">
      <div className="mb-[var(--space-xl)] flex items-center justify-between gap-[var(--space-s)]">
        <Button autoFocus variant="ghost" className="-ml-[var(--space-xs)]" onClick={async () => { await save(); if (!Object.keys(edits.current).length) onClose(); }}><ArrowLeft />Inspiration</Button>
        <div className="flex items-center gap-[var(--space-s)]">
          <span className={`ki-text-xs ${status.startsWith("Not saved") ? "ki-error" : "ki-muted"}`} role="status">{status}</span>
          <Button variant="outline" size="sm" onClick={() => discuss({ kind: "clip", path: clip.path, label: clip.title || clipLabel(clip) })}><MessageCircle />Discuss</Button>
        </div>
      </div>
      {error && <p className="ki-text-s ki-error mb-[var(--space-m)]" role="alert">{error}</p>}
      <div className={`ki-clip-detail-grid grid ${clip.image ? "lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,1fr)]" : "mx-auto max-w-2xl"}`}>
        {clip.image && <div className="ki-clip-image-surface flex min-h-48 items-start justify-center"><ClipImage path={clip.path} image={clip.image} alt={clipLabel(clip)} className="ki-clip-image max-h-[68vh] w-full object-contain" /></div>}
        <div className="ki-stack-xl min-w-0 select-text">
          <div className="ki-stack-s">
            <Input aria-label="Clip title" placeholder="Untitled" value={draft.title} onChange={(e) => edit("title", e.target.value)} onBlur={() => void save()} className="ki-clip-title" />
            <p className="ki-text-xs ki-muted">{clipSite(clip)}{clip.author && (clip.kind === "book" || clip.kind === "document") && <><span className="px-[var(--space-xs)]">·</span>{clip.author}</>} <span className="px-[var(--space-xs)]">·</span> <time className="ki-data" dateTime={clip.captured}>{clip.captured.slice(0, 10)}</time></p>
            {clip.summary && <p className="ki-text-s ki-muted">{clip.summary}</p>}
            {(fileLabel || source) && <div className="flex flex-wrap items-center gap-x-[var(--space-m)] gap-y-[var(--space-xs)]">
              {fileLabel && <Button variant="outline" size="sm" onClick={() => clips.openFile(clip.path).catch((e) => toast.error(String(e)))} title={clip.file ?? undefined}>{fileLabel === "PDF" ? <FileText /> : <BookOpen />}Open {fileLabel}</Button>}
              {source && <Tooltip><TooltipTrigger asChild><button className="ki-source-link ki-text-xs" onClick={() => openUrl(source).catch((e) => toast.error(String(e)))}><span className="truncate">Open source</span><ArrowUpRight className="size-[1em]" /></button></TooltipTrigger><TooltipContent>{source}</TooltipContent></Tooltip>}
            </div>}
          </div>
          <div className="ki-stack-xs">
            <label htmlFor="clip-note" className="ki-field-label">Your notes</label>
            <Textarea id="clip-note" aria-describedby="clip-note-help" value={draft.note} onChange={(e) => edit("note", e.target.value)} onBlur={() => void save()} placeholder="A quote or a note…" className="ki-clip-note min-h-48 resize-y" />
            <p id="clip-note-help" className="ki-text-xs ki-muted">Markdown</p>
            {(clip.quoteBy || quoteAt) && <p className="ki-text-xs ki-muted" data-quote-origin>
              {clip.quoteBy && <>Quote by {clip.quoteBy}</>}
              {quoteAt && <>{clip.quoteBy && <span className="px-[var(--space-xs)]">·</span>}<button className="ki-source-link" onClick={() => openUrl(quoteAt).catch((e) => toast.error(String(e)))} title={quoteAt}>{quoteLinkLabel(quoteAt) === "source" ? "Open at the passage" : `Open at ${quoteLinkLabel(quoteAt)}`}</button></>}
            </p>}
          </div>
          <div className="ki-stack-xs">
            <label htmlFor="clip-tags" className="ki-field-label">Tags</label>
            <Input id="clip-tags" placeholder="essays, design, to-read" value={draft.tags} onChange={(e) => edit("tags", e.target.value)} onBlur={() => void save()} />
          </div>
          <section aria-label="Clip backlinks" data-clip-used-in={clip.path} className="ki-stack-s ki-divider-top pt-[var(--space-l)]">
            {renderUsedIn ? renderUsedIn(clip) : <><h2 className="ki-text-s ki-medium">Used in</h2><p className="ki-text-s ki-muted">Not referenced yet.</p></>}
          </section>
          <div className="flex items-center justify-between gap-[var(--space-m)]">
            <Button variant="ghost" size="sm" onClick={() => setConfirmTrash(true)}><Trash2 />Move to Trash</Button>
            <div className="flex gap-[var(--space-xs)]">
              {status.startsWith("Not saved") && <Button variant="ghost" size="sm" onClick={() => { edits.current = {}; onClose(); }}>Discard changes</Button>}
              <Button variant="outline" size="sm" onClick={() => void save()} disabled={status === "Saved" || status === "Saving…"}>Save changes</Button>
            </div>
          </div>
        </div>
      </div>
      <Dialog open={confirmTrash} onOpenChange={(next) => { if (!trashing) setConfirmTrash(next); }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>Move this clip to Trash?</DialogTitle></DialogHeader>
          <div className="flex justify-end gap-[var(--space-xs)]">
            <Button variant="ghost" disabled={trashing} onClick={() => setConfirmTrash(false)}>Cancel</Button>
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
