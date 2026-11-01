import { defineEntry, type EntryMeta, type Control, type StoryContext } from "@kintsugi/lab";
import { ClipShapeStudy } from "./preview";
import type { ContentType } from "./clips";
import type { ShapeId } from "./preview";

export const meta: EntryMeta = {
  id: "experiment/clip-shape",
  title: "Clip shape — bite-sized against real ingestions",
  kind: "experiment",
  group: "inspiration",
  status: "exploring",
  sources: [
    "apps/lab/entries/experiment/clip-shape/shapes.tsx",
    "apps/lab/entries/experiment/clip-shape/clips.ts",
    "apps/lab/entries/experiment/clip-shape/capture/src/main.rs",
    "apps/lab/entries/experiment/clip-shape/REPORT.md",
    "crates/vault/src/clips.rs",
    "apps/desktop/src/inspiration/Detail.tsx",
  ],
  tickets: ["KI-21", "KI-40"],
  related: ["component/clip-card", "page/inspiration-library", "experiment/clip-open"],
  summary:
    "Nine real captures (article, X post, YouTube transcript, podcast transcript, PDF paper, HN thread, Reddit post, image, note) shown as A: a tweet-sized card with a thread of dated notes, B: a card that expands to summary and source, C: a long page, and A→B: A with B one tap away.",
  question:
    "Does a tweet-sized card with a thread of short dated notes still carry the nuance the writer cares about, across content types, when the summary and source are one tap away?",
};

export const controls: Record<string, Control> = {
  clip: {
    type: "select",
    default: "all",
    options: ["all", "article", "x-thread", "youtube", "podcast", "paper", "hn-thread", "reddit", "screenshot", "note"],
    target: "apps/lab/entries/experiment/clip-shape/clips.ts#annotations",
  },
  open: {
    type: "boolean",
    default: false,
    target: "apps/lab/entries/experiment/clip-shape/shapes.tsx#Hybrid.open",
  },
  annotate: {
    type: "boolean",
    default: false,
    target: "apps/lab/entries/experiment/clip-shape/preview.tsx#CaptureNote",
  },
};

const story = (shape: ShapeId, id: string, title: string) => ({
  id,
  title,
  render: ({ scenario, values }: StoryContext) => (
    <ClipShapeStudy
      key={`${shape}-${String(values.clip)}-${String(values.open)}`}
      shape={shape}
      only={values.clip as ContentType | "all"}
      open={Boolean(values.open)}
      annotate={Boolean(values.annotate)}
      reducedMotion={scenario.reducedMotion}
    />
  ),
});

export default defineEntry({
  meta,
  controls,
  stories: [
    story("ab", "default", "A→B · Card, then one tap deeper (the bet)"),
    story("a", "card-thread", "A · Tweet-sized card with a note thread"),
    story("b", "expandable", "B · Card that expands to summary and source"),
    story("c", "long-page", "C · Long page"),
  ],
  variants: [
    { id: "annotated", title: "With what each capture kept and lost", values: { annotate: true } },
    { id: "opened", title: "Every card opened", values: { open: true } },
    { id: "transcript", title: "YouTube transcript, opened", values: { clip: "youtube", open: true } },
    { id: "hn", title: "HN thread, opened", values: { clip: "hn-thread", open: true } },
  ],
});
