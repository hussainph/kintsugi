import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { WritingPreview } from "../../page/writing/preview";
export const meta: EntryMeta = {
  id: "component/editor",
  title: "Editor",
  kind: "component",
  group: "writing",
  status: "exploring",
  sources: ["packages/editor/src/Editor.tsx", "packages/editor/src/theme.ts"],
  tickets: ["KI-15"],
  related: [
    "foundation/typography",
    "foundation/spacing",
    "component/wikilink-chip",
    "page/writing",
  ],
  summary:
    "The live CodeMirror editor: frontmatter, Markdown hierarchy, selections, search and undo are the product implementation.",
};
export const controls: Record<string, Control> = {
  fontSize: {
    type: "number",
    default: 19,
    min: 15,
    max: 26,
    step: 1,
    target: "packages/editor/src/theme.ts#fontSize",
  },
  lineHeight: {
    type: "number",
    default: 1.7,
    min: 1.3,
    max: 2.1,
    step: 0.05,
    target: "packages/editor/src/theme.ts#.cm-scroller.lineHeight",
  },
};
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "A working draft",
      render: ({ values, scenario }) => (
        <WritingPreview
          entryId="component/editor"
          margin={false}
          fontSize={Number(values.fontSize) * scenario.textScale}
          lineHeight={Number(values.lineHeight)}
        />
      ),
    },
    {
      id: "empty",
      title: "A blank page",
      render: ({ values, scenario }) => (
        <WritingPreview
          entryId="component/editor"
          margin={false}
          initialText=""
          fontSize={Number(values.fontSize) * scenario.textScale}
          lineHeight={Number(values.lineHeight)}
        />
      ),
    },
  ],
});
