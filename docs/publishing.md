# Publishing to hussain.ph

Most complete documents end up on the blog, and the blog's posts are the
writing Hussain references most. This is the contract for both directions:
**publishing** a complete document into the blog repository, and **importing**
the blog's posts into the vault so `[[links]]`, `@`, the margin and search
reach them.

Owner decisions (from `docs/vision.md`, Export): publishing writes the post
and its images into the blog repository's working tree. Hussain reviews,
commits and pushes himself. Kintsugi never runs git, never pushes and calls
no social APIs.

## The blog, as it is

`~/Desktop/code/3d-portfolio` (github.com/hussainph/hussain.ph), read
2026-11: Astro 7 + `@astrojs/mdx`, static output, Markdown through
`@astrojs/markdown-satteri` with the site's own plugins
(`src/lib/markdown.mjs`).

| | Notes | Essays ("Writing") |
| --- | --- | --- |
| Folder | `src/content/notes/` | `src/content/writing/` |
| File | `YYYY-MM-DD-slug.md` / `.mdx`, flat (the loader is `**/*.{md,mdx}` but `posts.ts` throws on a nested filename without a date) | same |
| Frontmatter (`src/content.config.ts`) | optional; `tags` only | `title` (required), `tags` |
| `tags` | `[a-z0-9-]+`, trimmed, lowercased | same |
| URL | `/notes/<slug>/` | `/essays/<slug>/` |
| Date | the filename, never frontmatter | same |
| Preview | first sentence | first prose paragraph ("dek") |

- **Prose extras** are plain Markdown: `## headings` get anchors (three or
  more give an essay a contents rail); fenced code gets a label and Copy, and
  `title="file.ts"` after the language names it; an image alone on its line
  becomes a numbered figure whose Markdown title is the caption; a
  blockquote starting `[!NOTE]` (also TIP, INFO, IMPORTANT, WARNING, CAUTION;
  any case, so Obsidian's `[!note]` works) becomes a callout.
- **MDX components** are not global: an `.mdx` post imports what it uses
  (`import SpringDemo from "…"`, see `src/dev/specimen.mdx`). There is no
  component map to inject.
- **Images:** the site has no image service. A relative image in a post
  (`![](./fig.png)`) goes through `astro:assets`, which needs Sharp, and
  **Sharp isn't installed: `astro build` exits 1** (checked against a
  scratch copy). Files in `public/` are served as they are and build fine.
- **Deploy:** `pnpm build` writes `dist/`; `functions/` and
  `public/_routes.json` show Cloudflare Pages, which builds from the GitHub
  repository. Pushing `main` publishes. Kintsugi stops before that.
- The repo's own `pnpm note` / `pnpm essay` scripts use the same date-plus-
  slug naming and the slugifier copied below (72 characters for essays, 52
  for notes).

## Configuration (Settings → Blog)

- **Blog folder:** the repository's root, chosen with the folder picker. It
  must look like the blog: `src/content.config.ts` plus
  `src/content/writing/`. Status shows the post count or what's wrong.
- **Provenance** (the sources appendix and the "written by a human"
  statement) moved to Settings → Export; see [export.md](export.md).
- **Import posts now:** refreshes the mirror on demand.
- Stored as `blog.json` in the app's config folder (beside `config.json`),
  so a scratch config (headless, KI-7 isolated runs) never touches the
  owner's settings. An isolated run without a scratch config keeps it in
  memory.
- **Headless runs refuse any blog folder outside a `.headless/` directory**,
  so tests only ever write to a scratch copy, never the real repository.

## Importing posts: a generated, read-only mirror

The options:

1. **A virtual source.** Posts stay in the blog repo and Kintsugi reads them
   on the fly. Nothing is duplicated, but every consumer (tree, reference
   index, `[[` and `@`, backlinks, search, Kin, phone sync) would need a
   second kind of document, and Obsidian sees nothing.
2. **A copy.** Import writes ordinary editable documents. Everything works
   at once, but there are now two editable copies of every published post
   and no way to tell which one is right.
3. **A generated mirror (recommended, built).** Import writes each post as a
   plain file under `<vault>/hussain.ph/` (the site's host name), marked as
   a mirror, opened read-only, and **regenerated from the repository**.
   Every existing consumer works unchanged, because these are just vault
   documents, and there is still one source of truth: the repository.
   Edits flow one way only, from repo to mirror.

```
<vault>/hussain.ph/
  essays/the-sixth-attempt.md
  notes/friction.md
```

```yaml
---
title: The sixth attempt        # notes: their first sentence, as the blog does
status: published
tags: [writing, design]
date: 2026-09-16
url: https://hussain.ph/essays/the-sixth-attempt/
post: src/content/writing/2026-09-16-the-sixth-attempt.md
mirror: hussain.ph               # the marker; never hand-written
---
```

The body is the post's body, verbatim. `[[the-sixth-attempt]]` resolves by
basename like any document.

- **When:** when the vault opens (if a blog is configured), after every
  publish, and from Settings. It's a few dozen small files, so it simply
  rewrites what changed.
- **Read-only:** the editor opens a mirror file read-only with a line saying
  where to edit it. `doc_write`, the phone's save, rename and new documents
  inside a mirror file are refused on the backend too (the marker decides,
  so a folder name isn't trusted). Updating links after a rename never
  rewrites a mirror file either (see inspiration.md › Updating links on
  rename).
- **Pruning:** a mirror file whose post has gone is removed. Only files that
  carry the marker are ever rewritten or removed; a hand-written file in the
  same folder is left alone and reported.
- **No duplicates:** a vault document that published a post (it has
  `post:`, below) *is* that post's source, so the post isn't mirrored again;
  links to either resolve to the document.

## Publishing a complete document

**Publish…** (⇧⌘P, or the footer button next to the status) opens a
dialog. Only a `status: complete` document can be written; a draft shows the
preview and asks to mark it complete first. Pending saves are flushed first.

### 1. Plan (pure, `packages/core/src/publish.ts`)

**Kind and file.** Essay by default, Note on request. The file is
`src/content/{writing,notes}/<YYYY-MM-DD>-<slug>.<ext>`:

- *date* is today (local) the first time;
- *slug* is the blog's own slugifier applied to the title (essays) or the
  first line (notes);
- *ext* is `.mdx` only when the body uses MDX (an `import`/`export` line or a
  capitalised JSX tag), else `.md`, which can't trip over a stray `{`.

**Republishing** reuses the document's `post:` file, so the date, slug and
URL never move, even if the title changed (said in the checks). A different
kind than the recorded post is a new file, with a warning that the old one
stays.

**Frontmatter mapping.** Only what the schema accepts goes to the blog:

| Kintsugi | Blog |
| --- | --- |
| `title` (or a leading `# Heading` when there is none) | `title` (essays; required). Notes drop it. |
| `tags` (`[a, b]`, `a, b` or a YAML list) | `tags`, normalised to `[a-z0-9-]+`; changed or dropped tags are warnings |
| `status`, `post`, `url`, `published`, `aliases`, idea metadata, anything else | dropped |
| the date | the filename |

A leading `# Heading` equal to the title is removed (the layout prints the
title). After writing, the document records where it went:
`post: src/content/writing/2026-11-02-on-craft.md`,
`url: https://hussain.ph/essays/on-craft/` and `published: 2026-11-02`. These
are ordinary frontmatter lines, edited through the editor so undo and
autosave behave as usual.

**Wikilinks become blog links.** Resolution is the same as everywhere else
(`resolveReference`, documents before clips):

| Target | Becomes |
| --- | --- |
| A mirror post, or a document with `url:` | `[alias or title](/essays/slug/)` (site-relative) |
| A clip with a source URL | `[alias or title](https://…)` |
| This document itself | its text |
| An unpublished document, a clip without a URL, an unresolved link | plain text (alias, else title, else target) and a **warning** naming it |

Heading fragments are dropped (the blog's anchor slugs aren't guaranteed to
match). `![[note]]` embeds of documents are treated as links. Links inside
code and HTML comments are left alone.

**Images.** Markdown images (`![alt](path "caption")`) and Obsidian embeds
(`![[file.png|alt]]`) with a local path are resolved against the document's
folder, then the vault root, then (embeds only) by file name. Each is copied
to `public/posts/<YYYY-MM-DD-slug>/<safe-name>` and the link rewritten to
`/posts/<id>/<safe-name>`, which the figure plugin captions like any other.
Remote images stay as they are, with a warning that the page loads them
from that host. A missing image is an **error**. (If the blog gains Sharp,
colocated assets would add optimisation; the mapping is one function.)

**MDX compatibility.**

- `import` lines must resolve from the post's folder inside the blog repo;
  a missing module is an error.
- A capitalised JSX tag with no matching import is an error (MDX fails the
  build on it).
- In `.mdx`, HTML comments are invalid, so private `<!-- -->` notes are
  stripped (said in the checks); in `.md` they're stripped too, since
  they're notes to self, not content.
- In `.mdx`, a `{` in prose is JavaScript; it's a warning to escape it.
- Obsidian-only syntax that the blog renders as literal text (`==highlight==`,
  `%%comments%%`) is a warning.

**Provenance: sources appendix and statement.** Both optional and off by
default (Settings → Export, overridable per publish). The appendix lists the
clips the piece references, in order of first reference, as

```md
## Sources

- [Golden joinery](https://example.com/kintsugi), Example Site
```

A clip without a URL is listed by title. The "written by a human" statement
(KI-44) ends the post after a rule, in italics, in the writer's own wording:

```md
---

*Written by a human. I use AI to find sources and to question my drafts, not to write the words.*
```

The link resolution, the appendix and the statement are shared with every
export destination (`resolveLinks`, `sourcesAppendix`, `HUMAN_STATEMENT` in
`publish.ts`; see [export.md](export.md)).

### 2. Check (`blog_check`)

The backend confirms what the plan assumes: whether the post file exists and
whether this document owns it (its `post:` matches), whether it changed in
the repo since Kintsugi last wrote it (a hash ledger in the config folder;
publishing would replace those edits, so it's a warning), which images
resolve, and which imports exist.

### 3. Preview and the checks summary

The dialog shows:

- **Preview:** a rendering in the blog's terms (title, date, tags, minutes,
  figures with numbered captions, callouts, the appendix). It's an
  approximation; the blog's `pnpm dev` is the real thing.
- **File:** the exact file that will be written, plus the image copies, as
  repo paths.
- **Checks:** errors (block writing), warnings (unpublished links, changed
  tags, remote images, overwriting outside edits) and notes (republishing
  the same URL, stripped comments).

### 4. Write (`blog_publish`)

The backend writes only inside the configured repo, only to
`src/content/{writing,notes}/<date>-<slug>.md(x)` and
`public/posts/<id>/…`, atomically, and only replaces an existing post that
the document already owns. On republish, stale images in that post's own
`public/posts/<id>/` folder are removed. It records a hash for the next
check, then the mirror is refreshed.

The dialog ends with what changed in the repo and the next step, which is
Hussain's: review, `git add`, commit, push.

## Not doing (yet)

- Running git, pushing, deploying, or posting anywhere else.
- Running the blog's dev server for the preview.
- Image optimisation or resizing.
- Two-way sync: an edit made in the blog repo shows up in the mirror, not in
  the source document. A republish warns before replacing it.
- The phone: publishing is a Mac action. The phone sees and links to the
  mirror like any other documents.

## Testing

- `packages/core/src/publish.test.ts`: the plan (mapping, links, images,
  MDX checks, appendix, republishing).
- `blog::repo` tests in the desktop crate: reading posts, the mirror,
  writing posts and images only where they belong.
- `apps/desktop/test/runtime-publish.test.ts` (`pnpm --filter
  @kintsugi/desktop test:runtime`): Settings → Blog, the mirror opening
  read-only, and a publish through the real app into a scratch blog.
- A full `pnpm build` of a scratch copy of the real blog with a published
  post (figure, internal link, appendix) succeeds offline; set it up with
  `pnpm install --ignore-workspace --offline` inside the copy, since the
  worktree's own pnpm workspace would otherwise claim it.
