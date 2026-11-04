import type { EditorView } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { linkFor, resolveReference, type ReferenceSource } from "@kintsugi/core/references";
import { closeComment, openComment, type CommentPlace, type Comments, type CommentThread } from "@kintsugi/editor/Editor";
import { selectionChip, type Chip } from "@/lib/chips";
import { type ChatEvent, discuss, onAsked, onOpenThread, openThread, type Thread, threads as api } from "@/lib/chat";
import { docChip } from "@/kin/screen";
import { useKin } from "@/kin/useKin";
import { takeOrigin } from "./api";

const toThread = (thread: Thread): CommentThread => ({
  id: thread.id,
  anchor: thread.anchor!.quote!,
  status: thread.status,
  origin: thread.origin,
  created: thread.created,
  orphaned: thread.anchor?.orphaned,
  // The Kin tab shows the messages; the editor only places the thread.
  messages: [],
});

/** The placeholder avatar (KI-41 designs the real one), as plain DOM. */
function kinMark() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "comment-kin-avatar");
  svg.dataset.kinAvatar = "placeholder";
  const circle = document.createElementNS(ns, "circle");
  circle.setAttribute("cx", "20"); circle.setAttribute("cy", "20"); circle.setAttribute("r", "19");
  circle.setAttribute("fill", "var(--foreground)");
  const seam = document.createElementNS(ns, "path");
  seam.setAttribute("d", "M11 9 L17 17 L14 22 L21 27 L19 33");
  seam.setAttribute("fill", "none"); seam.setAttribute("stroke", "#d4a53c"); seam.setAttribute("stroke-width", "2.4");
  seam.setAttribute("stroke-linecap", "round"); seam.setAttribute("stroke-linejoin", "round");
  svg.append(circle, seam);
  return svg as unknown as HTMLElement;
}

/**
 * The open document's paragraph threads for the editor (KI-104): placed
 * by their anchors and kept on their paragraphs as he edits, each with a
 * gutter mark that opens it in the Kin tab. A quick ask on a paragraph
 * shows a "Kin replied" chip under it until he opens it.
 */
export function useComments(path: string, viewRef: RefObject<EditorView | null>, sources: ReferenceSource[], open: (source: ReferenceSource) => void): Comments {
  const [threads, setThreads] = useState<{ path: string; list: Thread[] }>({ path: "", list: [] });
  const [asks, setAsks] = useState<Record<string, "asking" | "replied">>({});
  const pathRef = useRef(path);
  pathRef.current = path;
  const kin = useKin();

  const reload = useCallback(() => {
    const at = pathRef.current;
    api.list({ about: at, resolved: true, limit: 500 }).then((found) => {
      if (pathRef.current !== at) return;
      setThreads({ path: at, list: found.threads.filter((t) => t.anchor?.kind === "paragraph" && t.anchor.quote) });
    }).catch((error) => {
      if (pathRef.current === at) setThreads({ path: at, list: [] });
      console.warn("threads unavailable", error);
    });
  }, []);

  useEffect(() => {
    setAsks({});
    reload();
  }, [path, reload]);

  const ids = useRef(new Set<string>());
  ids.current = new Set(threads.list.map((t) => t.id));
  useEffect(() => {
    const off = listen<ChatEvent>("kin:chat", ({ payload: event }) => {
      switch (event.type) {
        case "thread":
          if (event.thread.anchor?.path === pathRef.current || ids.current.has(event.thread.id)) reload();
          return;
        case "entry":
          if (event.entry.role !== "owner") setAsks((a) => (a[event.entry.thread] === "asking" ? { ...a, [event.entry.thread]: "replied" } : a));
          return;
        case "threads":
        case "switched":
          return reload();
        case "reviewEnded":
          if (event.path === pathRef.current) reload();
          return;
      }
    });
    const offAsked = onAsked((thread) => {
      if (thread.anchor?.kind !== "paragraph" || thread.anchor.path !== pathRef.current) return;
      setThreads((t) => (t.path === pathRef.current && !t.list.some((x) => x.id === thread.id) ? { ...t, list: [thread, ...t.list] } : t));
      setAsks((a) => ({ ...a, [thread.id]: "asking" }));
      // He asked from here: bring the chip into view once the editor draws it.
      let tries = 0;
      const reveal = () => {
        const chip = document.querySelector<HTMLElement>(`[data-comment-ask="${CSS.escape(thread.id)}"]`);
        if (chip) chip.scrollIntoView({ block: "nearest" });
        else if (++tries < 30) requestAnimationFrame(reveal);
      };
      requestAnimationFrame(reveal);
    });
    // Opened anywhere: the chip has done its job.
    const offOpened = onOpenThread((id) => setAsks((a) => {
      if (!(id in a)) return a;
      const { [id]: _, ...rest } = a;
      return rest;
    }));
    return () => { off.then((stop) => stop()); offAsked(); offOpened(); };
  }, [reload]);

  // The thread open in the Kin tab lights up its paragraph.
  const shown = kin.visible && kin.mode.kind === "thread" ? kin.mode.id : null;
  const composing = kin.visible && kin.mode.kind === "new" && kin.mode.anchor?.kind === "paragraph";
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (shown && ids.current.has(shown)) openComment(view, shown);
    else if (!composing) closeComment(view);
  }, [shown, composing, viewRef, threads]);

  const chipsFor = useCallback((place: CommentPlace | null): Chip[] => {
    const at = pathRef.current;
    const doc = docChip(viewRef.current, at);
    const paragraph = place && selectionChip(at, place.text, place.fromLine, place.toLine);
    return paragraph ? [paragraph, doc] : [doc];
  }, [viewRef]);

  const list = useMemo(() => threads.list.map(toThread), [threads.list]);
  const live = useMemo(() => Object.fromEntries(Object.entries(kin.live).filter(([id]) => ids.current.has(id)).map(([id, l]) => [id, l.text])), [kin.live]);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  return useMemo<Comments>(() => ({
    path: threads.path,
    threads: list,
    live,
    asks,
    // Threads show in the Kin tab, not in a popover.
    onOpen: (id) => openThread(id),
    onStart: (anchor, place) => {
      const at = pathRef.current;
      discuss(chipsFor(place), undefined, { anchor: { kind: "paragraph", path: at, quote: anchor }, origin: takeOrigin() });
    },
    onCreate: () => Promise.reject(new Error("Threads start in the Kin tab.")),
    onReply: () => {},
    onStatus: () => {},
    onMoved: (moves) => {
      const at = pathRef.current;
      api.moved(at, moves).catch((error) => console.warn("thread anchors not saved", error));
    },
    link: (target) => {
      const source = resolveReference(target, sourcesRef.current);
      return source ? { label: source.title, link: linkFor(source, sourcesRef.current) } : null;
    },
    onOpenLink: (target) => {
      const source = resolveReference(target, sourcesRef.current);
      if (source) open(source);
    },
    kinMark,
  }), [threads.path, list, live, asks, chipsFor, open]);
}
