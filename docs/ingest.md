# Ingest

One ingestion pipeline serves both the Feed and Inspiration (see "Ingesting
anything" in [vision.md](vision.md)). Source adapters turn a URL or a file
into one normalized **item**: clean Markdown with metadata and media beside
it. The engine lives in `crates/ingest` (`kintsugi-ingest`), with no Tauri
dependency. The desktop app supplies the one piece that needs a webview.

This document is the engine's contract. Change it in the same commit as the
code that changes the contract.

## The item

Every adapter produces the same shape (`kintsugi_ingest::Item`, serialized
in camelCase):

| Field | Meaning |
| --- | --- |
| `source` | Which adapter made it: `web`, `rss`, `x`, `reddit`, `youtube`, `podcast`, `pdf`, `epub` or `book` |
| `id` | Canonical id, `<source>:<key>`. For web pages the key is the canonical URL, for X the status id (`x:20`), for Reddit the post id (`reddit:1abc2d`), for YouTube the video id (`youtube:dQw4w9WgXcQ`), for podcasts the feed URL and GUID. A PDF or EPUB file is `pdf:sha256:<hex>` / `epub:sha256:<hex>` (an EPUB with an ISBN is `epub:isbn:<isbn>`), a linked one its URL; a book its Open Library work (`book:OL45804W`). Feeds deduplicate on it |
| `url` | Canonical URL, if any: no fragment, no tracking parameters (`utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `igshid`, `ref_src`) |
| `title`, `author`, `site`, `description` | As the source declared them, whitespace-collapsed and length-bounded |
| `published` | When the source says it was published, as written there (usually ISO 8601) |
| `captured` | When the engine captured it, RFC 3339 UTC |
| `media` | Images, the primary one first: `{ kind: "image", url? }` (a PDF's page one, an EPUB's or book's cover). Downloaded bytes travel beside the item in Rust (never serialized), only when the capture asked for them, and only as checked raster formats (PNG, JPEG, GIF, WebP; never SVG or HTML) |
| `body` | Readable content as Markdown, at most 20,000 characters, cut at a paragraph or line break near the end when possible. Inline `data:` images are dropped and blank-line runs collapsed. Empty for a video or a bare image. A transcript may run to 250,000 characters (see [Transcripts](#transcripts)) |
| `extras` | Adapter facts. Every item sets `extractor`. Web pages use `readability`, `html`, `oembed`, `defuddle`, `image` or `none`, and may set `lang` and `modified`. X, Reddit and transcript items list theirs below |

Everything in an item came from the outside and is untrusted data, never
instructions. Errors are fixed strings (for example `page fetch timed out`,
`could not fetch source page`, `source is rate limiting requests`) that
never echo fetched content or URLs.
`this source needs an optional tool that is not installed` (`ToolNeeded`)
means the capture needs a download the person hasn't agreed to yet.

## Adapters and the engine

An `Adapter` has three jobs:

- `matches(target)`: a cheap check, with no I/O, of whether it handles a target. A target is a
  URL (`Target::url` accepts only credential-free HTTP(S)) or a local file
  (`Target::File`: PDFs and EPUBs, matched by extension).
- `capture(target, { want_media })`: fetch and normalize one item.
- `poll(subscription)`: return items newer than the subscription's opaque
  `cursor`, plus the next cursor and, when the source sent a fresh document,
  what it says about itself (`source`: title, home page URL, image).
  Sources that can't be followed keep the default, which reports
  "unsupported". The web adapter can't be polled yet. "Follow this page"
  change detection will add it.

An `Arc<A>` of an adapter is an adapter too, so one instance can sit in an
engine and still be called directly for its own extras.

The `Engine` holds adapters in priority order and gives a target to the
first that matches. Specific adapters (X, Reddit, YouTube, PDFs) go before the
generic web adapter, which accepts any web URL. `Engine::poll(source, …)`
uses the adapter registered for that source. Through the `Arc<A>` impl, one
web adapter instance is both registered and Reddit's fallback.

The Mac app's clip enrichment registers `XAdapter`, then `RedditAdapter`
(with the web adapter as its fallback), then `YouTubeAdapter`, then
`PodcastAdapter` (links to audio files), then `PdfAdapter`, `EpubAdapter`
and `BookAdapter`, then `WebAdapter`
(`apps/desktop/src-tauri/src/enrich/mod.rs`). Clips of X and Reddit URLs
therefore go through the platform adapters, and a clip with a saved file
(`file:` in its frontmatter) is captured from that file, not its link.

The AI is not an extractor. Downstream consumers may use it to clean up
or summarize an item (clip enrichment does), but every body comes from a
deterministic extractor.

## Feeds

`feed::FeedAdapter` (`source: rss`) polls RSS 0.x/1.0/2.0, Atom and JSON
Feed documents, parsed with [feed-rs](https://github.com/feed-rs/feed-rs)
(MIT). It covers blogs, YouTube channels, podcasts and Hacker News
(hnrss.org). Feeds are followed, never captured: `matches` is always false,
so a single URL still goes to the web adapter.

- **Polling** makes a conditional request. The cursor is JSON holding the
  last `ETag` and `Last-Modified`; a 304 returns no items and the same
  cursor. A changed feed returns all its current entries, newest first as
  listed, and consumers deduplicate on `id`.
- **Items**: `id` is `rss:<entry id>` (feed-rs generates one when the feed
  has none); `site` is the feed's title; `description` is the entry summary
  as plain text (≤600 characters); `body` is the entry's content (or
  summary, or media description) as Markdown, with scripts, styles, iframes
  and forms dropped; `media` is the entry's thumbnail or first inline image
  (URL only); `published` is RFC 3339; `extras.media` is `article`,
  `video` (YouTube links, video media) or `audio` (audio enclosures).
- **Discovery**: `discover(url)` returns the URL if it is a feed, else the
  first working feed the page advertises with `<link rel="alternate">`
  (RSS, Atom or JSON types), or a YouTube channel page's uploads feed, else
  `NotAFeed`. `youtube_channel(page)` reads a channel page's `UC…` ID.
  `search_podcasts(term)` asks iTunes Search and keeps results with a
  public `feedUrl`.
- **Limits**: 8 MB per document, a 10-second connect and 25-second request
  timeout, at most 5 redirects, each checked against the URL policy.
- **Errors** add `Status(code)` ("source answered HTTP 503", a number,
  never content) and `NotAFeed`.

The Feed (`docs/feed.md`) is the consumer.

## Web pages

`WebAdapter` handles any HTTP(S) URL without embedded credentials:

1. **Download** with a Safari user agent. Every redirect (at most 5) is
   checked against the same URL policy. Caps: 2 MB of HTML (8 MB if the
   URL is itself an image), 256 KB for oEmbed, 8 MB for images. Each
   request has a 5-second connect timeout and a 15-second request timeout,
   and the whole capture shares a 45-second deadline.
2. **Extract statically.** OpenGraph, Twitter card, `<title>` and
   `article:*` metadata, then the readable article as Markdown via
   [`dom_smoothie`](https://github.com/niklak/dom_smoothie) (MIT, a port of
   Mozilla Readability). Hidden elements are removed first. Below 500
   characters, Readability tends to grab the whole page, so the largest
   `article`/`main`/`[role=main]` region (or the body) is converted instead,
   with page chrome (nav, header, footer, aside, forms, scripts) skipped.
   The same happens for pages nested more than 256 levels deep, because
   Readability's cleanup is quadratic in depth. Readability fills missing
   author, site, excerpt, published date, language and image. A declared
   canonical URL (`link[rel=canonical]` or `og:url`) is trusted only on the
   page's own host.
3. **oEmbed** for exact platform hosts (YouTube, X/Twitter, Bluesky,
   TikTok, Vimeo), including short links that only reveal the platform after
   a redirect. The embed fills metadata gaps without overwriting the page's
   metadata. Embed text, such as a post behind a login wall, replaces the
   body.
4. **JavaScript fallback.** If the static body has fewer than 200
   characters (an app shell, or a bot wall that returned an error status),
   the URL isn't an oEmbed platform or a direct image, and a renderer is
   configured, the page is rendered in a hidden local webview, which runs
   the vendored [Defuddle](https://github.com/kepano/defuddle) (MIT,
   `crates/ingest/vendor/defuddle/`). The render gets at most 20 seconds
   within the overall deadline. Its result fills metadata gaps, and its
   Markdown replaces the body if it's longer. A failed or timed-out render
   keeps the static result.
5. **Primary image**, when asked: the page's declared image (or the
   render's), downloaded best-effort within what's left of the deadline. A
   slow image never discards the page.

A capture fails only when nothing usable arrived: no HTML, embed, image or
render.

### The hidden webview (Mac app)

`apps/desktop/src-tauri/src/enrich/render.rs` implements the renderer
contract in `crates/ingest/src/web/render.rs`:

- One throwaway window per page, labelled `ingest-render-<n>`: invisible,
  unfocused, not in the taskbar, incognito (no persistent cookies or
  storage), devtools off. One render runs at a time, and the window is
  destroyed when the render finishes, fails or times out.
- No IPC: the label is outside every capability and the origin is remote,
  so Tauri refuses app and plugin commands from it.
- Navigation is limited to credential-free HTTP(S) and never to
  `localhost` or `*.localhost`, so a page can't reach an app-local origin.
  The app's navigation plugin applies this rule to `ingest-render-*`
  webviews instead of its app-origin rule. New windows and downloads are
  denied.
- A document-start script mutes and pauses media and stubs out `alert`,
  `confirm`, `prompt`, `print`, `window.open`, camera/screen capture,
  geolocation and notification prompts.
- After load, the renderer waits up to 6 seconds for the page's visible
  text length to stop changing, then evaluates Defuddle with
  `useAsync: false`. The bundle sees local `module`/`exports`, so it never
  touches the page's own globals or module loader. The JSON result is
  capped at 4 MB before parsing, and every field is bounded again on the
  Rust side.

Nothing leaves the Mac except the page's own requests. Defuddle is bundled
in the app binary, never fetched from a CDN. Headless runs (`pnpm desktop:headless`) have no
webview, so they use static extraction only.

## Platform APIs

The X and Reddit adapters share one bounded JSON client (`crates/ingest/src/api.rs`):

- It sends a descriptive user agent and no cookies, tokens or passwords. Nothing ever needs the owner's X
  or Reddit account.
- API requests from one adapter are spaced at least `min_interval` apart:
  1 second for X, 6 seconds for Reddit (about ten a minute is Reddit's
  unauthenticated allowance).
- A `429`, or `x-ratelimit-remaining: 0`, blocks that host until
  `Retry-After` / `x-ratelimit-reset` passes (60 seconds if neither says,
  at most an hour). Meanwhile calls fail with `RateLimited` without sending
  anything.
- Redirects are re-checked like web pages (at most 5). JSON is capped at
  2 MB (4 MB for Reddit) and images at 8 MB. Requests time out after 5 seconds
  to connect and 15 seconds in all, and a whole capture or poll gets 45
  seconds.
- Primary images download only when asked, and only as checked raster
  formats.

Post text is plain text made Markdown-safe (`crates/ingest/src/text.rs`):
a line can't start a heading, list, quote or code block the author never
wrote, and `<` is escaped so no raw HTML gets through. Media alt text and
link labels are flattened to one line without brackets. Only HTTP(S) media
and link URLs are written, with parentheses encoded.

## X posts and threads

`XAdapter` (`crates/ingest/src/x/`) handles post URLs on `x.com`,
`twitter.com` (also `www.` and `mobile.`) and the mirrors people share
(`fxtwitter.com`, `fixupx.com`, `vxtwitter.com`, `fixvx.com`), in the forms
`/<handle>/status/<id>`, `/i/status/<id>` and `/i/web/status/<id>`, with or
without a trailing `/photo/1` and the like. `t.co` short links and profile
pages fall through to the web adapter.

Capture tries these in order and stops at the first that answers:

1. **FxTwitter** `/2/thread/{id}`: the post, its ancestors, and the author's
   own continuation, with text, photos, videos, quoted posts, link cards and
   X Article previews. If that fails, `/2/status/{id}` gives the post alone.
   A rate limit isn't asked twice.
2. **Syndication** (`cdn.syndication.twimg.com/tweet-result`, the endpoint
   embeds load): the post, its parent and its quoted post. `t.co` links are
   expanded and media links removed.
3. **oEmbed** (`publish.twitter.com/oembed`, always asked about the
   canonical `x.com` URL): the post's text and author only. Only the text of
   the embed's `<blockquote><p>` is kept.

If none of them answers, the error is `RateLimited`, `TimedOut` or
`TooLarge` if one of those was the cause, and `Unavailable` otherwise.

The item:

- `id` is `x:<status id>` and `url` is `https://x.com/<handle>/status/<id>`
  for the captured post, even when the body holds the whole thread.
- `title` is the opening line of the author's first post in the thread,
  up to 120 characters. `author` is `Name (@handle)`, `site` is `X`, and
  `published` is the post's time as RFC 3339.
- `body` holds the conversation in order, posts separated by `---`.
  Posts by other people (ancestors of a reply) start with their author in
  bold. Photos appear as images, and videos and GIFs as their still plus a
  link. Link cards become a link and their description. A quoted post becomes
  a block quote headed by its author and a link to it.
- `media` lists the captured post's images first, then the rest of the
  thread's (photos, video stills, quoted media, card images), up to 20.
- `extras`: `extractor` (`fxtwitter`, `syndication`, `oembed`, or the
  backend's name), `complete` (true only when the thread endpoint answered),
  `posts`, `handle`, `lang`, and the post's `likes`, `reposts`, `replies`,
  `quotes` and `views` when known.

### Following X accounts

`XAdapter::poll` follows one account. `Subscription.url` is a profile:
`https://x.com/<handle>` (any X host), `@handle` or a bare handle.
`x::profile_handle` validates and normalizes one, and `x::profile_url` gives
the canonical URL to store. The cursor is the newest status id delivered.

Each poll reads FxTwitter's `/2/profile/{handle}/statuses` (the latest
page, about 20 posts) and keeps the account's own posts. Reposts and replies
to other people are dropped. Self-replies are folded into the post they
continue when both are on the page, so a thread arrives as one item.
Otherwise a self-reply stands alone. Only posts newer than the cursor are
returned, newest first. The poll's `source` is the account's
`Name (@handle)`, profile URL and avatar. An account that posts more than a page between
polls loses the overflow, so the Feed should poll every account at least
hourly, and no more often than every 15 minutes. The Feed follows X accounts
as `x` sources, polled every 30 minutes (see `docs/feed.md`).

The backend is the `XApi` trait (`name`, `thread`, `timeline`), with
`FxTwitter` as the default. `XAdapter::with_api` swaps it, for example for an
official-API client holding a user-supplied key, without changing
normalization, fallbacks or cursors.

## Reddit posts

`RedditAdapter` (`crates/ingest/src/reddit/`) captures a single post with its
comment tree. Subreddits can't be followed (Reddit's RSS ends in November
2026 and its public API closes in March 2027), so `poll` is unsupported.

- It accepts `/r/<sub>/comments/<id>/…`, `/comments/<id>`,
  `/user/<name>/comments/<id>` (on `reddit.com`, `www.`, `old.`, `new.`,
  `np.`, `m.`) and `redd.it/<id>`. A comment permalink captures its whole
  post. App share links (`/r/<sub>/s/<code>`) are resolved by reading their
  redirect's `Location`, never by following it, and must lead to a Reddit
  post.
- It fetches `/comments/<id>.json?raw_json=1&limit=300&depth=8`.
- `body` is the self text (Reddit Markdown, kept as is). A link post's link,
  gallery images in order (or the preview or a directly linked image) and
  a video link follow. Then comes `## Comments`: each comment headed
  `**u/name** · N points` (plus ` · OP` for the original poster), with
  replies as nested block quotes, at most 300 comments and 8 levels.
  AutoModerator's pinned notices are skipped, and so are deleted comments
  with no replies. Unloaded replies become `_N more replies on Reddit_`.
  Crossposts take their content from the original.
- `title`, `author` (`u/name`), `site` (`r/sub`), `published` (RFC 3339)
  and `media` (images, up to 20) come from the post. `extras`: `extractor`
  (`reddit-json`), `subreddit`, `score`, `comments` (Reddit's count),
  `includedComments`, `link` for link posts, and `nsfw` when marked.
- **Fallback.** Reddit refuses some networks outright (403). When the JSON
  fails for any reason other than a rate limit and a fallback adapter is
  configured, the post's `old.reddit.com` page is captured through it. On
  the Mac that's the web adapter with its hidden webview. The result keeps
  that page's extractor in `extras.extractor`, adds `fallback: "web"`, and is
  relabelled as the Reddit item (same `id` and `url`). The webview is
  incognito, so it never uses the owner's Reddit login: it gets past bot
  walls, not account walls. While Reddit is rate limiting, there is no
  fallback.

## PDFs

`pdf::PdfAdapter` (`source: pdf`) reads a local PDF (`Target::File` ending
in `.pdf`) or a link to one: a URL path ending in `.pdf`, or arXiv's
`/pdf/<id>`. Links download to a temporary file (at most 50 MB, two
minutes, the web URL policy on every redirect) and must start with
`%PDF-` in their first kilobyte; a login page served at a `.pdf` URL fails
as `Unavailable`.

**Out of the box: Apple PDFKit.** `pdf::PdfKitReader` runs `kintsugi-pdf`
(`crates/ingest/swift/pdf.swift`) as a child process with a 60-second
limit. It prints `{ pageCount, locked, title, author, subject, keywords,
created, outline, pages: [{ page, lines: [{ text, size, bold, y }] }] }`,
stopping after 400,000 characters, and with `--thumbnail <png>` renders
page one at most 800 pixels on its long side. Exit codes: 3 unsupported
(the build stub), 5 not a readable PDF. stderr is discarded: PDFKit logs
can carry document text. A PDF that is "encrypted" only against editing is
opened with the empty password; one that needs a real password gives
metadata only (`locked: true`, `textReason: locked`).

`pdf::layout` turns the lines into Markdown: the size most characters are
set in is the body size; shorter lines at least 1.2× larger are headings
(the largest `##`, then `###`, `####`; a title wrapped over two lines is
joined). Lines are rejoined into paragraphs, with a paragraph break where
the gap to the previous line is over 1.5× the usual line spacing, at a
column change, before bullets (`•`, `◦`, `–`… become `- `), and across a
page break only after a sentence end. A word hyphenated at a line end is
rejoined when the next line starts lower-case. Running headers and footers
(the first or last two lines of a page, recurring with digits ignored on
at least half the pages) and page numbers (`12`, `xiv`, `Page 3 of 9`) are
dropped. If the type gives no headings, lines matching the PDF's outline
become headings. Text is made Markdown-safe like post text.

The item: `title` is the declared title unless it's a word processor's
leftover (`Microsoft Word - …`, `untitled`, a file name), else the first
heading; `author`; `description` is the subject; `published` the creation
date (ISO 8601); `media` page one (only when asked); `extras`: `extractor`
(`pdfkit` or `docling`), `pages`, `keywords`, `locked`, and `textReason:
no-text` for a scan with no text layer (Docling's OCR can read those).

**Optional: Docling.** When the `docling` tool is installed (see
[Optional tools](#optional-tools)), `pdf::Docling` converts the body
instead: `docling <file> --to md --image-export-mode placeholder
--ocr-engine ocrmac --artifacts-path <version>/models --output <tmp>`, with
`HF_HUB_OFFLINE=1` so a conversion never downloads anything, and a
10-minute limit. Image placeholders are removed. PDFKit still supplies
the metadata and thumbnail. If Docling isn't installed, the item says
`converter: docling, converterReason: tool-not-installed`; if it fails or
times out, `converterReason: failed`, and the PDFKit body is kept. Docling
can also read a PDF PDFKit refused.

### Choosing a PDF reader

Researched 2026-11-01.

| | Apple PDFKit (Swift helper) | pdfium-render | Docling | marker |
| --- | --- | --- | --- | --- |
| Download | None: part of macOS | Pdfium isn't included; a ~5 MB `libpdfium` from bblanchon/pdfium-binaries must ship in the app or be downloaded | About 2 GB (Python, PyTorch, layout and table models) | Several GB |
| Isolation | Separate process, killed at its time limit | In-process C++; not thread-safe (pdfium-render serializes every call behind one mutex) | Separate process | Separate process |
| Output | Text lines with fonts and positions, metadata, outline, page images | The same | Layout-aware Markdown: reading order, tables, formulas, code | Similar to Docling |
| License | Part of macOS | MIT/Apache (bindings), BSD (Pdfium) | MIT code; models Apache-2.0 and CDLA-Permissive-2.0 | GPL code; model weights restrict commercial use |

**Choice: PDFKit by default, Docling optional.** PDFKit needs nothing
downloaded and reuses the Swift-helper pattern the transcriber
established, so a hostile PDF can only crash a child process. pdfium-render
would add a native library to ship and sign and run untrusted parsing
inside the app. Docling is the high-quality converter: on a two-column
paper or a report with tables, PDFKit's text is in reading order per
column at best and tables come out as runs of cells. MarkItDown was
considered; for PDFs it wraps pdfminer.six, which gives plain text no
better than PDFKit's. marker is not offered, because of its model licence.

Sources:
[pdfium-render README](https://github.com/ajrcarey/pdfium-render#binding-to-pdfium),
[Docling](https://github.com/docling-project/docling),
[Docling layout model licence](https://huggingface.co/docling-project/docling-layout-heron),
[Docling table models](https://huggingface.co/docling-project/docling-models).

## EPUBs

`epub::EpubAdapter` (`source: epub`) reads a local `.epub` or a link whose
path ends in `.epub` (downloaded like a PDF, 50 MB cap). It unzips in
memory with caps: at most 10,000 entries, 2 MB for `container.xml` and the
package document, 4 MB per chapter and 8 MB for the cover, each checked
both by the declared size and while inflating. Paths resolve inside the
archive only (percent-decoded, `..` never above the root). XML with a DTD
is refused.

- **Metadata** from the OPF package's Dublin Core: `title`, `creator`s
  (up to five, joined as `author`), `publisher` (as `site`), `date`
  (`published`), `language` (`extras.lang`), `description` (HTML reduced
  to text), and an ISBN from an `identifier` (`extras.isbn`).
- **Cover**: the manifest item with `properties="cover-image"` (EPUB 3) or
  the one named by `<meta name="cover">` (EPUB 2), as a checked raster
  image, only when asked.
- **Body**: the spine's XHTML items in order, each through the web path's
  HTML-to-Markdown conversion. Non-linear items and front matter (the nav
  document, and items whose id or file name is `cover`, `titlepage`,
  `toc`, `contents`, `copyright` or `nav`) are skipped. Images, scripts,
  styles, forms, SVG and MathML are left out; links into the book become
  plain text, outside links stay. Chapters are read until about twice the
  body cap, then the body is capped as usual: a book keeps its opening
  chapters, with `extras.truncated`.
- `extras`: `extractor: epub`, `chapters` (spine documents), `lang`,
  `isbn`, `truncated`.

## Books

`books::BookAdapter` (`source: book`) uses [Open
Library](https://openlibrary.org/developers/api) (the Internet Archive's
catalog; no key, data CC0). Requests carry a descriptive user agent and
are spaced 400 ms apart (identified clients may make three a second), with
the shared API client's rate-limit handling.

- `search(query, limit)` asks `/search.json` for a title (and author) or,
  when the query is an ISBN, by `isbn=`. A hit is `{ key, url, title,
  authors, year, isbn, coverUrl, editions }` with `url` the work's page.
  The Mac's `book_search` command serves the "Find a book" picker.
- As an adapter it captures `openlibrary.org` pages: `/works/OL…W`,
  `/books/OL…M` and `/isbn/<isbn>` (which Open Library redirects to the
  edition). It reads the edition (for ISBNs and editions), its work, and up
  to three authors. A book saved from the picker, or by ISBN on the phone
  or Mac, is a clip with that URL; enrichment captures it here.
- The item: `id` `book:<work id>`, `url` the work's page, `title`,
  `author`, `site: Open Library`, `published` (first publication),
  `description`, and the cover (`covers.openlibrary.org/b/id/<id>-L.jpg`,
  downloaded only when asked; Open Library's 1×1 placeholder is ignored).
  The body is the description followed by a list: by, first published,
  publisher, pages, ISBN, subjects. `extras`: `extractor: openlibrary`,
  `isbn`, `pages`, `subjects`, `edition`. It is the catalog record, never
  the book's text.
- ISBNs are validated by check digit (`books::normalize_isbn`, mirrored
  by `parseIsbn` in `packages/core/src/books.ts`).

## Optional tools

Heavy helpers are never bundled. `kintsugi_ingest::tools` downloads them
the first time they're needed, into `tools/` in the app's config folder
(`~/Library/Application Support/dev.phalasiya.kintsugi/tools/`, or
`$KINTSUGI_CONFIG_DIR/tools/` in headless and isolated runs), never the
vault.

- **Consent.** Nothing downloads until the person agrees. `Tools::grant`
  records consent per tool in `tools/<id>/tool.json`. `Tools::ensure`
  returns the installed file, installs a consented tool on first need, and
  otherwise fails with `NeedsConsent`, which adapters report as
  `ToolNeeded`. Settings › Optional tools is where he agrees: the button
  says what will be downloaded and roughly how big it is. Remove withdraws
  consent and deletes the files.
- **Checksums.** Every download is hashed as it streams and must match a
  SHA-256 published beside the release: a sums file (yt-dlp's
  `SHA2-256SUMS`), a per-asset `.sha256sum` (Deno), the `digest` GitHub
  records for each asset, or one pinned in the spec (for models). A mismatch
  or an oversized download is discarded. Downloads are HTTPS only, at most
  10 redirects, with a per-tool size cap. This protects against corruption
  and a swapped CDN file, not against a compromised publisher. Signed
  checksums (yt-dlp's `SHA2-256SUMS.sig`) are a possible next step.
- **Updates.** Installing again fetches the latest release, installs it
  next to the old one, records it, then deletes the old version. A failed
  update keeps the working version. A spec's `update_every` makes `ensure`
  check at most that often, and `update_if_stale(age)` lets an adapter check
  after a failure. Settings has "Check for updates".
- **Layout.** `tools/<id>/tool.json` (consent, installed version and
  checksum, last check, latest version) and `tools/<id>/<version>/<entry>`.
- **Generic.** A tool is a `ToolSpec` in `tools/catalog.rs`: id, name,
  purpose, homepage, license, source (`GitHubRelease { repo, checksums }`,
  `Pinned { version, url, sha256 }`, `PythonPackage { runner, package,
  version, python, prepare }` or `System`), per-platform asset names,
  archive (`None`, `Zip` or `TarGz`), entry file, size cap and update
  interval. Adding a tool (a model file, another converter) is a new spec
  and doesn't change the manager. `System` tools are fetched by the
  operating system, so the manager only records consent for them.
- **Python packages.** A `PythonPackage` (Docling) is installed by its
  runner, uv, itself a catalog tool that must be installed and consented:
  `uv tool install --python <python> <package>==<version>` straight into
  `tools/<id>/<version>/` (`env/` for the environment, `bin/` for its
  scripts; uv writes absolute paths, so it isn't staged and moved), with
  `UV_NO_CONFIG=1`, `UV_PYTHON_PREFERENCE=only-managed`, Python itself in
  `tools/python/` and no download cache kept (`UV_NO_CACHE`). Nothing
  touches the Mac's own Python or uv settings. uv checks each package
  against the hash the index publishes. The spec's `prepare` command then
  runs once from `bin/` (`{dir}` is the version directory); Docling uses it
  to fetch its layout and table models into `<version>/models`, so
  conversions run offline. The recorded checksum is the entry script's.
  The version is pinned in the spec: updating means shipping a new spec,
  and `tools_update` installs it if it differs. Each step is limited to an
  hour, with no output logged. A failed install removes the version
  directory and keeps any older working version.

| Tool | Source | Why | Updates |
| --- | --- | --- | --- |
| `yt-dlp` | `yt-dlp/yt-dlp` latest release, `yt-dlp_macos` (universal), `SHA2-256SUMS` | YouTube captions | Checked at most daily, and after a failure at most hourly |
| `deno` | `denoland/deno` latest release, `deno-<arch>-apple-darwin.zip`, `.sha256sum` | yt-dlp has needed a JavaScript runtime for YouTube's player challenges since 2025.11 ([EJS wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS)); installed with yt-dlp | Weekly |
| `apple-speech` | macOS (`System`) | The on-device speech model for podcast transcription | By macOS |
| `docling` | `docling[ocrmac]==2.145.0` from PyPI through uv, Python 3.12, plus the layout and table models (about 2 GB). Apple silicon only: PyTorch has no Intel Mac wheels | High-quality PDF conversion (columns, tables, formulas); OCR through Apple's Vision framework (`ocrmac`), so no OCR model | With a new spec |
| `uv` | `astral-sh/uv` latest release, `uv-<arch>-apple-darwin.tar.gz`, `.sha256` | Installs Docling; installed with it | Weekly |

Commands: `tools_list`, `tools_install({ id })` (consent plus download;
yt-dlp brings Deno, Docling brings uv), `tools_update({ id })`, `tools_remove({ id })`
(`apps/desktop/src-tauri/src/tools.rs`, types in
`apps/desktop/src/lib/tools.ts`).

## Transcripts

`kintsugi_ingest::transcript` parses WebVTT (including YouTube's rolling
auto-captions, where each line repeats in the next cue), SubRip, the
Podcasting 2.0 JSON transcript, and untimed HTML or plain text. It renders
timed segments as Markdown paragraphs, and each paragraph starts with a
timestamp that links to that moment:

```markdown
## The lacquer

[0:41](<https://www.youtube.com/watch?v=…&t=41s>) urushi lacquer takes weeks and gold & patience

[1:05](<https://pod.example/12.mp3#t=65>) **Ken:** Gold makes the crack visible.
```

- A paragraph breaks when the speaker or chapter changes, at a pause or
  sentence end once it is 30 seconds long, and always at 60 seconds.
  Chapters become `##` headings. Speakers are shown in bold.
- Transcript text is untrusted. `\ [ ] < > * ` |` are escaped, so it
  can't form links, HTML or emphasis.
- Bodies are capped at 250,000 characters (`TRANSCRIPT_CHARS`, about four
  hours of speech) and cut at a paragraph boundary, with `truncated: true`.
  Clips still store at most 20,000 characters of source
  (`crates/vault/src/clips.rs`), so a saved clip keeps roughly the first
  20 minutes until the clip format changes.
- `extras.transcript` says where the body came from: `subtitles`,
  `auto-captions`, `publisher`, `on-device` or `unavailable`. When it is
  `unavailable`, `transcriptReason` says why: `tool-not-installed`,
  `tool-unavailable`, `no-captions`, `no-transcript`, `no-transcriber`,
  `model-not-installed`, `transcription-unsupported`,
  `transcription-failed` or `no-speech`. Other keys: `lang`, `duration`
  (seconds), `truncated`, `transcriptType` (the publisher file's MIME
  type), `transcriber` (`apple-speech`) and `audioUrl`.

## YouTube

`YouTubeAdapter` matches video URLs: `watch?v=`, `youtu.be/`, `/shorts/`,
`/live/` and `/embed/` on `youtube.com`, `m.`, `music.` and
`youtube-nocookie.com`, with an 11-character id. Channels and playlists
are left to the web adapter (or the Feed).

1. `Tools::ensure(yt-dlp)`. Without consent, it hands the canonical watch
   URL to its fallback adapter, which on the Mac is the web adapter's oEmbed
   metadata. The result is marked `transcript: unavailable`,
   `transcriptReason: tool-not-installed`. Without a fallback it fails with
   `ToolNeeded`.
2. Runs yt-dlp in a temporary folder:
   `--ignore-config --no-playlist --skip-download --write-info-json
   --write-subs --write-auto-subs --sub-format vtt/best --sub-langs
   "en,en-[A-Z]{2},.*-orig"`, plus `--cache-dir <tools>/yt-dlp-cache` and, when
   Deno is installed, `--js-runtimes deno:<path>`. stdout and stderr are
   discarded. The run has a 180-second limit, with a 10-second socket
   timeout and one retry. The language list asks for English and every
   untranslated auto-caption track. `en.*` would also fetch machine
   translations into English, and every language about a hundred.
   yt-dlp prefers a language's manual subtitles when it has both.
3. If the run fails, the manager checks for a newer yt-dlp (at most hourly).
   If there is one, it installs it and retries once. This is how YouTube
   changes get picked up, such as PO tokens and player updates, without a
   Kintsugi release.
4. If yt-dlp listed caption tracks but downloaded none, the adapter fetches
   the best WebVTT track from `.info.json` itself. It only fetches
   YouTube's own HTTPS hosts, at most two tracks, 8 MB each. On the
   development Mac, yt-dlp's impersonating HTTP client (curl_cffi) timed
   out on the caption endpoint while a plain request answered in under a
   second. This fallback also covers manual subtitles in languages outside
   the list.
5. Picks a caption file: manual subtitles over auto-captions, the video's
   language over English over the rest, and untranslated (`-orig`) over
   translated. Chapters from `.info.json` become headings. Timestamps link
   to `https://www.youtube.com/watch?v=<id>&t=<s>s`.

The item has id `youtube:<id>`, the canonical watch URL, title, channel as
`author`, `site: YouTube`, `published` from `upload_date` (`YYYY-MM-DD`)
and the thumbnail (downloaded only when asked). Extras: `extractor:
yt-dlp`, `toolVersion`, `duration`, `channelUrl` and `wasLive`. A video
with no captions keeps its description as the body, with `transcriptReason:
no-captions`.

## Podcasts

The Feed (KI-25) owns podcast subscriptions. `PodcastAdapter` turns one
episode into a transcript item:

- `podcast::episodes(xml, feed_url)` parses a podcast RSS feed into
  `Episode`s: GUID, title, show, author, page link, enclosure, published,
  notes (`content:encoded`, `description` or `itunes:summary`), image,
  `itunes:duration`, language, and every `<podcast:transcript>` (URL,
  type, language, rel). Relative URLs resolve against the feed. DTDs are
  refused.
- `capture_episode(&Episode, options)` captures one episode the Feed
  already parsed. `capture_from_feed(feed_url, guid, options)` fetches the
  feed and captures the episode with that GUID, which is all the Feed needs
  to store. A Feed item from a podcast source has `extras.media: audio` and
  id `rss:<guid>`, so the Feed passes its source URL and that GUID. As an `Adapter`, it also matches pasted links to audio files
  (`.mp3`, `.m4a`, `.aac`, `.wav`, `.aiff`, `.flac`, `.ogg`, `.opus`,
  `.caf`).

Each capture takes the first of these that works:

1. **Publisher transcript.** This is the `<podcast:transcript>` tag from the
   [Podcasting 2.0 namespace](https://podcasting2.org/docs/podcast-namespace/tags/transcript),
   which Podcast Index maintains. Transcripts in another language are tried
   last. Among the rest, JSON is tried first, then WebVTT, SubRip, HTML and
   plain text. At most three are fetched, each capped at 8 MB.
2. **On-device transcription.** If a `Transcriber` is configured, the
   enclosure is downloaded to a temporary file (at most 1 GB and 30
   minutes, keeping its extension) and transcribed with the feed's
   language.
3. **Show notes**, as Markdown, marked `transcript: unavailable`.

Timestamps link to the audio with a media fragment (`<enclosure>#t=754`),
which browsers' audio players seek to. The id is `podcast:<feed
URL>#<guid>`, or the episode page or audio URL when there's no feed. `url`
is the episode page (canonical) or the audio. `site` is the show.

The Podcast Index API (`/episodes/byfeedurl`, which has a `transcripts`
field) needs an API key and secret. It isn't used: the same transcript
links are in the RSS feed the Feed already fetches.

### On-device transcription: Apple SpeechAnalyzer

`transcribe::SpeechAnalyzerTranscriber` runs `kintsugi-transcribe`
(`crates/ingest/swift/transcribe.swift`) as a child process. The helper
uses `SpeechTranscriber` with `.audioTimeRange`, and
`SpeechAnalyzer.analyzeSequence(from: AVAudioFile)` followed by
`finalizeAndFinish(through:)`. It prints `{ locale, segments: [{ start,
end, text }] }`. Exit codes: 3 unsupported (macOS older than 26, or the
locale isn't supported), 4 the speech model isn't installed, 5 the audio
can't be read. Neither stdout nor errors carry transcript text into logs.
The helper runs as a separate process so a crash in the speech stack can't
take the app down. Each run is limited to an hour.

- The speech model is a macOS asset, downloaded per language through
  `AssetInventory` and kept up to date by the system. The helper downloads
  it only with `--install-assets`, which the app passes once he has allowed
  `apple-speech` in Settings. Until then, a missing model gives
  `transcriptReason: model-not-installed`.
- `apps/desktop/src-tauri/build.rs` compiles the helper with `xcrun
  swiftc` (deployment target macOS 13; it checks for 26 at runtime) into
  `binaries/kintsugi-transcribe-<target>`. It ships as a Tauri sidecar
  (`bundle.externalBin`), next to the app binary. If there's no Swift
  toolchain, a stub that exits 3 takes its place. The PDF helper
  (`kintsugi-pdf`, from `swift/pdf.swift`) is built and shipped the same
  way; its stub makes PDFs fall back to Docling, if installed.

### Choosing a transcription engine

The research was done on 2026-11-01. Each source is linked below.

| | Apple SpeechAnalyzer | Parakeet TDT 0.6B via FluidAudio | whisper.cpp via whisper-rs (large-v3-turbo) |
| --- | --- | --- | --- |
| Accuracy, same harness on a Mac (LibriSpeech clean / other WER) | 2.12 / 4.56 | v2: 2.01 / 3.40 | not in that study. Open ASR leaderboard average is 7.83 (Parakeet v2: 6.05) |
| Long-form conversational speech (earnings22 WER, Argmax) | 14.0 | 11.7 | (whisper-small: 12.8) |
| Speed | A 34-minute file in 45 s, 2.2× faster than MacWhisper large-v3-turbo (1:41) | About 110–210× real time on an M4 Pro | The slowest of the three |
| Download | None. macOS fetches a shared model | About 450–630 MB | 1.5 GB (547 MB at q5) |
| Build | One Swift file, no dependencies | A Swift package whose API is still changing, plus a first-run model compile | CMake and a C++ toolchain, which this Mac doesn't have |
| Languages | About 10 | v2: English. v3: 25 European languages | About 100 |
| License | Part of macOS | Apache-2.0 code, CC-BY-4.0 weights | MIT |

**Choice: SpeechAnalyzer.**

- It adds nothing to the download and needs no build toolchain.
- It's about as accurate as Parakeet on clean speech (podcasts are mostly
  clean, close-miked speech) and faster than Whisper.
- It returns timed results.
- Parakeet is more accurate on noisy, conversational audio. It can be added
  later as a second `Transcriber` behind a pinned model in the tools
  catalog, without changing the adapter.
- Whisper lost on every axis except language coverage.
- On this Mac (macOS 27.0.1), the helper transcribed `say`-generated speech
  in about a second, with the model already installed.

Sources:
[Open ASR leaderboard data](https://raw.githubusercontent.com/huggingface/open_asr_leaderboard/16743c6dabc69abcb8fd5bf529a95e3c6c16ac3c/scripts/data/en_shortform.csv),
[Lyonesse: Apple Speech vs Parakeet benchmark](https://lyonesse.app/blog/parakeet-moss-apple-speech-benchmark.html),
[Argmax: Apple and Argmax](https://www.argmaxinc.com/blog/apple-and-argmax),
[MacStories: Apple's speech APIs vs Whisper](https://www.macstories.net/stories/hands-on-how-apples-new-speech-apis-outpace-whisper-for-lightning-fast-transcription/),
[FluidAudio benchmarks](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Benchmarks.md),
[whisper.cpp models](https://huggingface.co/ggerganov/whisper.cpp),
[whisper-rs build requirements](https://codeberg.org/tazz4843/whisper-rs/raw/branch/master/BUILDING.md),
[WWDC25 session 277](https://developer.apple.com/videos/play/wwdc2025/277/).

## Testing

`cargo test -p kintsugi-ingest` runs on saved fixtures in
`crates/ingest/fixtures/` (feeds in `fixtures/feed/`) and a loopback HTTP server, with no internet. The
renderer is tested through a fake that returns a saved Defuddle result
(`spa.rendered.json`). The X fixtures in `fixtures/x/` are real FxTwitter
thread, status and profile responses (trimmed), plus a syndication and an
oEmbed response. The Reddit fixtures in `fixtures/reddit/` follow the
`.json` listing format.

- **Tools manager:** tested against a fake GitHub release on the loopback
  server, covering consent, checksum mismatch, size caps, zip archives,
  updates and failed updates.
- **yt-dlp:** replaced by a shell script that copies saved `.info.json`
  and `.vtt` files (`fixtures/youtube/`) and logs its arguments. The update
  and retry path installs a "fixed" script from a fake release.
- **Podcasts:** use a saved feed and transcripts (`fixtures/podcast/`)
  and a fake `Transcriber`.
- **Transcription helper:** its protocol is tested with fake scripts.
- **PDFs:** `fixtures/pdf/repair.pdf` (two pages with a running header,
  page numbers, headings and a hyphenated line, written by
  `fixtures/pdf/make.py`) and the helper's saved output for it
  (`repair.json`) test the layout and the adapter. On a Mac with a Swift
  toolchain, `pdfkit_helper_reads_the_fixture` compiles the real helper and
  reads the fixture with PDFKit (it skips elsewhere). Docling's install and
  conversion run against a fake uv that writes fake `docling` scripts.
- **EPUBs:** `fixtures/epub/repair.epub` (written by `make.py`: metadata
  with an ISBN, a cover, nav, copyright page and two chapters) plus
  archives built in the tests (a DTD, an oversized chapter, not a zip).
- **Books:** trimmed Open Library responses in `fixtures/books/`.

No test downloads a real tool or model. The opt-in tests are `#[ignore]`d:

- `live_article_and_video_metadata`, `live_post_thread_and_profile` and
  `live_post_with_comments` touch the network. Reddit may answer 403 from
  some networks.
- `live_youtube_transcript` downloads yt-dlp and Deno into
  `target/live-tools/` and fetches a real video's captions.
- `live_speech_analyzer` compiles the Swift helper and transcribes speech
  from `say`. It never asks macOS to download a model.
- `live_book_by_isbn_and_search` asks Open Library for an ISBN and a
  search.
- `live_docling` installs uv, Python and Docling with its models (about
  2 GB) into `target/live-tools/` and converts the PDF fixture. It passed
  on 2026-11-01 in about four minutes, including the install. Delete
  `target/live-tools/` afterwards.

Run them with `cargo test -p kintsugi-ingest -- --ignored`, or one at a
time by name (`-- --ignored live_speech_analyzer`).
