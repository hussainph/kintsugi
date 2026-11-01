import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import type { IdeasState } from "./model";
import { IdeasStudy, IdentityStudy, type Layout } from "./variants";

export const meta: EntryMeta = {
  id: "experiment/idea-cards",
  title: "Ideas — cards with progressive disclosure",
  kind: "experiment",
  group: "ideas",
  status: "exploring",
  sources: [
    "docs/vision.md",
    "apps/desktop/src/kin/Avatar.tsx",
    "scripts/seed-desktop.mjs",
  ],
  tickets: ["KI-22", "KI-23"],
  related: ["page/writing", "component/clip-card"],
  summary:
    "Three layouts for Kin's daily ideas (Ledger, Desk, Letter) over one shared model and hand-written fixtures grounded in the seed vault. Covers the batch, engagement (observed vs hunch, quoted clips, how I got here, Why this? as correction), Adopt into an empty draft with the idea beside it, Attach, Refine, Discuss, Dismiss as a signal, and fading.",
  question:
    "Which layout lets five ideas be ignored at a glance, yet makes the one worth engaging with easy to check against its evidence and correct?",
};

export const controls: Record<string, Control> = {
  layout: {
    type: "select",
    default: "ledger",
    options: ["ledger", "desk", "letter"],
    target: "apps/lab/entries/experiment/idea-cards/variants.tsx#IdeasStudy.layout",
  },
};

const first = "what-repair-costs";
const story = (id: string, title: string, initial: Partial<IdeasState> = {}) => ({
  id,
  title,
  render: ({ values }: { values: Record<string, unknown> }) => (
    <IdeasStudy key={String(values.layout)} layout={values.layout as Layout} initial={initial} />
  ),
});

export default defineEntry({
  meta,
  controls,
  stories: [
    story("batch", "Today's batch: titles and one line"),
    story("engaged", "Engaged: observed, hunch, clips", { open: first }),
    story("why-this", "Why this? as correction", { open: first, whyOpen: first }),
    story("adopt", "Adopt: new draft or an existing one", { open: first, adopting: first }),
    story("adopted-draft", "Adopted: an empty draft with the idea beside it", {
      route: { view: "draft", id: first },
      adopted: { [first]: "new" },
    }),
    story("attached-draft", "Adopted into a draft already started", {
      route: { view: "draft", id: "kintsugi-draft-home", attachTo: "notes/repair" },
      adopted: { "kintsugi-draft-home": "notes/repair" },
    }),
    story("after-adopt", "Back in the list: adopted ideas stop fading", {
      adopted: { [first]: "new", "tools-that-shape": "new" },
    }),
    story("refine", "Refine: tell Kin what's off", { open: first, refining: first }),
    story("discuss", "Discuss with Kin", { route: { view: "discuss", id: first } }),
    story("dismiss", "Dismiss as a signal", {
      dismissed: { "kintsugi-draft-home": null, "rest-or-closure": "Already on it" },
    }),
    story("fading", "Fading through the week", { showFaded: true }),
    {
      id: "kin-identity",
      title: "Kin on a card: three treatments",
      render: () => <IdentityStudy />,
    },
  ],
  variants: [
    { id: "ledger", title: "A · Ledger", values: { layout: "ledger" } },
    { id: "desk", title: "B · Desk", values: { layout: "desk" } },
    { id: "letter", title: "C · Letter", values: { layout: "letter" } },
  ],
});
