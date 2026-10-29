import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { ColorPreview } from "./preview";
export const meta: EntryMeta = {
  id: "foundation/color",
  title: "Color roles",
  kind: "foundation",
  group: "system",
  status: "exploring",
  sources: ["packages/ui/src/styles.css", "packages/editor/src/theme.ts"],
  tickets: ["KI-15"],
  related: [
    "component/button",
    "foundation/typography",
    "foundation/radius-and-elevation",
  ],
  summary:
    "The live light/dark semantic CSS roles and editor-derived colors, alongside real product buttons and input.",
};
export const controls: Record<string, Control> = {
  role: {
    type: "select",
    default: "primary",
    options: [
      "primary",
      "background",
      "foreground",
      "muted",
      "accent",
      "destructive",
      "border",
      "ring",
      "editor-selection",
    ],
    target: "packages/ui/src/styles.css#theme-color-roles",
  },
};
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "Theme roles in use",
      render: ({ values, scenario }) => (
        <ColorPreview selected={String(values.role)} theme={scenario.theme} />
      ),
    },
  ],
});
