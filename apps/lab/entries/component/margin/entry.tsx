import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { WritingPreview } from "../../page/writing/preview";
export const meta: EntryMeta = {
  id: "component/margin",
  title: "Reference margin",
  kind: "component",
  group: "writing",
  status: "exploring",
  sources: [
    "apps/desktop/src/references/Writing.tsx",
    "apps/desktop/src/references/references.css",
    "apps/desktop/src/references/useReferenceIndex.ts",
  ],
  tickets: ["KI-15"],
  related: ["page/writing", "component/wikilink-chip", "component/clip-card"],
  summary:
    "The private MarginSection and MarginCard are exercised through exported Writing: own work first, references, backlinks, missing targets and draggable quotes.",
};
export const controls: Record<string, Control> = {
  visible: {
    type: "boolean",
    default: true,
    target: "apps/desktop/src/references/Writing.tsx#margin",
  },
};
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "Referenced here and links here",
      render: ({ values, scenario }) => (
        <WritingPreview
          key={String(values.visible)}
          entryId="component/margin"
          margin={Boolean(values.visible)}
          fontSize={19 * scenario.textScale}
        />
      ),
    },
  ],
});
