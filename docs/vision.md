# Vision

Kintsugi is where scattered inspiration becomes writing.

Everything Hussain reads, watches and hears (books, articles, tweets, Hacker
News threads, blogs, podcasts, videos) ends up in one place. An agent reads
all of it alongside him, connects it, and helps turn it into finished pieces.
Kintsugi is the Japanese art of mending broken pottery with gold. Here the
broken pieces are fragments of inspiration, and the gold is the connections
between them.

This document holds the product's shape and direction. Contracts for parts that are
already built live beside it (`docs/inspiration.md`). Where they disagree,
the contract describes what exists and this document describes where it's
going.

## Who it's for

Hussain, first and only. It's single-player and local-first: the vault is a
folder of plain files on his Mac, the phone reaches it over Tailscale, and
there's no cloud and no account. The AI is bring-your-own-key. Kintsugi is
free and open source so that anyone who likes it can run their own copy, but
nothing is built for multi-user use, hosting or onboarding at scale.

## The loop

```
  Feed ──save──▶ Inspiration ──ingest──▶ Wiki ──ideas──▶ Writing ──export──▶ the world
   ▲                 ▲                    │                 │
   └──── ranking ────┴──── signals ◀──────┴─────────────────┘
```

1. **Feed (discover).** New work from sources Hussain chooses (RSS feeds of
   favourite blogs, Hacker News, podcasts, YouTube channels, new books by
   favourite authors) arrives in one feed, ranked by what he cares about.
   Anything worth keeping is one tap away from Inspiration.
2. **Inspiration (collect).** Anything worth keeping is captured: from the
   feed, the phone's share sheet, the Mac, a pasted link or a screenshot.
   Each capture becomes a clip, a plain Markdown file with readable source
   text, so humans can browse it and agents can read it.
3. **Wiki (understand).** An agent reads every clip and every piece
   Hussain writes, and maintains a wiki of what it has learned: people,
   ideas, recurring themes, how sources relate, where they disagree. This is
   the part that improves passively: every capture, question and published
   post makes it richer.
4. **Writing (create).** The point of all of it. A focused MDX editor
   where Hussain's own words stay at the center, with his inspiration and an
   AI muse within reach. Finished pieces export anywhere: the blog, a PDF, a
   LinkedIn post, whatever destination he sets up.

Writing matters most. When features compete, the one that makes writing and
publishing a piece easier or more pleasant wins.

## Two readers, one vault

The core idea, borrowed from Andrej Karpathy's
[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
pattern: Hussain isn't the only one taking all this in. A universal
agent reads everything he collects and writes, the same way he does, and
builds up its own understanding in files he can read.

Most AI-over-documents tools (RAG) rediscover knowledge from scratch on every
question. Nothing accumulates. In Kintsugi, the agent *compiles* what it reads
into a persistent wiki: a source is integrated once, its connections and
contradictions are recorded, and the synthesis is kept current as new sources
arrive. The wiki is a compounding artifact. LLMs make this viable because the
tedious part of a wiki, the bookkeeping, costs them nearly nothing.

Ownership is strict, and it's how "the AI never writes for you" holds up in
practice:

| Layer | What | Who writes it | Who reads it |
| --- | --- | --- | --- |
| Inspiration | Clips: captured sources, Hussain's notes on them | Hussain (enrichment adds metadata and source text, never touching his words) | Both |
| Writing | Drafts, notes, published posts | **Hussain only** | Both |
| Wiki | Topic, person and idea pages, syntheses, index, log | **The agent only** | Both |
| Schema | Who Hussain is, what he cares about, how the wiki is run | Both, in the open | The agent |

Hussain's own writing is a raw source like clips are, and the most
important one. What he chooses to write about is the strongest signal of
what matters to him.

### Agent operations

- **Ingest.** When a clip is captured or a piece is written or published, the
  agent reads it and integrates it: it updates the relevant wiki pages,
  creates new ones, adds cross-references, flags contradictions with earlier
  sources, updates the index and appends to the log. One source may touch
  many pages. This grows out of today's enrichment worker, which already
  reads every clip and makes one AI call to title, summarize and tag it.
- **Query (Discuss).** Hussain asks questions, from the feed, a clip, the
  wiki or the margin. The agent answers from the wiki with citations. A good
  answer can be saved back as a wiki page, so exploration compounds too.
- **Lint.** On a schedule, the agent health-checks the wiki: contradictions,
  stale claims superseded by newer sources, orphan pages, concepts that
  deserve a page, gaps worth a search. Lint findings are a good source of
  ideas.
- **Ideas.** See [The muse](#the-muse).

### Learning

"Self-improving" means concrete signals feeding concrete outputs:

- **Signals:** what gets captured, highlighted and annotated; tag edits; feed
  saves and skips; ideas acted on or dismissed; what gets linked or quoted
  in writing; what gets published.
- **Outputs:** feed ranking, which wiki pages grow, which ideas appear, what
  the margin surfaces while writing, and updates to the schema's picture of
  Hussain's interests and voice.

The agent never changes its picture of Hussain silently. Schema changes are
proposed and logged where he can see, edit or revert them.

## The muse

The muse gives ideas. It doesn't draft. Meta's Muse app is a good
reference: a list of specific, grounded offers ("I can…"), each with a short
explanation, some saying outright what it won't do. It also has a
feed whose steering prompt sits at the top in plain view ("Feed for Hussain.
Tone: clear and direct…").

Kintsugi's ideas are about writing and thinking, drawn from the wiki and
the vault. For example:

- "You've saved seven things about tools that shape thinking and never
  written about it. Here's an angle nobody in those sources takes."
- "Two clips this month disagree about X. Want a page laying out both sides?"
- "This draft argues the opposite of what you published in March."
- "Three posts in your feed today extend an idea in your draft on Y."

Ideas are specific, cite their sources, and can be dismissed (dismissing is a
signal). They appear as a list of their own and, while writing, in the
margin. The muse can critique, question, find sources and point out
connections. The words are Hussain's.

## Surfaces

- **Feed.** Sources Hussain subscribes to, ranked against the schema and the
  wiki. Cards are rich: images, the key fact, a one-line "why this is here."
  Save (the heart) creates a clip. Discuss opens a question to the agent.
  Feed items live in app data, not the vault, until they're saved.
- **Inspiration.** The library of clips: an image-forward grid, search and
  tags (built on the Mac).
- **Wiki.** A readable, linked view of the agent's pages, clearly marked as
  the agent's, with the log as "what I learned recently."
- **Ideas.** The muse's list.
- **Writing.** The editor, `[[links]]` to clips, documents and wiki pages, and
  the margin.
- **Export.** Destinations configured once and used in one click: the blog
  (hussain.ph, Astro + MDX), PDF, LinkedIn and others. MDX is the
  source format; each destination is an exporter.

### The phone

The phone carries the parts that suit a phone: capturing (share sheet,
paste), the feed, browsing inspiration and the wiki, ideas, and Discuss.
Long-form writing happens mostly on the Mac. The Mac is the server; the phone
reaches it over Tailscale and queues captures while it's away.

## Vault layout (direction)

```
~/Documents/Kintsugi/
  KINTSUGI.md      the schema: Hussain's interests and voice, wiki conventions
  inbox/           quick thoughts captured from the phone
  inspiration/     clips and their media
  wiki/            the agent's pages, plus index.md and log.md
  …                Hussain's drafts, notes and posts, anywhere else
```

Everything stays plain Markdown with Obsidian-compatible links, so the vault
opens in Obsidian and any coding agent can read it. Wiki pages cite their
sources with `[[links]]`, so backlinks show which clips and documents
fed each page. The writing sidebar skips `wiki/` the way it skips
`inspiration/`.

## The AI harness

Bring-your-own-key, with keys held in Rust and never sent to the webview.
Today's harness sends a prompt and streams text back. The agent needs more:
a tool-using loop with file access scoped to its job (write only in `wiki/`,
read everywhere), model tiers (a cheap model for ingest, a stronger one for
ideas and Discuss), and a spending budget, because one ingest can touch
many pages.

At moderate scale (around a hundred sources and a few hundred pages),
`wiki/index.md` plus lexical search is enough for the agent to find its way.
Embeddings come later, if they're needed.

## Principles

- **Writing comes first.** Every feature serves turning inspiration into
  finished pieces.
- **The AI never writes for you.** It writes the wiki and offers ideas. It
  never writes Hussain's prose.
- **Plain files, local first.** One folder on disk is the source of truth.
  No cloud, no lock-in.
- **Capture is instant and never lost.** Save first, enrich later.
- **No organizing chores.** The agent does the filing, linking and
  bookkeeping.
- **Learning is visible.** What the agent learned, and what it believes about
  Hussain, is readable and editable.

## Not doing

- Multi-user use, collaboration, cloud hosting or sync services.
- AI drafting, ghostwriting or "continue writing."
- Competing with dedicated readers, feed apps or note apps feature by feature.
  The value is the loop between them.

## Open questions

To be worked through one at a time:

- Feed: which source types come first, and how ranking works.
- Ingest: fully automatic, or reviewable? What does a "what I learned today"
  view look like?
- The wiki's page types and conventions, and what goes in `KINTSUGI.md`.
  Should it be an `AGENTS.md` so outside agents like Claude Code can maintain
  the wiki too?
- The agent loop: its tools, permissions, model tiers and budget.
- Ideas: when they're generated, how many, and how dismissals feed back.
- Export: the exporter model and the first destinations beyond the blog.
- Naming: what the agent, the wiki and the surfaces are called in the app.

## Where things stand

Built: the vault, document editing with drafts and status, phone access over
Tailscale, capture from the iOS share sheet, the phone and the Mac, clip
enrichment, the Inspiration library on the Mac, `[[links]]` with backlinks
and the margin, AI edits on a selection (⌘K), and bring-your-own-key provider
access.

Next, roughly in order: the agent harness, ingest into the wiki, the wiki
view, ideas, the feed, lint, and export (starting with the blog).

## References

- Andrej Karpathy, [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
  the raw sources / wiki / schema pattern and the ingest, query and lint
  operations.
- Meta's Muse: ideas as specific, grounded offers, and a feed with a visible
  steering prompt.
- For individual surfaces: Readwise Reader and myMind (capture and library),
  Feedly and Reeder (feeds), Obsidian (plain linked files), iA Writer
  (focused writing), Typefully (publishing to social).
