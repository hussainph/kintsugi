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

Readable Markdown extracted from the page, for search and the AI. Up to
20,000 characters. Everything above the invisible boundary comment is the clip's
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
| `via` | `mac`, `phone`, `share` (a share sheet or extension), `feed` (saved from the Feed; see `docs/feed.md`) |
| `tags` | Lowercase tags. Enrichment adds them, preferring tags already in use. The writer may edit them |
| `summary` | One sentence, written by enrichment |
| `enriched` | When enrichment finished. Absent means "not yet" |
| `enrich_error` | Why enrichment gave up, after its retries |

The frontmatter is flat: scalars, plus lists written inline (`[a, b]`).
Readers also accept block lists (`tags:\n  - a`), because Obsidian writes them.

## Capture

A capture carries any of: `url`, `text` (a shared passage or a note), `note`,
one image (bytes + MIME type), plus `capturedAt` and `via`. An optional
client-generated `id` is a UUID string in hyphenated 8-4-4-4-12 hexadecimal
form (case-insensitive). Generate it once when queuing a capture and persist
it with that capture; every delivery attempt, including the share extension
and app outbox, must reuse it. Omit it only for legacy/non-retried captures.
An optional `title` is used when the capturing app already knows it. URLs
must be HTTP or HTTPS; empty captures are rejected. `capturedAt` is required local time
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

- `POST /v1/clips`: `{ id?, url?, text?, note?, title?, image?: base64, imageType?,
  capturedAt, via }` → `{ path }` with 200, including on a duplicate `id`.
  Invalid UUID strings return 400 (wrong field types return 422; null IDs
  are treated as omitted).
  Images up to 15 MiB decoded; `imageType`
  is required with image bytes. Supported types: JPEG, PNG, GIF, WebP, HEIC,
  HEIF and AVIF. SVG is not accepted. Invalid captures return 400 without
  writing a clip (422 for a JSON field/type error, 413 for an oversized image
  or request). Storage/receipt failures return 500 and may be retried with
  the same ID: a 500 can occur after the clip was saved. Errors never echo
  capture content. The request body limit allows base64's
  encoding overhead.
- `GET /v1/clips` → `ClipSummary[]`, newest first (path breaks timestamp ties).
  A summary has `path`, `kind`, `captured`, `tags`, and nullable `title`,
  `url`, `site`, `author`, `image`, `via`, `summary`, `enriched`, `enrichError`.
  `path` is vault-relative; `image` remains relative to the clip file.
- `GET /v1/clip?path=…` → the summary fields plus `text` (own text, without
  frontmatter or source) and `hasSource`. Extracted source is kept on disk,
  not sent to the phone. Missing clips return 404; non-clip paths return 400.

The shared types live in `@kintsugi/core/clips`. The remote client exposes
`captureClip(capture)`, `clips()` and `clip(path)`. Non-OK replies throw the
exported `HttpError` from `@kintsugi/core/remote`, carrying numeric `status`
and the server's message in `message` (a safe fallback if none was supplied).
`isPermanentCaptureStatus(status)` is true only for **400, 413 and 422**:
keep those rejected captures for the writer to fix or discard, but do not
auto-retry the unchanged payload. Other HTTP statuses (notably 408, 429 and
5xx) remain retry candidates with backoff. `Unpaired` (401) still requires
pairing again; `Offline` still covers network failures/timeouts and 502/504.
An accepted document-write conflict (409) is still returned, not thrown.
Existing document and inbox-capture API calls remain compatible.

### Desktop and storage API

The desktop commands are `clip_list`, `clip_read`, `clip_create({ capture })`,
`clip_update({ path, title?, tags?, note? })` and `clip_trash({ path })`.
Desktop captures carry image bytes rather than base64 (`DesktopClipCapture`
uses a JSON number array; convert a `Uint8Array` with `Array.from`).
Both desktop and phone captures accept the same optional `id` and use one
receipt service in the desktop app. It keeps the latest **1024 distinct IDs**
(oldest first eviction, duplicate reads do not refresh order), scoped to the
canonical vault root, in `clip-capture-ids.json` in the app config directory.
No IDs or receipt indexes are added to the vault's plain files. Lookup and
creation share one in-process lock across both entry points. While retained,
a repeated ID returns the original path without rewriting the clip, media or
receipt file, even if the clip was edited or trashed; it never resurrects it.
The original capture wins over changed retry content. After eviction (or if
app config is deleted), the ID no longer has a deduplication guarantee.

The receipt journal reserves the selected path before any clip/media write,
then marks it complete before answering success. Every app capture, even
without an ID, skips other pending reservations during naming, so it cannot
take a crashed capture's filename. On restart, a pending reservation whose
clip exists is completed rather than duplicated, even after enrichment or
writer edits; if no clip was saved, delivery can try again. Known failed
writes release their reservation when possible. App trash completes pending
receipts before deleting their clip, so a retry cannot resurrect it either.
An unreadable/corrupt receipt store fails closed for all app clip captures
(and clip trash) with an error instead of silently losing IDs. Repair the
app config's `clip-capture-ids.json` before retrying; deleting it deliberately
resets the deduplication guarantee. This journal coordinates app operations,
not arbitrary external tools writing into unpublished reserved paths.

`ClipEdit` and `ClipChanged` type the edit arguments and event payload.
Updating `note` replaces the whole own-text section (including a shared quote, if present),
not the extracted source. An omitted edit field is unchanged; an empty title
clears it and an empty tag array clears tags. Trash includes the primary
image. Generic desktop/phone document mutation commands reject paths in
`inspiration/`; clip names stay stable and all clip writes share their lock.
Successful desktop and phone mutations emit `clips:changed` with
`{ path }`; enrichment uses that event too. Already-completed duplicate
captures emit no event.

The vault crate exports `clip_list`, `clip_read`, `clip_create`, `clip_update`,
`clip_enrich`, `clip_save_media`, `clip_trash`, and `clips_needing_enrichment`.
`clip_validate_capture` checks payloads without writing;
`clip_create_with_receipt` invokes an app-owned reservation callback under
the naming/path locks, before saving media or Markdown, and skips the
provided reserved paths during naming. The app's receipt service uses this hook; raw `clip_create` remains a non-idempotent storage
primitive without delivery IDs.
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

1. **Fetch**: the clip's URL is captured through the ingest engine
   ([ingest.md](ingest.md)): OpenGraph / Twitter card / `<title>` metadata,
   oEmbed where the platform offers it (YouTube, X, Bluesky, TikTok, Vimeo),
   the readable article as Markdown (Readability via `dom_smoothie`, with a
   hidden-webview Defuddle fallback for pages that need JavaScript), and
   the hero image if the clip has none, saved to `media/`. The item's
   Markdown body becomes the `## Source` section. Socials behind a login wall
   give little; the clip keeps what the share sheet sent (text, screenshot).
2. **Think**: one AI call (the `edit`-quality model via the existing
   harness) given the metadata, own text and source text, plus the vault's
   existing tags from both writing documents and clips. Prefer that shared
   vocabulary so the writer's own work and outside inspiration meet in search.
   It returns a title if missing, a one-sentence summary, 2 to 5 tags, and a
   corrected `kind`.
3. **Write back**: the frontmatter fields and the `## Source` section, with
   `enriched` set. The writer's own text is never touched. Failures retry
   with backoff, then set `enrich_error`.

The worker makes three attempts, waiting 2 then 10 seconds between them.
A clip with `enrich_error` stays available but is not retried on every scan;
remove that field to try again. Captures wake the worker, and a five-second
scan also finds clips added by plain-file tools. Only HTTP(S) URLs without
embedded credentials are fetched, including redirects. Downloads are capped
at 2 MB for HTML, 256 KB for oEmbed and 8 MB for hero images, with a 15-second
request timeout and a 45-second overall fetch deadline. That deadline also
covers the JavaScript fallback, which gets at most 20 seconds of it in a
hidden, incognito webview with no IPC access, and only when the static page
had almost no readable text. Image failures are
best-effort; existing capture images are never replaced. A shared passage or
existing source text can still be summarized and tagged if fetching fails;
that clip completes with the text already available, rather than waiting for
connectivity. A bare URL with no usable text retries instead of asking the AI
to guess what the page says.

## Library (Mac)

A view beside the editor, reached from the sidebar and with ⇧⌘I:

- A masonry grid of cards, newest first: image-forward when there's an
  image, the quote or note otherwise, with the site and title small beneath.
- One search field over title, summary, tags, own text, source text and
  site, with tag filters. Results are ranked by the shared hybrid index
  (words and meaning, [search.md](search.md)).
- A card opens a detail view with the large image, the quote and note
  (editable), source link, editable tags, and **Used in**: the documents that
  reference this clip.
- Paste or drop anywhere in the library to capture.

### Library implementation and shared seams

`clip_search({ query?, tags?, offset?, limit? })` is the reusable desktop
clip search command, including for the editor's `[[` picker. It returns
`{ clips: (ClipSummary & { text: string })[], total, tags: string[] }`.
`text` is an own-text preview of at most 600 Unicode characters, never the
extracted source. Search itself uses the full own text and source, plus title,
summary, tags, site and URL. Terms are whitespace-separated, case-insensitive
substrings, ANDed across those fields. Tags are trimmed/lowercased exact AND
filters. Without a query, results keep `clip_list` ordering (newest captured
first, then path ascending). With one, the hybrid index ([search.md](search.md))
ranks them: clips with every word (by stem or prefix) or close in meaning
come first, best first, and then any other substring match, newest first. So
a clip found before is never lost, and clips that match only by meaning are
added. If the index fails, the plain lexical order is used. Returned tags
cover the whole vault, not just matching clips.
Pagination defaults to offset 0 and limit 60 (clamped to 1–120).

The Rust index is cached per canonical vault root and invalidated per path by
`clips:changed`, including enrichment. First indexing, search and media reads
run off the main thread. A lightweight file metadata snapshot on search also
picks up external edits, captures and deletions without reopening the app.
Live refresh retains the already-loaded window rather than resetting to page
one, and returning from detail restores grid position/focus. The grid pages results and
virtualizes the masonry viewport, mounting only nearby cards and freeing their
image object URLs as they leave. Fixed, varied thumbnail frames avoid layout
jumps during enrichment; detail shows the uncropped image.

Images use **binary IPC, not an asset-protocol filesystem scope**:
`clip_image({ path })` takes a clip path and returns an `ArrayBuffer` containing
only that clip's primary image. Rust validates the clip and its media path
under `inspiration/media/`, rejects symlinks, non-regular files, unsupported
extensions/signatures (including SVG) and files over 15 MiB. The frontend
creates a short-lived Blob URL. No arbitrary vault path is exposed to the
webview. Missing, corrupt or unsupported images get a quiet fallback.
The window disables Tauri's native drag interception so HTML drops receive
both Finder files and browser URLs/text. Clipboard and dropped files use
`clip_create` with `via: mac`; there is no arbitrary local-file-read command.
Raster files with an empty browser MIME type use an extension allowlist.

Paste/drop listeners are active only while the library is open, including its
detail view. Pasting into an input or editable note remains normal editing;
**Keep something** also accepts a link, text or an image explicitly. Whole
HTTP(S) URLs become links; other text stays intact as a note. Each capture
is persisted before the UI reports success. Title, quote/note and tag edits
save field patches on blur, navigation and window blur, with a retry/discard
choice on failure. App navigation, vault switching and window close await
pending clip edits, preventing a queued edit from crossing vaults. They never
replace source text or unrelated enrichment fields.

UI lives in `apps/desktop/src/inspiration/`. `Library` accepts
`renderUsedIn?: (clip: Clip) => ReactNode` for KI-8's shared backlink index;
the default slot is deliberately not a second index or an assertion that no
backlinks exist. App connects it to KI-8's shared `UsedIn` component, and
Writing's clip-open callback to the same library detail. To open a clip from
the editor, dispatch
`new CustomEvent("kintsugi:open-clip", { detail: { path } })` on `window`.
App flushes the document, switches views and opens the detail. The editor
stays mounted while hidden so switching views preserves its current state.

For isolated development, debug builds accept `KINTSUGI_VAULT` pointing to
an existing scratch vault (see README). This mode never reads or persists the
normal app config, requires the specified folder to exist, and skips starting
enrichment and phone services. Capture receipts also stay under the scratch
vault's hidden `.kintsugi/` folder. Release builds ignore the variable.

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

### Reference lookup and interaction

`reference_index` returns `{ documents, clips, links }`. Documents have
`path`, nullable `title` and `status`, and their Markdown body as `text`.
Clips are `ClipSummary` values; their extracted source does not cross this
interface. Each link has the containing document's `source` path, a file
`target` (without alias or heading), and the canonical `resolved` path or
`null`. Repeated links to one file produce one backlink. The desktop shares
this snapshot between the margin, document backlinks and library **Used in**,
refreshing after document saves/create/rename/trash, phone writes and
`clips:changed`. Scanning runs off the UI thread.

Names are case-sensitive. Explicit vault-relative paths and `.md`/`.mdx`
extensions are accepted, as are Obsidian aliases and heading/block fragments.
A root document disambiguates same-named nested documents; otherwise an
ambiguous basename stays unresolved and the picker inserts an explicit path.
Frontmatter, code fences, inline code, HTML comments and escaped openers do
not create backlinks. Hidden files and symlinks are not indexed.

Use ↑/↓ and Enter in the picker; Shift+Enter quotes a clip with a captured
passage, and Escape dismisses. Clicking a chip exposes the plain link for
editing. Command-click (Control-click too) opens its target. Margin clips can
be dragged in as attributed blockquotes; documents drag in as references.
The margin button remembers its visibility; on narrow windows it starts
closed, and an empty margin takes no space.

Renaming a document or folder refreshes resolution but does **not** rewrite
existing links yet. Offering a reviewed link update on rename is follow-up
work; unresolved links remain visible, never silently rebound to an
arbitrary duplicate.

## Publishing (to be designed)

Most complete documents end up on the blog: hussain.ph, an Astro + MDX site
(`~/Desktop/code/3d-portfolio`). Publishing a document there, and importing
the blog's existing posts so they can be referenced, get their own design.
