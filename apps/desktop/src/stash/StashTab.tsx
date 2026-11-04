import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { draftSelectionMime } from "@kintsugi/editor/stash";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@kintsugi/ui/components/tooltip";
import { ArrowDown, MessageCircle, Plus, Trash2, X } from "@kintsugi/ui/icons";
import { toast } from "sonner";
import { ShortcutHint } from "@/components/Shortcuts";
import { keysOf } from "@/lib/keys";
import { SHORTCUTS } from "@/lib/shortcuts";
import { KinAvatar } from "../kin/Avatar";
import { openLink } from "../kin/links";
import type { StashItem } from "./api";
import { splitWikiLinks } from "./model";
import "./stash.css";

export const STASH_DRAG_TYPE = "application/x-kintsugi-stash";
/** How long a fresh row stays highlighted; `stash.css` fades within it. */
export const FRESH_MS = 1200;

type Action = void | Promise<unknown>;
export type StashTabProps = {
  path: string;
  items: StashItem[];
  readOnly?: boolean;
  loading?: boolean;
  asking?: boolean;
  error?: string;
  versions?: ReactNode;
  /** What ⌥⌘X would take now (KI-110): the selection, else the paragraph.
   *  `ready` is false when there's nothing there to stash. */
  target?: { selection: boolean; ready: boolean };
  /** The row just stashed, to highlight once. */
  fresh?: string | null;
  onStash?: () => Action;
  /** A selection dragged from the draft, with its payload. */
  onStashDrop?: (data: string) => void;
  onInsert: (item: StashItem) => Action;
  onFocus?: (item: StashItem | null) => void;
  onRemove: (item: StashItem) => Action;
  /** A zero-based position in the resulting list. */
  onMove: (id: string, toIndex: number) => Action;
  /** Returning false keeps the note in the field after a failed save. */
  onAdd: (text: string) => void | boolean | Promise<void | boolean>;
  onAsk: () => Action;
  onDiscuss: (item: StashItem) => Action;
  onRetry?: () => Action;
  /** Add the editor's drag payload here; the panel also writes its reorder ID. */
  onDrag?: (event: DragEvent<HTMLElement>, item: StashItem) => void;
};

function ItemText({ item }: { item: StashItem }) {
  return (
    <>
      {item.kind === "rewrite" && item.anchor?.exact && <del className="ki-stash-original">{item.anchor.exact}</del>}
      <p className="ki-stash-text" data-prose={item.by === "owner" || item.kind === "rewrite" ? "" : undefined}>
        {item.by === "kin" && item.kind === "idea"
          ? splitWikiLinks(item.text).map((part, i) => typeof part === "string" ? part : (
            <button key={i} type="button" className="ki-stash-link" data-target={part.target} onClick={() => openLink(part.target)}>{part.label}</button>
          ))
          : item.text}
      </p>
    </>
  );
}

/** The shared stash, below the parent's passage-version controls. */
export function StashTab(props: StashTabProps) {
  // Changing documents also clears focus and an unfinished note. Using a key
  // here avoids one frame of another document's local interaction state.
  return <StashPanel key={props.path} {...props} />;
}

function StashPanel({ path, items, readOnly = false, loading = false, asking = false, error, versions, target = { selection: false, ready: false }, fresh = null, onStash, onStashDrop, onInsert, onFocus, onRemove, onMove, onAdd, onAsk, onDiscuss, onRetry, onDrag }: StashTabProps) {
  const helpId = useId();
  const headingId = useId();
  const [focused, setFocused] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  const [skipMotion, setSkipMotion] = useState(false);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const rows = useRef(new Map<string, HTMLLIElement>());
  const dragging = useRef<string | null>(null);
  const disabled = readOnly || loading || !path;
  const [dropping, setDropping] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const draftDrag = (event: DragEvent) => !disabled && !!onStashDrop && event.dataTransfer.types.includes(draftSelectionMime);

  // A fresh stash lights its row once, when the row arrives.
  useEffect(() => {
    if (!fresh) return;
    setHighlight(fresh);
    const timer = setTimeout(() => setHighlight((current) => current === fresh ? null : current), FRESH_MS);
    return () => clearTimeout(timer);
  }, [fresh]);
  const shown = highlight !== null && items.some((item) => item.id === highlight);
  useEffect(() => {
    if (shown) rows.current.get(highlight!)?.scrollIntoView({ block: "nearest" });
  }, [shown, highlight]);

  const focusRow = (id: string) => rows.current.get(id)?.focus({ preventScroll: true });
  const focusItem = (item: StashItem) => {
    setFocused(item.id);
    if (focused !== item.id) onFocus?.(item);
  };
  const move = (id: string, to: number) => {
    void onMove(id, to);
    setAnnouncement(`Moved to position ${to + 1}.`);
  };
  const remove = (item: StashItem, index: number) => {
    // Move real keyboard focus before removing its element.
    const next = items[index + 1] ?? items[index - 1];
    if (next) focusRow(next.id);
    else {
      setFocused(null);
      onFocus?.(null);
    }
    void onRemove(item);
  };
  const keydown = (event: KeyboardEvent<HTMLLIElement>, item: StashItem, index: number) => {
    if (event.nativeEvent.isComposing) return;
    // Nested buttons retain native Enter/Space behavior. Arrows still move
    // between rows, and Option+arrows reorder from any row control.
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      setSkipMotion(event.repeat);
      const to = Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
      if (event.altKey) {
        if (!disabled && to !== index) move(item.id, to);
      } else {
        const target = items[to];
        focusRow(target.id);
        rows.current.get(target.id)?.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    if (event.key.toLowerCase() === "j" && event.shiftKey && event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) void onDiscuss(item);
      return;
    }
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (!disabled && !event.repeat) void onInsert(item);
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      event.stopPropagation();
      if (!disabled && !event.repeat) remove(item, index);
    }
  };
  const submitNote = async () => {
    const text = note.trim();
    if (!text || disabled || adding) return;
    setAdding(true);
    try {
      if (await onAdd(text) !== false) setNote((current) => current.trim() === text ? "" : current);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div
      className="ki-stash"
      data-skip-motion={skipMotion ? "" : undefined}
      data-path={path}
      data-drop-target={dropping ? "" : undefined}
      onDragOver={(event) => {
        if (!draftDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropping(true);
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }}
      onDrop={(event) => {
        setDropping(false);
        if (!draftDrag(event)) return;
        event.preventDefault();
        onStashDrop!(event.dataTransfer.getData(draftSelectionMime));
      }}
    >
      {versions}
      <section className="ki-stash-shared" aria-labelledby={headingId}>
        <div className="ki-stash-heading">
          <h2 id={headingId}>Stash</h2>
          <Button type="button" variant="ghost" size="xs" className="ki-stash-ask" disabled={disabled || asking} aria-busy={asking} onClick={() => void onAsk()}>
            <KinAvatar className="ki-stash-ask-avatar" />
            {asking ? "Asking Kin…" : "Ask Kin"}
          </Button>
          {onStash && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="xs"
                  className="ki-stash-take relative"
                  disabled={disabled || !target.ready}
                  aria-keyshortcuts="Meta+Alt+X"
                  // Keeps focus, and the cursor, in the draft.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void onStash()}
                >
                  {target.selection ? "Stash selection" : "Stash paragraph"}
                  <ShortcutHint id="stash" side="below" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{keysOf(SHORTCUTS.stash.key)}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {error && <div className="ki-stash-error" role="alert"><span>{error}</span>{onRetry && <Button type="button" variant="ghost" size="xs" onClick={() => void onRetry()} disabled={loading}>Retry</Button>}</div>}
        <p id={helpId} className="sr-only">Reorder with Option and arrow keys.</p>
        {loading && !items.length ? <p className="ki-stash-empty" role="status">Loading stash…</p> : !items.length && !error ? <p className="ki-stash-empty">Nothing stashed yet.</p> : null}
        <ul className="ki-stash-list" aria-label="Stash items" aria-busy={loading}>
          {items.map((item, index) => {
            const expanded = focused === item.id;
            return (
              <li
                key={item.id}
                ref={(node) => { if (node) rows.current.set(item.id, node); else rows.current.delete(item.id); }}
                className="ki-stash-row"
                data-stash-id={item.id}
                data-by={item.by}
                data-kind={item.kind}
                data-focused={expanded ? "" : undefined}
                data-fresh={highlight === item.id ? "" : undefined}
                data-drop={drop?.id === item.id ? drop.after ? "after" : "before" : undefined}
                tabIndex={0}
                aria-label={`${item.by === "owner" ? "Your" : "Kin's"} ${item.kind === "rewrite" ? "rewrite" : item.kind === "idea" ? "idea" : "text"}`}
                aria-describedby={helpId}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Enter Backspace Meta+Shift+J"
                draggable={!disabled}
                onFocus={() => focusItem(item)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setFocused((current) => current === item.id ? null : current);
                    onFocus?.(null);
                  }
                }}
                onClick={(event) => {
                  if (!(event.target as HTMLElement).closest("button, a, input")) focusRow(item.id);
                }}
                onKeyDown={(event) => keydown(event, item, index)}
                onKeyUp={() => setSkipMotion(false)}
                onDragStart={(event) => {
                  dragging.current = item.id;
                  event.dataTransfer.effectAllowed = "copyMove";
                  event.dataTransfer.setData(STASH_DRAG_TYPE, JSON.stringify({ path, id: item.id }));
                  event.dataTransfer.setData("text/plain", item.text);
                  onDrag?.(event, item);
                }}
                onDragEnd={() => { dragging.current = null; setDrop(null); }}
                onDragOver={(event) => {
                  if (disabled || !dragging.current || dragging.current === item.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const rect = event.currentTarget.getBoundingClientRect();
                  setDrop({ id: item.id, after: event.clientY > rect.top + rect.height / 2 });
                }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null); }}
                onDrop={(event) => {
                  const id = dragging.current;
                  const edge = drop;
                  dragging.current = null;
                  setDrop(null);
                  if (disabled || !id || !edge || edge.id !== item.id) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const from = items.findIndex((entry) => entry.id === id);
                  const boundary = index + Number(edge.after);
                  const to = boundary - Number(from < boundary);
                  if (from >= 0 && from !== to) move(id, to);
                  focusRow(id);
                }}
              >
                <span className="ki-stash-mark" aria-hidden>{item.by === "kin" && <KinAvatar className="ki-stash-avatar" />}</span>
                <div className="ki-stash-content">
                  <ItemText item={item} />
                  <div className="ki-stash-actions" aria-hidden={!expanded} inert={!expanded}>
                    <div className="ki-stash-actions-clip">
                      <div className="ki-stash-toolbar">
                        <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" className="ki-stash-action" disabled={disabled} aria-label="Insert" onClick={() => void onInsert(item)}><ArrowDown /></Button></TooltipTrigger><TooltipContent>Insert <span aria-hidden>↵</span></TooltipContent></Tooltip>
                        <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" className="ki-stash-action" disabled={disabled} aria-label={item.by === "kin" ? "Dismiss" : "Delete"} onClick={() => remove(item, index)}>{item.by === "kin" ? <X /> : <Trash2 />}</Button></TooltipTrigger><TooltipContent>{item.by === "kin" ? "Dismiss" : "Delete"} <span aria-hidden>⌫</span></TooltipContent></Tooltip>
                        <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" className="ki-stash-action" aria-label="Discuss" onClick={() => void onDiscuss(item)}><MessageCircle /></Button></TooltipTrigger><TooltipContent>Discuss <span aria-hidden>⇧⌘J</span></TooltipContent></Tooltip>
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <form className="ki-stash-note" onSubmit={(event) => { event.preventDefault(); void submitNote(); }}>
          <Input aria-label="Add a note" placeholder="Add a note…" value={note} disabled={disabled || adding} onChange={(event) => setNote(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
          <Button type="submit" variant="ghost" size="icon-xs" className="ki-stash-add" disabled={disabled || adding || !note.trim()} aria-label="Add note"><Plus /></Button>
        </form>
      </section>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    </div>
  );
}
