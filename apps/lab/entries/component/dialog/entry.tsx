import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { DialogPreview } from "./preview";
export const meta: EntryMeta = {
  id: "component/dialog",
  title: "Dialog",
  kind: "component",
  group: "system",
  status: "exploring",
  sources: [
    "packages/ui/src/components/dialog.tsx",
    "apps/desktop/src/inspiration/Detail.tsx",
  ],
  tickets: ["KI-15"],
  related: [
    "component/button",
    "foundation/radius-and-elevation",
    "foundation/motion",
  ],
  summary:
    "Real dialog primitives with product confirmation copy, focus trapping, Escape and a reversible fixture action.",
};
export const controls: Record<string, Control> = {
  title: {
    type: "text",
    default: "Move this clip to Trash?",
    target: "apps/desktop/src/inspiration/Detail.tsx#DialogTitle",
  },
  open: {
    type: "boolean",
    default: true,
    target: "packages/ui/src/components/dialog.tsx#open",
  },
};
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "Confirm moving a clip",
      render: ({ values, scenario }) => (
        <DialogPreview
          key={String(values.open)}
          initialOpen={Boolean(values.open)}
          title={String(values.title)}
          reducedMotion={scenario.reducedMotion}
        />
      ),
    },
  ],
});
