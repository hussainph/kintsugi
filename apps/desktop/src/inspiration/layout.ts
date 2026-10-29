import type { ClipPreview } from "./api";

export type Tile = { clip: ClipPreview; x: number; y: number; width: number; height: number; bodyHeight: number };

/** Stable sizes avoid layout shifts while media loads; only visible tiles mount. */
export function masonry(clips: ClipPreview[], width: number) {
  const gap = 24;
  const columns = Math.max(1, Math.floor((width + gap) / (220 + gap)));
  const cardWidth = Math.max(1, (width - gap * (columns - 1)) / columns);
  const bottoms = Array<number>(columns).fill(0);
  const tiles: Tile[] = clips.map((clip) => {
    const column = bottoms.indexOf(Math.min(...bottoms));
    const hash = [...clip.path].reduce((sum, c) => sum + c.charCodeAt(0), 0);
    const bodyHeight = clip.image
      ? Math.round(Math.min(320, cardWidth * [0.78, 1.08, 0.92, 1.24][hash % 4]))
      : Math.min(260, Math.max(150, 100 + Math.ceil((clip.text || clip.summary || "").length / 28) * 22));
    const height = bodyHeight + 78;
    const tile = { clip, x: column * (cardWidth + gap), y: bottoms[column], width: cardWidth, height, bodyHeight };
    bottoms[column] += height + gap;
    return tile;
  });
  return { tiles, height: Math.max(0, ...bottoms) };
}
