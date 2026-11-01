import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import type { KinState } from "./marks";
import {
  CustomizeStory,
  DirectionsStory,
  MadeByKinStory,
  SizesStory,
  StatesStory,
  lookFrom,
} from "./preview";

export const meta: EntryMeta = {
  id: "experiment/kin-look",
  title: "Kin — its look, states and colour",
  kind: "experiment",
  group: "kin",
  status: "exploring",
  sources: [
    "apps/desktop/src/kin/Avatar.tsx",
    "apps/desktop/src/kin/Chat.tsx",
    "docs/vision.md",
  ],
  tickets: ["KI-23", "KI-41"],
  related: ["component/wikilink-chip", "foundation/color", "foundation/motion"],
  summary:
    "Five directions for Kin's mark (gold seam, mended shards, glazed orb, ink portrait, mended k) against the KI-31 placeholder: owner customization, the four states with still forms for reduced motion, every size from nav to phone, and one gold that marks anything Kin made. Nothing in the product changes.",
  question:
    "Which mark reads as a calm, crafted presence at 16px and 96px, carries Kintsugi's gold repair, and gives the owner enough to make it his without becoming a mascot?",
};

export const controls: Record<string, Control> = {
  direction: {
    type: "select",
    default: "seam",
    options: ["seam", "shards", "orb", "portrait", "monogram"],
    target: "apps/desktop/src/kin/Avatar.tsx#KinAvatar",
  },
  glaze: {
    type: "select",
    default: "ink",
    options: ["ink", "porcelain", "celadon", "clay", "indigo", "ash"],
    target: "apps/lab/entries/experiment/kin-look/marks.tsx#glazes",
  },
  form: {
    type: "select",
    default: "round",
    options: ["round", "pebble", "tile"],
    target: "apps/lab/entries/experiment/kin-look/marks.tsx#formPath",
  },
  seed: {
    type: "number",
    default: 417,
    min: 1,
    max: 9999,
    step: 1,
    target: "apps/lab/entries/experiment/kin-look/marks.tsx#seamFor",
  },
  expression: {
    type: "select",
    default: "calm",
    options: ["calm", "attentive", "wry"],
    target: "apps/lab/entries/experiment/kin-look/marks.tsx#PortraitMark",
  },
  state: {
    type: "select",
    default: "thinking",
    options: ["idle", "thinking", "has-something", "listening"],
    target: "apps/lab/entries/experiment/kin-look/marks.tsx#KinState",
  },
};

export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "directions",
      title: "Directions compared",
      render: ({ scenario, values }) => <DirectionsStory look={lookFrom(values, scenario.reducedMotion)} />,
    },
    {
      id: "states",
      title: "States, with still forms",
      render: ({ scenario, values }) => <StatesStory look={lookFrom(values, scenario.reducedMotion)} />,
    },
    {
      id: "sizes",
      title: "Sizes in context: nav, floating, chat, @Kin, phone",
      render: ({ scenario, values }) => (
        <SizesStory look={lookFrom(values, scenario.reducedMotion)} state={values.state as KinState} />
      ),
    },
    {
      id: "customize",
      title: "Your Kin: the owner's controls",
      render: ({ scenario, values }) => {
        const look = lookFrom(values, scenario.reducedMotion);
        return <CustomizeStory key={JSON.stringify(look)} initial={look} />;
      },
    },
    {
      id: "made-by-kin",
      title: "Kin gold: marking what Kin produced",
      render: ({ scenario, values }) => <MadeByKinStory look={lookFrom(values, scenario.reducedMotion)} />,
    },
  ],
  variants: [
    { id: "celadon-pebble", title: "Celadon pebble seam", values: { direction: "seam", glaze: "celadon", form: "pebble", seed: 2203 } },
    { id: "porcelain-shards", title: "Porcelain shards", values: { direction: "shards", glaze: "porcelain", seed: 58 } },
    { id: "clay-portrait", title: "Raku portrait, wry", values: { direction: "portrait", glaze: "clay", expression: "wry" } },
  ],
});
