import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { stashForRoot, STASH_CHANGED, type StashItem } from "./api";
import { StashSession } from "./persistence";

/**
 * Root-scoped document queues survive ordinary document switches, including
 * the old editor's destroy/flush. A new root invalidates every old queue,
 * even if it opens a document with the same vault-relative path.
 */
export function useStash(root: string | null, path: string, readOnly = false) {
  const scope = useMemo(() => ({ root, api: stashForRoot(root ?? ""), sessions: new Map<string, StashSession>(), readOnly: new Map<string, boolean>() }), [root]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  scope.readOnly.set(path, readOnly);
  const session = useMemo(() => {
    const cached = scope.sessions.get(path);
    if (cached) return cached;
    const next = new StashSession(
      path,
      scope.api,
      () => currentScope.current === scope && !!scope.root && !!path,
      () => !scope.readOnly.get(path),
      (error) => toast.error(String(error)),
    );
    scope.sessions.set(path, next);
    return next;
  }, [scope, path]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  useEffect(() => {
    if (!root || !path) return;
    void session.reload();
    const off = listen<{ path: string }>(STASH_CHANGED, ({ payload }) => {
      if (payload.path === path) void session.reload();
    });
    void off.catch((error) => { if (currentScope.current === scope) toast.error(String(error)); });
    return () => {
      // This can still save the previous document in the same root. It does
      // nothing after a root switch; no command is sent to the new vault.
      void session.flush();
      void off.then((stop) => stop(), () => {});
    };
  }, [root, path, scope, session]);

  /** The initial/config items are disk-owned, not the live UI items.
   * onUpdate/onChange update rows immediately without changing that baseline. */
  const config = useMemo(() => state.file ? {
    path,
    items: state.file.items,
    onSave: session.onSave,
    onUpdate: session.onUpdate,
    onChange: session.onChange,
  } : undefined, [path, session, state.file]);

  return {
    ...state,
    config,
    /** Alias for the editor prop. */
    editor: config,
    reload: session.reload,
    flush: session.flush,
    /** Supply stashItems(view.state) when the caller needs an explicit
     * snapshot barrier before saving the draft or asking Kin. */
    saveEditor: (items: StashItem[]) => { session.onChange(items); return session.flush(); },
    flushBeforeAsk: (items?: StashItem[]) => { if (items) session.onChange(items); return session.flush(); },
    onSave: session.onSave,
    onUpdate: session.onUpdate,
    onChange: session.onChange,
    add: (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return Promise.resolve(false);
      return session.add({ id: crypto.randomUUID(), by: "owner", kind: "text", text: trimmed, created: new Date().toISOString() });
    },
    remove: (item: StashItem) => session.remove(item.id),
    move: session.move,
    /** Flushes the editor snapshot before starting the explicit request. */
    ask: session.ask,
  };
}
