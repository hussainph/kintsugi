import type { StashApi, StashFile, StashItem } from "./api.ts";
import { mergeEditorItems, moveItem } from "./model.ts";

type Recovery = { item: StashItem; index: number };
type RemovalIntent = { id: string; observedAbsent: boolean; restored: boolean; recovery?: Recovery };

export type StashState = {
  file: StashFile | null;
  /** Includes unsaved editor changes; `file` remains the disk baseline. */
  items: StashItem[];
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  asking: boolean;
  /** Successful dismissals not subsequently restored by editor undo/redo. */
  dismissedIds: string[];
  /** Failed optimistic removals awaiting restoration into the matching editor. */
  recoveryItems: Recovery[];
  error?: string;
};

/**
 * One root/document queue, reused across visits in the same vault. A slow
 * refresh cannot replace an edit or reorder; writes rebase onto disk first.
 * `active` means the vault is still current, not that this document is open:
 * the editor flushes the old document while switching to the next one.
 */
export class StashSession {
  private state: StashState = { file: null, items: [], loaded: false, loading: true, saving: false, asking: false, dismissedIds: [], recoveryItems: [] };
  private listeners = new Set<() => void>();
  private tail = Promise.resolve(false);
  private removed = new Set<string>();
  private editorBase: StashItem[] = [];
  private editorItems: StashItem[] | null = null;
  private editorRevision = 0;
  private pendingRemovals = new Set<RemovalIntent>();
  private restoredIds = new Set<string>();
  private recoveries = new Map<string, Recovery>();
  private knownItems = new Map<string, Recovery>();

  readonly path: string;
  private api: StashApi;
  private active: () => boolean;
  private retired = false;
  private writable: () => boolean;
  private onError: (error: unknown) => void;

  constructor(path: string, api: StashApi, active: () => boolean, writable: () => boolean, onError: (error: unknown) => void) {
    this.path = path;
    this.api = api;
    this.active = () => !this.retired && active();
    this.writable = writable;
    this.onError = onError;
  }

  /** Its saved sidecar moved. Ignore late model replies and old editor echoes. */
  retire = () => { this.retired = true; };

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private publish(patch: Partial<StashState>) {
    if (!this.active()) return;
    const recoveries = [...this.recoveries.values()];
    const recoveryItems = recoveries.length === this.state.recoveryItems.length && recoveries.every((value, index) => value === this.state.recoveryItems[index])
      ? this.state.recoveryItems
      : recoveries;
    this.state = { ...this.state, ...patch, recoveryItems };
    this.listeners.forEach((listener) => listener());
  }

  private protectRecoveries(items: StashItem[], current: StashItem[]) {
    const next = [...items];
    for (const [id, recovery] of this.recoveries) {
      if (!next.some((item) => item.id === id)) {
        next.splice(Math.min(recovery.index, next.length), 0, current.find((item) => item.id === id) ?? recovery.item);
      }
    }
    return next;
  }

  private mergeEditor(base: StashItem[], edited: StashItem[], current: StashItem[]) {
    const existing = new Set(current.map((item) => item.id));
    // A restored ID may already have been deleted on disk by its in-flight
    // dismissal. Treat it as a local addition only while it is absent there.
    const baseline = base.filter((item) => existing.has(item.id) || !this.restoredIds.has(item.id));
    return this.protectRecoveries(mergeEditorItems(baseline, edited.filter((item) => !this.removed.has(item.id)), current), current);
  }

  private publishFile(file: StashFile) {
    if (!this.state.loaded) this.editorBase = file.items;
    file.items.forEach((item, index) => { if (!this.knownItems.has(item.id)) this.knownItems.set(item.id, { item, index }); });
    const items = this.editorItems ? this.mergeEditor(this.editorBase, this.editorItems, file.items) : file.items;
    this.publish({ file, items, loaded: true, dismissedIds: [...this.removed], error: undefined });
  }

  private enqueue(action: () => Promise<void | boolean>, failure: string) {
    const next = this.tail.then(async () => {
      if (!this.active()) return false;
      try {
        return await action() !== false && this.active();
      } catch (error) {
        if (this.active()) {
          this.publish({ error: failure });
          this.onError(error);
        }
        return false;
      }
    });
    this.tail = next;
    return next;
  }

  private async latest(): Promise<StashFile> {
    const file = await this.api.load(this.path);
    if (file.path !== this.path) throw new Error("Stash document changed while loading.");
    return file;
  }

  reload = () => this.enqueue(async () => {
    this.publish({ loading: true });
    try { this.publishFile(await this.latest()); }
    finally { this.publish({ loading: false }); }
  }, "Couldn't load the stash.");

  private canWrite() { return this.active() && this.writable() && this.state.loaded; }

  /** Called inside the document queue, including an in-flight dismiss restore. */
  private async write(update: (current: StashItem[]) => StashItem[], onSaved?: () => void) {
    // The backend compares `base` under the same lock as stash_add. A
    // rejected write is retried from disk, never with the stale list.
    for (let attempt = 0; attempt < 3; attempt++) {
      const file = await this.latest();
      if (!this.canWrite()) return false;
      const items = update(file.items);
      try { await this.api.save(this.path, items, file.items); }
      catch (error) { if (attempt === 2) throw error; else continue; }
      if (!this.active()) return false;
      onSaved?.();
      this.publishFile({ path: this.path, items });
      return true;
    }
    return false;
  }

  private change(update: (current: StashItem[]) => StashItem[], onSaved?: () => void) {
    // A failed initial load is never treated as an empty stash to overwrite.
    if (!this.canWrite()) return Promise.resolve(false);
    return this.enqueue(async () => {
      if (!this.canWrite()) return false;
      this.publish({ saving: true });
      try { return await this.write(update, onSaved); }
      finally { this.publish({ saving: false }); }
    }, "Couldn't save the stash.");
  }

  saveEditor = (base: StashItem[], edited: StashItem[]) => {
    const observed = this.editorItems;
    const revision = this.editorRevision;
    let saved = edited;
    return this.change((current) => {
      // A debounce callback can queue before an undo or a dismissal rollback.
      // Apply the later editor delta rather than replaying the stale snapshot.
      saved = observed && this.editorItems && this.editorRevision !== revision
        ? mergeEditorItems(observed, this.editorItems, edited)
        : edited;
      return this.mergeEditor(base, saved, current);
    }, () => { this.editorBase = saved; });
  };

  /** UI updates do not become the config's initial/disk items. Newly loaded
   * IDs are acknowledged without accepting local mutations as a baseline. */
  onUpdate = (path: string, items: StashItem[]) => {
    if (path !== this.path || !this.active() || !this.writable() || !this.state.file) return;
    const incoming = new Set(items.map((item) => item.id));
    for (const intent of this.pendingRemovals) {
      if (!incoming.has(intent.id)) { intent.observedAbsent = true; intent.restored = false; }
      else if (intent.observedAbsent) intent.restored = true;
    }
    items.forEach((item, index) => this.knownItems.set(item.id, { item, index }));
    this.editorRevision++;
    // CodeMirror does not re-add its removed IDs from stale configuration.
    // An observed absent -> present transition is therefore an explicit
    // restore (undo/redo), not a save echo, and must be allowed to persist.
    const previous = this.editorItems && new Set(this.editorItems.map((item) => item.id));
    const restored = new Set([...this.removed, ...this.recoveries.keys()].filter((id) => previous && !previous.has(id) && incoming.has(id)));
    for (const id of restored) {
      this.removed.delete(id);
      this.recoveries.delete(id);
      this.restoredIds.add(id);
    }
    const known = new Set(this.editorBase.map((item) => item.id));
    this.editorBase = [...this.editorBase, ...this.state.file.items.filter((item) => incoming.has(item.id) && !known.has(item.id))];
    this.editorItems = items;
    const displayed = this.mergeEditor(this.editorBase, items, this.state.file.items);
    if (restored.size || JSON.stringify(displayed) !== JSON.stringify(this.state.items)) this.publish({ items: displayed, dismissedIds: [...this.removed] });
  };
  onChange = (items: StashItem[]) => this.onUpdate(this.path, items);
  onSave = (path: string, items: StashItem[]) => {
    // A navigation barrier can save before CodeMirror's delayed callback.
    // Its identical late echo must not write the old path after a rename.
    if (path === this.path && (this.dirty() || JSON.stringify(items) !== JSON.stringify(this.editorBase))) void this.saveEditor(this.editorBase, items);
  };
  /** Editor changes not yet on disk, including restores and recoveries. */
  private dirty() {
    if (!this.editorItems) return false;
    const disk = new Set(this.state.file?.items.map((item) => item.id));
    const missingRestore = this.editorItems.some((item) => this.restoredIds.has(item.id) && !disk.has(item.id));
    const missingRecovery = [...this.recoveries.keys()].some((id) => !disk.has(id));
    return missingRestore || missingRecovery || JSON.stringify(this.editorItems) !== JSON.stringify(this.editorBase);
  }

  /** A barrier, never called from inside the queue. It waits for every queued
   * command, including a Kin turn, and for editor changes made meanwhile.
   * `true` means the current editor stash is on disk; an earlier failed
   * reload or dismissal does not count against it once nothing is unsaved. */
  flush = async () => {
    for (let pass = 0; pass < 8; pass++) {
      if (!this.active()) return false;
      const saving = this.dirty();
      // Queue a dirty save now, in order, so it captures the current snapshot.
      const waited = saving ? this.saveEditor(this.editorBase, this.editorItems!) : this.tail;
      const saved = await waited;
      if (!this.active()) return false;
      if (saving && !saved) return false;
      if (!this.dirty() && waited === this.tail) return true;
    }
    // A continuously changing queue has not reached a safe navigation point.
    return false;
  };

  add = (item: StashItem) => this.change((current) => current.some((entry) => entry.id === item.id) ? current : [...current, item]);
  move = (id: string, toIndex: number) => this.change((current) => moveItem(current, id, toIndex));

  remove = (id: string) => {
    if (!this.canWrite()) return Promise.resolve(false);
    // Capture the intent now, not when its queued command begins. The caller
    // has already removed the CM row, and may undo while dismiss is awaiting.
    const intent: RemovalIntent = {
      id, observedAbsent: !!this.editorItems && !this.editorItems.some((item) => item.id === id), restored: false,
      recovery: this.knownItems.get(id),
    };
    this.pendingRemovals.add(intent);
    this.recoveries.delete(id);
    return this.enqueue(async () => {
      if (!this.canWrite()) return false;
      this.publish({ saving: true });
      let dismissed = false;
      try {
        await this.api.dismiss(this.path, id, intent.recovery?.item);
        dismissed = true;
        if (!this.active()) return false;
        const restored = intent.restored && this.editorItems?.some((item) => item.id === id);
        if (restored) {
          this.removed.delete(id);
          this.restoredIds.add(id);
        } else this.removed.add(id);
        const file = this.state.file!;
        this.publishFile({ path: this.path, items: file.items.filter((item) => item.id !== id) });
        if (restored) {
          // Restore within this queue entry, not through change()/flush():
          // enqueueing and awaiting another write here would deadlock it.
          let saved: StashItem[] = [];
          return await this.write((current) => {
            saved = this.editorItems ?? [];
            return this.mergeEditor(this.editorBase, saved, current);
          }, () => { this.editorBase = saved; });
        }
      } catch (error) {
        // A failed optimistic removal must remain recoverable even if an old
        // debounced deletion save is already queued behind this request.
        if (!dismissed && intent.observedAbsent && this.active()) {
          if (intent.restored && this.editorItems?.some((item) => item.id === id)) this.restoredIds.add(id);
          else if (intent.recovery) this.recoveries.set(id, intent.recovery);
          this.publishFile(this.state.file!);
        }
        throw error;
      } finally { this.publish({ saving: false }); }
    }, "Couldn't remove the stash item.").finally(() => { this.pendingRemovals.delete(intent); });
  };

  /** Explicit only. Flush first so Kin sees the newest set-aside text.
   * The model never holds the save queue. Compare-and-save rebases editor
   * writes over its appends, so a slow provider cannot block draft saves. */
  ask = async (text?: string) => {
    if (!this.canWrite() || this.state.asking) return false;
    this.publish({ asking: true });
    try {
      if (!await this.flush() || !this.canWrite()) return false;
      await this.api.ask(this.path, text);
      if (!this.active()) return false;
      return await this.reload();
    } catch (error) {
      this.publish({ error: "Couldn't ask Kin. Try again." });
      if (this.active()) this.onError(error);
      return false;
    } finally { this.publish({ asking: false }); }
  };
}
