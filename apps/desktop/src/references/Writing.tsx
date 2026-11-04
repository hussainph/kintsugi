import { isolateHistory } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { alternativePanelCommands, alternativesPanelModel, closeAlternatives, openAlternatives, type Alternatives, type VersionCard as VersionCardModel, type VersionCardActions } from "@kintsugi/editor/alternatives";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import type { Clip } from "@kintsugi/core/clips";
import { attributedQuote, linkFor, type ReferenceSource } from "@kintsugi/core/references";
import { Editor, stashRewrite, textAfterCuts, type CommandSkill, type Commands, type KinAnchor, type MarkCard as Card, type MarkCardActions, type Marks } from "@kintsugi/editor/Editor";
import { Button } from "@kintsugi/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@kintsugi/ui/components/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@kintsugi/ui/components/tooltip";
import { beginComment, passageAnchor } from "@/comments/api";
import { discuss, openThread, threads } from "@/lib/chat";
import { passageChips } from "@/kin/screen";
import { words } from "@/refine/marks";
import { ReviewBar, TrimBar, type TrimCount } from "@/refine/TrimBar";
import { MarkCard } from "@/refine/MarkCard";
import { discussNote } from "@/refine/review";
import { registerReviewer, showReview, startReview, stopReview, useReviewing, useReviewVersion } from "@/refine/reviews";
import { useComments } from "@/comments/useComments";
import { useAlternatives } from "@/alternatives/useAlternatives";
import { Versions } from "@/alternatives/Versions";
import { VersionCard } from "@/alternatives/VersionCard";
import { useWritingStash } from "@/stash/WritingStash";
import { hideMargin, marginState, showMargin, useMargin, visibleTab } from "@/margin/state";
import { registerInsert, type Found } from "@/lib/insert";
import { memory } from "@/lib/kin";
import { ideasForDraft } from "@/ideas/api";
import { type Action } from "@/refine/prompts";
import { skillAction } from "@/refine/kin";
import { SelectionMenu } from "@/refine/SelectionMenu";
import { MarginPortal } from "@/margin/Portal";
import { UsedIn } from "./UsedIn";
import { useReferenceIndex } from "./useReferenceIndex";
import { useReferenceSearch } from "./useReferenceSearch";
import "./references.css";

type Props = Omit<ComponentProps<typeof Editor>, "references" | "commands"> & {
  root: string | null;
  onOpenDoc: (path: string) => void;
  onOpenClip?: (path: string) => void;
  /** Opens ⌘K on a range, running `action` straight away when given. */
  onRefine?: (from: number, to: number, action?: Action) => void;
};
const name = (path: string) => path.replace(/^.*\//, "").replace(/\.mdx?$/, "");
const documentFirst = (a: ReferenceSource, b: ReferenceSource) => Number(a.kind === "clip") - Number(b.kind === "clip");

/** Editor-only integration: the library can replace this view without losing
 * the shared index. The references render into the margin's References tab
 * (KI-103); open or closed is the margin's, never the cursor's. They never
 * produce or change the writer's words. */
export function Writing({ root, onOpenDoc, onOpenClip, onRefine, ...editor }: Props) {
  const index = useReferenceIndex(root);
  const activePath = useRef(editor.path);
  activePath.current = editor.path;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [paragraph, setParagraph] = useState("");
  const [related, setRelated] = useState<ReferenceSource[]>([]);
  const [clip, setClip] = useState<ReferenceSource | null>(null);
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
  // Kin's chat adds a web source here as a link (KI-78): after the
  // selection, never over it, so none of his words are replaced.
  const append = useCallback((text: string) => {
    const view = editor.viewRef.current;
    if (!view || !text) return;
    const at = view.state.selection.main.to;
    const before = at > 0 && !/\s/.test(view.state.sliceDoc(at - 1, at)) ? " " : "";
    const replacement = before + text;
    view.dispatch({ changes: { from: at, insert: replacement }, selection: { anchor: at + replacement.length }, annotations: isolateHistory.of("full"), userEvent: "input.reference" });
  }, [editor.viewRef]);
  // An edit Kin proposed in the chat, which he applies (KI-79): the
  // passage as Kin quoted it, found once in the document, replaced as one
  // undoable change.
  const find = useCallback((passage: string): Found => {
    const view = editor.viewRef.current;
    const text = view?.state.doc.toString() ?? "";
    const at = passage ? text.indexOf(passage) : -1;
    if (at < 0) return "missing";
    return text.indexOf(passage, at + 1) >= 0 ? "ambiguous" : "once";
  }, [editor.viewRef]);
  const replace = useCallback((passage: string, next: string) => {
    const view = editor.viewRef.current;
    if (!view || find(passage) !== "once") return false;
    const from = view.state.doc.toString().indexOf(passage);
    view.dispatch({ changes: { from, to: from + passage.length, insert: next }, selection: { anchor: from + next.length }, scrollIntoView: true, annotations: isolateHistory.of("full"), userEvent: "input.kin" });
    return true;
  }, [editor.viewRef, find]);
  useEffect(() => (editor.readOnly ? undefined : registerInsert(editor.path, append, { find, replace })), [editor.readOnly, editor.path, append, find, replace]);
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
  const marginEmpty = referenced.length + related.length + backlinks.length + unresolved.length === 0;
  const readClipText = useCallback(async (source: ReferenceSource) => (await invoke<Clip>("clip_read", { path: source.path })).text, []);
  const onReferenceError = useCallback((error: unknown) => toast.error(String(error)), []);
  // @Kin: a comment thread on the paragraph (KI-38). Kin replies in the
  // margin; the thread's messages are in Kin's one conversation log.
  const onKin = useCallback((anchor: KinAnchor) => {
    const view = editor.viewRef.current;
    if (view) beginComment(view, anchor.from, anchor.to, "mention");
  }, [editor.viewRef]);
  const comments = useComments(editor.path, editor.viewRef, sources, open);
  // Kin's gold marks (KI-90). A trim's preview shows its word counts; the
  // focused mark's card (KI-109) renders here, into the block the editor
  // puts under its paragraph.
  const [trim, setTrim] = useState<TrimCount | null>(null);
  const [card, setCard] = useState<{ dom: HTMLElement; card: Card; actions: MarkCardActions } | null>(null);
  const marks = useMemo<Marks>(() => ({
    onChange: (value, state) => {
      const scope = value.batch?.kind === "trim" ? value.batch.scope : null;
      setTrim(scope && { before: words(state.sliceDoc(scope.from, scope.to)).length, after: words(textAfterCuts(state, scope)).length });
    },
    // A thread on the paragraph that opens with the suggestion as Kin's note.
    onDiscuss: (mark) => {
      const view = editor.viewRef.current;
      if (!view) return;
      const path = activePath.current;
      const { from, to } = mark.range;
      const anchor = passageAnchor(view, path, from, to);
      if (!anchor?.quote) {
        discuss(passageChips(view, path, from, to), undefined, { anchor });
        return;
      }
      threads.reviewDiscuss(path, anchor.quote, discussNote(mark, view.state.sliceDoc(from, to)))
        .then((thread) => openThread(thread.id))
        .catch((error) => toast.error(String(error)));
    },
    onStash: (mark) => {
      const view = editor.viewRef.current;
      const stashed = !!view && mark.text !== undefined && !!stashRewrite(view, mark.range, mark.text);
      // The stash shows where it went (KI-110): a lit row or a dot, no toast.
      if (!stashed) toast.error("Couldn’t add to stash");
      return stashed;
    },
    renderCard: (dom, next, actions) => {
      setCard({ dom, card: next, actions });
      return () => setCard((now) => (now?.dom === dom ? null : now));
    },
  }), [editor.viewRef]);
  // The card's height is known once React has drawn it.
  useLayoutEffect(() => { if (card) editor.viewRef.current?.requestMeasure(); }, [card, editor.viewRef]);
  // A review he asked for (KI-109) shows once its document is the one open.
  const reviewing = useReviewing(editor.path);
  const reviewVersion = useReviewVersion();
  useEffect(() => {
    const view = editor.viewRef.current;
    if (view) showReview(view, editor.path);
  }, [reviewVersion, editor.path, editor.viewRef]);
  useEffect(() => registerReviewer(editor.path, (kind) => {
    const view = editor.viewRef.current;
    if (view && activePath.current === editor.path) void startReview(view, editor.path, kind);
  }), [editor.path, editor.viewRef]);
  const alternatives = useAlternatives(editor.path);
  const margin = useMargin();
  const [versionModel, setVersionModel] = useState<ReturnType<typeof alternativesPanelModel>>(null);
  const cursorOpening = useRef(false);
  const showStash = useCallback(() => showMargin("stash"), []);
  const stash = useWritingStash({ root, path: editor.path, viewRef: editor.viewRef, readOnly: editor.readOnly, show: showStash });
  const onPanelClose = useCallback(() => {
    if (visibleTab(marginState()) === "stash") hideMargin();
  }, []);
  const onPanelOpen = useCallback(() => {
    showStash();
    if (!cursorOpening.current) requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".ki-versions input")?.focus());
  }, [showStash]);
  // The cursor's span's `‹ 2 of 3 ›` (KI-111), drawn into the editor's block like the mark card.
  const [versionCard, setVersionCard] = useState<{ dom: HTMLElement; card: VersionCardModel; actions: VersionCardActions } | null>(null);
  useLayoutEffect(() => { if (versionCard) editor.viewRef.current?.requestMeasure(); }, [versionCard, editor.viewRef]);
  const versionHost = useMemo<Alternatives>(() => ({
    ...(alternatives ?? { path: "", sets: [], onSave: () => {} }),
    externalPanel: true, onPanelOpen, onPanelClose, onPanelChange: setVersionModel,
    renderCard: (dom, next, actions) => {
      setVersionCard({ dom, card: next, actions });
      return () => setVersionCard((now) => (now?.dom === dom ? null : now));
    },
  }), [alternatives, onPanelOpen, onPanelClose]);
  // A blank paragraph has no version target. Once the cursor reaches words,
  // start following it without stealing focus back from the draft.
  const followVersions = useMemo(() => EditorView.updateListener.of((update) => {
    if (!update.selectionSet || visibleTab(marginState()) !== "stash" || alternativesPanelModel(update.state)) return;
    queueMicrotask(() => {
      const view = editor.viewRef.current;
      if (!view || view.state !== update.state || visibleTab(marginState()) !== "stash") return;
      cursorOpening.current = true;
      try { openAlternatives(view); } finally { cursorOpening.current = false; }
    });
  }), [editor.viewRef]);
  const extensions = useMemo(() => [editor.extensions ?? [], followVersions, stash.extension], [editor.extensions, followVersions, stash.extension]);
  useEffect(() => {
    const view = editor.viewRef.current;
    if (!view) return;
    if (margin.showing("stash")) {
      if (!alternativesPanelModel(view.state)) {
        cursorOpening.current = true;
        try { openAlternatives(view); } finally { cursorOpening.current = false; }
      }
    } else closeAlternatives(view);
  }, [margin.tab, editor.path, alternatives?.path, editor.viewRef]);
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
      if (action.id === "review" && view) void startReview(view, activePath.current, "draft");
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
      <Editor {...editor} references={options} commands={commands} comments={comments} alternatives={versionHost} stash={stash.config} marks={marks} extensions={extensions} />
      {trim && editor.viewRef.current && <TrimBar view={editor.viewRef.current} count={trim} />}
      {reviewing && !trim && <ReviewBar onStop={() => stopReview(editor.path)} />}
      {card && createPortal(<MarkCard card={card.card} actions={card.actions} />, card.dom)}
      {versionCard && createPortal(<VersionCard card={versionCard.card} actions={versionCard.actions} />, versionCard.dom)}
      {onRefine && <SelectionMenu viewRef={editor.viewRef} path={editor.path} onRefine={onRefine} />}
      <MarginPortal tab="stash">{stash.content(<Versions model={versionModel} viewRef={editor.viewRef} onAsk={() => { const view = editor.viewRef.current; if (view) alternativePanelCommands(view).askKin(); }} />)}</MarginPortal>
      <MarginPortal tab="references">
        <div className="reference-margin">
          {index.error && <button className="reference-error" onClick={index.refresh}>References unavailable · Retry</button>}
          {marginEmpty && !index.error && <p className="ki-margin-empty">Nothing related to this paragraph.</p>}
          <MarginSection title="Referenced here" sources={referenced} all={sources} root={root} onOpen={open} onInsert={insert} onQuote={quote} />
          {unresolved.map((target) => <Tooltip key={target}><TooltipTrigger asChild><p className="reference-missing">{target}<span>not found</span></p></TooltipTrigger><TooltipContent>No matching document or clip</TooltipContent></Tooltip>)}
          <MarginSection title="Along this paragraph" sources={related.map((item) => byPath.get(item.path) ?? item)} all={sources} root={root} onOpen={open} onInsert={insert} onQuote={quote} />
          <MarginSection title="Links here" sources={backlinks} all={sources} root={root} onOpen={open} onInsert={insert} onQuote={quote} />
        </div>
      </MarginPortal>
      {clip && <ClipCard key={`${root}:${clip.path}`} root={root} source={clip} onClose={() => setClip(null)} onQuote={() => quote(clip)} onReference={() => { setClip(null); insert(linkFor(clip, sources)); }} onOpenDoc={onOpenDoc} />}
    </div>
  );
}

const ACTIONS = [
  { id: "ideas", label: "Ideas for this draft", description: "Open Ideas filtered to this document" },
  { id: "review", label: "Review this draft", description: "Kin marks what to cut, rewrite or look at" },
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
    <Tooltip><TooltipTrigger asChild><button className="reference-card-main" onClick={() => onOpen(source)}>
      {source.image && <img src={source.image} alt="" loading="lazy" />}
      <span><strong>{source.title}</strong><small>{source.kind === "document" ? source.status ?? "Document" : source.site ?? "Clip"}</small></span>
    </button></TooltipTrigger><TooltipContent>{source.kind === "clip" ? "Open clip · drag to quote" : "Open document · drag to reference"}</TooltipContent></Tooltip>
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
    <DialogTitle>{source.title}</DialogTitle>
    <DialogDescription>{source.site || "Inspiration"}{clip?.author ? ` · ${clip.author}` : ""}</DialogDescription>{/* copy-lint-allow: the clip's source and author, not an explanation */}
    {source.image && <img src={source.image} alt="" className="max-h-60 w-full rounded-(--radius-s) object-cover" />}
    {source.summary && <p className="ki-text-s ki-muted">{source.summary}</p>}
    {error ? <p className="ki-text-s ki-error" role="alert">{error}</p> : <p role={!clip ? "status" : undefined} className="ki-prose whitespace-pre-wrap select-text">{clip ? clip.text || "No passage captured." : "Opening…"}</p>}
    <div className="flex items-center gap-[var(--space-xs)]"><Button ref={referenceButton} variant="outline" onClick={onReference}>Reference</Button><Button disabled={!clip?.text.trim()} onClick={onQuote}>Quote passage</Button>{clip?.url && /^https?:\/\//i.test(clip.url) && <button className="ki-source-link ki-text-xs ml-auto" onClick={() => { void openUrl(clip.url!).catch((error) => toast.error(String(error))); }}>Open source ↗</button>}</div>
    <UsedIn root={root} path={source.path} onOpen={(path) => { onClose(); onOpenDoc(path); }} />
  </DialogContent></Dialog>;
}
