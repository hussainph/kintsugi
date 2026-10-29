import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { ClipCardsPreview, ReferenceClipPreview } from "./preview";
export const meta: EntryMeta = {
  id: "component/clip-card",
  title: "Clip cards",
  kind: "component",
  group: "inspiration",
  status: "exploring",
  sources: [
    "apps/desktop/src/inspiration/Masonry.tsx",
    "apps/desktop/src/inspiration/ClipImage.tsx",
    "apps/desktop/src/references/Writing.tsx",
  ],
  tickets: ["KI-15"],
  related: [
    "page/inspiration-library",
    "component/margin",
    "experiment/clip-open",
  ],
  summary:
    "Actual image, quote, note and unenriched cards via Masonry; Writing’s private clip dialog remains reachable through the margin story.",
};
export const controls: Record<string, Control> = {
  kind: {
    type: "select",
    default: "all",
    options: ["all", "image", "quote", "note", "link"],
    target: "apps/desktop/src/inspiration/Masonry.tsx#items",
  },
};
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "Image, passage, thought, bare link",
      render: ({ values }) => <ClipCardsPreview kind={String(values.kind)} />,
    },
    {
      id: "writing-card",
      title: "Open a clip from the margin",
      render: () => <ReferenceClipPreview />,
    },
  ],
  variants: [
    { id: "passages", title: "Quote cards", values: { kind: "quote" } },
  ],
});
