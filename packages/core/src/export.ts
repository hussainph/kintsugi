/** Exporting a document: MDX in, a destination out. See docs/export.md.
 *
 *  Every destination starts from the same `Piece`: the document read once,
 *  with its [[links]] resolved to where they live on the web, its images
 *  found in the vault, its private notes and MDX code left out, and its
 *  provenance (the sources appendix and the "written by a human" statement)
 *  attached. A destination only renders a Piece; it never reads Markdown or
 *  the vault itself. Publishing to the blog (publish.ts) is the one
 *  destination with its own plan, because it writes into a repository. */

import { splitFrontmatter } from "./frontmatter.ts";
import { parseMarkdown, walkImages, type Block } from "./markdown.ts";
import {
  applyEdits, documentTags, ESM, imageCandidates, isRemote, MD_IMAGE, protectedSpans, resolveLinks, scalar,
  type Check, type ClipInfo, type Edit, type ImageRef, type PublishedDoc,
} from "./publish.ts";
import type { ReferenceSource } from "./references.ts";
import { renderHtml } from "./export-html.ts";
import { renderText } from "./export-text.ts";
import { renderTypst } from "./export-typst.ts";

export type { Block, Inline } from "./markdown.ts";
export type { Check, ClipInfo, ImageRef } from "./publish.ts";
export { LINKEDIN_FOLD, LINKEDIN_LIMIT } from "./export-text.ts";

export type ExportInput = {
  /** Vault-relative path of the document. */
  path: string;
  text: string;
  /** Local date, YYYY-MM-DD, for a piece that was never published. */
  today: string;
  sources: readonly ReferenceSource[];
  published: readonly PublishedDoc[];
  clips: readonly ClipInfo[];
  appendix: boolean;
  /** The writer's "written by a human" statement, or null to leave it out. */
  statement: string | null;
  /** The backend's answer for `imageRefs`: key → vault path, or null when
   *  missing. Absent on the first pass. */
  images?: Record<string, string | null>;
};

/** A vault image the piece shows, under the name destinations use for it
 *  (blocks refer to it as `asset:<name>`). */
export type Asset = { name: string; from: string };

export type SourceItem = { title: string; url: string | null; by: string | null };

export type Piece = {
  path: string;
  title: string | null;
  date: string;
  tags: string[];
  /** Its address on the blog, when it was published there. */
  url: string | null;
  /** The body, read into blocks; provenance is kept apart. */
  blocks: Block[];
  /** The sources appendix (clips in order of first reference), when on. */
  appendix: SourceItem[] | null;
  statement: string | null;
  words: number;
  /** Local images to look up in the vault (the first pass's question). */
  imageRefs: ImageRef[];
  assets: Asset[];
  /** Applies to every destination; each adds its own when it renders. */
  checks: Check[];
};

export const ASSET = "asset:";

/** Reads a document once for every destination. Call without `images`
 *  first to learn which images to look up, then again with the answer. */
export function preparePiece(input: ExportInput): Piece {
  const checks: Check[] = [];
  const say = (level: Check["level"], message: string) => checks.push({ level, message });
  const { text, path } = input;
  const { body: original } = splitFrontmatter(text);

  const leading = /^#[ \t]+(.+?)[ \t#]*(?:\n|$)/.exec(original.trimStart())?.[1].trim() ?? null;
  const title = scalar(text, "title") ?? leading;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(scalar(text, "published") ?? "") ? scalar(text, "published")! : input.today;
  const url = scalar(text, "url") ?? input.published.find((p) => p.path === path)?.url ?? null;

  const { code, comments } = protectedSpans(original);
  const shielded = (at: number) => [...code, ...comments].some((s) => at >= s.from && at < s.to);
  const edits: Edit[] = [];

  // A leading H1 that repeats the title: every destination prints the title.
  if (leading && title && leading === title.trim()) {
    const start = original.indexOf("#");
    const lineEnd = original.indexOf("\n", start);
    edits.push({ from: 0, to: lineEnd === -1 ? original.length : lineEnd + 1, insert: "" });
  }
  // HTML comments are notes to self.
  for (const span of comments) edits.push({ from: span.from, to: span.to, insert: "" });

  // Images: local ones become assets once the backend has found them.
  const imageRefs: ImageRef[] = [];
  const assets: Asset[] = [];
  const byKey = new Map<string, string | null>();
  const local = (key: string, ref: string, embed: boolean): string | null => {
    if (!imageRefs.some((r) => r.key === key)) {
      imageRefs.push({ key, embed, candidates: imageCandidates(ref, path), name: ref.split("/").pop() ?? ref });
    }
    if (!input.images) return null;
    if (byKey.has(key)) return byKey.get(key)!;
    const from = input.images[key] ?? null;
    if (!from) {
      say("warning", `Image not found in the vault, so it's left out: ${ref}`);
      byKey.set(key, null);
      return null;
    }
    const ext = /\.([a-z0-9]+)$/i.exec(from)?.[1].toLowerCase().replace("jpeg", "jpg") ?? "png";
    const name = `image-${assets.length + 1}.${ext}`;
    assets.push({ name, from });
    byKey.set(key, `${ASSET}${name}`);
    return `${ASSET}${name}`;
  };
  for (const match of original.matchAll(MD_IMAGE)) {
    if (shielded(match.index)) continue;
    const [all, alt, rawRef, dq, sq] = match;
    const ref = rawRef.replace(/^<|>$/g, "");
    if (isRemote(ref)) continue;
    const src = local(`md:${ref}`, ref, false);
    const caption = dq ?? sq;
    edits.push({ from: match.index, to: match.index + all.length, insert: src ? `![${alt}](${src}${caption ? ` "${caption.replace(/"/g, "'")}"` : ""})` : alt ? `*${alt}*` : "" });
  }

  // [[Links]] go where their targets live on the web.
  const links = resolveLinks(original, {
    path, sources: input.sources, published: input.published, clips: input.clips, shielded,
    href: (href) => href,
    image: (destination, alias) => {
      const src = local(`embed:${destination}`, destination, true);
      return src ? `![${alias ?? ""}](${src})` : alias ? `*${alias}*` : "";
    },
  });
  edits.push(...links.edits);
  checks.push(...links.checks);

  const markdown = withoutMdx(applyEdits(original, edits), say);
  const blocks = parseMarkdown(markdown);

  let remote = 0;
  walkImages(blocks, (image) => {
    if (!image.src.startsWith(ASSET)) remote++;
  });
  if (remote) say("note", `${remote === 1 ? "An image comes" : `${remote} images come`} from another site.`);

  let appendix: SourceItem[] | null = null;
  if (input.appendix) {
    appendix = links.clips.map(sourceItem);
    if (!appendix.length) {
      appendix = null;
      say("note", "No clips are referenced, so there's no sources appendix.");
    }
  }
  const statement = input.statement?.trim() || null;

  return {
    path, title, date, url, blocks, appendix, statement, imageRefs, assets, checks,
    tags: documentTags(text),
    words: markdown.replace(/```[\s\S]*?```/g, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0,
  };
}

const sourceItem = (clip: ClipInfo): SourceItem => ({
  title: clip.title || clip.path.split("/").pop()!.replace(/\.md$/, ""),
  url: clip.url && /^https?:\/\//i.test(clip.url) ? clip.url : null,
  by: [clip.author, clip.site].filter(Boolean).join(", ") || null,
});

/** MDX's code (imports, exports, components) and Obsidian-only marks have no
 *  meaning outside the blog: imports go, components go with a warning,
 *  `%%comments%%` go and `==highlights==` keep their words. */
function withoutMdx(markdown: string, say: (level: Check["level"], message: string) => void): string {
  const { code } = protectedSpans(markdown);
  const inCode = (at: number) => code.some((s) => at >= s.from && at < s.to);
  const out: string[] = [];
  const components = new Set<string>();
  let at = 0;
  let island: string | null = null;
  for (const line of markdown.split("\n")) {
    const start = at;
    at += line.length + 1;
    if (inCode(start)) { out.push(line); continue; }
    if (island) {
      if (/\/>\s*$|<\/[A-Z][\w.]*>\s*$/.test(line) || !line.trim()) island = null;
      continue;
    }
    if (ESM.test(line)) continue;
    const tag = /^\s*<([A-Z][\w.]*)/.exec(line);
    if (tag) {
      components.add(tag[1]);
      if (!/\/>\s*$|<\/[A-Z][\w.]*>\s*$/.test(line)) island = tag[1];
      continue;
    }
    out.push(line.replace(/%%[\s\S]*?%%/g, "").replace(/==([^=\s][^=]*?)==/g, "$1"));
  }
  for (const name of components) say("warning", `<${name}> is an MDX component; it only renders on the blog, so it's left out.`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Destinations

/** How a destination hands its result over. `file` asks where to save it;
 *  the backend writes `text` as it is and compiles `typst` to a PDF.
 *  `clipboard` copies text. `publish` is the blog's own flow (publish.ts).
 *  A destination outside the app (for example one Kin adds through MCP)
 *  would be a new delivery that receives the Piece as JSON; the Piece is
 *  plain data so it can cross that boundary as it is. */
export type Delivery =
  | { kind: "file"; format: "text" | "typst"; extension: string; filter: string }
  | { kind: "clipboard" }
  | { kind: "publish" };

export type Rendered = {
  /** What is delivered: the file's text, Typst source, or the clipboard text. */
  content: string;
  checks: Check[];
};

/** What destinations get beside the piece: image bytes as data URLs, for
 *  destinations that carry their images inside the output (HTML). */
export type RenderContext = { dataUrls: Record<string, string> };

export type Destination = {
  id: string;
  label: string;
  /** One line for Settings and the menu. */
  hint: string;
  delivery: Delivery;
  render?: (piece: Piece, context: RenderContext) => Rendered;
};

export const DESTINATIONS: readonly Destination[] = [
  {
    id: "blog",
    label: "hussain.ph",
    hint: "Publish into the blog repository; you commit and push.",
    delivery: { kind: "publish" },
  },
  {
    id: "pdf",
    label: "PDF",
    hint: "A typeset PDF, saved where you choose.",
    delivery: { kind: "file", format: "typst", extension: "pdf", filter: "PDF" },
    render: renderTypst,
  },
  {
    id: "linkedin",
    label: "LinkedIn text",
    hint: "Plain text with links spelled out, copied to the clipboard.",
    delivery: { kind: "clipboard" },
    render: renderText,
  },
  {
    id: "html",
    label: "HTML",
    hint: "One self-contained .html file, images included.",
    delivery: { kind: "file", format: "text", extension: "html", filter: "HTML" },
    render: renderHtml,
  },
];

export const destination = (id: string) => DESTINATIONS.find((d) => d.id === id) ?? null;

/** A file name for the piece: its title (or the document's name), slugged. */
export function exportName(piece: Piece, extension: string): string {
  const base = (piece.title ?? piece.path.split("/").pop()!.replace(/\.mdx?$/, ""))
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 80);
  return `${base || "untitled"}.${extension}`;
}

/** Renders a piece for one destination, with the piece's own checks first. */
export function render(dest: Destination, piece: Piece, context: RenderContext = { dataUrls: {} }): Rendered {
  if (!dest.render) throw new Error(`${dest.label} has no renderer`);
  const out = dest.render(piece, context);
  const order: Record<Check["level"], number> = { error: 0, warning: 1, note: 2 };
  return { content: out.content, checks: [...piece.checks, ...out.checks].sort((a, b) => order[a.level] - order[b.level]) };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** 2 November 2026 */
export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
