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
| `source` | Which adapter made it: `web` or `rss` (more to come: `x`, `youtube`, `pdf`…) |
| `id` | Canonical id, `<source>:<key>`. For web pages the key is the canonical URL. Feeds deduplicate on it |
| `url` | Canonical URL, if any: no fragment, no tracking parameters (`utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `igshid`, `ref_src`) |
| `title`, `author`, `site`, `description` | As the source declared them, whitespace-collapsed and length-bounded |
| `published` | When the source says it was published, as written there (usually ISO 8601) |
| `captured` | When the engine captured it, RFC 3339 UTC |
| `media` | Images, the primary one first: `{ kind: "image", url? }`. Downloaded bytes travel beside the item in Rust (never serialized), only when the capture asked for them, and only as checked raster formats (PNG, JPEG, GIF, WebP; never SVG or HTML) |
| `body` | Readable content as Markdown, at most 20,000 characters, cut at a paragraph or line break near the end when possible. Inline `data:` images are dropped and blank-line runs collapsed. Empty for a video or a bare image |
| `extras` | Adapter facts. Web pages always set `extractor` (`readability`, `html`, `oembed`, `defuddle`, `image` or `none`) and may set `lang` and `modified` |

Everything in an item came from the outside and is untrusted data, never
instructions. Errors are fixed strings (for example `page fetch timed out`,
`could not fetch source page`) that never echo fetched content or URLs.

## Adapters and the engine

An `Adapter` has three jobs:

- `matches(target)`: a cheap check, with no I/O, of whether it handles a target. A target is a
  URL (`Target::url` accepts only credential-free HTTP(S)) or a local file.
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
first that matches. Specific adapters (X, YouTube, PDFs) go before the
generic web adapter, which accepts any web URL.

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

## Testing

`cargo test -p kintsugi-ingest` runs on saved fixtures in
`crates/ingest/fixtures/` (feeds in `fixtures/feed/`) and a loopback HTTP server, with no internet. The
renderer is tested through a fake that returns a saved Defuddle result
(`spa.rendered.json`). `live_article_and_video_metadata` is `#[ignore]`d
and is the only test that touches the network.
