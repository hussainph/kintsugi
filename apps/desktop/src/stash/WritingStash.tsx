import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { addRequestedStashItems, addStashNote, focusStashItem, insertStashItem, moveStashItem, removeStashItem, stashDropped, stashItems, stashKinReply, stashSelection, stashTargetAt, type StashItem } from "@kintsugi/editor/stash";
import { Button } from "@kintsugi/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@kintsugi/ui/components/dialog";
import { toast } from "sonner";
import { discuss } from "@/lib/chat";
import { registerStashTarget } from "@/lib/stash";
import { trackStashWrite } from "@/lib/stashFlush";
import { snippet } from "@/lib/chips";
import { noticeStash } from "@/margin/state";
import { StashTab } from "./StashTab";
import { useStash } from "./useStash";
import "./writing-stash.css";

type Props = { root: string | null; path: string; viewRef: RefObject<EditorView | null>; readOnly?: boolean; show: () => void };

/** The editor owns undoable items. The host owns the sidecar and shared arrivals. */
export function useWritingStash({ root, path, viewRef, readOnly = false, show }: Props) {
  const store = useStash(root, path, readOnly);
  const current = useRef({ root, path, readOnly });
  current.current = { root, path, readOnly };
  const [picker, setPicker] = useState(false);
  const items = store.items;
  const openPicker = useCallback(() => { show(); setPicker(true); }, [show]);
  const onError = useCallback((message: string) => { toast.error(message); }, []);
  // KI-110: a stash from anywhere lights its row if the Stash tab is showing,
  // else pulses a dot. It no longer opens the margin.
  const [fresh, setFresh] = useState<string | null>(null);
  const onStashed = useCallback((id: string) => { if (noticeStash() === "row") setFresh(id); }, []);
  const config = useMemo(() => store.config && { ...store.config, onStashed, onPicker: openPicker, onError }, [store.config, onStashed, openPicker, onError]);
  // What the Stash selection button would take, from the editor's state.
  const [target, setTarget] = useState({ selection: false, ready: false });
  const reported = useRef(target);
  const extension = useMemo(() => {
    const report = (state: EditorState) => {
      const selection = !state.selection.main.empty;
      const ready = !!stashTargetAt(state);
      if (reported.current.selection === selection && reported.current.ready === ready) return;
      reported.current = { selection, ready };
      setTarget(reported.current);
    };
    return ViewPlugin.define((view) => {
      queueMicrotask(() => report(view.state));
      return { update: (update) => report(update.state) };
    });
  }, []);
  useEffect(() => { setPicker(false); }, [root, path]);
  useEffect(() => {
    if (!store.loaded || !store.recoveryItems.length || readOnly) return;
    // After a failed optimistic removal, recover into this document's
    // editor cache too. A different document's reused view is never touched.
    const frame = requestAnimationFrame(() => {
      const view = viewRef.current;
      if (!view) return;
      for (const { item, index } of store.recoveryItems) {
        if (!stashItems(view.state).some((current) => current.id === item.id) && addRequestedStashItems(view, [item])) {
          moveStashItem(view, item.id, Math.min(index, stashItems(view.state).length - 1));
        }
      }
      void store.saveEditor(stashItems(view.state));
    });
    return () => cancelAnimationFrame(frame);
  }, [store.loaded, store.recoveryItems, readOnly, root, path, viewRef]);
  useEffect(() => {
    if (readOnly || !store.loaded || !root) return;
    return registerStashTarget(path, (text) => trackStashWrite(root, async () => {
      const view = viewRef.current;
      if (!view) return false;
      await invoke("stash_validate_reply", { text, expectedRoot: root });
      if (viewRef.current !== view || current.current.path !== path || current.current.root !== root || current.current.readOnly) return false;
      return !!stashKinReply(view, text);
    }));
  }, [path, root, readOnly, viewRef, store.loaded]);

  const insert = (item: StashItem) => {
    const view = viewRef.current;
    if (!view || !insertStashItem(view, item.id)) { toast.error("Those words changed. Keep this rewrite for later."); return; }
    setPicker(false);
  };
  const content = (versions: ReactNode) => <>
    <StashTab path={path} items={items} readOnly={readOnly} loading={store.loading || !store.loaded} asking={store.asking} error={store.error} versions={versions}
      target={target} fresh={fresh}
      onStash={() => { const view = viewRef.current; if (view) stashSelection(view); }}
      onStashDrop={(data) => { const view = viewRef.current; if (view) stashDropped(view, data); }}
      onInsert={insert}
      onFocus={(item) => { const view = viewRef.current; if (view && item?.kind === "rewrite") focusStashItem(view, item.id); }}
      onRemove={async (item) => {
        const view = viewRef.current;
        // EditorView is reused on a document switch. Mutate this state now,
        // never the state it may be showing after an awaited disk write.
        if (view && removeStashItem(view, item.id)) await store.remove(item);
      }}
      onMove={(id, to) => { const view = viewRef.current; if (view) moveStashItem(view, id, to); }}
      onAdd={(text) => { const view = viewRef.current; return !!view && !!addStashNote(view, text); }}
      onAsk={async () => {
        const view = viewRef.current;
        if (!view) return;
        const text = view.state.doc.toString();
        if (await store.flushBeforeAsk(stashItems(view.state))) await store.ask(text);
      }}
      onDiscuss={(item) => discuss([{ kind: "doc", path, label: path.replace(/^.*\//, "").replace(/\.mdx?$/, "") }], item.text)}
      onRetry={store.reload}
    />
    <Dialog open={picker} onOpenChange={setPicker}><DialogContent className="ki-stash-picker" aria-describedby={undefined} onCloseAutoFocus={(event) => { event.preventDefault(); viewRef.current?.focus(); }}><DialogTitle>Insert from stash</DialogTitle>
      {items.length ? <div className="ki-stash-picker-list">{items.map((item) => <Button variant="ghost" key={item.id} onClick={() => insert(item)}>{snippet(item.text, 160)}</Button>)}</div> : <p>Nothing stashed yet.</p>}
    </DialogContent></Dialog>
  </>;
  return { config, content, extension, items: () => viewRef.current ? stashItems(viewRef.current.state) : items };
}
