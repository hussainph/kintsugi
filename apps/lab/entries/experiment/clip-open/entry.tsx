import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { ClipOpenStudy } from "./preview";
export const meta: EntryMeta = {
  id: "experiment/clip-open",
  title: "Clip opening — keeping the thread",
  kind: "experiment",
  group: "inspiration",
  status: "exploring",
  sources: [
    "apps/desktop/src/inspiration/Masonry.tsx",
    "apps/desktop/src/inspiration/Detail.tsx",
    "packages/lab/src/adapters/dialkit.tsx",
  ],
  tickets: ["KI-15"],
  related: [
    "page/inspiration-library",
    "component/clip-card",
    "foundation/motion",
  ],
  summary:
    "A direct Dialkit timeline study around real Masonry and Detail, with replay/scrub, a short settling motion and an explicit reduced-motion path. No product motion is changed.",
  question:
    "Does a short, non-bouncy settle preserve the connection between a card and its detail without slowing repeated reading, compared with an instant change?",
};
export const controls: Record<string, Control> = {
  duration: {
    type: "number",
    default: 0.22,
    min: 0.1,
    max: 0.3,
    step: 0.01,
    target: "packages/lab/src/adapters/dialkit.tsx#MotionStudy.duration",
  },
  initialView: {
    type: "select",
    default: "detail",
    options: ["grid", "detail"],
    target: "apps/lab/entries/experiment/clip-open/preview.tsx#initialDetail",
  },
};
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "Open, replay and scrub a real clip",
      render: ({ scenario, values }) => (
        <ClipOpenStudy
          key={String(values.initialView)}
          duration={Number(values.duration)}
          reducedMotion={scenario.reducedMotion}
          initialDetail={values.initialView === "detail"}
        />
      ),
    },
    {
      id: "from-collection",
      title: "Begin at the collection",
      render: ({ scenario, values }) => (
        <ClipOpenStudy
          duration={Number(values.duration)}
          reducedMotion={scenario.reducedMotion}
          initialDetail={false}
        />
      ),
    },
  ],
  variants: [
    { id: "brisk", title: "150ms comparison", values: { duration: 0.15 } },
    { id: "measured", title: "280ms comparison", values: { duration: 0.28 } },
  ],
});
