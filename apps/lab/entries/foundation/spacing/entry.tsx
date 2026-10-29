import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { WritingPreview } from "../../page/writing/preview";
export const meta: EntryMeta = {
  id: "foundation/spacing",
  title: "Space around the page",
  kind: "foundation",
  group: "writing",
  status: "exploring",
  sources: ["packages/editor/src/theme.ts", "packages/ui/src/styles.css"],
  tickets: ["KI-15"],
  related: ["foundation/typography", "component/editor", "component/margin"],
  summary:
    "The real editor’s 88px top inset, 32px gutters and 68ch content measure. These are existing layout literals; there is no shared Kintsugi spacing-token scale to imply.",
};
export const controls: Record<string, Control> = {
  topInset: {
    type: "number",
    default: 88,
    min: 24,
    max: 144,
    step: 8,
    target: "packages/editor/src/theme.ts#.cm-content.padding-top",
  },
  gutter: {
    type: "number",
    default: 32,
    min: 16,
    max: 64,
    step: 4,
    target: "packages/editor/src/theme.ts#.cm-content.padding-inline",
  },
};
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "The page’s breathing room",
      render: ({ values, scenario }) => (
        <WritingPreview
          entryId="foundation/spacing"
          margin={false}
          fontSize={19 * scenario.textScale}
          contentPadding={Number(values.topInset)}
          contentGutter={Number(values.gutter)}
        />
      ),
    },
  ],
  variants: [
    {
      id: "close",
      title: "A closer page",
      values: { topInset: 48, gutter: 24 },
    },
  ],
});
