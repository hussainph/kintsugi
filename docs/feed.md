# Feed

The contract for the Feed as built (KI-25, with X accounts from KI-33 and
watched pages and authors from KI-43, and older writing from KI-95). A
personal compilation, new and old. Direction lives in
`docs/vision.md` › Feed; where they disagree, this describes what exists.

## Storage

One SQLite file, `feed.sqlite`, in the app's data directory
(`~/Library/Application Support/dev.phalasiya.kintsugi/`), never the vault.
Headless runs keep it in `$KINTSUGI_CONFIG_DIR`; a debug run with
`KINTSUGI_CONFIG_DIR` uses that folder, and a scratch-vault run without one
uses a temporary folder. Schema version is `PRAGMA user_version` (2).

- `sources`: URL (unique), kind (`feed`, `hn`, `youtube`, `podcast`, `x`,
  `page`, `author`), title,
  site URL, muted, and health: last fetch, last success, last HTTP status,
  last error, consecutive failures, next fetch, and the ingest adapter's
  poll cursor (the feed adapter's `ETag` and `Last-Modified`, the newest
  X status id, a watched page's validators, hash and lines, or an author's
  seen titles).
  Unfollowing sets `removed_at`; following the same URL again revives it.
- `items`: one row per `(source, guid)`, with plain-text summary (≤600
  characters) and content (≤19,000), image URL, media (`article`, `video`,
  `audio`, `book`), published/fetched/sort times, and his actions: `liked_at`,
  `note`, `saved_path` (+ the stable `save_id` capture key), `dismissed_at`
  (Not interested), `expired_at`, and `full_text_at` (when the full article
  was fetched). Older metadata has `back_catalogue` and a nullable
  `catalogue_released_at`. Sources keep discovery state and their switch;
  `catalogue_releases` records admissions by UTC day, and
  `catalogue_neighbours` records links already considered.
- `events`: **append-only** (triggers reject UPDATE and DELETE). Every
  impression and every action, with time in ms, item, source, `surface`
  (`newest`, `picked` for Picked for you, `kin` for Kin's picks) and
  `position`. Kinds:
  `impression`, `open` (read in the app), `open_original`, `like`, `unlike`,
  `note`, `note_cleared`, `save`, `not_interested`, `undo_not_interested`,
  `discuss`, `subscribe`, `unsubscribe`, `mute`, `unmute`, and from ranking
  (KI-32) `correction` / `undo_correction` (`data.reason`, a "Why this?"
  reason removed or restored) and `kin_pick` (surface `kin`, `data.tool`: an
  item Kin's `shortlist` or `similar_to` returned). A note event
  records its length, not its words. Ranking ([ranking.md](ranking.md))
  reads this log to learn online and to evaluate offline; it never learns
  from `kin` events.

Item text is Markdown from the ingest engine. No feed HTML reaches the
webview, and the reader renders the Markdown as plain paragraphs, never as
HTML.

## Sources and polling

All fetching goes through the ingest engine (`docs/ingest.md`): its feed
adapter polls and discovers feeds, its X adapter polls X accounts, its web
adapter watches pages and fetches full articles, and its author adapter polls
authors. This module decides what to poll when, and keeps the store.

- **Link**: any feed URL, or a page that advertises one with
  `<link rel="alternate">` (`FeedAdapter::discover`). A URL that doesn't
  answer right now is still followed, with its error in its health line; a
  page with no feed is refused, with a hint to follow it as a Page.
- **Hacker News**: `https://hnrss.org/{frontpage|best|newest|show|ask}`,
  optionally `?points=N`.
- **YouTube**: a channel ID, `/channel/UC…`, `/user/…` or playlist URL maps
  straight to `youtube.com/feeds/videos.xml`; an `@handle` or `/c/` page is
  fetched once to read its channel ID.
- **Podcasts**: `feed_podcast_search` asks iTunes Search
  (`FeedAdapter::search_podcasts`); results without a public `feedUrl` are
  dropped.
- **X accounts**: an `@handle`, bare handle or profile URL on an X host
  (`{ kind: "x", account }`, the Following sheet's X tab) is stored as
  `https://x.com/<handle>`. An `@handle` or X profile link typed into the
  Link tab, and an OPML outline pointing at one, become X sources too. They
  poll through the X adapter (FxTwitter, best-effort, no X account): the
  account's own posts and self-threads, newest-status-id cursor, title and
  image from the profile. FxTwitter returns only the latest ~20 posts, so
  failures back off to at most **1 hour** for X, as for YouTube.
- **Pages** (`{ kind: "page", url }`, the Page tab): any HTTP(S) page,
  stored as typed (normalized). The web adapter watches it
  (`docs/ingest.md` › Watching a page): a conditional request every **6
  hours**, the readable region as lines, noise (dates, times, "3 hours ago",
  view/like/comment counters, copyright years, link targets) masked before
  hashing. Following records a baseline and adds nothing. Each change after
  that is one item: the first added line as its title (or "Removed: …"),
  "2 lines added and 1 removed on <page>" as its summary, the added and
  removed lines (up to 12 each) as its text, and the page as its link. The
  source's title and image come from the page.
- **Authors** (`{ kind: "author", name }`, the Author tab): stored as the
  author's Open Library search page,
  `https://openlibrary.org/search?author=<name>&sort=new`, titled with the
  name. Polled **weekly** through the author adapter (Google Books
  `inauthor:` newest first, Open Library when Google doesn't answer).
  Following shows the author's latest three books; after that, each title
  the catalogue newly lists is one item (media `book`): title and subtitle,
  authors, cover, description, and a body with publisher, release date,
  pages and ISBN, linking to the book's Google Books or Open Library page.
  Reissues of a known title never return. A release first listed more than
  30 days after its date still shows, sorted as just found.
- Neither a page change nor a book is an excerpt of an article: reading one
  never fetches its link as full text.

One background task polls due, unmuted sources every minute (four at a
time), and wakes on subscribe, import and unmute. Requests are conditional
through the adapter's cursor; a 304 is a healthy fetch. Healthy sources poll
every 30 minutes (pages every 6 hours, authors weekly). A failure never removes a source: it records the HTTP
status (if any) and a readable reason, and retries after 5 minutes, doubling
to a cap of 24 hours, or **1 hour for YouTube** (its feeds fail
transiently; a non-200 means retry, not gone) and X. A rate limit reads
"rate limited; Kintsugi will try again later". The adapter's limits apply
(8 MB, 25-second timeout, 5 redirects, credential-free HTTP(S) only).

A poll stores at most 100 entries. For blogs and pages, older articles enter
the back catalogue instead of expiring on arrival. Other adapters keep the
previous rule: entries over 30 days old start expired, except the newest
three on the first fetch.

## Older writing

Blogs and watched pages have **Older writing** enabled by default. Follow
Paul Graham's `https://paulgraham.com/articles.html` as a Page; Jason Cohen's
`https://longform.asmartbear.com/index.xml` or
`https://blog.asmartbear.com/feed/` as a Link.

A separate background task scans each source once. Ordinary Refresh never
repeats the scan. Following shows its state and count; **Find again** asks
for another scan. Turning Older writing off hides its older pieces without
muting new posts. Interrupted scans resume from the queued state on restart.

Discovery reads metadata from the full feed, advertised feed-history pages,
archive indexes and sitemaps. It checks robots.txt at each origin, honours
crawl delays and spaces requests by at least one second per origin. A scan
stops at 40 index pages, 5,000 entries, 8 MB per page, 32 MB overall, five
redirects per request or three minutes. A reached limit appears in its source
row; Find again repeats a bounded scan rather than promising a complete crawl.
It never downloads articles, images or scripts. Sitemap modification dates
are not publication dates. Unknown dates say **Date unknown** until a lazy
article read finds a declared publication date.

Metadata waits in a persistent pool. KI-32's local ranker chooses at most
**two older pieces per UTC day**, across all sources and surfaces. A durable
release ledger prevents refreshes, different list sizes, dismissals or a
restart from spending the quota again. The pool does not expire while it
waits. Unseen ordinary articles can age into this pool; articles he already
saw and ignored still expire. Released items retain their original dates; only ranking's scoring
copy neutralizes their age penalty. Likes, notes, saves and Inspiration
still supply taste, through local embeddings or the hashed fallback.

Picked for you and Newest each show at most two older candidates even after
several days of releases. Newest places them by when they were offered;
the date beside each piece is its original date, with **Older writing**.
Unseen releases remain eligible for future picks. Seen, ignored pieces expire
after 30 days; Kin's reads and picks do not start that clock.
Full text is fetched only when opened. Discovery and ranking make no model
calls; no summaries are generated here.

### Close neighbours

An unfollowed origin needs meaningful article links from two distinct Feed
items he liked, noted or saved. Only links already in their stored text
count; images, navigation, platform profiles and a further link crawl do
not. At most three destinations per origin are considered in a pass, and a
durable URL journal prevents repeats. A candidate also needs nearest-positive
local similarity of at least 0.55 before release. This same threshold applies
to model and hashed vectors, so uncertain matches are left out.

At most one neighbour is admitted per day, within the two-piece older-work
quota. It is marked **Suggested**, with a (?) reason naming the kept item
that linked to it, and **Follow**. It stays out of Following, polling and
OPML until Follow. Follow discovers its feed when available, else follows
its homepage as a Page. Unfollowed sources are never revived by discovery.

## Order and expiry

Newest first by publish time (capped at "now"; undated entries use the
fetch time and keep the feed's order). Muted and unfollowed sources,
dismissed and expired items are hidden. Items he never acted on (no like,
note, save or Not interested) expire 30 days after they were first seen (older writing: first human exposure
after release): the
row stays, so a later poll can't revive them, but their text is dropped.
Dismissed items keep their row as a negative signal and lose their text
after 30 days.

## Actions

- **Like** toggles `liked_at`. The toast says what it changed in Picked for
  you (the source, author or topic affinities it moved, and picks that came
  in or made room, from `feed_effect`), with Undo, which reverses it exactly.
- **Note** stays on the item, saved as he types. Once saved, the note lives
  in the clip and is edited in Inspiration.
- **Save** is the only way from the Feed into Inspiration. It goes through
  the shared clip capture path (`clip_capture::create`, the same receipt
  journal as Mac and phone captures) with `via: feed`, the item's URL and
  title, and his note as the clip's own text, keyed by the item's stable
  `save_id`, so a retried save never doubles. The clip then gets `site`
  (the source), `author` and the item's text as its `## Source`;
  enrichment fills in the rest. `clips:changed` fires as for any capture.
- **Not interested** hides the item, with Undo.
- **Discuss** opens Kin's chat with the item pinned as a `feed` context chip (`{ kind: "feed", path: <item id>, label: <title> }`, see `docs/kin.md`) and logs the event. An item open in the reader is also on-screen context for the chat. The chip reaches Kin as `feed:<id>`, which its `read` tool opens (title, source, author, link, his actions and note, then the text), see [ranking.md](ranking.md) › Kin's tools.

**Full text.** When he opens an article whose feed text is an excerpt
(under 600 characters), `feed_read` fetches the page once through the
ingest engine's web adapter (with the hidden-webview fallback on the Mac;
static only in headless) and keeps the longer text. A failure keeps the
feed's text and isn't retried. Saving never waits on the network: the clip
gets the best text already stored, and clip enrichment fetches the rest.

## Search

Visible items are also in the shared search index ([search.md](search.md)),
in its `feed` scope as `feed:<id>`. Every Feed change refreshes the index in
the background, and items that are hidden or expired leave it. Kin finds
them with `search` (`kind: "feed"`).

## OPML

`feed_opml_export({ path })` writes OPML 2.0 to the path the save dialog
chose (in headless, only inside the scratch vault or config). Outlines carry
`kintsugiKind` and `kintsugiMuted` attributes, which other readers ignore.
Pages and authors aren't feeds, so they're written as OPML 2.0 `type="link"`
outlines with a `url` and no `xmlUrl`: other readers skip them, and import
reads them back only when `kintsugiKind` is `page` or `author`.
`feed_opml_import({ opml })` takes the file's text, read by the webview's
file input (no arbitrary file reads cross IPC). It flattens folders, skips
duplicates and already-followed URLs, counts unusable URLs, restores muted
state, and lets the poller fetch new sources in the background.

## Commands

`feed_sources`, `feed_subscribe({ input })`, `feed_unsubscribe({ id })`,
`feed_mute({ id, muted })`, `feed_refresh({ id? })`,
`feed_catalogue({ id, enabled?, retry? })`, `feed_follow_suggestion({ id })`,
`feed_podcast_search({ term })`, `feed_opml_import`, `feed_opml_export`,
`feed_items({ offset?, limit?, source? })`, `feed_read({ id, place? })`,
`feed_act({ id, action, place? })`, `feed_note({ id, note, place? })`,
`feed_save({ id, place? })`, `feed_impressions({ impressions })`, and
ranking's `feed_picked({ n? })`, `feed_correct({ reason, id?, undo? })`,
`feed_effect({ id })` ([ranking.md](ranking.md)). `place` is
`{ surface, position }`. Changes emit `feed:changed`. Types live in
`apps/desktop/src/feed/api.ts`.

## UI

`apps/desktop/src/feed/`. The Feed sits beside Inspiration in the sidebar
(⇧⌘F). `Feed` takes a `picked?: ReactNode` slot above the newest list:
`Picked.tsx` renders **Picked for you** there (eight picks, four shown until
"Show more", one exploring), each with "Why this?", and logs its impressions
with surface `picked`. See [ranking.md](ranking.md).
**Following** (a sheet) adds sources (tabs: Link, HN, YouTube, Podcast, X,
Page, Author; each is an icon, and only the selected one shows its name),
shows each one's health, mutes, fetches now, unfollows, and imports/exports
OPML. Each source shows a podcast's artwork or its site's `/favicon.ico`
(loaded straight from that site, with no referrer), else its type icon.
HN, YouTube, X and authors always use their type icon.

## On the phone (KI-42)

The phone reaches the Feed through the phone API (version 6,
`apps/desktop/src-tauri/src/phone/sections.rs`; client methods in
`packages/core/src/remote.ts`, types in `@kintsugi/core/sections`). Every
route calls the same command as the Mac's webview (`phone/desk.rs`), so the
events, ranking, captures and `feed:changed` are the Mac's own; the phone
never ranks, fetches or calls a model.

| Route | Command |
| --- | --- |
| `GET /v1/feed?offset&limit` | `feed_items` (limit 1–100, default 40) |
| `GET /v1/feed/picked` | `feed_picked` |
| `POST /v1/feed/read {id, place?}` | `feed_read` (an `open`; fetches the full text) |
| `POST /v1/feed/act {id, action, place?}` | `feed_act` |
| `PUT /v1/feed/note {id, note, base?, place?}` | `feed_note`, version-checked: `base` is `kintsugi_vault::version` of the note the phone started from (`""` for none). `{result: "saved", version, item}`, or 409 `{result: "conflict", current: {text, version}, item}` with nothing written |
| `POST /v1/feed/save {id, place?}` | `feed_save` (already idempotent through its `save_id`) |
| `POST /v1/feed/impressions {impressions}` | `feed_impressions` (at most 500) |
| `GET /v1/feed/effect?id` | `feed_effect` |

Unknown items and refusals are 400 with the command's message; an unknown
action is 422. A server without the app behind it (the bare
`phone_dev_server`) answers 503.

**The phone app** (`apps/mobile/src/lib/feed.ts`, `app/feed.tsx`,
`app/feed-item.tsx`, `components/FeedRow.tsx`): Picked for you (four, then
"Show more", with Why this?) above the newest list, from a copy kept in the
app's key-value store so it reads offline; an opened article's text is kept
too (the latest 40). Like, save, note and Not interested apply at once and
wait in order until the Mac takes them (`lib/waiting.ts`); a refusal the
request can't recover from (400, 404, 413, 422) is dropped with the reason
shown. Notes are version-checked: an edit elsewhere in the note merges
(`merge3`), the same words changed on both sides ask which to keep. Shown
items are logged as impressions (surface `picked` or `newest`, once per
launch). A like shows what it changed (`feed_effect`) with Undo; Not
interested has Undo. Discuss logs `discuss` and opens Kin with the item as a
`feed` chip. Older Macs (before API 6) are told to update.

## Testing

Rust unit tests use the ingest crate's fixtures (feeds, X, watched pages in
`crates/ingest/fixtures/watch/`, Google Books in `crates/ingest/fixtures/authors/`)
and a loopback server. `apps/desktop/test/runtime-feed.test.ts` drives the real
headless runtime with Playwright against `test/feed-fixtures.ts` (run it on
its own with `node apps/desktop/test/feed-fixtures.ts`) and blocks every
non-loopback request; screenshots go to `.headless/feed-shots/`. It runs Kin's
headless mock model (`KINTSUGI_HEADLESS_KIN=mock`) for the ranking tools.
The fixture server also serves a `/now` page whose version the test switches (noise only,
then a real edit, with ETags), and stands in for Google Books: the test sets
`KINTSUGI_HEADLESS_BOOKS=<fixture base>/`, which headless builds honour only
for an `http://127.0.0.1` URL.
