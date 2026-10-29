import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { DialogPreview } from "../../component/dialog/preview";
export const meta: EntryMeta = {
  id: "foundation/motion",
  title: "Existing motion recipes",
  kind: "foundation",
  group: "system",
  status: "exploring",
  sources: [
    "packages/ui/src/components/dialog.tsx",
    "packages/ui/src/components/sidebar.tsx",
    "packages/ui/src/styles.css",
  ],
  tickets: ["KI-15"],
  related: ["component/dialog", "experiment/clip-open"],
  summary:
    "The real dialog’s current 100ms fade/zoom recipe. Kintsugi has component-local durations, not a shared motion-token scale; this entry does not pretend otherwise. Reduced-motion scenarios suppress movement.",
};
export const controls: Record<string, Control> = {
  duration: {
    type: "number",
    default: 100,
    min: 0,
    max: 300,
    step: 25,
    target: "packages/ui/src/components/dialog.tsx#duration-100",
  },
};
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "Open, dismiss, reopen",
      render: ({ values, scenario }) => (
        <DialogPreview
          duration={Number(values.duration)}
          reducedMotion={scenario.reducedMotion}
        />
      ),
    },
  ],
  variants: [
    { id: "instant", title: "No transition", values: { duration: 0 } },
    { id: "slower", title: "200ms comparison", values: { duration: 200 } },
  ],
});
