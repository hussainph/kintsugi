import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { WritingPreview } from "../../page/writing/preview";
export const meta: EntryMeta = {
  id: "component/wikilink-chip",
  title: "Wikilink chip",
  kind: "component",
  group: "writing",
  status: "exploring",
  sources: [
    "packages/editor/src/references.ts",
    "apps/desktop/src/references/Writing.tsx",
  ],
  tickets: ["KI-15"],
  related: ["component/editor", "component/margin", "component/clip-card"],
  summary:
    "Actual CodeMirror reference widgets: resolved document, captured clip, alias and missing target. Click to edit; modifier-click to open.",
};
export const controls: Record<string, Control> = {
  alias: {
    type: "text",
    default: "the visible seam",
    target: "packages/editor/src/references.ts#ReferenceChip",
  },
};
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "References in prose",
      render: ({ values, scenario }) => (
        <WritingPreview
          key={String(values.alias)}
          entryId="component/wikilink-chip"
          margin={false}
          fontSize={19 * scenario.textScale}
          initialText={`# A thought with company\n\nThe thought begins here.\n\nRead [[on-craft]] again, then look at [[the-beauty-of-repair|${String(values.alias).replace(/[\[\]\n]/g, "")}]].\n\nA clip can also be a passage: [[work-with-the-door-open]].\n\nNot every thought is finished: [[not-written-yet]].\n\nType [[ to find your own writing and captured inspiration together.\n`}
        />
      ),
    },
  ],
});
