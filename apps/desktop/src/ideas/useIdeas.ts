import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { discuss as discussWithKin } from "@/lib/chat";
import { openAboutYou } from "@/lib/kin";
import { ideas, IDEAS_CHANGED, type Listed, type Quote, type View } from "./api";
import { concerns, group } from "./model";

export type Props = {
  /** "Ideas for this draft": only ideas bearing on this document. */
  filter?: string;
  onFilter: (path?: string) => void;
  onOpenDoc: (path: string) => void;
  /** Drafts an idea can be added to, newest edits first if known. */
  drafts: { path: string; title: string }[];
};

/**
 * Everything an Ideas layout needs, whatever it looks like: the list in
 * groups, which idea is open, and every action. Ledger renders it today;
 * Desk or Letter would render the same model.
 */
export function useIdeas({ filter, onFilter, onOpenDoc, drafts }: Props) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [refining, setRefining] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState<string | null>(null);
  const [showFaded, setShowFaded] = useState(false);
  /** Dismissed in this visit: they keep their place, with reasons and Undo. */
  const [justDismissed, setJustDismissed] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await ideas.list();
      if (mine === seq.current) {
        setView(next);
        setError(undefined);
      }
    } catch (e) {
      if (mine === seq.current) setError(String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    const off = listen(IDEAS_CHANGED, () => void reload());
    // Jobs move on their own (queued, running, waiting at the cap).
    const offJobs = listen<{ type: string }>("kin:chat", ({ payload }) => payload.type === "job" && void reload());
    return () => {
      off.then((stop) => stop());
      offJobs.then((stop) => stop());
    };
  }, [reload]);

  const run = useCallback(async (action: Promise<View>, notice?: { text: string; undo?: () => Promise<View> }) => {
    try {
      setView(await action);
      if (notice)
        toast(notice.text, notice.undo ? { action: { label: "Undo", onClick: () => void notice.undo!().then(setView, (e) => toast.error(String(e))) } } : undefined);
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  const list = useMemo(() => (view?.ideas ?? []).filter((i) => !filter || concerns(i, filter)), [view, filter]);
  const groups = useMemo(() => group(list, justDismissed), [list, justDismissed]);
  const byId = (id: string | null) => list.find((i) => i.id === id) ?? null;
  const job = view?.job ?? null;
  const busy = !!job && ["queued", "running", "waiting"].includes(job.status);

  return {
    view,
    error,
    filter,
    groups,
    total: list.length,
    job,
    busy,
    drafts: drafts.filter((d) => d.path !== filter),
    state: { open, adopting, refining, whyOpen, showFaded, justDismissed },
    byId,
    reload,
    toggle: (id: string) => {
      setOpen((o) => (o === id ? null : id));
      setAdopting(null);
      setRefining(null);
      setWhyOpen(null);
    },
    startAdopt: (id: string) => {
      setAdopting((a) => (a === id ? null : id));
      setRefining(null);
    },
    startRefine: (id: string) => {
      setRefining((r) => (r === id ? null : id));
      setAdopting(null);
    },
    toggleWhy: (id: string) => setWhyOpen((w) => (w === id ? null : id)),
    toggleFaded: () => setShowFaded((s) => !s),
    clearFilter: () => onFilter(undefined),

    async adopt(idea: Listed, opts: { title?: string; into?: string }) {
      try {
        const { path, view } = await ideas.adopt(idea.id, opts);
        setView(view);
        setAdopting(null);
        toast(opts.into ? `Added to ${path}. Its body is untouched.` : `New draft: ${path}. The body is yours.`);
        onOpenDoc(path);
      } catch (e) {
        toast.error(String(e));
      }
    },
    dismiss(idea: Listed) {
      setJustDismissed((s) => new Set(s).add(idea.id));
      if (open === idea.id) setOpen(null);
      void run(ideas.dismiss(idea.id));
    },
    dismissWhy(idea: Listed, reason: string) {
      void run(ideas.dismiss(idea.id, [reason]));
      if (reason === "Wrong about me") openAboutYou();
    },
    undismiss(idea: Listed) {
      setJustDismissed((s) => {
        const next = new Set(s);
        next.delete(idea.id);
        return next;
      });
      void run(ideas.undismiss(idea.id));
    },
    removeReason(idea: Listed, reason: { id: string; text: string }) {
      void run(ideas.reason(idea.id, reason.id, true), {
        text: `Kin won't weigh “${reason.text}” for ideas like this.`,
        undo: () => ideas.reason(idea.id, reason.id, false),
      });
    },
    restoreReason(idea: Listed, reason: { id: string }) {
      void run(ideas.reason(idea.id, reason.id, false));
    },
    fixProfile: () => openAboutYou(),
    refine(idea: Listed, ask: string) {
      setRefining(null);
      void run(ideas.refine(idea.id, ask), { text: "Kin is reworking it in the background. The earlier version is kept." });
    },
    undoRefine(idea: Listed) {
      void run(ideas.undoRefine(idea.id), { text: "Back to the earlier version." });
    },
    discuss(idea: Listed) {
      discussWithKin({ kind: "idea", path: idea.id, label: idea.title });
      void ideas.discussed(idea.id).catch(() => {});
    },
    generate(focus?: string) {
      void run(ideas.generate(focus, filter), { text: filter ? "Kin is looking for ideas for this draft." : "Kin is looking for more ideas." });
    },
    openQuote(quote: Quote) {
      if (quote.source.startsWith("feed:")) {
        if (quote.link && /^https?:\/\//i.test(quote.link)) void openUrl(quote.link).catch((e) => toast.error(String(e)));
        else toast("That Feed item has no link.");
      } else if (quote.source.startsWith("inspiration/")) {
        window.dispatchEvent(new CustomEvent("kintsugi:open-clip", { detail: { path: quote.source } }));
      } else {
        onOpenDoc(quote.source);
      }
    },
  };
}

export type IdeasModel = ReturnType<typeof useIdeas>;
