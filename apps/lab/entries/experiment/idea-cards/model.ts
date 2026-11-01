import { useState } from "react";
import { FADE_DAYS, ideas as fixtureIdeas, type Idea } from "./fixtures";

export type DismissReason = "Not for me" | "Already on it" | "Wrong about me";

export type Route =
  | { view: "list" }
  | { view: "draft"; id: string; attachTo?: string }
  | { view: "discuss"; id: string };

export type IdeasState = {
  open: string | null;
  route: Route;
  adopting: string | null;
  refining: string | null;
  refined: string[];
  dismissed: Record<string, DismissReason | null>;
  /** Adopted ideas leave the fade clock: idea id → the draft they became. */
  adopted: Record<string, string>;
  /** Reasons the owner removed from "Why this?", per idea. */
  removed: Record<string, string[]>;
  /** Profile lines the owner rewrote from "Why this?", keyed idea:reason. */
  fixes: Record<string, string>;
  whyOpen: string | null;
  showFaded: boolean;
  /** One-line feedback after a correction, with undo. */
  notice: { text: string; undo: () => void } | null;
};

export const initialState: IdeasState = {
  open: null,
  route: { view: "list" },
  adopting: null,
  refining: null,
  refined: [],
  dismissed: {},
  adopted: {},
  removed: {},
  fixes: {},
  whyOpen: null,
  showFaded: false,
  notice: null,
};

/** One small model behind every variant, so they differ only in layout. */
export function useIdeas(initial: Partial<IdeasState> = {}) {
  const [state, setState] = useState<IdeasState>({ ...initialState, ...initial });
  const set = (patch: Partial<IdeasState>) =>
    setState((s) => ({ ...s, ...patch }));

  const resolve = (idea: Idea): Idea => {
    if (!state.refined.includes(idea.id) || !idea.refined) return idea;
    const { title, draftTitle, snippet, hunch } = idea.refined;
    return { ...idea, title, draftTitle, snippet, hunch };
  };
  const all = fixtureIdeas.map(resolve);
  /** This week's batch in order, dismissed ones included so they can stay in place. */
  const week = all.filter((i) => i.age < FADE_DAYS);
  const live = week.filter((i) => !(i.id in state.dismissed));
  const faded = all.filter((i) => i.age >= FADE_DAYS);
  const dismissed = all.filter((i) => i.id in state.dismissed);
  const byId = (id: string | null) => all.find((i) => i.id === id) ?? null;

  return {
    state,
    week,
    today: week.filter((i) => i.age === 0),
    earlier: week.filter((i) => i.age > 0),
    live,
    isDismissed: (id: string) => id in state.dismissed,
    faded,
    dismissed,
    byId,
    toggle: (id: string) =>
      set({ open: state.open === id ? null : id, adopting: null, refining: null, whyOpen: null }),
    close: () => set({ open: null, adopting: null, refining: null }),
    startAdopt: (id: string) => set({ adopting: state.adopting === id ? null : id, refining: null }),
    adopt: (id: string, attachTo?: string) =>
      set({
        route: { view: "draft", id, attachTo },
        adopting: null,
        adopted: { ...state.adopted, [id]: attachTo ?? "new" },
      }),
    openDraft: (id: string) => {
      const to = state.adopted[id];
      set({ route: { view: "draft", id, attachTo: to && to !== "new" ? to : undefined } });
    },
    original: (id: string) => fixtureIdeas.find((i) => i.id === id) ?? null,
    discuss: (id: string) => set({ route: { view: "discuss", id } }),
    back: () => set({ route: { view: "list" } }),
    startRefine: (id: string) => set({ refining: state.refining === id ? null : id, adopting: null }),
    refine: (id: string) =>
      set({
        refining: null,
        refined: [...state.refined, id],
        notice: {
          text: "Kin refined this idea. The earlier version is kept.",
          undo: () =>
            setState((s) => ({ ...s, refined: s.refined.filter((r) => r !== id), notice: null })),
        },
      }),
    dismiss: (id: string) =>
      set({
        dismissed: { ...state.dismissed, [id]: null },
        open: state.open === id ? null : state.open,
      }),
    reason: (id: string, reason: DismissReason) =>
      set({ dismissed: { ...state.dismissed, [id]: reason } }),
    undismiss: (id: string) => {
      const { [id]: _, ...rest } = state.dismissed;
      set({ dismissed: rest });
    },
    toggleWhy: (id: string) => set({ whyOpen: state.whyOpen === id ? null : id }),
    removeReason: (id: string, reasonId: string, text: string) => {
      const before = state.removed;
      set({
        removed: { ...before, [id]: [...(before[id] ?? []), reasonId] },
        notice: {
          text: `Kin won't weigh “${text}” for ideas like this.`,
          undo: () => setState((s) => ({ ...s, removed: before, notice: null })),
        },
      });
    },
    fixLine: (id: string, reasonId: string, line: string) => {
      const before = state.fixes;
      set({
        fixes: { ...before, [`${id}:${reasonId}`]: line },
        notice: {
          text: "About you updated. The change is in its history.",
          undo: () => setState((s) => ({ ...s, fixes: before, notice: null })),
        },
      });
    },
    clearNotice: () => set({ notice: null }),
    toggleFaded: () => set({ showFaded: !state.showFaded }),
  };
}

export type IdeasModel = ReturnType<typeof useIdeas>;
