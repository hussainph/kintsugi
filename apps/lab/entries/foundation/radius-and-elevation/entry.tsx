import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { DialogPreview } from "../../component/dialog/preview";
export const meta: EntryMeta = {
  id: "foundation/radius-and-elevation",
  title: "Radius & surface separation",
  kind: "foundation",
  group: "system",
  status: "exploring",
  sources: [
    "packages/ui/src/styles.css",
    "packages/ui/src/components/dialog.tsx",
    "packages/ui/src/components/button.tsx",
  ],
  tickets: ["KI-15"],
  related: ["component/dialog", "component/button", "foundation/color"],
  summary:
    "The actual --radius base (0.625rem) and its source-derived multipliers in product buttons/dialogs. Surface separation uses the dialog’s existing ring, overlay and blur recipe, not a fictional elevation-token scale.",
};
export const controls: Record<string, Control> = {
  radius: {
    type: "number",
    default: 0.625,
    min: 0,
    max: 1.25,
    step: 0.025,
    target: "packages/ui/src/styles.css#--radius",
  },
};
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "A surface above the page",
      render: ({ values, scenario }) => (
        <DialogPreview
          radius={Number(values.radius)}
          reducedMotion={scenario.reducedMotion}
        />
      ),
    },
    {
      id: "resting",
      title: "Resting surface and trigger",
      render: ({ values, scenario }) => (
        <DialogPreview
          initialOpen={false}
          radius={Number(values.radius)}
          reducedMotion={scenario.reducedMotion}
        />
      ),
    },
  ],
  variants: [
    { id: "square", title: "Square-edge study", values: { radius: 0 } },
  ],
});
