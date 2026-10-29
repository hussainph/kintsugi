import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { WritingPreview } from "../../page/writing/preview";
const specimen = `---\ntitle: A page with room to think\nstatus: draft\n---\n\n# A page with room to think\n\nThe editor’s prose face leaves your words at the center. **A little weight**, *a softer emphasis*, and the marks of Markdown still within reach.\n\n## Noticing the shape of a thought\n\nHeadings come from the actual highlight style, not a separate Lab type scale. The interface uses Geist; prose uses the platform serif stack.\n\n### A smaller turn\n\n> Something worth keeping, without raising its voice.\n\nInline \`monospace\` and frontmatter have their own quiet place.\n\n#### Details that stay in the margin\n\n- The line is generous.\n- The markup recedes.\n- Your words stay yours.\n`;
export const meta: EntryMeta = {
  id: "foundation/typography",
  title: "Typography",
  kind: "foundation",
  group: "writing",
  status: "exploring",
  sources: [
    "packages/ui/src/styles.css",
    "packages/editor/src/theme.ts",
    "packages/editor/src/Editor.tsx",
  ],
  tickets: ["KI-15"],
  related: ["component/editor", "foundation/spacing", "foundation/color"],
  summary:
    "Live CodeMirror typography: Geist interface, serif prose, mono frontmatter, 19px / 1.7 body and source-defined Markdown heading ratios. Values are source literals, not an invented token scale.",
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
      title: "Markdown as a page",
      render: ({ values, scenario }) => (
        <WritingPreview
          entryId="foundation/typography"
          initialText={specimen}
          margin={false}
          fontSize={Number(values.fontSize) * scenario.textScale}
          lineHeight={Number(values.lineHeight)}
        />
      ),
    },
  ],
  variants: [
    {
      id: "denser",
      title: "Denser reading study",
      values: { fontSize: 17, lineHeight: 1.6 },
    },
  ],
});
