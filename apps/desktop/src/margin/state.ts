import { useSyncExternalStore } from "react";

/**
 * The right margin (KI-103): one panel beside the draft with three tabs.
 * While writing it shows Kin, References or the Stash; away from the editor
 * (Feed, a story, Ideas, Inspiration, Settings) only Kin. It overlays the
 * empty gutter right of the draft, so opening it never re-wraps a line.
 *
 * Open or closed, and which tab, is his choice, kept across documents,
 * screens and restarts. Away from the editor the margin shows only while its
 * tab is Kin; a writing tab waits for him to come back to the draft.
 */
export type MarginTab = "kin" | "references" | "stash";
export type MarginWhere = "writing" | "away";

export const TABS: { tab: MarginTab; label: string }[] = [
  { tab: "kin", label: "Kin" },
  { tab: "references", label: "References" },
  { tab: "stash", label: "Stash" },
];

type State = { open: boolean; tab: MarginTab; where: MarginWhere };

const KEY = "kintsugi:margin";

/** The saved choice. The old reference margin saved "visible" or "hidden". */
export function parseSaved(saved: string | null): Pick<State, "open" | "tab"> {
  if (saved === "visible") return { open: true, tab: "references" };
  if (!saved || saved === "hidden") return { open: false, tab: "kin" };
  try {
    const value = JSON.parse(saved) as Partial<State>;
    const tab = TABS.some((t) => t.tab === value.tab) ? value.tab! : "kin";
    return { open: value.open === true, tab };
  } catch {
    return { open: false, tab: "kin" };
  }
}

function read(): State {
  try {
    return { ...parseSaved(localStorage.getItem(KEY)), where: "writing" };
  } catch {
    return { open: false, tab: "kin", where: "writing" };
  }
}

let state: State = read();
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  const merged = { ...state, ...next };
  if (merged.open === state.open && merged.tab === state.tab && merged.where === state.where) return;
  const saved = merged.open !== state.open || merged.tab !== state.tab;
  state = merged;
  if (saved) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ open: state.open, tab: state.tab }));
    } catch {
      // A convenience only.
    }
  }
  for (const listener of listeners) listener();
}

/** The tabs a screen has: all three while writing, Kin elsewhere. */
export const tabsFor = (where: MarginWhere): MarginTab[] => (where === "writing" ? TABS.map((t) => t.tab) : ["kin"]);

/** The tab showing now, or null while the margin is closed. */
export function visibleTab(s: State = state): MarginTab | null {
  if (!s.open) return null;
  return tabsFor(s.where).includes(s.tab) ? s.tab : null;
}

export const showMargin = (tab: MarginTab) => set({ open: true, tab });
export const hideMargin = () => set({ open: false });

/** ⌥⌘\ and the margin button: away from the editor, the margin is Kin. */
export function toggleMargin() {
  if (visibleTab()) return hideMargin();
  set({ open: true, tab: tabsFor(state.where).includes(state.tab) ? state.tab : "kin" });
}

/** A tab's own key: shows it, or closes the margin when it's already showing. */
export function toggleTab(tab: MarginTab) {
  if (visibleTab() === tab) hideMargin();
  else showMargin(tab);
}

/** App sets this as the screen changes. */
export const setMarginWhere = (where: MarginWhere) => set({ where });

export const marginState = () => state;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMargin() {
  const s = useSyncExternalStore(subscribe, () => state);
  const tab = visibleTab(s);
  return { open: tab !== null, tab, where: s.where, chosen: s.tab, showing: (t: MarginTab) => tab === t };
}

// --- Slots ------------------------------------------------------------------
// A screen fills a tab from where its state lives: the editor's references
// render in `Writing` and portal into the References panel (`MarginPortal`).

const slots = new Map<MarginTab, HTMLElement>();
const slotListeners = new Set<() => void>();

/** The margin registers each tab panel's element (null when it unmounts). */
export function setSlot(tab: MarginTab, element: HTMLElement | null) {
  if (element) slots.set(tab, element);
  else slots.delete(tab);
  for (const listener of slotListeners) listener();
}

export function useSlot(tab: MarginTab): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => {
      slotListeners.add(listener);
      return () => slotListeners.delete(listener);
    },
    () => slots.get(tab) ?? null,
  );
}
