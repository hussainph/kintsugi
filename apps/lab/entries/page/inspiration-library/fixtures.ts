import type { Clip, DesktopClipCapture } from "@kintsugi/core/clips";
import type { Doc, Entry } from "@kintsugi/core/vault";
import {
  parseWikilinks,
  resolveReference,
  type ReferenceSource,
} from "@kintsugi/core/references";
import {
  labBridge,
  registerFixtureHandlers,
  type FixtureArgs,
} from "../../../bridge/install";
import { imageBytes } from "./images";

export const writingPath = "a-place-for-attention.md";
export const writingText = `---
title: A place for attention
status: draft
---

# A place for attention

The best tools leave room for the unfinished thought. A quiet window, a page with a little resistance, something worth returning to.

I keep coming back to [[on-craft]]: the work is not to make more, but to notice what is already here.

A seam can be an invitation rather than a flaw. [[the-beauty-of-repair]] makes that visible.

## Keeping things close

A reference should sit beside the paragraph, not interrupt it. The margin is a small promise that the thought will still be here when I need it.

[[an-unfinished-thought]] is a name for something I have not written yet.
`;
export const documentSeeds = [
  {
    path: writingPath,
    title: "A place for attention",
    status: "draft",
    text: writingText,
  },
  {
    path: "on-craft.md",
    title: "On craft",
    status: "complete",
    text: "# On craft\n\nAttention is a practice. Leave the work better than you found it. A seam can tell the story of a repair.\n\n[[a-place-for-attention]]",
  },
  {
    path: "notes/windows.md",
    title: "Windows, not dashboards",
    status: "draft",
    text: "# Windows, not dashboards\n\nWhat if software gave us a place to look, rather than a list to finish?\n\n[[the-beauty-of-repair]]",
  },
];
const seedClips: Clip[] = [
  {
    path: "inspiration/the-beauty-of-repair.md",
    kind: "image",
    captured: "2026-10-29T14:05",
    title: "The beauty of repair",
    url: null,
    site: null,
    author: null,
    image: "media/stone.png",
    file: null,
    tags: ["craft", "attention"],
    summary: "A visible seam makes the repair part of the object’s story.",
    enriched: "2026-10-29T14:06",
    enrichError: null,
    via: "share",
    text: "A repaired bowl, kept because of the seam rather than in spite of it.\n\nA thought for the next piece about craft.",
    hasSource: false,
  },
  {
    path: "inspiration/a-room-to-think.md",
    kind: "image",
    captured: "2026-10-29T13:50",
    title: "A room to think",
    url: null,
    site: null,
    author: null,
    image: "media/window.png",
    file: null,
    tags: ["spaces", "attention"],
    summary: "Light, a window, and enough room to pay attention.",
    enriched: "2026-10-29T13:51",
    enrichError: null,
    via: "phone",
    text: "Leave some space around the thing that matters.",
    hasSource: false,
  },
  {
    path: "inspiration/work-with-the-door-open.md",
    kind: "quote",
    captured: "2026-10-28T16:20",
    title: "Work with the door open",
    url: "https://example.com/door-open",
    site: "Field notes (fixture)",
    author: "Lab fixture",
    image: null,
    file: null,
    tags: ["writing", "craft"],
    summary: "Keep a little of the process visible.",
    enriched: "2026-10-28T16:21",
    enrichError: null,
    via: "mac",
    text: "> The unfinished edges are often where the next idea begins.\n\nA fictional passage for testing the quote interaction.",
    hasSource: true,
  },
  {
    path: "inspiration/a-small-page.md",
    kind: "image",
    captured: "2026-10-28T12:15",
    title: "A small page, well considered",
    url: null,
    site: null,
    author: null,
    image: "media/paper.png",
    file: null,
    tags: ["typography", "writing"],
    summary: "A generous page with almost nothing on it.",
    enriched: "2026-10-28T12:16",
    enrichError: null,
    via: "share",
    text: "A typographic sketch. The silence around the paragraph is doing some of the work.",
    hasSource: false,
  },
  {
    path: "inspiration/notice-what-stays.md",
    kind: "note",
    captured: "2026-10-27T09:30",
    title: "Notice what stays",
    url: null,
    site: null,
    author: null,
    image: null,
    file: null,
    tags: ["attention"],
    summary: null,
    enriched: null,
    enrichError: null,
    via: "phone",
    text: "Perhaps a library should be less like a filing cabinet and more like a walk: something catches your eye, and you stop.",
    hasSource: false,
  },
  {
    path: "inspiration/still-on-its-way.md",
    kind: "link",
    captured: "2026-10-26T18:40",
    title: null,
    url: "https://example.com/still-on-its-way",
    site: null,
    author: null,
    image: null,
    file: null,
    tags: [],
    summary: null,
    enriched: null,
    enrichError: null,
    via: "share",
    text: "",
    hasSource: false,
  },
];
const clone = <T>(value: T): T => structuredClone(value);
const stringArg = (args: FixtureArgs, key: string): string => {
  if (typeof args[key] !== "string")
    throw new Error(`Lab fixture requires ${key}`);
  return args[key] as string;
};

/** One fixture store per preview frame. No disk, owner config or network I/O. */
export function createInspirationFixtures(entryId: string, empty = false) {
  const bridge = labBridge();
  const items = clone(empty ? [] : seedClips);
  const documents = clone(documentSeeds);
  const capturedImages = new Map<string, ArrayBuffer>();
  const openedSources: string[] = [];
  let captureSequence = 0;
  const find = (path: string) => {
    const item = items.find((clip) => clip.path === path);
    if (!item) throw new Error(`Clip not found in Lab fixtures: ${path}`);
    return item;
  };
  const changed = (path: string) => bridge.emit("clips:changed", { path });
  const preview = (clip: Clip) => {
    const { hasSource: _, ...rest } = clip;
    return { ...rest, text: clip.text.slice(0, 600) };
  };
  const search = (args: FixtureArgs = {}) => {
    const terms = String(args.query ?? "")
      .toLocaleLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const tags = Array.isArray(args.tags)
      ? args.tags.map((tag) => String(tag).trim().toLocaleLowerCase())
      : [];
    const matches = items.filter((clip) => {
      const haystack = [
        clip.title,
        clip.summary,
        clip.text,
        clip.site,
        clip.url,
        ...clip.tags,
      ]
        .join(" ")
        .toLocaleLowerCase();
      return (
        terms.every((term) => haystack.includes(term)) &&
        tags.every((tag) => clip.tags.includes(tag))
      );
    });
    const offset = Math.max(0, Number(args.offset ?? 0));
    const limit = Math.min(120, Math.max(1, Number(args.limit ?? 60)));
    return clone({
      clips: matches.slice(offset, offset + limit).map(preview),
      total: matches.length,
      tags: [...new Set(items.flatMap((clip) => clip.tags))].sort(),
    });
  };
  const referenceIndex = () => {
    const sources: ReferenceSource[] = [
      ...documents.map((doc) => ({ kind: "document" as const, ...doc })),
      ...items.map((clip) => ({
        ...clip,
        kind: "clip" as const,
        title: clip.title ?? clip.path,
      })),
    ];
    return clone({
      documents,
      clips: items.map(({ text: _, hasSource: __, ...clip }) => clip),
      links: documents.flatMap((doc) =>
        parseWikilinks(doc.text).map((link) => ({
          source: doc.path,
          target: link.target,
          resolved: resolveReference(link.target, sources)?.path ?? null,
        })),
      ),
    });
  };
  const dispose = registerFixtureHandlers(entryId, {
    clip_list: () => clone(items),
    clip_search: search,
    clip_read: (args) => clone(find(stringArg(args, "path"))),
    clip_image: (args) => {
      const path = stringArg(args, "path");
      const clip = find(path);
      const captured = capturedImages.get(path);
      if (captured) return captured.slice(0);
      if (!clip.image) throw new Error("This fixture clip has no image");
      return imageBytes(
        clip.image.includes("window")
          ? "window"
          : clip.image.includes("paper")
            ? "paper"
            : "stone",
      );
    },
    clip_update: (args) => {
      const clip = find(stringArg(args, "path"));
      if (args.title !== undefined) clip.title = String(args.title) || null;
      if (args.note !== undefined) clip.text = String(args.note);
      if (Array.isArray(args.tags)) clip.tags = args.tags.map(String);
      changed(clip.path);
      return clone(clip);
    },
    clip_trash: (args) => {
      const clip = find(stringArg(args, "path"));
      items.splice(items.indexOf(clip), 1);
      capturedImages.delete(clip.path);
      changed(clip.path);
      return null;
    },
    clip_create: (args) => {
      const capture = args.capture as DesktopClipCapture | undefined;
      if (
        !capture ||
        (!capture.url &&
          !capture.text &&
          !capture.note &&
          !capture.image?.length)
      )
        throw new Error("An empty fixture capture cannot be saved");
      const path = `inspiration/lab-capture-${++captureSequence}.md`;
      const clip: Clip = {
        path,
        kind: capture.image?.length ? "image" : capture.url ? "link" : "note",
        captured: capture.capturedAt,
        via: capture.via,
        title: capture.title ?? null,
        url: capture.url ?? null,
        site: null,
        author: null,
        image: capture.image?.length ? "media/capture.png" : null,
        file: null,
        tags: [],
        summary: null,
        enriched: null,
        enrichError: null,
        text: [capture.text, capture.note].filter(Boolean).join("\n\n"),
        hasSource: false,
      };
      if (capture.image)
        capturedImages.set(path, Uint8Array.from(capture.image).buffer);
      items.unshift(clip);
      changed(path);
      return path;
    },
    reference_index: referenceIndex,
    "plugin:opener|open_url": (args) => {
      const url = stringArg(args, "url");
      if (!/^https?:\/\//.test(url))
        throw new Error("Only HTTP(S) fixture source links are supported");
      openedSources.push(url);
      return null;
    },
  });
  return {
    items,
    documents,
    search,
    referenceIndex,
    openedSources,
    dispose,
    saveDocument(path: string, text: string) {
      const doc = documents.find((doc) => doc.path === path);
      if (!doc) throw new Error(`Document not found in Lab fixtures: ${path}`);
      doc.text = text;
      bridge.emit("references:changed", { path });
    },
  };
}
export function documentTree(): Entry[] {
  const docs: Doc[] = documentSeeds.map((doc) => ({
    kind: "doc",
    name: doc.path.split("/").pop()!,
    path: doc.path,
    title: doc.title,
    status: doc.status,
  }));
  return [
    ...docs.filter((doc) => !doc.path.includes("/")),
    {
      kind: "folder",
      name: "notes",
      path: "notes",
      children: docs.filter((doc) => doc.path.startsWith("notes/")),
    },
  ];
}
