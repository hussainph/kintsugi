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
| `source` | Which adapter made it: `web`, `rss`, `x` or `reddit` (more to come: `youtube`, `pdf`…) |
| `id` | Canonical id, `<source>:<key>`. For web pages the key is the canonical URL, for X the status id (`x:20`), for Reddit the post id (`reddit:1abc2d`). Feeds deduplicate on it |
| `url` | Canonical URL, if any: no fragment, no tracking parameters (`utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `igshid`, `ref_src`) |
| `title`, `author`, `site`, `description` | As the source declared them, whitespace-collapsed and length-bounded |
| `published` | When the source says it was published, as written there (usually ISO 8601) |
| `captured` | When the engine captured it, RFC 3339 UTC |
| `media` | Images, the primary one first: `{ kind: "image", url? }`. Downloaded bytes travel beside the item in Rust (never serialized), only when the capture asked for them, and only as checked raster formats (PNG, JPEG, GIF, WebP; never SVG or HTML) |
| `body` | Readable content as Markdown, at most 20,000 characters, cut at a paragraph or line break near the end when possible. Inline `data:` images are dropped and blank-line runs collapsed. Empty for a video or a bare image |
| `extras` | Adapter facts. Every item sets `extractor`. Web pages use `readability`, `html`, `oembed`, `defuddle`, `image` or `none`, and may set `lang` and `modified`. X and Reddit items list theirs below |

Everything in an item came from the outside and is untrusted data, never
instructions. Errors are fixed strings (for example `page fetch timed out`,
`could not fetch source page`, `source is rate limiting requests`) that
never echo fetched content or URLs.

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
first that matches. Specific adapters (X, Reddit, YouTube, PDFs) go before the
generic web adapter, which accepts any web URL. `Engine::poll(source, …)`
uses the adapter registered for that source. Through the `Arc<A>` impl, one
web adapter instance is both registered and Reddit's fallback.

The Mac app's clip enrichment registers `XAdapter`, then `RedditAdapter`
(with the web adapter as its fallback), then `WebAdapter`
(`apps/desktop/src-tauri/src/enrich/mod.rs`). Clips of X and Reddit URLs
therefore go through the platform adapters.

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

## Testing

`cargo test -p kintsugi-ingest` runs on saved fixtures in
`crates/ingest/fixtures/` (feeds in `fixtures/feed/`) and a loopback HTTP server, with no internet. The
renderer is tested through a fake that returns a saved Defuddle result
(`spa.rendered.json`). The X fixtures in `fixtures/x/` are real FxTwitter
thread, status and profile responses (trimmed), plus a syndication and an
oEmbed response. The Reddit fixtures in `fixtures/reddit/` follow the
`.json` listing format. Only the `#[ignore]`d tests touch the network:
`live_article_and_video_metadata`, `live_post_thread_and_profile` and
`live_post_with_comments`. Run them with `cargo test -p kintsugi-ingest --
--ignored`. Reddit may answer 403 from some networks.
