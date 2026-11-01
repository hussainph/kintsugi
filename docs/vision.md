# Vision

Kintsugi is where scattered inspiration becomes writing.

Everything Hussain reads, watches and hears (books, articles, posts on X and
Reddit, Hacker News threads, blogs, podcasts, videos) flows through one
place. The things worth keeping are kept. An agent, **Kin**, reads all of it
alongside him and helps turn it into finished pieces, without writing them
for him. Kintsugi is the Japanese art of mending broken pottery with gold.
Here the pieces are fragments of inspiration, and the gold is what connects
them.

This document holds the product's shape and direction, as decided with the owner on
2026-11-01. Contracts for built parts live beside it (`docs/inspiration.md`,
`docs/ingest.md`, `docs/feed.md`, `docs/ranking.md`).
Where they disagree, the contract describes what exists and this document
describes where it's going. Tickets on the board carry the build plan.

## Who it's for

Hussain, first and only. Kintsugi is single-player and local-first: the
vault is a folder of plain files on his Mac, the phone reaches the Mac over
Tailscale, and there's no cloud and no account. AI is bring-your-own-key. It's
free and open source so anyone who likes it can run their own copy, but
nothing is built for multi-user use, hosting or onboarding at scale.

## The shape

Four places, and Kin everywhere:

| Place | What it is | Who fills it |
| --- | --- | --- |
| **Feed** | A digest of new work from sources Hussain follows | Automatic |
| **Inspiration** | A small, curated library of what's worth keeping | **Hussain only** |
| **Ideas** | A few specific, grounded ideas a day about his writing and collection | Kin |
| **Writing** | Notes, drafts and posts, on the Mac and the phone | **Hussain only** |

**Kin** is a universal presence: one avatar on every screen, one chat that
picks up whatever he's looking at, and comment threads in his drafts.

```
 sources ─▶ Feed ──save──▶ Inspiration ─┐
             ▲                          ├─▶ Kin ──▶ Ideas ──adopt──▶ Writing ──▶ export
             └── ranking ◀── signals ◀──┴── Writing ◀───────────────────┘
```

Writing matters most. When features compete, the one that makes writing and
publishing a piece easier or more pleasant wins.

## Feed

The Feed fills itself from sources Hussain chooses. Nothing in it is kept
unless he keeps it.

- **Sources:** RSS/Atom first. One adapter covers blogs, YouTube channels,
  podcasts and Hacker News (via hnrss.org). Then X accounts (via the
  FxTwitter API, best-effort, with fallbacks), "follow this page" change
  detection for sites without feeds, and new books from favourite authors.
  Reddit can't be followed (its RSS and public API are closing), so Reddit
  posts are single captures only.
- **Order:** newest first, plus a small **Picked for you** section ranked
  for him.
- **Actions:** ♥ like (a signal; it shows what it changed, with undo),
  📝 note (a strong signal; travels with the item if saved), ⤓ save (copies
  it into Inspiration, the only way anything gets there), and **Not
  interested** (the strongest negative). Ignored items are a weak negative
  and drop out after 30 days.
- **Discuss** on any item opens Kin with that item in context.
- Feed items and the subscription list live in the app's own data, not the
  vault. Subscriptions import and export as OPML. Each source shows its
  health (last fetch, errors) and can be muted.

### Ranking without burning tokens

Ranking is local machine learning, not LLM calls, borrowing the ideas that
carry over from X's and TikTok's published recommenders to one person:

- Small on-device text embeddings (model2vec-class) for every item.
- Taste vectors from liked and saved items (a long and a short half-life),
  plus closeness to his nearest saved clips, so separate interests don't
  blur together.
- Online logistic regression over a handful of features (taste similarity;
  source, author and tag affinity; age; length; media type), updated on every
  action and weighted X-style (save > note > like > open; Not interested
  strongly negative).
- 10–15% of picks reserved for exploration (Thompson sampling), with author
  diversity and near-duplicate removal.
- Cold start from what's already in Inspiration.
- Everything in one SQLite file in app data, including an event log of
  every impression and action, so ranking can be evaluated offline.

The same signals become cheap tools for Kin (`shortlist`, `search`,
`similar_to`, `top_topics`, `explain`), so it reads twenty pre-ranked items
instead of five hundred. Kin's own picks are logged separately, so it can't
learn from its own choices.

## Inspiration

Inspiration is curated and human-driven. Kin learns from it and never adds
to it. Things arrive by Hussain's hand: saving from the Feed, the phone's
share sheet, the Mac, a pasted link, a dropped file.

- A clip is a plain Markdown file (see `docs/inspiration.md`): what was
  saved, readable source text for Kin, and his own words.
- The direction is **bite-sized**: a tweet-sized card, with his thoughts as
  a thread of short dated notes rather than one long note, and the summary
  and full source one tap away. The exact shape is being explored in the Lab
  against real ingestions before the file format changes.
- Each clip shows where it's been referenced in his writing.
- Anything machine-made on a card (summary, transcript excerpt) is labelled.
  Quotes are direct, not paraphrased, and link back to the passage or
  timestamp.

### Ingesting anything

One ingestion pipeline serves both the Feed and Inspiration: source
adapters turn anything into clean Markdown with metadata and media.

- Web pages: readable-article extraction in Rust, with a hidden-webview
  fallback for pages that need JavaScript.
- X posts and threads, Reddit posts with comments, YouTube (transcripts),
  podcasts (on-device transcription), PDFs, EPUBs and books.
- The core stays Rust/Swift. Heavy tools (yt-dlp, a high-quality PDF
  converter, transcription models) are optional and downloaded the first
  time they're needed.
- The AI is used to clean up and summarize, never as the main extractor.

## Kin

Kin is the agent. It reads everything Hussain collects and writes, the same
way he does, and helps. It never writes his prose. It has no "Muse"-style
persona: it's called Kin ("your Kin"), and its look is something he
customizes (explored in the Lab).

### Present everywhere

- One avatar on every screen opens one chat. Whatever he's looking at (a
  feed item, a clip, a paragraph mid-draft) is attached as a removable
  context chip.
- In the editor, `@Kin` starts a conversation inline. Kin replies the way a
  reviewer does: **comment threads** anchored to a paragraph, stored outside
  the document and moving with the paragraph as it's edited. Anything it
  finds can be dragged in as a reference.

### How it thinks: tools, not a knowledge dump

Kin doesn't keep a wiki or a growing private knowledge base. It's very good
at finding things: it searches the vault, Inspiration and the Feed with
coding-agent-style tools (search, read, list) and the ranking tools above,
across as many calls as it needs. Its always-loaded context stays small.

Its memory is modelled on Hermes Agent: small, capped and visible, in
`.kintsugi/agent/` in the vault.

| File | Holds | Cap | Loaded |
| --- | --- | --- | --- |
| `USER.md` (shown as **About you**) | Taste, voice, themes, dislikes | ~1.5k chars | Always |
| `NOTES.md` | Where to look and how things are organized, never copies of content | ~2k chars | Always |
| `skills/` | Procedures and shortcuts (see below) | per skill | Index always; body on demand |
| Conversation history | Every chat and comment thread | none | Through search only |

Writes that would exceed a cap are rejected, so Kin has to consolidate
rather than hoard. Changes apply automatically. **About you** shows the
current memory, where each line came from, a change log, and undo. Any chat
can be marked "don't remember this."

**Skills** are one system with two uses. Kin writes procedures for itself
("how to make ideas for Hussain", "how to rank his feed"), and skills
flagged for the editor appear as AI commands in the `/` menu. Hussain can
write his own ("/steelman this", "/find counterexamples"), and Kin suggests
new ones when it notices him asking for the same thing repeatedly.

### One conversation, underneath

Following how always-on agents like Grok Bot are built:

- **One log.** What each turn is about (a draft, a clip, a feed item, a
  paragraph) is inferred from what's on screen and what's said. Hussain
  never tags or files anything. A "thread", such as "the conversation about
  draft X", is just that inferred grouping, a view of the one log with its
  own running summary, not a separate session. Paragraph comment threads
  live in the same log.
- **A lean main conversation, with helpers.** Heavy or background work
  (ranking the feed, generating ideas, long searches) runs as helper agents
  with their own context, recorded in a local job table so they survive
  quitting the app. Each gets a clear brief plus About you and the notes
  file, and reports back quietly.
- **Context engineering.** A fixed, cached prompt prefix; context chips as
  references Kin reads on demand rather than pasted text; tools loaded when
  needed; long outputs written to files. Summaries are made while Hussain is
  idle, and the history he can scroll is never deleted.
- Typing interrupts Kin, and bursts of messages are batched into one turn.

### Trust and cost

- Bring-your-own-key, with keys held in Rust on the Mac, never in the webview
  and never on the phone. Kin runs on the Mac. When the Mac is unreachable,
  Kin on the phone says so and queues the request.
- Model choice per task (cheap for feed triage, strong for Ideas and chat),
  with a cost tracker in Settings and a monthly cap.
- Feed text, transcripts and web pages are content, never instructions. Kin
  never acts on what a post tells it to do.
- A plain statement in Settings: his writing, collection and Kin's memory
  stay on the Mac. The only things that leave it are calls to his own AI
  provider, fetches of the sources he follows or saves, and one-time
  downloads of local models and tools. Nothing is used for training.
- Kin's stance is a critical reader, not a flatterer.

## Ideas

A small daily batch (up to about five), plus ideas on demand. Each one is
specific and grounded in his own writing and collection: "You've saved seven
things about tools that shape thinking and never written about it",
"Two clips this month disagree about X", "This draft argues the opposite of
what you published in March."

- **Progressive disclosure.** Most ideas will be ignored, so the list shows
  a title and at most a one-line snippet. Detail appears only when he
  engages: what Kin *observed* kept separate from its *hunch*, 2–4 quoted
  clips as evidence, a collapsed "how I got here", and "Why this?", which
  doubles as a way to correct Kin.
- **Actions:** Adopt (creates a new draft titled after the idea with an
  empty body, the idea and its clips beside it and in the draft's metadata,
  never in the prose; or attaches it to an existing draft), Discuss with Kin,
  Refine, Dismiss (a signal). Unused ideas fade after about a week.
- Ideas have their own section. They don't appear in the editor margin.
  Inside a draft, "ideas for this draft" is a command that opens Ideas
  filtered to that document.

## Writing

Writing is first-class on both the Mac and the phone.

- **The editor:** focused Markdown/MDX, with a Notion-style `/` menu for
  blocks and AI commands (skills), and `@` to reference clips, documents
  and Kin. `@` opens the same picker as `[[` and writes the same `[[link]]`
  to disk, so files stay Obsidian-compatible. ⌘K's AI edits on a selection
  stay, alongside non-prose actions like "find supporting clips", "who
  disagrees?" and "Discuss this paragraph".
- **Organizing:** drafts can be tagged and organized (folders on disk, tags
  in frontmatter), and filtered on both devices.

### The phone is a notes app

Some of the best ideas get written on a phone in downtime, so the phone has
to feel like a simple notes app.

- **Offline first, kept simple.** The phone keeps its own copy of all the
  writing (text is small), so anything can be opened, written or started at
  any time. It syncs when the Mac is reachable. Edits that don't overlap
  merge automatically, and only true collisions ask which version to keep.
  Inspiration on the phone keeps cards and thumbnails, with full sources
  fetched on demand.
- It opens where he left off, with a fast way to start a new note (which
  lands in `inbox/`). A note is just a document; there's no separate type.
- **One editor.** The Mac's CodeMirror editor runs on the phone through
  Expo's web components, so `/`, `@` and Kin's comment threads behave the
  same on both devices. Native keyboard, selection and toolbar feel get
  proven in a spike first.
- Feed, Inspiration, Ideas and Kin are all on the phone too.

## Export

MDX is the source format. Each destination is an exporter.

- **v1:** transform to a file or clipboard (PDF, LinkedIn-ready text,
  HTML), and publish to the blog (hussain.ph, Astro + MDX) by writing the
  post into its repository for him to commit and push. No social media APIs.
- **Later:** he picks his destinations, and Kin can create new ones by
  plugging into something like MCP, because every place he posts works
  differently.
- **Provenance:** an export can carry a sources appendix built from the
  clips the piece referenced, and an honest "written by a human" statement,
  because the editor never inserts Kin's text unasked.

## Outside agents

The vault is plain files, so Claude Code or any other agent can work with
it. Kin's tools may also be exposed as an MCP server or CLI. This is a nice
extra, not a priority: the goal is an internal agent good enough that he'd
rather use it. Outside agents never add to Inspiration.

## Vault layout

```
~/Documents/Kintsugi/
  inbox/            quick notes from the phone
  inspiration/      clips and their media (human-curated); sources/ keeps
                    long clips' whole text for Kin
  .kintsugi/
    agent/          Kin's memory: USER.md, NOTES.md, skills/
    comments/       Kin's comment threads on documents (direction)
  …                 drafts, notes and posts, in folders, anywhere else
```

The Feed, subscriptions, ranking data, conversation log and job table live
in the app's data directory, not the vault.

## Principles

- **Writing comes first.** Every feature serves turning inspiration into
  finished pieces.
- **Kin helps; it doesn't ghostwrite.** It finds, connects, questions and
  suggests. Prose is Hussain's, apart from edits he explicitly asks for.
- **Curated stays curated.** Only Hussain puts things in Inspiration and
  Writing.
- **Plain files, local first.** One folder on disk is the source of truth.
- **Capture is instant and never lost.** Save first, enrich later.
- **No organizing chores.** Tags and folders are there when he wants them,
  never required.
- **Learning is visible and reversible.** What Kin believes about him, and
  what a like changed, can be seen and undone.
- **Cheap by default.** Local machine learning before LLM calls. Costs are
  tracked and capped.

## Not doing

- Multi-user use, collaboration, cloud hosting or a sync service.
- Ghostwriting: drafting pieces, "continue writing", autocomplete, or
  cloning his voice.
- A Karpathy-style agent-written wiki. Kin finds things instead of
  compiling them.
- Competing feature-for-feature with dedicated readers, feed apps or note
  apps. The value is the loop between them.

## References

- Andrej Karpathy, [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
  the starting point. Kintsugi keeps the idea of an agent reading alongside
  you, and drops the wiki.
- Hermes Agent (Nous Research): small, capped, visible memory; skills;
  searchable history.
- Lee Robinson, "How always-on agents work" (Grok Bot, Stanford CS146S): one
  lean conversation, helper agents, context engineering.
- Meta's Muse app: ideas as specific offers, and a feed with a visible
  steering prompt. Reference only, not branding.
- Emily Campbell, [The Shape of AI](https://www.shapeof.ai): synthesis,
  citations, memory, rating and footprint patterns.
- X's and TikTok's published recommenders (xai-org/x-algorithm, Monolith),
  scaled down to one person.
- Readwise Reader and myMind (capture and library), Feedly and Reeder
  (feeds), Obsidian (plain linked files), Apple Notes (the phone's feel),
  Notion (`/` and `@`), iA Writer (focused writing).
