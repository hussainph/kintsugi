/** Publishing a document to the blog (hussain.ph, Astro + MDX), as a pure
 *  plan: what file to write, with what frontmatter and body, which images to
 *  copy, and what to tell the writer first. See docs/publishing.md. The
 *  desktop backend checks the plan against the repository and writes it. */

import { frontmatter, splitFrontmatter } from "./frontmatter.ts";
import { parseWikilinks, resolveReference, type ReferenceSource } from "./references.ts";

export type PostKind = "writing" | "note";
export type CheckLevel = "error" | "warning" | "note";
export type Check = { level: CheckLevel; message: string };

/** A vault document that lives on the blog: a mirror of a post, or a
 *  document that was published (its `url:` frontmatter). */
export type PublishedDoc = { path: string; url: string; post?: string | null };
export type ClipInfo = { path: string; title: string | null; url: string | null; site: string | null; author: string | null };

/** An image the body refers to, with the vault paths it could mean. */
export type ImageRef = { key: string; embed: boolean; candidates: string[]; name: string };

/** What the backend found in the repository and vault for a plan. */
export type BlogCheck = {
  /** The post file already exists in the repository. */
  exists: boolean;
  /** This document published the post (its `post:` names the file, or the
   *  file it replaces), so writing it again is a republish. */
  owned: boolean;
  /** …and it changed in the repository since Kintsugi last wrote it. */
  changed: boolean;
  /** Repository-relative module path (as planned) → whether it exists. */
  imports: Record<string, boolean>;
  /** Image key → the vault file it resolved to, or null. */
  images: Record<string, string | null>;
};

export type PublishInput = {
  /** Vault-relative path of the document. */
  path: string;
  text: string;
  /** Local date, YYYY-MM-DD, used the first time a document is published. */
  today: string;
  kind?: PostKind;
  /** The blog's origin, e.g. https://hussain.ph */
  site: string;
  /** Documents and clips, for resolving [[links]] (as in the editor). */
  sources: readonly ReferenceSource[];
  published: readonly PublishedDoc[];
  clips: readonly ClipInfo[];
  appendix: boolean;
  /** The "written by a human" statement to end the post with, if any. */
  statement?: string | null;
  /** Absent on the first pass, before the backend has checked anything. */
  check?: BlogCheck;
};

export type PublishImage = { from: string; to: string; url: string };

export type PublishPlan = {
  kind: PostKind;
  /** The collection id: the file name without its extension. */
  id: string;
  /** Repository-relative, e.g. src/content/writing/2026-11-02-on-craft.md */
  file: string;
  /** A file of the same post to remove: its extension changed (.md ↔ .mdx). */
  replaces: string | null;
  url: string;
  date: string;
  title: string | null;
  tags: string[];
  /** The whole file that will be written. */
  content: string;
  /** The body alone (after the blog's frontmatter), for the preview. */
  body: string;
  republish: boolean;
  images: PublishImage[];
  imageRefs: ImageRef[];
  /** Repository-relative module paths the post imports. */
  imports: string[];
  checks: Check[];
  /** No errors, and the backend has checked the plan. */
  ready: boolean;
};

export const COLLECTIONS: Record<PostKind, { folder: string; route: string; label: string; slugLength: number }> = {
  writing: { folder: "src/content/writing", route: "essays", label: "Essay", slugLength: 72 },
  note: { folder: "src/content/notes", route: "notes", label: "Note", slugLength: 52 },
};
const IMAGE_FOLDER = "public/posts";
export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const POST_FILE = /^src\/content\/(writing|notes)\/(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.(mdx?)$/;

/** The blog's slugifier (scripts/new-essay.mjs, new-note.mjs). */
export function blogSlug(value: string, limit = 72): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.length <= limit) return slug;
  // Unlike the scripts, a long slug ends on a whole word when it can.
  const cut = slug.slice(0, limit + 1).lastIndexOf("-");
  return (cut > limit / 2 ? slug.slice(0, cut) : slug.slice(0, limit)).replace(/-$/g, "");
}

export function localDate(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A top-level frontmatter value as written (scalar or YAML list). */
function rawField(text: string, key: string): string[] | string | null {
  const block = frontmatter(text);
  if (!block) return null;
  const lines = block.fields.map((line) => line.text);
  const index = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (index === -1) return null;
  const value = lines[index].slice(key.length + 1).trim();
  if (value) return value;
  const items: string[] = [];
  for (const line of lines.slice(index + 1)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (!item) break;
    items.push(item[1]);
  }
  return items;
}

const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

export function scalar(text: string, key: string): string | null {
  const value = rawField(text, key);
  return typeof value === "string" ? unquote(value) || null : null;
}

/** `tags: [a, b]`, `tags: a, b` or a YAML list. */
export function documentTags(text: string): string[] {
  const value = rawField(text, "tags");
  if (value == null) return [];
  const items = Array.isArray(value) ? value : value.replace(/^\[|\]$/g, "").split(",");
  return items.map(unquote).filter(Boolean);
}

/** Tags the schema accepts (`[a-z0-9-]+`), and what changed on the way. */
export function blogTags(tags: readonly string[]): { tags: string[]; changed: string[] } {
  const out: string[] = [];
  const changed: string[] = [];
  for (const tag of tags) {
    const next = blogSlug(tag.replace(/^#/, ""), 64);
    if (next !== tag) changed.push(next ? `${tag} → ${next}` : `${tag} (dropped)`);
    if (next && !out.includes(next)) out.push(next);
  }
  return { tags: out, changed };
}

/** Where a recorded `post:` lives, if it is a valid blog post file. */
export function parsePostFile(file: string | null | undefined) {
  const match = file ? POST_FILE.exec(file) : null;
  if (!match) return null;
  const [, collection, date, slug, ext] = match;
  return { kind: (collection === "notes" ? "note" : "writing") as PostKind, date, slug, ext, id: `${date}-${slug}` };
}

export function postUrl(site: string, kind: PostKind, slug: string): string {
  return `${site.replace(/\/+$/, "")}/${COLLECTIONS[kind].route}/${slug}/`;
}

/** Site-relative when the link is on the blog itself. */
function blogHref(url: string, site: string): string {
  try {
    const target = new URL(url);
    return target.origin === new URL(site).origin ? target.pathname + target.search + target.hash : url;
  } catch {
    return url;
  }
}

type Span = { from: number; to: number };

/** Fenced code, inline code and HTML comments: never rewritten as links or images. */
export function protectedSpans(body: string): { code: Span[]; comments: Span[] } {
  const code: Span[] = [];
  const comments: Span[] = [];
  let fence: { marker: string; from: number } | null = null;
  let pos = 0;
  for (const line of body.split("\n")) {
    const end = pos + line.length + 1;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line.replace(/^(\s*>\s?)+/, ""))?.[1];
    if (fence) {
      if (marker && marker[0] === fence.marker[0] && marker.length >= fence.marker.length) {
        code.push({ from: fence.from, to: Math.min(end, body.length) });
        fence = null;
      }
    } else if (marker) fence = { marker, from: pos };
    pos = end;
  }
  if (fence) code.push({ from: fence.from, to: body.length });
  const inside = (spans: Span[], at: number) => spans.some((s) => at >= s.from && at < s.to);
  for (let i = 0; i < body.length; i++) {
    if (inside(code, i)) continue;
    if (body.startsWith("<!--", i)) {
      const close = body.indexOf("-->", i + 4);
      const to = close === -1 ? body.length : close + 3;
      comments.push({ from: i, to });
      i = to - 1;
    } else if (body[i] === "`" && body[i - 1] !== "\\") {
      let run = i;
      while (body[run] === "`") run++;
      const ticks = body.slice(i, run);
      const close = body.indexOf(ticks, run);
      if (close !== -1 && !body.slice(run, close).includes("\n\n")) {
        code.push({ from: i, to: close + ticks.length });
        i = close + ticks.length - 1;
      } else i = run - 1;
    }
  }
  return { code, comments };
}

function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

export const isRemote = (ref: string) => /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//");
export const decodeRef = (ref: string) => {
  try {
    return decodeURI(ref);
  } catch {
    return ref;
  }
};

/** The vault paths a local image reference could mean, best first. */
export function imageCandidates(ref: string, docPath: string): string[] {
  const clean = decodeRef(ref.split(/[?#]/)[0]);
  const dir = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/")) : "";
  const candidates = clean.startsWith("/") ? [normalize(clean)] : [normalize(`${dir}/${clean}`), normalize(clean)];
  return [...new Set(candidates.filter((c): c is string => !!c))];
}

export type Edit = { from: number; to: number; insert: string };

export const MD_IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"([^"\n]*)"|'([^'\n]*)'))?\s*\)/g;
const JSX_TAG = /<([A-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*)[\s/>]/g;
export const ESM = /^(import|export)\s/;

function safeName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const stem = blogSlug(dot > 0 ? name.slice(0, dot) : name, 60) || "image";
  const ext = (dot > 0 ? name.slice(dot + 1) : "png").toLowerCase().replace("jpeg", "jpg");
  let candidate = `${stem}.${ext}`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem}-${n}.${ext}`;
  taken.add(candidate);
  return candidate;
}

/** Plans a publish. Call once without `check` to learn what to check, then
 *  again with the backend's answer; only then can the plan be `ready`. */
export function planPublish(input: PublishInput): PublishPlan {
  const checks: Check[] = [];
  const say = (level: CheckLevel, message: string) => checks.push({ level, message });
  const { text, path, site } = input;
  const { body: original } = splitFrontmatter(text);

  if (scalar(text, "mirror")) say("error", "This is a mirror of a blog post. Edit it in the blog repository.");
  const status = scalar(text, "status");
  if (status !== "complete") say("error", `Only a complete document can be published (this one is ${status ? `“${status}”` : "without a status"}). Mark it complete with ⇧⌘D.`);

  // Title: frontmatter, else a leading `# Heading`.
  const leading = /^#[ \t]+(.+?)[ \t#]*(?:\n|$)/.exec(original.trimStart())?.[1].trim() ?? null;
  const title = scalar(text, "title") ?? leading;

  // Where it goes: the recorded post, or a new dated file.
  const recorded = parsePostFile(scalar(text, "post"));
  if (scalar(text, "post") && !recorded) say("warning", `The recorded post “${scalar(text, "post")}” isn't a blog post file; this publishes a new one.`);
  const kind: PostKind = input.kind ?? recorded?.kind ?? "writing";
  const collection = COLLECTIONS[kind];
  const sameFile = recorded && recorded.kind === kind ? recorded : null;
  if (recorded && !sameFile) say("warning", `It was published as a ${COLLECTIONS[recorded.kind].label.toLowerCase()}; as a ${collection.label.toLowerCase()} it becomes a new post, and the old file stays in the repository.`);
  const firstLine = original.split("\n").find((line) => line.trim() && !line.startsWith("#") && !ESM.test(line)) ?? "";
  const slug = sameFile?.slug ?? (blogSlug(title ?? firstLine, collection.slugLength) || "untitled");
  if (sameFile && title && blogSlug(title, collection.slugLength) !== sameFile.slug) say("note", `The title changed; the post keeps its address, /${collection.route}/${sameFile.slug}/.`);
  const date = sameFile?.date ?? input.today;
  const id = `${date}-${slug}`;
  if (kind === "writing" && !title) say("error", "An essay needs a title: add `title:` to the frontmatter or start with a `# Heading`.");

  const { code, comments } = protectedSpans(original);
  const shielded = (at: number) => [...code, ...comments].some((s) => at >= s.from && at < s.to);
  const edits: Edit[] = [];

  // A leading H1 that repeats the title: the layout prints the title itself.
  if (leading && title && leading === title.trim()) {
    const start = original.indexOf("#");
    const lineEnd = original.indexOf("\n", start);
    let to = lineEnd === -1 ? original.length : lineEnd + 1;
    while (original[to] === "\n") to++;
    edits.push({ from: 0, to, insert: "" });
  }

  if (comments.length) {
    for (const span of comments) {
      let to = span.to;
      if (original[to] === "\n" && (span.from === 0 || original[span.from - 1] === "\n")) to++;
      edits.push({ from: span.from, to, insert: "" });
    }
    say("note", `${comments.length === 1 ? "An HTML comment was" : `${comments.length} HTML comments were`} left out (they're notes to yourself, and MDX rejects them).`);
  }

  // Images: Markdown images and ![[embeds]] of image files.
  const imageRefs: ImageRef[] = [];
  const images: PublishImage[] = [];
  const taken = new Set<string>();
  const byKey = new Map<string, PublishImage | null>();
  const local = (key: string, ref: string, embed: boolean): string | null => {
    if (!imageRefs.some((r) => r.key === key)) {
      imageRefs.push({ key, embed, candidates: imageCandidates(ref, path), name: decodeRef(ref).split("/").pop() ?? ref });
    }
    if (!input.check) return null;
    if (byKey.has(key)) return byKey.get(key)?.url ?? null;
    const from = input.check.images[key] ?? null;
    if (!from) {
      say("error", `Image not found in the vault: ${ref}`);
      byKey.set(key, null);
      return null;
    }
    const name = safeName(from.split("/").pop()!, taken);
    const image = { from, to: `${IMAGE_FOLDER}/${id}/${name}`, url: `/posts/${id}/${name}` };
    images.push(image);
    byKey.set(key, image);
    return image.url;
  };

  let remote = 0;
  for (const match of original.matchAll(MD_IMAGE)) {
    if (shielded(match.index)) continue;
    const [all, alt, rawRef, dq, sq] = match;
    const ref = rawRef.replace(/^<|>$/g, "");
    if (isRemote(ref)) {
      remote++;
      continue;
    }
    if (ref.startsWith("/posts/")) continue; // Already on the blog.
    const url = local(`md:${ref}`, ref, false);
    const caption = dq ?? sq;
    if (url) edits.push({ from: match.index, to: match.index + all.length, insert: `![${alt}](${url}${caption ? ` "${caption.replace(/"/g, "'")}"` : ""})` });
  }
  if (remote) say("warning", `${remote === 1 ? "An image loads" : `${remote} images load`} from another site; the post depends on it staying there.`);

  // [[Wikilinks]] become blog links, or plain text when the target isn't published.
  const links = resolveLinks(original, {
    path, sources: input.sources, published: input.published, clips: input.clips, shielded,
    href: (url) => blogHref(url, site),
    image: (destination, alias) => {
      const url = local(`embed:${destination}`, destination, true);
      return url ? `![${alias ?? ""}](${url})` : null;
    },
  });
  edits.push(...links.edits);
  const referencedClips = links.clips;
  checks.push(...links.checks);

  const rewritten = applyEdits(original, edits);
  let body = rewritten.replace(/^\s*\n/, "").replace(/\s+$/, "") + "\n";

  // MDX: components need imports, and imports need to exist in the repo.
  const { code: finalCode } = protectedSpans(body);
  const proseLines: string[] = [];
  let at = 0;
  for (const line of body.split("\n")) {
    if (!finalCode.some((s) => at >= s.from && at < s.to)) proseLines.push(line);
    at += line.length + 1;
  }
  const esm = proseLines.filter((line) => ESM.test(line));
  const imported = new Set<string>();
  const imports: string[] = [];
  for (const line of esm) {
    const spec = /from\s+["']([^"']+)["']/.exec(line)?.[1] ?? /^import\s+["']([^"']+)["']/.exec(line)?.[1];
    for (const name of /^import\s+(.+?)\s+from/.exec(line)?.[1].replace(/[{}]/g, ",").split(",") ?? []) {
      const local = name.trim().split(/\s+as\s+/).pop()?.trim();
      if (local && local !== "*") imported.add(local);
    }
    if (spec && /^\.{1,2}\//.test(spec)) {
      const resolved = normalize(`${collection.folder}/${spec}`);
      if (resolved) imports.push(resolved);
      else say("error", `The import “${spec}” points outside the blog repository.`);
    }
  }
  const components = new Set<string>();
  for (const line of proseLines) for (const m of line.matchAll(JSX_TAG)) components.add(m[1].split(".")[0]);
  for (const name of components) if (!imported.has(name)) say("error", `<${name}> is used without an import; MDX would fail the build.`);
  const mdx = esm.length > 0 || components.size > 0;
  const ext = mdx ? "mdx" : "md";
  if (input.check) {
    for (const spec of imports) if (input.check.imports[spec] === false) say("error", `The blog repository has no ${spec} to import.`);
  }
  if (mdx && proseLines.some((line) => !ESM.test(line) && !/^\s*</.test(line) && /(^|[^\\])[{}]/.test(line))) {
    say("warning", "A { or } in the prose is JavaScript in MDX; write \\{ to show a brace.");
  }
  if (proseLines.some((line) => /==[^=\s][^=]*==/.test(line))) say("warning", "==Highlights== aren't Markdown on the blog; they show as typed.");
  if (proseLines.some((line) => /%%/.test(line))) say("warning", "%%Comments%% aren't Markdown on the blog; they show as typed.");

  // Provenance: a sources appendix from the clips the piece references, and
  // the writer's own statement that a human wrote it.
  if (input.appendix) {
    const appendix = sourcesAppendix(referencedClips);
    if (appendix) body += `\n${appendix}`;
    else say("note", "No clips are referenced, so there's no sources appendix.");
  }
  if (input.statement?.trim()) body += `\n---\n\n*${escapeInline(input.statement.trim())}*\n`;

  // The blog's frontmatter: only what its schema accepts.
  const { tags, changed } = blogTags(documentTags(text));
  if (changed.length) say("warning", `Tags changed to fit the blog: ${changed.join("; ")}.`);
  const head = [
    ...(kind === "writing" && title ? [`title: ${JSON.stringify(title)}`] : []),
    ...(tags.length ? [`tags: [${tags.join(", ")}]`] : []),
  ];
  if (kind === "note" && title) say("note", "Notes have no title on the blog; the title is left out.");
  const content = (head.length ? `---\n${head.join("\n")}\n---\n\n` : "") + body;

  const file = `${collection.folder}/${id}.${ext}`;
  const replaces = sameFile && sameFile.ext !== ext ? `${collection.folder}/${id}.${sameFile.ext}` : null;
  if (replaces) say("note", `The post becomes .${ext}; it replaces ${replaces}.`);
  const url = postUrl(site, kind, slug);

  const check = input.check;
  const republish = !!check?.owned;
  if (check?.owned) {
    say("note", `This updates the published post at ${blogHref(url, site)}.`);
    if (check.changed) say("warning", "The post was edited in the blog repository since it was published from here; publishing replaces those edits.");
  } else if (check?.exists) say("error", `${file} already exists in the blog repository and wasn't published from this document.`);

  const order: Record<CheckLevel, number> = { error: 0, warning: 1, note: 2 };
  checks.sort((a, b) => order[a.level] - order[b.level]);
  return {
    kind, id, file, replaces, url, date, title, tags, content, body, republish, images, imageRefs, imports, checks,
    ready: !!check && !checks.some((c) => c.level === "error"),
  };
}

/** The frontmatter fields a document gets once it is written to the blog. */
export function publishedFields(plan: PublishPlan): [string, string][] {
  return [["post", plan.file], ["url", plan.url], ["published", plan.date]];
}

/** Applies non-overlapping edits, last first so offsets stay valid; an edit
 *  overlapping a later one is skipped. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.from - a.from || b.to - a.to);
  let out = text;
  let floor = Infinity;
  for (const edit of sorted) {
    if (edit.to > floor) continue;
    out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to);
    floor = edit.from;
  }
  return out;
}

/** Backslash-escapes what Markdown would read as emphasis or links. */
export const escapeInline = (text: string) => text.replace(/([\\`*_[\]<>])/g, "\\$1");

export type LinkOptions = {
  /** The document being exported (a link to itself is just its words). */
  path: string;
  sources: readonly ReferenceSource[];
  published: readonly PublishedDoc[];
  clips: readonly ClipInfo[];
  /** Offsets inside code or comments, which stay as typed. */
  shielded: (at: number) => boolean;
  /** How a published document's URL is written (site-relative on the blog). */
  href: (url: string) => string;
  /** An `![[image.png|alt]]` embed, as Markdown, or null to leave it. */
  image: (destination: string, alias: string | undefined) => string | null;
};

/** [[Wikilinks]] become Markdown links to where their targets live on the
 *  web (a published post, a clip's source), or plain text with a warning.
 *  Shared by Publish and every export destination. */
export function resolveLinks(original: string, o: LinkOptions): { edits: Edit[]; clips: ClipInfo[]; checks: Check[] } {
  const publishedByPath = new Map(o.published.map((p) => [p.path, p]));
  const clipsByPath = new Map(o.clips.map((c) => [c.path, c]));
  const unpublished = new Set<string>();
  const clips: ClipInfo[] = [];
  const edits: Edit[] = [];
  for (const link of parseWikilinks(original)) {
    if (o.shielded(link.from)) continue;
    const embed = original[link.from - 1] === "!" && original[link.from - 2] !== "\\";
    const from = embed ? link.from - 1 : link.from;
    const destination = link.target.split("#")[0].trim();
    if (embed && IMAGE_EXTENSIONS.test(destination)) {
      const insert = o.image(destination, link.alias);
      if (insert != null) edits.push({ from, to: link.to, insert });
      continue;
    }
    const source = resolveReference(link.target, o.sources);
    const readable = (s: ReferenceSource | null) => link.alias ?? s?.title ?? destination.split("/").pop()!.replace(/\.mdx?$/, "").replace(/[-_]+/g, " ");
    const label = readable(source).replace(/([[\]])/g, "\\$1");
    let insert = label;
    if (source?.kind === "document" && source.path === o.path) {
      // A link to itself is just its words.
    } else if (source?.kind === "document" && publishedByPath.has(source.path)) {
      insert = `[${label}](${o.href(publishedByPath.get(source.path)!.url)})`;
    } else if (source?.kind === "clip") {
      const clip = clipsByPath.get(source.path);
      if (clip && !clips.includes(clip)) clips.push(clip);
      if (clip?.url && /^https?:\/\//i.test(clip.url)) insert = `[${label}](${clip.url})`;
      else unpublished.add(`${readable(source)} (a clip without a link)`);
    } else if (source) {
      unpublished.add(`${readable(source)} (not published)`);
    } else {
      unpublished.add(`${link.target} (not found)`);
    }
    edits.push({ from, to: link.to, insert });
  }
  const checks: Check[] = [...unpublished].map((target) => ({
    level: "warning",
    message: `[[${target.replace(/ \(.*\)$/, "")}]] becomes plain text: ${/\((.*)\)$/.exec(target)?.[1]}.`,
  }));
  return { edits, clips, checks };
}

/** The optional sources appendix: the clips a piece references, in order of
 *  first reference, as Markdown. Null when there are none. */
export function sourcesAppendix(clips: readonly ClipInfo[]): string | null {
  if (!clips.length) return null;
  const items = clips.map((clip) => {
    const name = (clip.title || clip.path.split("/").pop()!.replace(/\.md$/, "")).replace(/([[\]])/g, "\\$1");
    const linked = clip.url && /^https?:\/\//i.test(clip.url) ? `[${name}](${clip.url})` : name;
    const by = [clip.author, clip.site].filter(Boolean).join(", ");
    return `- ${linked}${by ? `, ${by}` : ""}`;
  });
  return `## Sources\n\n${items.join("\n")}\n`;
}

/** The vision's "written by a human" statement, as first offered. The
 *  writer edits it in Settings → Export; it is off until he turns it on. */
export const HUMAN_STATEMENT =
  "Written by a human. I use AI to find sources and to question my drafts, not to write the words.";
