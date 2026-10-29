# Inspiration

Kintsugi is a writing app with a mind attached: capture anything that
inspires you, from anywhere (a post, a blog, a video, a screenshot, a passing
thought), and reach for it while you write. Think myMind's effortless,
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

## Source

Readable text extracted from the page, for search and the AI. Up to ~20k
characters. Everything above this heading is the clip's own text.
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
one image (bytes + MIME type), plus `capturedAt` and `via`. The receiver
writes the clip at once:

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

- `POST /v1/clips`: `{ url?, text?, note?, image?: base64, imageType?,
  capturedAt, via }` → `{ path }`. Images up to 15 MB.
- `GET /v1/clips` → `ClipSummary[]`, newest first.
- `GET /v1/clip?path=…` → the clip (summary fields + own text + whether it
  has source text).

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

- A reference is an Obsidian wikilink to the clip's file name:
  `[[why-we-sleep]]`. It resolves against `inspiration/` first, then the
  rest of the vault, by basename.
- Typing `[[` in the editor opens a picker of clips (search as you type,
  cards with thumbnails). Choosing one inserts the link.
- Quoting a clip inserts a blockquote attributed to it:
  `> passage\n>\n> [[why-we-sleep]]`.
- In the editor, wikilinks render as small inline chips (title and site);
  hovering shows the card; ⌘-click opens the clip.
- **The margin**: a quiet right-hand panel listing the clips this document
  references and clips related to the paragraph being written. Drag one in
  to quote it.
- Backlinks come from scanning documents for wikilinks; the library's
  **Used in** and the margin share one index.
