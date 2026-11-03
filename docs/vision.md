# Vision

Kintsugi collects what Hussain reads and helps him turn it into writing.

Everything he reads, watches and hears (books, articles, posts on X and
Reddit, Hacker News threads, blogs, podcasts, videos) comes into one
place, and he saves the things worth keeping. An agent, **Kin**, reads all of it
alongside him and helps turn it into finished pieces, without writing them
for him.

Kintsugi is the Japanese art of mending broken pottery with gold. Here the pieces are fragments of inspiration, and the gold is what connects them. <!-- copy-lint-allow: the owner keeps the name's origin -->

This document holds the product's shape and direction, as decided with the owner on
2026-11-01. Contracts for built parts live beside it (`docs/writing.md`, `docs/inspiration.md`,
`docs/ingest.md`, `docs/feed.md`, `docs/ranking.md`).
Where they disagree, the contract describes what exists and this document
describes where it's going. Tickets on the board carry the build plan.

## Who it's for

Hussain, first and only. Kintsugi is single-player and local-first: the
vault is a folder of plain files on his Mac, the phone reaches the Mac over
Tailscale, and there's no cloud and no account. AI is bring-your-own-key. It's
free and open source so anyone who likes it can run their own copy, but
nothing is built for multi-user use, hosting or onboarding at scale.

## The life of a piece

Every piece of writing goes through the same five stages. Most sparks happen
outside Kintsugi, on a walk or in another app.

| Stage | What happens | Where |
| --- | --- | --- |
| **Spark** | Something catches his attention: a thought, a post, a conversation | Anywhere. The phone's capture box and share sheet, the Feed, the Mac |
| **I want to write about this** | A spark becomes an idea, his or Kin's, or he just starts writing | Ideas, or a new draft |
| **Research and test it** | What he already has on it comes back, and Kin argues with it | The draft and its margin |
| **Write and revise** | He writes. Kin reads and questions, and edits only when asked | The draft |
| **Publish or keep** | It goes to the blog, or he marks it complete and keeps it | Publish, or the status |

Two things get in the way, and Kintsugi's job is to remove both:

- **A. Collecting.** Getting sparks, sources and his own thoughts in, from
  inside Kintsugi and outside it, with as little effort as possible.
- **B. Recall.** Getting them back while he writes, without going to look
  for them. This is the harder problem and the one that matters most. A
  library he has to visit and search only half solves it.

Nothing is carried by hand between stages. He doesn't attach sources to an
idea or file a clip under a draft; what he collected comes back beside the
draft when it fits what he's writing (see Writing › Recall).

## The shape

Kintsugi has four places, and Kin is in all of them:

| Place | What it is | Who fills it |
| --- | --- | --- |
| **Feed** | A personal compilation, new and old, from followed sources and close neighbours | Automatic |
| **Inspiration** | A small, curated library of what's worth keeping | **Hussain only** |
| **Ideas** | Bite-sized sparks: his own, and a few of Kin's each day | **Hussain** and Kin |
| **Writing** | Notes, drafts and posts, on the Mac and the phone | **Hussain only** |

**Kin** is on every screen: one avatar, one chat that
picks up whatever he's looking at, and comment threads in his drafts.

```
 sources ─▶ Feed ──save──▶ Inspiration ─┐
             ▲                          ├─▶ Kin ──▶ Ideas ──start writing──▶ Writing ──▶ publish or keep
             └── ranking ◀── signals ◀──┴── Writing ◀───────────────────────────┘

 Feed, Inspiration, Ideas, notes, earlier writing ──recall──▶ the draft's margin
```

The bottom row is problem B: everything he has collected or written can
come back beside the draft he's working on, without a trip to its page.

Writing matters most. When features compete, the one that makes writing and
publishing a piece easier or more pleasant wins.

## Feed

The Feed is a personal compilation, new and old. It fills itself from sources
Hussain follows, their older writing, and a few closely related pieces.
Nothing in it is saved unless he saves it.

- **Sources:** RSS/Atom first. One adapter covers blogs, YouTube channels,
  podcasts and Hacker News (via hnrss.org). Then X accounts (via the
  FxTwitter API, best-effort, with fallbacks), "follow this page" change
  detection for sites without feeds, and new books from favourite authors.
  Reddit can't be followed (its RSS and public API are closing), so Reddit
  posts are single captures only.
- **Order:** new posts alongside older writing chosen by his taste, with a
  small **Picked for you** section. Older writing keeps its original date.
  At most two older pieces enter a day, including at most one from an
  unfollowed source. Each source's older writing can be switched off.
- **Actions:** ♥ like (a signal; it shows what it changed, with undo),
  📝 note (a strong signal; travels with the item if saved), ⤓ save (copies
  it into Inspiration, the only way anything gets there), and **Not
  interested** (the strongest negative). Ignored items are a weak negative
  and drop out after 30 days. Items he liked or noted stay
  searchable after they leave the Feed, so recall can still bring them
  back.
- **Discuss** on any item opens Kin with that item in context.
- Feed items and the subscription list live in the app's own data, not the
  vault. Subscriptions import and export as OPML. Each source shows its
  health (last fetch, errors) and can be muted.

### Ranking without burning tokens

Ranking uses local machine learning instead of LLM calls. It borrows the ideas
from X's and TikTok's published recommenders that still work for one person:

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

Hussain curates Inspiration by hand. Kin learns from it and never adds
to it. He adds things by saving from the Feed, the phone's
share sheet, the Mac, a pasted link or a dropped file.

- A clip is a plain Markdown file (see `docs/inspiration.md`): what was
  saved, readable source text for Kin, and his own words.
- The direction is **bite-sized**: a tweet-sized card, with his thoughts as
  a thread of short dated notes rather than one long note, and the summary
  and full source one tap away. The owner designs the exact shape in Paper
  before the file format changes.
- Each clip shows where it's been referenced in his writing.
- Inspiration stays a page of its own, where he sees what he has kept. Its
  second job matters more: everything in it can come back beside a draft
  through recall, without him opening the page. His note on a clip is
  optional, and when he writes one, it's what recall matches first.
- Anything machine-made on a card (summary, transcript excerpt) is labelled.
  Quotes are verbatim and link back to the passage or
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
way he does, and helps him. It never writes his prose. It has no "Muse"-style
persona. It's called Kin ("your Kin"), and he
customizes its look (designed in Paper).

### Who Kin is

Paul Graham ends his essays by thanking the people who read drafts and
suggested ideas. Kin is meant to be those people for Hussain: friends who
respect his mind and his work, read what he's working on, bring ideas and
sources, ask the hard question, and leave the writing to him. A
collaborator and a light editor.

This describes who Kin is, not a feature. Posts carry no thanks to Kin.

A test for any Kin feature: would a friend like that do it?

What Kin does at each stage of a piece:

| Stage | Kin |
| --- | --- |
| Spark | Notices. Offers a few sparks a day from his writing and saves |
| I want to write about this | Stays out of the way. The idea is his line, with nothing attached |
| Research and test it | Gathers what he already has when asked, his own writing first. Asks what a sharp reader would ask, and finds who disagrees |
| Write and revise | Reads. Comments and questions; writing suggestions only when he turns them on, into the stash; edits only when asked |
| Publish or keep | Checks links and quotes. Moves nothing by itself |

### Present everywhere

- One avatar on every screen opens one chat. Whatever he's looking at (a
  feed item, a clip, a paragraph mid-draft) is attached as a removable
  context chip.
- In the editor, `@Kin` starts a conversation inline. Kin replies the way a
  reviewer does: **comment threads** anchored to a paragraph, stored outside
  the document and moving with the paragraph as it's edited. Anything it
  finds can be dragged in as a reference.

### How it finds things

Kin doesn't keep a wiki or a growing private knowledge base. Instead it
searches the vault, Inspiration and the Feed with
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
what it already has. Changes apply automatically. **About you** shows the
current memory, where each line came from, a change log, and undo. Any chat
can be marked "don't remember this."

**Skills** are one system with two uses. Kin writes procedures for itself
("how to make ideas for Hussain", "how to rank his feed"), and skills
flagged for the editor appear as AI commands in the `/` menu. Hussain can
write his own ("/steelman this", "/find counterexamples"), and Kin suggests
new ones when it notices him asking for the same thing repeatedly.

### One conversation log per vault

This follows how always-on agents like Grok Bot are built.

- **One log per vault.** Each vault keeps its own, in `.kintsugi/kin/`,
  and opening another vault opens its conversation. What each turn is about
  (a draft, a clip, a feed item, a paragraph) is inferred from what's on
  screen and what's said. Hussain never tags or files anything. A "thread",
  such as "the conversation about draft X", is that inferred grouping: a
  view of the vault's log with its own running summary. It isn't a separate session. Paragraph comment threads
  live in the same log.
- **A lean main conversation, with helpers.** Heavy or background work
  (ranking the feed, generating ideas, long searches) runs as helper agents
  with their own context, recorded in a local job table so they survive
  quitting the app. Each gets a clear brief plus About you and the notes
  file, and reports back to the log without interrupting him.
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
  provider, fetches of the sources he follows or saves, and downloads of
  optional tools he agrees to. Search's model ships with the app. Nothing is
  used for training.
- Kin reads critically and doesn't flatter.

## Ideas

An idea is a bite-sized spark: one line that gets his mind going. It
condenses things he has read and written into something short, and adding
detail to it works against that. His own ideas sit beside Kin's.

- **His ideas** are typed with **New idea**, on the Mac or the phone. A
  title and at most a line, nothing attached: no sources, no questions.
  They're his words, so they're kept in the vault, work offline on the
  phone, and never fade.
- **An idea isn't a status.** A document has no `status: idea`. **Start
  writing** makes a draft that lists the idea in its frontmatter, or adds
  the idea to a draft he picks, and the idea shows the drafts it's in. One
  idea can start several pieces, and one piece can grow from several ideas.
  He can also just start writing; most pieces never need an idea first.
- Ideas, his and Kin's, are in the search index, so recall can bring one
  back beside a draft it fits.

**Kin's ideas** are a small daily batch (up to about five), plus ideas on
demand. Each one is specific and grounded in his own writing and
collection: "You've saved seven things about tools that shape thinking and
never written about it", "Two clips this month disagree about X", "This
draft argues the opposite of what you published in March."

- **Progressive disclosure.** Most ideas will be ignored, so the list shows
  a title and at most a one-line snippet. Detail appears only when he
  engages: Kin's hunch and a few observed takeaways, each citing its quoted
  clip inline (`[1]`) rather than justifying itself at length.
- **Actions:** Start writing (today's Adopt: a new draft titled after the
  idea with an empty body, the idea in the draft's metadata, never in the
  prose; or added to a draft he's started), Discuss with Kin, Refine,
  Dismiss (a signal). Unused ideas of Kin's fade after about a week.
- Inside a draft, "ideas for this draft" opens Ideas filtered to that
  document. Kin's suggestions for a draft go to its stash (KI-89).

## Writing

Writing works fully on both the Mac and the phone.

- **The editor:** focused Markdown/MDX, with a Notion-style `/` menu for
  blocks and AI commands (skills), and `@` to reference clips, documents
  and Kin. `@` opens the same picker as `[[` and writes the same `[[link]]`
  to disk. The picker ranks by what he's writing, not by name (see
  Recall). ⌘K's AI edits on a selection
  stay, alongside non-prose actions like "find supporting clips", "who
  disagrees?" and "Discuss this paragraph".
- **One margin.** The draft column keeps a fixed measure. One margin on
  the right holds three tabs, Kin, References and Stash, and opening it
  never re-wraps a line (KI-103).
- **Organizing:** drafts can be tagged and organized (folders on disk, tags
  in frontmatter), and filtered on both devices.
- **Two endings.** A finished piece is published, or he marks it complete
  and keeps it. Neither moves the file. How document status works overall
  (draft, complete, published) needs its own revisit.

### Recall

What he has collected and written comes back to him while he writes,
without him going to look. The References tab does this, in order of how
much it asks of him:

- **Along this paragraph**, always on. When he pauses, the paragraph he's
  in is searched against everything: his posts and notes first, then his
  ideas, clips, and Feed items he liked, noted or saved. It's the local
  search index (see `docs/search.md`), so it costs no model calls. It shows
  a few items, each with the sentence that matched, and nothing when
  nothing clears the bar. What he has already linked, or set aside for this
  draft, doesn't come back.
- **`[[` and `@`** use the same ranking: before he types a letter, the
  picker offers what fits the paragraph.
- **Gather**, when he asks. Kin reads the section and lays out what he has
  on it: what he's said before, what supports it, what argues against it,
  each with a quote checked against its source. One Kin turn, under the
  monthly cap.

What he inserts and what he waves away teach the ranking, the way Feed
signals do.

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
  lands in `inbox/`). A note is a document; there's no separate type.
- **One editor.** The Mac's CodeMirror editor runs on the phone through
  Expo's web components, so `/`, `@` and Kin's comment threads behave the
  same on both devices. Native keyboard, selection and toolbar feel get
  proven in a spike first.
- Feed, Inspiration, Ideas and Kin are all on the phone too. A thought
  typed on the phone is a note in `inbox/` or a new idea, and recall finds
  either one later on the Mac.

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
extra and a low priority. The goal is an internal agent good enough that he'd
rather use it. Outside agents never add to Inspiration.

## Vault layout

```
~/Documents/Kintsugi/
  inbox/            quick notes from the phone
  inspiration/      clips and their media (human-curated); sources/ keeps
                    long clips' whole text for Kin
  .kintsugi/
    agent/          Kin's memory: USER.md, NOTES.md, skills/
    comments/       Kin's comment threads on documents (KI-38; see docs/kin.md)
    kin/            Kin's conversation in this vault: the log and thread summaries
    folders.json    each folder's colour and icon (KI-75), by folder path
  …                 drafts, notes and posts, in folders, anywhere else
```

The Feed, subscriptions, ranking data and job table live in the app's data
directory, not the vault.

## Principles

- **Writing comes first.** Every feature serves turning inspiration into
  finished pieces.
- **Nothing is carried by hand.** What he collects comes back to him while
  he writes. He never has to file it, attach it or go looking for it.
- **Kin helps; it doesn't ghostwrite.** It finds, connects, questions and
  suggests. Prose is Hussain's, apart from edits he explicitly asks for.
- **Hussain curates.** Only Hussain puts things in Inspiration and
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
  apps. Kintsugi's value is in connecting them.

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
