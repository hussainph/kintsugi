# Inspiration

Kintsugi exists to make writing for the blog easy and delightful. Most
finished pieces are published there. What a piece draws on can come from
anywhere, but most often it's the writer's own work: earlier posts, drafts
and notes in the vault, their projects. Outside inspiration matters too: a
post, a blog, a video, a screenshot, a passing thought.

So Kintsugi is a writing app with a mind attached. It captures anything
worth keeping, from anywhere, and puts the writer's own work and the
captured clips within reach while they write. Think myMind's effortless,
image-forward library with Obsidian's plain files and links, in Kintsugi's
quiet interface.

This document is the contract the capture, library and editor work builds
against. Change it in the same commit as the code that changes the contract.

## Principles

- **Capture is instant and never lost.** A capture is written to disk with
  whatever arrived before anything is fetched. Enrichment comes later and may
  fail; the clip survives either way.
- **No organizing chores.** No folders to choose. The Mac titles, summarizes
  and tags clips by itself; search and the editor find them.
- **Plain files.** Every clip is a Markdown file in the vault. The vault still
  opens in Obsidian, links and all.
- **The writer's own work comes first.** References, search and the margin
  treat the vault's documents (published posts, drafts, notes) as first-class
  sources alongside clips, never as an afterthought.
- **The AI never writes for you.** It organizes inspiration and surfaces it in
  the margin. Your words stay yours.

## Storage

A *clip* is one Markdown file in `inspiration/` at the vault root:

```
inspiration/
  why-we-sleep.md
  media/
    why-we-sleep.jpg
```

- File name: `slugify(title)` (or of the URL host/path, or the first line of
  text, when there's no title yet), made unique like documents are. The file
  name never changes after capture, so links to it stay valid.
- Media (a shared image, a screenshot, a page's hero image) lives in
  `inspiration/media/<slug>.<ext>`, one primary image per clip.
- `vault::tree` (the writing sidebar, and the phone's tree) skips
  `inspiration/`. Clips have their own views.

### A clip file

```markdown
---
kind: link
title: "Why we sleep"
url: "https://www.newyorker.com/…"
site: "The New Yorker"
author: "Jane Doe"
image: "media/why-we-sleep.jpg"
captured: "2026-10-29T14:05"
via: share
tags: [sleep, science, attention]
summary: "One sentence on what this is and why it's interesting."
enriched: "2026-10-29T14:06"
---

> A passage the writer highlighted or shared, if any.

The writer's own note, if any.

<!-- kintsugi:source -->
## Source

Readable text extracted from the page, for search and the AI. Up to ~20k
characters. Everything above the invisible boundary comment is the clip's
own text. New captures keep the comment even before a source is available,
so a captured note can itself contain `## Source` or an unfinished code
fence without losing words. The exact `<!-- kintsugi:source -->` comment is
reserved (escaped on capture if supplied as text). Legacy files without the
comment use the first `## Source` heading outside a fenced code block.
```

Frontmatter fields. All optional except `kind` and `captured`:

| Field | Meaning |
| --- | --- |
| `kind` | `link` (article, blog, page), `post` (X, Instagram, Threads, Bluesky, TikTok…), `video`, `image`, `quote` (a passage with a source), `note` (just a thought) |
| `title` | Human title. Written by the capture if known, else by enrichment |
| `url` | Canonical source URL |
| `site` | Publisher or platform name |
| `author` | Author or account handle |
| `image` | Path relative to the clip file |
| `captured` | The capturing device's local time, `YYYY-MM-DDTHH:MM`, as inbox captures use |
| `via` | `mac`, `phone`, `share` (a share sheet or extension) |
| `tags` | Lowercase tags. Enrichment adds them, preferring tags already in use. The writer may edit them |
| `summary` | One sentence, written by enrichment |
| `enriched` | When enrichment finished. Absent means "not yet" |
| `enrich_error` | Why enrichment gave up, after its retries |

The frontmatter is flat: scalars, plus lists written inline (`[a, b]`).
Readers also accept block lists (`tags:\n  - a`), because Obsidian writes them.

## Capture

A capture carries any of: `url`, `text` (a shared passage or a note), `note`,
one image (bytes + MIME type), plus `capturedAt` and `via`. An optional
`title` is used when the capturing app already knows it. URLs must be HTTP
or HTTPS; empty captures are rejected. `capturedAt` is required local time
in `YYYY-MM-DDTHH:MM` form. The receiver writes the clip at once:

- the `kind` guessed from what arrived (a known social host → `post`, a
  video host → `video`, an image without a URL → `image`, text with a URL →
  `quote`, text alone → `note`, otherwise `link`),
- shared text as a blockquote when there's a URL, as plain text otherwise,
- the image saved to `media/`.

### Channels

- **Phone share sheet** (iOS share extension): share from any app (Safari,
  X, Instagram, YouTube, Photos, screenshots) into Kintsugi. The extension
  queues the capture and the app or extension delivers it to the Mac, same
  outbox guarantees as text captures today.
- **Phone app**: the existing capture box. Pasting a URL makes a clip.
- **Mac**: paste or drop a URL, image or text into the Inspiration library.
  (Later: a browser extension, and a macOS share extension.)

### Phone API

Added to the server in `apps/desktop/src-tauri/src/phone/server.rs` and its
client in `packages/core/src/remote.ts`; `hello` reports `api: 2`.

- `POST /v1/clips`: `{ url?, text?, note?, title?, image?: base64, imageType?,
  capturedAt, via }` → `{ path }`. Images up to 15 MiB decoded; `imageType`
  is required with image bytes. Supported types: JPEG, PNG, GIF, WebP, HEIC,
  HEIF and AVIF. SVG is not accepted. Invalid captures return 400 without
  writing a clip (422 for a JSON field/type error, 413 for an oversized image
  or request). Errors never echo capture content. The request body limit
  allows base64's encoding overhead.
- `GET /v1/clips` → `ClipSummary[]`, newest first (path breaks timestamp ties).
  A summary has `path`, `kind`, `captured`, `tags`, and nullable `title`,
  `url`, `site`, `author`, `image`, `via`, `summary`, `enriched`, `enrichError`.
  `path` is vault-relative; `image` remains relative to the clip file.
- `GET /v1/clip?path=…` → the summary fields plus `text` (own text, without
  frontmatter or source) and `hasSource`. Extracted source is kept on disk,
  not sent to the phone. Missing clips return 404; non-clip paths return 400.

The shared types live in `@kintsugi/core/clips`. The remote client exposes
`captureClip(capture)`, `clips()` and `clip(path)`. Existing document and
inbox-capture API calls remain compatible.

### Desktop and storage API

The desktop commands are `clip_list`, `clip_read`, `clip_create({ capture })`,
`clip_update({ path, title?, tags?, note? })` and `clip_trash({ path })`.
Desktop captures carry image bytes rather than base64 (`DesktopClipCapture`
uses a JSON number array; convert a `Uint8Array` with `Array.from`).
`ClipEdit` and `ClipChanged` type the edit arguments and event payload.
Updating `note` replaces the whole own-text section (including a shared quote, if present),
not the extracted source. An omitted edit field is unchanged; an empty title
clears it and an empty tag array clears tags. Trash includes the primary
image. Generic desktop/phone document mutation commands reject paths in
`inspiration/`; clip names stay stable and all clip writes share their lock.
Successful desktop and phone mutations emit `clips:changed` with
`{ path }`; enrichment uses that event too.

The vault crate exports `clip_list`, `clip_read`, `clip_create`, `clip_update`,
`clip_enrich`, `clip_save_media`, `clip_trash`, and `clips_needing_enrichment`.
Metadata updates are patches against the latest file. `ClipUpdate` also accepts `kind`, `url`,
`site`, `author`, `image`, `summary`, `enriched`, `enrich_error`, and `source`;
an absent field is untouched, an empty optional scalar clears it. Source
updates are limited to 20,000 characters and preserve the own-text prefix;
metadata-only updates preserve the entire body byte-for-byte. Writer edits,
enrichment, media saves and trash share one in-process mutex per clip path;
unique capture names are selected serially. `clip_enrich` compares against
the pre-fetch summary under that lock: it fills only a still-missing title,
leaves concurrently edited tags alone,
and cannot change own text. `clip_save_media` fills a missing primary image
and sets its field; if an image already exists, it returns that path without
replacing the screenshot. Media writes never overwrite an existing file.
Capture naming also avoids orphan media names. `clip_trash` takes the
desktop's OS Trash callback under the same lock, so enrichment cannot
resurrect a trashed clip. Pending enrichment
excludes clips with either `enriched` or `enrich_error` set. Invalid external
clip files are skipped by listing, while reading one reports an error.

## Enrichment (on the Mac)

A background worker picks up clips without `enriched` (on capture, at
launch, and when a vault opens), one at a time:

1. **Fetch**: the URL's HTML: OpenGraph / Twitter card / `<title>` metadata,
   oEmbed where the platform offers it (YouTube, X, Bluesky, TikTok, Vimeo),
   readable main text, and the hero image if the clip has none, saved to
   `media/`. Socials behind a login wall give little; the clip keeps what the
   share sheet sent (text, screenshot).
2. **Think**: one AI call (the `edit`-quality model via the existing
   harness) given the metadata, own text and source text, plus the vault's
   existing tags. It returns a title if missing, a one-sentence summary, 2 to 5
   tags, and a corrected `kind`.
3. **Write back**: the frontmatter fields and the `## Source` section, with
   `enriched` set. The writer's own text is never touched. Failures retry
   with backoff, then set `enrich_error`.

## Library (Mac)

A view beside the editor, reached from the sidebar and with ⇧⌘I:

- A masonry grid of cards, newest first: image-forward when there's an
  image, the quote or note otherwise, with the site and title small beneath.
- One search field over title, summary, tags, own text, source text and
  site, with tag filters. Lexical first; semantic search comes later.
- A card opens a detail view with the large image, the quote and note
  (editable), source link, editable tags, and **Used in**: the documents that
  reference this clip.
- Paste or drop anywhere in the library to capture.

## Referencing in writing

- A reference is an Obsidian wikilink to a file name: a clip
  (`[[why-we-sleep]]`) or one of the writer's own documents
  (`[[on-craft]]`). It resolves by basename across the whole vault; if a
  clip and a document share a name, the document wins (`[[inspiration/x]]`
  reaches the clip).
- Typing `[[` in the editor opens one picker over the writer's documents and
  clips (search as you type; documents show title and status, clips show
  cards with thumbnails). Choosing one inserts the link.
- Quoting a clip inserts a blockquote attributed to it:
  `> passage\n>\n> [[why-we-sleep]]`.
- In the editor, wikilinks render as small inline chips (title and site);
  hovering shows the card; ⌘-click opens the clip.
- **The margin**: a quiet right-hand panel listing what this document
  references and what relates to the paragraph being written: the writer's
  own documents first, then clips. Drag one in to quote it.
- Backlinks come from scanning documents for wikilinks; the library's
  **Used in**, a document's own backlinks and the margin share one index.

## Publishing (to be designed)

Most complete documents end up on the blog: hussain.ph, an Astro + MDX site
(`~/Desktop/code/3d-portfolio`). Publishing a document there, and importing
the blog's existing posts so they can be referenced, get their own design.
