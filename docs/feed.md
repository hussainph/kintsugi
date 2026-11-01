# Feed

The contract for the Feed as built (KI-25). Direction lives in
`docs/vision.md` › Feed; where they disagree, this describes what exists.

## Storage

One SQLite file, `feed.sqlite`, in the app's data directory
(`~/Library/Application Support/dev.phalasiya.kintsugi/`), never the vault.
Headless runs keep it in `$KINTSUGI_CONFIG_DIR`; a debug run with
`KINTSUGI_CONFIG_DIR` uses that folder, and a scratch-vault run without one
uses a temporary folder. Schema version is `PRAGMA user_version` (1).

- `sources`: URL (unique), kind (`feed`, `hn`, `youtube`, `podcast`), title,
  site URL, muted, and health: last fetch, last success, last HTTP status,
  last error, consecutive failures, next fetch, and the ingest feed
  adapter's poll cursor (its `ETag` and `Last-Modified`).
  Unfollowing sets `removed_at`; following the same URL again revives it.
- `items`: one row per `(source, guid)`, with plain-text summary (≤600
  characters) and content (≤19,000), image URL, media (`article`, `video`,
  `audio`), published/fetched/sort times, and his actions: `liked_at`,
  `note`, `saved_path` (+ the stable `save_id` capture key), `dismissed_at`
  (Not interested), `expired_at`, and `full_text_at` (when the full article
  was fetched).
- `events`: **append-only** (triggers reject UPDATE and DELETE). Every
  impression and every action, with time in ms, item, source, `surface`
  (`newest`; `picked` is reserved for KI-32) and `position`. Kinds:
  `impression`, `open` (read in the app), `open_original`, `like`, `unlike`,
  `note`, `note_cleared`, `save`, `not_interested`, `undo_not_interested`,
  `discuss`, `subscribe`, `unsubscribe`, `mute`, `unmute`. A note event
  records its length, not its words. Ranking (KI-32) reads this log to learn
  online and to evaluate offline.

Item text is Markdown from the ingest engine. No feed HTML reaches the
webview, and the reader renders the Markdown as plain paragraphs, never as
HTML.

## Sources and polling

All fetching goes through the ingest engine (`docs/ingest.md`): its feed
adapter polls and discovers feeds, and its web adapter fetches full
articles. This module decides what to poll when, and keeps the store.

- **Link**: any feed URL, or a page that advertises one with
  `<link rel="alternate">` (`FeedAdapter::discover`). A URL that doesn't
  answer right now is still followed, with its error in its health line; a
  page with no feed is refused.
- **Hacker News**: `https://hnrss.org/{frontpage|best|newest|show|ask}`,
  optionally `?points=N`.
- **YouTube**: a channel ID, `/channel/UC…`, `/user/…` or playlist URL maps
  straight to `youtube.com/feeds/videos.xml`; an `@handle` or `/c/` page is
  fetched once to read its channel ID.
- **Podcasts**: `feed_podcast_search` asks iTunes Search
  (`FeedAdapter::search_podcasts`); results without a public `feedUrl` are
  dropped.

One background task polls due, unmuted sources every minute (four at a
time), and wakes on subscribe, import and unmute. Requests are conditional
through the adapter's cursor; a 304 is a healthy fetch. Healthy sources poll
every 30 minutes. A failure never removes a source: it records the HTTP
status (if any) and a readable reason, and retries after 5 minutes, doubling
to a cap of 24 hours, or **1 hour for YouTube** (its feeds fail
transiently; a non-200 means retry, not gone). The adapter's limits apply
(8 MB, 25-second timeout, 5 redirects, credential-free HTTP(S) only).

A poll stores at most 100 entries. Entries published more than 30 days
before they were first seen are recorded already expired (so they never come
back), except the newest three on a source's first fetch.

## Order and expiry

Newest first by publish time (capped at "now"; undated entries use the
fetch time and keep the feed's order). Muted and unfollowed sources,
dismissed and expired items are hidden. Items he never acted on (no like,
note, save or Not interested) expire 30 days after they were first seen: the
row stays, so a later poll can't revive them, but their text is dropped.
Dismissed items keep their row as a negative signal and lose their text
after 30 days.

## Actions

- **Like** toggles `liked_at`. The toast says it is a signal for Picked for
  you, with Undo; showing what it changed comes with ranking.
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
- **Discuss** opens Kin's chat with the item pinned as a `feed` context chip (`{ kind: "feed", path: <item id>, label: <title> }`, see `docs/kin.md`) and logs the event. An item open in the reader is also on-screen context for the chat. Kin has no feed-reading tool yet, so it sees the title.

**Full text.** When he opens an article whose feed text is an excerpt
(under 600 characters), `feed_read` fetches the page once through the
ingest engine's web adapter (with the hidden-webview fallback on the Mac;
static only in headless) and keeps the longer text. A failure keeps the
feed's text and isn't retried. Saving never waits on the network: the clip
gets the best text already stored, and clip enrichment fetches the rest.

## OPML

`feed_opml_export({ path })` writes OPML 2.0 to the path the save dialog
chose (in headless, only inside the scratch vault or config). Outlines carry
`kintsugiKind` and `kintsugiMuted` attributes, which other readers ignore.
`feed_opml_import({ opml })` takes the file's text, read by the webview's
file input (no arbitrary file reads cross IPC). It flattens folders, skips
duplicates and already-followed URLs, counts unusable URLs, restores muted
state, and lets the poller fetch new sources in the background.

## Commands

`feed_sources`, `feed_subscribe({ input })`, `feed_unsubscribe({ id })`,
`feed_mute({ id, muted })`, `feed_refresh({ id? })`,
`feed_podcast_search({ term })`, `feed_opml_import`, `feed_opml_export`,
`feed_items({ offset?, limit?, source? })`, `feed_read({ id, place? })`,
`feed_act({ id, action, place? })`, `feed_note({ id, note, place? })`,
`feed_save({ id, place? })`, `feed_impressions({ impressions })`. `place` is
`{ surface, position }`. Changes emit `feed:changed`. Types live in
`apps/desktop/src/feed/api.ts`.

## UI

`apps/desktop/src/feed/`. The Feed sits beside Inspiration in the sidebar
(⇧⌘F). `Feed` takes a `picked?: ReactNode` slot above the newest list: KI-32
renders Picked for you there and logs its impressions with surface `picked`.
**Following** (a sheet) adds sources, shows each one's health, mutes,
fetches now, unfollows, and imports/exports OPML.

## Testing

Rust unit tests use fixtures in `src-tauri/src/feed/fixtures/` and a
loopback server. `apps/desktop/test/runtime-feed.test.ts` drives the real
headless runtime with Playwright against `test/feed-fixtures.ts` (run it on
its own with `node apps/desktop/test/feed-fixtures.ts`) and blocks every
non-loopback request; screenshots go to `.headless/feed-shots/`.
