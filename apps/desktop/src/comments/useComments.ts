import type { EditorView } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { linkFor, resolveReference, type ReferenceSource } from "@kintsugi/core/references";
import type { CommentPlace, Comments, CommentThread } from "@kintsugi/editor/Editor";
import { selectionChip, type Chip } from "@/lib/chips";
import type { ChatEvent } from "@/lib/chat";
import { docChip } from "@/kin/screen";
import { comments as api, reviewDraft, takeOrigin, type CommentsPage, type StoredThread } from "./api";

const toThread = (stored: StoredThread): CommentThread => ({
  id: stored.id,
  anchor: stored.anchor,
  status: stored.status,
  origin: stored.origin,
  created: stored.created,
  orphaned: stored.orphaned,
  messages: stored.entries.map((e) => ({ seq: e.seq, role: e.role, text: e.text, at: e.at, interrupted: e.interrupted, error: e.error })),
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
 * The open document's comment threads for the editor: loaded from the
 * backend, kept live from `kin:chat` (new entries, Kin's streaming reply,
 * reviews), with the editor's actions wired to the commands.
 */
export function useComments(path: string, viewRef: RefObject<EditorView | null>, sources: ReferenceSource[], open: (source: ReferenceSource) => void): Comments {
  const [page, setPage] = useState<CommentsPage>({ path: "", threads: [], running: [] });
  const [live, setLive] = useState<Record<string, string>>({});
  const turns = useRef(new Map<string, string | null>());
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(() => {
    const at = pathRef.current;
    api.list(at).then((next) => {
      if (pathRef.current !== at) return;
      setPage(next);
      // Turns already running when the document opened.
      for (const run of next.running) turns.current.set(run.turn, run.comment);
      setLive((old) => {
        const now: Record<string, string> = {};
        for (const run of next.running) if (run.comment) now[run.comment] = old[run.comment] ?? "";
        return now;
      });
    }).catch((error) => {
      if (pathRef.current === at) setPage({ path: at, threads: [], running: [] });
      console.warn("comments unavailable", error);
    });
  }, []);

  useEffect(() => {
    turns.current.clear();
    setLive({});
    reload();
  }, [path, reload]);

  useEffect(() => {
    const off = listen<ChatEvent>("kin:chat", ({ payload: event }) => {
      const here = pathRef.current;
      switch (event.type) {
        case "entry":
          if ((event.entry.comment || event.entry.review) && event.entry.topic === here) reload();
          return;
        case "commentStarted":
          if (event.path !== here) return;
          turns.current.set(event.turn, event.comment);
          if (event.comment) setLive((l) => ({ ...l, [event.comment!]: "" }));
          return reload();
        case "turn": {
          const id = turns.current.get(event.turn);
          if (!id) return;
          const e = event.event;
          if (e.type === "text") setLive((l) => (id in l ? { ...l, [id]: l[id] + e.delta } : l));
          // Text before a tool call was thinking aloud.
          else if (e.type === "toolCall") setLive((l) => (id in l ? { ...l, [id]: "" } : l));
          return;
        }
        case "commentEnded":
          if (!turns.current.has(event.turn)) return;
          turns.current.delete(event.turn);
          if (event.comment) setLive((l) => { const { [event.comment!]: _, ...rest } = l; return rest; });
          return reload();
        case "comments":
          if (event.path === here) reload();
          return;
      }
    });
    return () => { off.then((stop) => stop()); };
  }, [reload]);

  const chipsFor = useCallback((place: CommentPlace | null): Chip[] => {
    const at = pathRef.current;
    const doc = docChip(viewRef.current, at);
    const paragraph = place && selectionChip(at, place.text, place.fromLine, place.toLine);
    return paragraph ? [paragraph, doc] : [doc];
  }, [viewRef]);

  const threads = useMemo(() => page.threads.map(toThread), [page.threads]);
  const reviewing = page.running.some((run) => run.comment === null);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  return useMemo<Comments>(() => ({
    path: page.path,
    threads,
    live,
    reviewing,
    onCreate: async (anchor, place, text) => {
      const at = pathRef.current;
      const thread = await api.create(at, anchor, takeOrigin(), text, chipsFor(place));
      setPage((p) => (p.path === at ? { ...p, threads: [...p.threads.filter((t) => t.id !== thread.id), thread] } : p));
      return thread.id;
    },
    onReply: (id, text, place) => {
      const at = pathRef.current;
      api.reply(at, id, text, chipsFor(place)).then(() => reload()).catch((error) => toast.error(String(error)));
    },
    onStatus: (id, status) => {
      const at = pathRef.current;
      setPage((p) => ({ ...p, threads: p.threads.map((t) => (t.id === id ? { ...t, status } : t)) }));
      api.status(at, id, status).catch((error) => { toast.error(String(error)); reload(); });
    },
    onMoved: (moves) => {
      const at = pathRef.current;
      api.moved(at, moves).catch((error) => console.warn("comment anchors not saved", error));
    },
    onStop: (id) => { void api.stop(pathRef.current, id).catch(() => {}); },
    onReview: () => { const view = viewRef.current; if (view) reviewDraft(view, pathRef.current); },
    link: (target) => {
      const source = resolveReference(target, sourcesRef.current);
      return source ? { label: source.title, link: linkFor(source, sourcesRef.current) } : null;
    },
    onOpenLink: (target) => {
      const source = resolveReference(target, sourcesRef.current);
      if (source) open(source);
      else toast(`${target} isn't in this vault.`);
    },
    kinMark,
  }), [page.path, threads, live, reviewing, chipsFor, reload, viewRef, open]);
}
