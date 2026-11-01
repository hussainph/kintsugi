import type { EditorView } from "@codemirror/view";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AlertCircle, AlertTriangle, Check as CheckIcon, Info } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { DESTINATIONS, LINKEDIN_FOLD, LINKEDIN_LIMIT, exportName, preparePiece, render, type Destination, type ExportInput, type Piece, type Rendered } from "@kintsugi/core/export";
import { localDate } from "@kintsugi/core/publish";
import { Button } from "@kintsugi/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@kintsugi/ui/components/dialog";
import { Switch } from "@kintsugi/ui/components/switch";
import { blog, openPublish } from "@/lib/blog";
import { exporting, statementFor, type ExportSettings } from "@/lib/exporting";
import { usePieceSources } from "./sources";
import "../publish/publish.css";
import "./export.css";

type Props = {
  root: string | null;
  /** The open document, or null when none is (or the editor is hidden). */
  path: string | null;
  viewRef: RefObject<EditorView | null>;
  /** Writes pending saves; false when one failed. */
  flush: () => Promise<boolean>;
};

type Ready = { dest: Destination; piece: Piece; rendered: Rendered; dataUrls: Record<string, string>; pdf: { pages: number; preview: string[] } | null };
type Phase =
  | { kind: "closed" }
  | { kind: "loading"; dest: Destination }
  | { kind: "failed"; dest: Destination; error: string }
  | ({ kind: "ready" | "saving" } & Ready);

/** Destinations this dialog delivers itself (the blog has its own). */
const local = (d: Destination) => d.delivery.kind !== "publish";
const LAST = "kintsugi:export:last";

/** Export… (⌥⌘E, or the footer's Export menu): one document, rendered for a
 *  destination, previewed and checked, then saved as a file or copied. */
export function Export({ root, path, viewRef, flush }: Props) {
  const { sources, clips } = usePieceSources(root);
  const [phase, setPhase] = useState<Phase>({ kind: "closed" });
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [options, setOptions] = useState<{ appendix: boolean; statement: boolean } | null>(null);
  const run = useRef(0);

  const prepare = useCallback(async (dest: Destination, choice?: { appendix: boolean; statement: boolean }) => {
    if (!path) return;
    const id = ++run.current;
    setPhase((p) => (p.kind === "ready" && p.dest.id === dest.id ? p : { kind: "loading", dest }));
    try {
      if (!(await flush())) throw new Error("Save the document first; a save failed.");
      const current = await exporting.settings();
      const picked = choice ?? { appendix: current.appendix, statement: current.statement };
      const input: ExportInput = {
        path, text: viewRef.current?.state.doc.toString() ?? "", today: localDate(), sources, clips,
        published: await blog.links(), appendix: picked.appendix,
        statement: picked.statement ? statementFor({ ...current, statement: true }) : null,
      };
      const first = preparePiece(input);
      const images = first.imageRefs.length ? await exporting.images(first.imageRefs) : {};
      const piece = preparePiece({ ...input, images });
      const dataUrls = dest.id === "html" && piece.assets.length ? await exporting.assets(piece.assets) : {};
      const rendered = render(dest, piece, { dataUrls });
      const pdf = dest.delivery.kind === "file" && dest.delivery.format === "typst"
        ? await exporting.pdf({ source: rendered.content, assets: piece.assets })
        : null;
      if (id !== run.current) return;
      setSettings(current);
      setOptions(picked);
      setPhase({ kind: "ready", dest, piece, rendered, dataUrls, pdf });
    } catch (e) {
      if (id === run.current) setPhase({ kind: "failed", dest, error: String(e instanceof Error ? e.message : e) });
    }
  }, [path, flush, viewRef, sources, clips]);

  const open = useCallback(async (requested?: string) => {
    if (!path) return;
    let enabled: Destination[];
    try {
      const fresh = await exporting.settings();
      setSettings(fresh);
      enabled = DESTINATIONS.filter((d) => local(d) && fresh.destinations.includes(d.id));
    } catch (e) {
      toast.error(String(e));
      return;
    }
    const wanted = requested ?? sessionStorage.getItem(LAST) ?? undefined;
    const dest = enabled.find((d) => d.id === wanted) ?? enabled[0];
    if (!dest) {
      toast("No export destinations are on. Choose them in Settings → Export.");
      return;
    }
    setOptions(null);
    void prepare(dest);
  }, [path, prepare]);

  useEffect(() => {
    const onEvent = (e: Event) => {
      const id = (e as CustomEvent<{ destination?: string }>).detail?.destination;
      if (id === "blog") openPublish();
      else void open(id);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey && e.code === "KeyE" && path) {
        e.preventDefault();
        e.stopPropagation();
        void open();
      }
    };
    window.addEventListener("kintsugi:export", onEvent);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("kintsugi:export", onEvent);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, path]);

  const close = () => { run.current++; setPhase({ kind: "closed" }); viewRef.current?.focus(); };

  const choose = (dest: Destination) => {
    sessionStorage.setItem(LAST, dest.id);
    void prepare(dest, options ?? undefined);
  };
  const toggle = (key: "appendix" | "statement", on: boolean) => {
    if (phase.kind !== "ready") return;
    const next = { ...(options ?? { appendix: false, statement: false }), [key]: on };
    setOptions(next);
    void prepare(phase.dest, next);
  };

  const deliver = async () => {
    if (phase.kind !== "ready") return;
    const ready: Ready = phase;
    const { dest, piece, rendered } = ready;
    sessionStorage.setItem(LAST, dest.id);
    if (dest.delivery.kind === "clipboard") {
      try {
        await navigator.clipboard.writeText(rendered.content);
        toast(`Copied ${[...rendered.content.trim()].length.toLocaleString("en")} characters for ${dest.label}.`);
        close();
      } catch (e) {
        toast.error(`Couldn't copy: ${String(e)}`);
      }
      return;
    }
    if (dest.delivery.kind !== "file") return;
    const { extension, filter, format } = dest.delivery;
    const chosen = await save({ title: `Save ${dest.label}`, defaultPath: exportName(piece, extension), filters: [{ name: filter, extensions: [extension] }] });
    if (!chosen) return;
    setPhase({ ...ready, kind: "saving" });
    try {
      const written = format === "typst"
        ? (await exporting.pdf({ source: rendered.content, assets: piece.assets, path: chosen })).written!
        : await exporting.write(chosen, rendered.content);
      const file = written.split("/").pop();
      toast(`Saved ${file}.`, {
        action: { label: "Show in Finder", onClick: () => void revealItemInDir(written).catch((e) => toast.error(String(e))) },
      });
      close();
    } catch (e) {
      toast.error(String(e));
      setPhase({ ...ready, kind: "ready" });
    }
  };

  const enabled = DESTINATIONS.filter((d) => local(d) && (settings?.destinations ?? []).includes(d.id));
  const current = phase.kind === "closed" ? null : phase.dest;
  const ready = phase.kind === "ready" || phase.kind === "saving" ? phase : null;
  const busy = phase.kind !== "ready";

  return (
    <Dialog open={phase.kind !== "closed"} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="publish-dialog export-dialog sm:max-w-3xl" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>{current?.hint ?? "Render this document for somewhere else."}</DialogDescription>
        </DialogHeader>

        <div className="publish-bar">
          <div role="radiogroup" aria-label="Destination" className="publish-segments">
            {enabled.map((d) => (
              <button key={d.id} role="radio" aria-checked={current?.id === d.id} disabled={phase.kind === "saving"} onClick={() => choose(d)}>
                {d.label}
              </button>
            ))}
          </div>
          <label className="publish-toggle">
            <Switch checked={!!options?.appendix} disabled={busy} onCheckedChange={(on) => toggle("appendix", on)} aria-label="Sources appendix" />
            Sources appendix
          </label>
          <label className="publish-toggle" title={settings ? statementFor({ ...settings, statement: true }) ?? "" : ""}>
            <Switch checked={!!options?.statement} disabled={busy} onCheckedChange={(on) => toggle("statement", on)} aria-label="Written by a human" />
            Written by a human
          </label>
        </div>

        {phase.kind === "loading" && <p className="text-sm text-muted-foreground">Rendering {phase.dest.label}…</p>}
        {phase.kind === "failed" && <p className="text-sm text-destructive" role="alert">{phase.error}</p>}

        {ready && (
          <>
            <ul className="publish-checks" aria-label="Checks">
              {ready.rendered.checks.length === 0 && <li data-level="ok"><CheckIcon size={14} /> Ready: every link and image made it.</li>}
              {ready.rendered.checks.map((c, i) => (
                <li key={i} data-level={c.level}>
                  {c.level === "error" ? <AlertCircle size={14} /> : c.level === "warning" ? <AlertTriangle size={14} /> : <Info size={14} />}
                  <span>{c.message}</span>
                </li>
              ))}
            </ul>
            <div className="publish-pane export-pane" role="tabpanel" aria-label={`${ready.dest.label} preview`}>
              <Preview ready={ready} />
            </div>
            <div className="publish-actions">
              <span className="text-xs text-muted-foreground">{summary(ready)}</span>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button disabled={phase.kind === "saving"} onClick={deliver}>
                {phase.kind === "saving" ? "Saving…" : ready.dest.delivery.kind === "clipboard" ? "Copy text" : `Save ${ready.dest.label}…`}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function summary({ dest, piece, rendered, pdf }: Ready): string {
  if (pdf) return `${pdf.pages} page${pdf.pages === 1 ? "" : "s"} · A4`;
  if (dest.delivery.kind === "clipboard") return `${[...rendered.content.trim()].length.toLocaleString("en")} / ${LINKEDIN_LIMIT.toLocaleString("en")} characters`;
  return `${piece.words.toLocaleString("en")} words · ${Math.max(1, Math.round(rendered.content.length / 1024)).toLocaleString("en")} KB, one file`;
}

function Preview({ ready }: { ready: Ready }) {
  const { dest, rendered, pdf } = ready;
  if (pdf) {
    return (
      <div className="export-pages">
        {pdf.preview.map((svg, n) => (
          <img key={n} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={`Page ${n + 1}`} />
        ))}
        {pdf.pages > pdf.preview.length && <p>…and {pdf.pages - pdf.preview.length} more pages.</p>}
      </div>
    );
  }
  if (dest.delivery.kind === "clipboard") {
    const text = rendered.content.trim();
    const chars = [...text];
    return (
      <div className="export-text" aria-label="Post text">
        <span>{chars.slice(0, LINKEDIN_FOLD).join("")}</span>
        {chars.length > LINKEDIN_FOLD && <><span className="export-fold" aria-label="see more">…see more</span><span>{chars.slice(LINKEDIN_FOLD).join("")}</span></>}
      </div>
    );
  }
  // The exported file itself, without scripts or network (a sandboxed frame).
  return <iframe className="export-frame" title="HTML preview" sandbox="" srcDoc={rendered.content} />;
}

