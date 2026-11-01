import type { EditorView } from "@codemirror/view";
import { AlertCircle, AlertTriangle, Check as CheckIcon, Copy, Info } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { field, setField } from "@kintsugi/core/frontmatter";
import { localDate, planPublish, publishedFields, type ClipInfo, type PostKind, type PublishInput, type PublishPlan } from "@kintsugi/core/publish";
import type { ReferenceSource } from "@kintsugi/core/references";
import { Button } from "@kintsugi/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@kintsugi/ui/components/dialog";
import { Switch } from "@kintsugi/ui/components/switch";
import { blog, importSummary, type BlogStatus, type Published } from "@/lib/blog";
import { useReferenceIndex } from "@/references/useReferenceIndex";
import { Preview } from "./Preview";
import "./publish.css";

type Props = {
  root: string | null;
  /** The open document, or null when none is (or the editor is hidden). */
  path: string | null;
  viewRef: RefObject<EditorView | null>;
  /** Writes pending saves; false when one failed. */
  flush: () => Promise<boolean>;
};

type Phase =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "setup"; status: BlogStatus | null; error?: string }
  | { kind: "plan"; plan: PublishPlan; repo: string }
  | { kind: "writing"; plan: PublishPlan; repo: string }
  | { kind: "done"; plan: PublishPlan; result: Published };

const name = (path: string) => path.replace(/^.*\//, "").replace(/\.mdx?$/, "");
const shellQuote = (value: string) => (/^[\w./@-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);

/** Publish… (⇧⌘P): a preview, a checks summary, then the post and its images
 *  written into the blog repository's working tree. Never git. Also keeps the
 *  vault's mirror of the blog fresh when a vault opens. */
export function Publish({ root, path, viewRef, flush }: Props) {
  const index = useReferenceIndex(root);
  const [phase, setPhase] = useState<Phase>({ kind: "closed" });
  const [kind, setKind] = useState<PostKind | undefined>();
  const [appendix, setAppendix] = useState<boolean | undefined>();
  const [tab, setTab] = useState<"preview" | "file">("preview");
  const run = useRef(0);

  const sources = useMemo<ReferenceSource[]>(() => [
    ...index.documents.map((d) => ({ kind: "document" as const, path: d.path, title: d.title || name(d.path), status: d.status })),
    ...index.clips.map((c) => ({ kind: "clip" as const, path: c.path, title: c.title || name(c.path), site: c.site })),
  ], [index.documents, index.clips]);
  const clips = useMemo<ClipInfo[]>(() => index.clips.map((c) => ({ path: c.path, title: c.title, url: c.url, site: c.site, author: c.author })), [index.clips]);

  // The mirror follows the blog: refresh it whenever a vault opens.
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    blog.status().then((status) => {
      if (!cancelled && status.path && !status.error) return blog.import();
    }).catch(() => { /* Settings shows what's wrong. */ });
    return () => { cancelled = true; };
  }, [root]);

  const prepare = useCallback(async (options: { kind?: PostKind; appendix?: boolean } = {}) => {
    if (!path) return;
    const id = ++run.current;
    setPhase((p) => (p.kind === "plan" ? p : { kind: "loading" }));
    try {
      if (!(await flush())) throw new Error("Save the document first; a save failed.");
      const status = await blog.status();
      if (!status.path || status.error) {
        if (id === run.current) setPhase({ kind: "setup", status });
        return;
      }
      const text = viewRef.current?.state.doc.toString() ?? "";
      const input: PublishInput = {
        path, text, today: localDate(), kind: options.kind, site: status.site, sources, clips,
        published: await blog.links(), appendix: options.appendix ?? status.appendix,
      };
      const first = planPublish(input);
      const check = await blog.check({ source: path, file: first.file, replaces: first.replaces, imports: first.imports, images: first.imageRefs });
      if (id !== run.current) return;
      setAppendix(input.appendix);
      setKind(first.kind);
      setPhase({ kind: "plan", plan: planPublish({ ...input, check }), repo: check.repo });
    } catch (e) {
      if (id === run.current) setPhase({ kind: "setup", status: null, error: String(e instanceof Error ? e.message : e) });
    }
  }, [path, flush, viewRef, sources, clips]);

  const open = useCallback(() => {
    if (!path) return;
    setTab("preview");
    setKind(undefined);
    setAppendix(undefined);
    void prepare();
  }, [path, prepare]);

  useEffect(() => {
    const onEvent = () => open();
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "p" && path) {
        e.preventDefault();
        e.stopPropagation();
        open();
      }
    };
    window.addEventListener("kintsugi:publish", onEvent);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("kintsugi:publish", onEvent);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, path]);

  const close = () => { run.current++; setPhase({ kind: "closed" }); viewRef.current?.focus(); };

  const markComplete = async () => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: setField(view.state.doc.toString(), "status", "complete") });
    await prepare({ kind, appendix });
  };

  const write = async () => {
    if (phase.kind !== "plan" || !phase.plan.ready || !path) return;
    const { plan, repo } = phase;
    setPhase({ kind: "writing", plan, repo });
    try {
      const result = await blog.publish({
        source: path, file: plan.file, replaces: plan.replaces, content: plan.content,
        images: plan.images.map(({ from, to }) => ({ from, to })),
      });
      // The document remembers where it went, as ordinary (undoable) edits.
      const view = viewRef.current;
      if (view) {
        for (const [key, value] of publishedFields(plan)) {
          if (field(view.state.doc.toString(), key) !== value) view.dispatch({ changes: setField(view.state.doc.toString(), key, value) });
        }
        await flush();
      }
      setPhase({ kind: "done", plan, result });
    } catch (e) {
      toast.error(String(e));
      setPhase({ kind: "plan", plan, repo });
    }
  };

  const plan = phase.kind === "plan" || phase.kind === "writing" || phase.kind === "done" ? phase.plan : null;
  const images = useMemo(() => new Map(plan?.images.map((i) => [i.url, i.from]) ?? []), [plan]);
  const errors = plan?.checks.filter((c) => c.level === "error") ?? [];
  const current = viewRef.current?.state.doc.toString() ?? "";
  const draft = plan && !field(current, "mirror") && field(current, "status") !== "complete";

  return (
    <Dialog open={phase.kind !== "closed"} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="publish-dialog sm:max-w-3xl" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{phase.kind === "done" ? "Written to the blog" : "Publish to the blog"}</DialogTitle>
          <DialogDescription>
            {phase.kind === "done"
              ? "The post is in the blog's working tree. Review it, then commit and push when you're ready."
              : "Kintsugi writes the post into the blog repository. You commit and push."}
          </DialogDescription>
        </DialogHeader>

        {phase.kind === "loading" && <p className="text-sm text-muted-foreground">Checking the post…</p>}

        {phase.kind === "setup" && (
          <div className="space-y-3 text-sm">
            <p>{phase.error ?? phase.status?.error ?? "Choose the blog's folder (the hussain.ph repository) in Settings first."}</p>
            <Button variant="outline" onClick={() => { close(); window.dispatchEvent(new CustomEvent("kintsugi:open-settings")); }}>Open Settings</Button>
          </div>
        )}

        {plan && phase.kind !== "done" && (
          <>
            <div className="publish-bar">
              <div role="radiogroup" aria-label="Kind of post" className="publish-segments">
                {(["writing", "note"] as const).map((k) => (
                  <button key={k} role="radio" aria-checked={plan.kind === k} disabled={phase.kind === "writing"} onClick={() => { setKind(k); void prepare({ kind: k, appendix }); }}>
                    {k === "writing" ? "Essay" : "Note"}
                  </button>
                ))}
              </div>
              <label className="publish-toggle">
                <Switch checked={!!appendix} disabled={phase.kind === "writing"} onCheckedChange={(on) => { setAppendix(on); void prepare({ kind, appendix: on }); }} aria-label="Sources appendix" />
                Sources appendix
              </label>
              <span className="publish-target" title={plan.file}>{new URL(plan.url).pathname}</span>
            </div>

            <ul className="publish-checks" aria-label="Checks">
              {plan.checks.length === 0 && <li data-level="ok"><CheckIcon size={14} /> Ready: no broken links, images or components.</li>}
              {plan.checks.map((c, i) => (
                <li key={i} data-level={c.level}>
                  {c.level === "error" ? <AlertCircle size={14} /> : c.level === "warning" ? <AlertTriangle size={14} /> : <Info size={14} />}
                  <span>{c.message}</span>
                </li>
              ))}
            </ul>

            <div className="publish-tabs" role="tablist">
              <button role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>Preview</button>
              <button role="tab" aria-selected={tab === "file"} onClick={() => setTab("file")}>File</button>
            </div>
            <div className="publish-pane" role="tabpanel">
              {tab === "preview" ? (
                <Preview title={plan.title} kind={plan.kind} date={plan.date} tags={plan.tags} body={plan.body} images={images} />
              ) : (
                <div className="publish-file">
                  <p><strong>{plan.file}</strong>{plan.replaces && <> (replaces {plan.replaces})</>}</p>
                  {plan.images.map((i) => <p key={i.to}>{i.to} <span>← {i.from}</span></p>)}
                  <pre aria-label="Post file">{plan.content}</pre>
                </div>
              )}
            </div>

            <div className="publish-actions">
              <span className="text-xs text-muted-foreground">{phase.kind === "plan" || phase.kind === "writing" ? phase.repo : ""}</span>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              {draft ? (
                <Button onClick={markComplete}>Mark complete</Button>
              ) : (
                <Button disabled={!plan.ready || phase.kind === "writing"} onClick={write} title={errors.length ? "Fix the errors above first" : undefined}>
                  {phase.kind === "writing" ? "Writing…" : plan.republish ? "Update the post" : "Write to blog"}
                </Button>
              )}
            </div>
          </>
        )}

        {phase.kind === "done" && <Done plan={phase.plan} result={phase.result} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}

function Done({ plan, result, onClose }: { plan: PublishPlan; result: Published; onClose: () => void }) {
  const files = [...new Set([...result.written, ...result.removed])];
  const commands = [
    `cd ${shellQuote(result.repo)}`,
    `git add ${files.map(shellQuote).join(" ")}`,
    `git commit -m ${shellQuote(`${plan.republish ? "Update" : "Publish"}: ${plan.title ?? plan.id}`)}`,
    "git push",
  ].join("\n");
  return (
    <div className="space-y-3 text-sm">
      <ul className="publish-written" aria-label="Changed in the blog repository">
        {result.written.map((f) => <li key={f}><CheckIcon size={13} /> {f}</li>)}
        {result.removed.map((f) => <li key={f} data-removed><span>−</span> {f}</li>)}
      </ul>
      <p className="text-muted-foreground">It will appear at <strong className="text-foreground">{plan.url}</strong> once pushed.</p>
      {result.import && <p className="text-xs text-muted-foreground">{importSummary(result.import)}</p>}
      <p className="text-xs text-muted-foreground">Kintsugi never commits or pushes. When you're ready:</p>
      <pre className="publish-commands">{commands}</pre>
      <div className="publish-actions">
        <Button variant="outline" onClick={() => navigator.clipboard.writeText(commands).then(() => toast("Copied."), (e) => toast.error(String(e)))}><Copy size={14} /> Copy commands</Button>
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}
