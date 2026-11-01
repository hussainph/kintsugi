import { isolateHistory } from "@codemirror/commands";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PanelRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { toast } from "sonner";
import type { Clip } from "@kintsugi/core/clips";
import { attributedQuote, linkFor, type ReferenceSource } from "@kintsugi/core/references";
import { Editor, type CommandSkill, type Commands, type KinAnchor } from "@kintsugi/editor/Editor";
import { Button } from "@kintsugi/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@kintsugi/ui/components/dialog";
import { beginComment, reviewDraft } from "@/comments/api";
import { useComments } from "@/comments/useComments";
import { memory } from "@/lib/kin";
import { ideasForDraft } from "@/ideas/api";
import { type Action } from "@/refine/prompts";
import { skillAction } from "@/refine/kin";
import { UsedIn } from "./UsedIn";
import { useReferenceIndex } from "./useReferenceIndex";
import { useReferenceSearch } from "./useReferenceSearch";
import "./references.css";

type Props = Omit<ComponentProps<typeof Editor>, "references" | "commands"> & {
  root: string | null;
  onOpenDoc: (path: string) => void;
  onOpenClip?: (path: string) => void;
  /** Opens ⌘K's review on a range, running `action` straight away. */
  onRefine?: (from: number, to: number, action: Action) => void;
};
const name = (path: string) => path.replace(/^.*\//, "").replace(/\.mdx?$/, "");
const documentFirst = (a: ReferenceSource, b: ReferenceSource) => Number(a.kind === "clip") - Number(b.kind === "clip");

/** Editor-only integration: the library can replace this view without losing
 * the shared index. The margin never produces or changes the writer's words. */
export function Writing({ root, onOpenDoc, onOpenClip, onRefine, ...editor }: Props) {
  const index = useReferenceIndex(root);
  const activePath = useRef(editor.path);
  activePath.current = editor.path;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [paragraph, setParagraph] = useState("");
  const [related, setRelated] = useState<ReferenceSource[]>([]);
  const [clip, setClip] = useState<ReferenceSource | null>(null);
  const [margin, setMargin] = useState(() => {
    try {
      const saved = localStorage.getItem("kintsugi:margin");
      return saved ? saved === "visible" : window.matchMedia("(min-width: 1001px)").matches;
    } catch { return window.innerWidth > 1000; }
  });
  const rawSources = useMemo<ReferenceSource[]>(() => [
    ...index.documents.map((document) => ({
      kind: "document" as const, path: document.path, title: document.title || name(document.path), status: document.status,
      text: document.text, summary: document.text.trim().replace(/^#+\s+[^\n]+\n*/, "").slice(0, 200),
    })),
    ...index.clips.map((clip) => ({ kind: "clip" as const, path: clip.path, title: clip.title || name(clip.path), site: clip.site, summary: clip.summary, quoteBy: clip.quoteBy, quoteLink: clip.quoteLink })),
  ], [index.documents, index.clips]);
  const { sources, search, warmImages } = useReferenceSearch(root, rawSources, index.clips);
  const byPath = useMemo(() => new Map(sources.map((source) => [source.path, source])), [sources]);
  const referenced = useMemo(() => {
    const paths = new Set(index.links.filter((link) => link.source === editor.path && link.resolved).map((link) => link.resolved!));
    return sources.filter((source) => paths.has(source.path)).sort(documentFirst);
  }, [index.links, editor.path, sources]);
  const unresolved = useMemo(() => [...new Set(index.links.filter((link) => link.source === editor.path && !link.resolved).map((link) => link.target))], [index.links, editor.path]);
  const backlinks = useMemo(() => {
    const paths = new Set(index.links.filter((link) => link.resolved === editor.path && link.source !== editor.path).map((link) => link.source));
    return sources.filter((source) => paths.has(source.path));
  }, [index.links, editor.path, sources]);

  // Lexical recommendations are deliberately modest. Stop words don't turn
  // every paragraph into a suggestion; a blank paragraph shows no suggestions.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const terms = paragraphTerms(paragraph);
      if (!terms.length) { setRelated([]); return; }
      const counts = new Map<string, { source: ReferenceSource; score: number }>();
      let matches: ReferenceSource[][];
      try { matches = await Promise.all(terms.map(search)); }
      catch { if (!cancelled) setRelated([]); return; }
      for (const results of matches) {
        for (const source of results) {
          if (source.path === editor.path || referenced.some((item) => item.path === source.path)) continue;
          const previous = counts.get(source.path);
          counts.set(source.path, { source, score: (previous?.score ?? 0) + 1 });
        }
      }
      if (!cancelled) setRelated([...counts.values()].sort((a, b) => documentFirst(a.source, b.source) || b.score - a.score || a.source.title.localeCompare(b.source.title)).map((item) => item.source).slice(0, 6));
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [paragraph, editor.path, search, referenced]);

  useEffect(() => { warmImages([...referenced, ...related].map((source) => source.path)); }, [referenced, related, warmImages]);

  const open = useCallback((source: ReferenceSource) => {
    if (source.kind === "document") onOpenDoc(source.path);
    else if (onOpenClip) onOpenClip(source.path);
    else setClip(source);
  }, [onOpenDoc, onOpenClip]);
  const insert = useCallback((text: string) => {
    const view = editor.viewRef.current;
    if (!view || !text) return;
    const { from, to } = view.state.selection.main;
    const block = text.startsWith(">");
    const before = block && from > 0 && view.state.sliceDoc(0, from).slice(-2) !== "\n\n" ? "\n\n" : "";
    const after = block ? "\n\n" : "";
    const replacement = before + text + after;
    view.dispatch({ changes: { from, to, insert: replacement }, selection: { anchor: from + replacement.length }, annotations: isolateHistory.of("full"), userEvent: "input.reference" });
    view.focus();
  }, [editor.viewRef]);
  const quote = useCallback(async (source: ReferenceSource) => {
    const path = activePath.current;
    try {
      const clip = source.kind === "clip" ? await invoke<Clip>("clip_read", { path: source.path }) : null;
      const passage = clip ? clip.text : source.text || "";
      if (!mounted.current || activePath.current !== path) return;
      const text = attributedQuote(passage, linkFor(source, sources), clip);
      if (!text) { toast("This clip has no passage to quote. Insert its reference instead."); return; }
      setClip(null);
      insert(text);
    } catch (error) { toast.error(String(error)); }
  }, [sources, insert]);
  const hasMargin = referenced.length + related.length + backlinks.length + unresolved.length > 0;
  const readClipText = useCallback(async (source: ReferenceSource) => (await invoke<Clip>("clip_read", { path: source.path })).text, []);
  const onReferenceError = useCallback((error: unknown) => toast.error(String(error)), []);
  // @Kin: a comment thread on the paragraph (KI-38). Kin replies in the
  // margin; the thread's messages are in Kin's one conversation log.
  const onKin = useCallback((anchor: KinAnchor) => {
    const view = editor.viewRef.current;
    if (view) beginComment(view, anchor.from, anchor.to, "mention");
  }, [editor.viewRef]);
  const comments = useComments(editor.path, editor.viewRef, sources, open);
  const options = useMemo(() => ({ sources, search, readClipText, onError: onReferenceError, onOpen: open, onParagraph: setParagraph, onKin }), [sources, search, readClipText, onReferenceError, open, onKin]);

  // Skills flagged for the / menu. Re-read when he comes back to the window,
  // since About you or Kin may have changed them.
  const [skills, setSkills] = useState<CommandSkill[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => memory.skills().then((all) => { if (!cancelled) setSkills(all.filter((skill) => skill.command).map(({ name, description }) => ({ name, description }))); }).catch(() => {});
    load();
    window.addEventListener("focus", load);
    return () => { cancelled = true; window.removeEventListener("focus", load); };
  }, [root]);
  const commands = useMemo<Commands>(() => ({
    skills,
    actions: ACTIONS,
    onAction: (action) => {
      if (action.id === "ideas") ideasForDraft(activePath.current);
      const view = editor.viewRef.current;
      if (action.id === "review" && view) reviewDraft(view, activePath.current);
    },
    onSkill: (skill, range) => {
      if (!range) { toast("Write or select something for the skill to work on."); return; }
      const path = activePath.current;
      memory.skill(skill.name).then((full) => {
        if (activePath.current === path) onRefine?.(range.from, range.to, skillAction(full));
      }).catch((error) => toast.error(String(error)));
    },
  }), [skills, onRefine, editor.viewRef]);

  return (
    <div className="reference-writing">
      <Editor {...editor} references={options} commands={commands} comments={comments} />
      <button className="reference-toggle" aria-label={margin ? "Hide reference margin" : "Show reference margin"} aria-pressed={margin} title="Reference margin" onClick={() => {
        const next = !margin; setMargin(next);
        try { localStorage.setItem("kintsugi:margin", next ? "visible" : "hidden"); } catch { /* A convenience only. */ }
      }}><PanelRight size={15} /></button>
      {margin && hasMargin && <aside className="reference-margin" aria-label="Reference margin">
        <MarginSection title="Referenced here" sources={referenced} all={sources} root={root} onOpen={open} onInsert={insert} onQuote={quote} />
        {unresolved.map((target) => <p className="reference-missing" key={target} title="No matching document or clip">{target}<span>not found</span></p>)}
        <MarginSection title="Along this paragraph" sources={related.map((item) => byPath.get(item.path) ?? item)} all={sources} root={root} onOpen={open} onInsert={insert} onQuote={quote} />
        <MarginSection title="Links here" sources={backlinks} all={sources} root={root} onOpen={open} onInsert={insert} onQuote={quote} />
      </aside>}
      {index.error && <button className="reference-error" onClick={index.refresh}>References unavailable · Retry</button>}
      {clip && <ClipCard key={`${root}:${clip.path}`} root={root} source={clip} onClose={() => setClip(null)} onQuote={() => quote(clip)} onReference={() => { setClip(null); insert(linkFor(clip, sources)); }} onOpenDoc={onOpenDoc} />}
    </div>
  );
}

const ACTIONS = [
  { id: "ideas", label: "Ideas for this draft", description: "Open Ideas filtered to this document" },
  { id: "review", label: "Kin, review this draft", description: "Kin reads it and leaves comments on paragraphs" },
];

const stopWords = new Set("a about after again all also an and any are as at be because been before being between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves".split(" "));
export function paragraphTerms(text: string): string[] {
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return [...new Set(words.filter((word) => !stopWords.has(word)))].slice(0, 5);
}

type SectionProps = { title: string; sources: ReferenceSource[]; all: ReferenceSource[]; root: string | null; onOpen: (source: ReferenceSource) => void; onInsert: (text: string) => void; onQuote: (source: ReferenceSource) => void };
function MarginSection({ title, sources, ...props }: SectionProps) {
  if (!sources.length) return null;
  return <section className="reference-section"><h2>{title}</h2>{sources.map((source) => <MarginCard key={source.path} source={source} {...props} />)}</section>;
}
function MarginCard({ source, all, onOpen, onInsert, onQuote }: Omit<SectionProps, "title" | "sources"> & { source: ReferenceSource }) {
  const [passage, setPassage] = useState<string | null>(source.kind === "document" ? source.text ?? "" : null);
  useEffect(() => {
    if (source.kind !== "clip") return;
    let cancelled = false;
    void invoke<Clip>("clip_read", { path: source.path }).then((clip) => { if (!cancelled) setPassage(clip.text); }).catch(() => { if (!cancelled) setPassage(""); });
    return () => { cancelled = true; };
  }, [source]);
  const link = linkFor(source, all);
  const dragText = source.kind === "clip" ? attributedQuote(passage ?? "", link, source) || link : link;
  return <article className="reference-card" draggable={passage !== null} onDragStart={(event) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-kintsugi-reference", JSON.stringify({ text: dragText }));
    event.dataTransfer.setData("text/plain", dragText);
  }}>
    <button className="reference-card-main" onClick={() => onOpen(source)} title={source.kind === "clip" ? "Open clip · drag to quote" : "Open document · drag to reference"}>
      {source.image && <img src={source.image} alt="" loading="lazy" />}
      <span><strong>{source.title}</strong><small>{source.kind === "document" ? source.status ?? "Document" : source.site ?? "Clip"}</small></span>
    </button>
    {source.summary && <p>{source.summary}</p>}
    <div className="reference-card-actions"><button onClick={() => onInsert(link)}>Reference</button>{source.kind === "clip" && passage?.trim() && <button onClick={() => onQuote(source)}>Quote</button>}</div>
  </article>;
}
function ClipCard({ root, source, onClose, onQuote, onReference, onOpenDoc }: { root: string | null; source: ReferenceSource; onClose: () => void; onQuote: () => void; onReference: () => void; onOpenDoc: (path: string) => void }) {
  const [clip, setClip] = useState<Clip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const referenceButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<Clip>("clip_read", { path: source.path }).then((clip) => { if (!cancelled) setClip(clip); }).catch((error) => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; };
  }, [source.path]);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto" onOpenAutoFocus={(event) => { event.preventDefault(); referenceButton.current?.focus(); }} onCloseAutoFocus={(event) => event.preventDefault()}>
    <DialogTitle className="pr-6 leading-snug">{source.title}</DialogTitle>
    <DialogDescription>{source.site || "Inspiration"}{clip?.author ? ` · ${clip.author}` : ""}</DialogDescription>
    {source.image && <img src={source.image} alt="" className="max-h-60 w-full rounded-md object-cover" />}
    {source.summary && <p className="text-sm text-muted-foreground">{source.summary}</p>}
    {error ? <p className="text-sm text-muted-foreground">{error}</p> : <p className="whitespace-pre-wrap select-text font-[family-name:var(--font-prose)] leading-relaxed">{clip ? clip.text || "No passage captured." : "Opening…"}</p>}
    <div className="flex items-center gap-2"><Button ref={referenceButton} variant="outline" onClick={onReference}>Reference</Button><Button disabled={!clip?.text.trim()} onClick={onQuote}>Quote passage</Button>{clip?.url && /^https?:\/\//i.test(clip.url) && <button className="ml-auto text-xs text-muted-foreground hover:underline" onClick={() => { void openUrl(clip.url!).catch((error) => toast.error(String(error))); }}>Open source ↗</button>}</div>
    <UsedIn root={root} path={source.path} onOpen={(path) => { onClose(); onOpenDoc(path); }} />
  </DialogContent></Dialog>;
}
