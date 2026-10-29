import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useSyncExternalStore } from "react";
import type { ClipSummary } from "@kintsugi/core/clips";

export type ReferenceDocument = { path: string; title: string | null; status: string | null; text: string };
export type ReferenceLink = { source: string; target: string; resolved: string | null };
export type ReferenceIndex = { documents: ReferenceDocument[]; clips: ClipSummary[]; links: ReferenceLink[] };
type Snapshot = ReferenceIndex & { loading: boolean; error: string | null };
const empty: Snapshot = { documents: [], clips: [], links: [], loading: true, error: null };

/** The margin and library subscribe to the same snapshot, not separate scans.
 * Changes coalesce while a scan is running; an older vault can never publish
 * into the next one's snapshot. No source text or image bytes live here. */
export class IndexStore {
  private load: () => Promise<ReferenceIndex>;
  private watch: (event: string, changed: () => void) => Promise<() => void>;
  constructor(
    load: () => Promise<ReferenceIndex> = () => invoke<ReferenceIndex>("reference_index"),
    watch: (event: string, changed: () => void) => Promise<() => void> = (event, changed) => listen(event, changed),
  ) { this.load = load; this.watch = watch; }
  snapshot = empty;
  private subscribers = new Set<() => void>();
  private stop: (() => void) | null = null;
  private generation = 0;
  private running = false;
  private again = false;

  subscribe = (fn: () => void) => {
    this.subscribers.add(fn);
    if (this.subscribers.size === 1) this.start();
    return () => {
      this.subscribers.delete(fn);
      if (!this.subscribers.size) {
        this.generation++;
        this.stop?.();
        this.stop = null;
        this.running = false;
      }
    };
  };
  getSnapshot = () => this.snapshot;
  private publish(snapshot: Snapshot) {
    this.snapshot = snapshot;
    this.subscribers.forEach((fn) => fn());
  }
  private start() {
    const generation = ++this.generation;
    const events = ["references:changed", "vault:changed", "clips:changed"];
    const stops = events.map((event) => this.watch(event, () => this.refresh()));
    this.stop = () => { stops.forEach((stop) => { void stop.then((off) => off()); }); };
    // Register first so a save during the initial scan schedules another pass.
    void Promise.all(stops).then(() => {
      if (generation === this.generation) this.refresh();
    }).catch((error) => {
      if (generation === this.generation) this.publish({ ...this.snapshot, loading: false, error: String(error) });
    });
  }
  refresh = () => {
    if (this.running) { this.again = true; return; }
    const generation = this.generation;
    this.running = true;
    this.again = false;
    void this.load().then((index) => {
      if (generation === this.generation) this.publish({ ...index, loading: false, error: null });
    }).catch((error) => {
      if (generation === this.generation) this.publish({ ...this.snapshot, loading: false, error: String(error) });
    }).finally(() => {
      if (generation !== this.generation) return;
      this.running = false;
      if (this.again) this.refresh();
    });
  };
}

// Only one vault is open, but React may unmount the editor while the library
// mounts. Keep that vault's shared snapshot and discard it on a vault switch.
let active: { root: string; store: IndexStore } | null = null;
const idle = new IndexStore();
const noSubscription = () => () => {};
export function useReferenceIndex(root: string | null) {
  if (root && active?.root !== root) active = { root, store: new IndexStore() };
  const store = root ? active!.store : idle;
  const snapshot = useSyncExternalStore(root ? store.subscribe : noSubscription, store.getSnapshot);
  return { ...snapshot, refresh: useCallback(() => { if (root) store.refresh(); }, [root, store]) };
}
