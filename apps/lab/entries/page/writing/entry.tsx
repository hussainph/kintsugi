import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { WritingPreview } from "./preview";

export const meta: EntryMeta = {
  id: "page/writing",
  title: "Writing",
  kind: "page",
  group: "writing",
  status: "exploring",
  sources: [
    "apps/desktop/src/references/Writing.tsx",
    "apps/desktop/src/components/Sidebar.tsx",
    "packages/editor/src/Editor.tsx",
    "apps/desktop/src/references/references.css",
  ],
  tickets: ["KI-15"],
  related: [
    "component/sidebar",
    "component/margin",
    "component/wikilink-chip",
    "page/inspiration-library",
  ],
  summary:
    "The real writing integration, sidebar, shared references and library detail in a frame-local fixture vault.",
};
export const controls: Record<string, Control> = {
  margin: {
    type: "boolean",
    default: true,
    target: "apps/desktop/src/references/Writing.tsx#margin",
  },
  fontSize: {
    type: "number",
    default: 19,
    min: 15,
    max: 26,
    step: 1,
    target: "packages/editor/src/theme.ts#fontSize",
  },
};
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "A draft with references",
      render: ({ values, scenario }) => (
        <WritingPreview
          key={String(values.margin)}
          entryId="page/writing"
          navigation
          margin={Boolean(values.margin)}
          fontSize={Number(values.fontSize) * scenario.textScale}
        />
      ),
    },
    {
      id: "quiet-draft",
      title: "Writing without the margin",
      render: ({ values, scenario }) => (
        <WritingPreview
          entryId="page/writing"
          navigation
          margin={false}
          fontSize={Number(values.fontSize) * scenario.textScale}
        />
      ),
    },
  ],
  variants: [
    {
      id: "focused",
      title: "Words first",
      values: { margin: false, fontSize: 21 },
    },
  ],
});
