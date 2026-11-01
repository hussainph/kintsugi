# KI-21 · Clip shape, judged against real ingestions

**Question (owner):** does the bite-sized form still carry the nuance he cares about?

**Short answer: mostly yes.** The nuance he cares about turned out to live in two
places: *which passage he kept* and *what he thought about it, over time*. Both
fit a tweet-sized card with a thread of dated notes. What the card can't carry
is **structure** (a paper's argument, a thread's who-replied-to-whom) and
**attribution** (which commenter said it). Those have to come from the source,
one tap away. Today's extraction keeps them for Reddit and X, and loses them
for HN and PDFs. So A→B holds, on three conditions:

1. **The card's quote is his passage, not a machine excerpt.** Every type
   needed a deliberate passage. The summary is too generic to stand in for it
   (the podcast's summary describes an ad; his passage is the one useful minute).
2. **"More" opens the source at the passage,** not at the top. A transcript's
   first minutes ("(majestic music)", podcast banter) are noise.
3. **Quotes keep their speaker and their place:** a timestamp, a text
   fragment, a comment author. Without the speaker, a Reddit reply reads as
   the original poster's words.

Open it with `pnpm lab` → Experiments → *Clip shape — bite-sized against real
ingestions*. There are four stories (A→B is the default), set to desktop or
phone width in the scenario bar. Variants: *annotated* (what each capture kept
and lost, beside the card), *opened*, *transcript* and *HN*.

## The shapes

| | What it is | Holds up for | Breaks for |
| --- | --- | --- | --- |
| **A** card + note thread | Byline, title, his passage (with its deep link), media where the media is the content; dated notes as replies underneath with "Add a note…" | Article, X, YouTube, podcast, image, note: the passage plus the thread *is* the clip | Paper and HN: a slogan without the argument or the speaker |
| **B** card that expands | Today's single note field on the card; "Summary and source" opens the machine summary, more passages and the source | Papers: the summary and a scrollable source help | Notes lose their dates and order: "PG stops at clarity" was written two days later, after the McEnerney talk, and B can't show that |
| **C** long page | Wiki-ish: title, machine summary, passages, his words, the whole source, an infobox | Reading a paper or a transcript properly | As a default it buries his words under 20,000 characters; it's a reader, not a card |
| **A→B** | A, with "More" opening B's depth inside the card; the thread stays outside | Every type, given the conditions above | Image and note clips have nothing behind them, so "More" is hidden for them |

## Trade-offs per content type

All nine are real captures run through the ingest pipelines on `main`, written
into a scratch vault under `.headless/ki21/vault` by the vault crate, then
copied unchanged into `fixtures/inspiration/`.

| Type | Source | Pipeline | Bite-sized keeps | Bite-sized loses / what B must supply |
| --- | --- | --- | --- | --- |
| Article | Paul Graham, *Putting Ideas into Words* | web · Readability, 6,623 chars | The thesis fits in one sentence. Text-fragment links (`#:~:text=`) land on the exact passage | The "neutral stranger" argument is the nuance; it's passage two. Footnotes come out mangled, the title GIF sits in the first line, and the page names no author |
| X post | Karpathy, *LLM Knowledge Bases* (one long post) | x · FxTwitter, 3,446 chars, complete | A natural fit: one claim per card, linked to the post. His disagreement ("exactly what Kin is not") lives in the thread, not the source | Little. A 3,400-character post is really an essay, but the source is whole, one tap away |
| YouTube | McEnerney, *The Craft of Writing Effectively* (81:51) | youtube · yt-dlp manual subtitles + chapters, 80,100 chars | "If it's clear and useless, it's useless." with *Watch from 14:48*: the best case for bite-sized | **Storage, not shape:** the clip keeps 20,000 characters, which is 18:56 of 81:51, cut mid-sentence. His note points to minute ~30, which isn't on disk. B's source shows what was kept, not the talk |
| Podcast | Buzzcast, *Your Podcast Idea Doesn't Have To Be Perfect…* (12:31) | podcast · publisher transcript (Podcasting 2.0 JSON), speakers, timestamps, 18,426 chars | *Listen from 10:17*, and the one paragraph worth keeping from an ad | The summary describes the ad, so his passage matters more than the summary. The clip URL is an OP3/Podtrac tracking redirect (the feed has no episode page), and the kind came out `link` |
| Paper (PDF) | Kleppmann et al., *Local-First Software* (25 pp.) | pdf · PDFKit helper → layout, 19,962 chars | The founding sentence, plus his note on why it matters to Kintsugi | **Worst fit.** The argument is seven ideals; a card shows one. The clip keeps ideals 1–5 (2.6 and 2.7 fall past the cap). The two-column author block interleaves with the abstract, section numbers fold into paragraphs (`\2.1 No Spinners…`), and there's no page number to link a quote to. The title loses a space (`Software:You`). Kind is `link`, not `document`, because it was saved as a link |
| HN thread | Local-first discussion, 190 comments | web · Readability (no HN adapter), 19,595 chars | The quote, linked to the thread | **Who said it and to whom are gone:** each comment is a three-cell table row with a spacer GIF, with no author and no nesting. He had to type "josephg's comment" himself. Needs an HN adapter (Algolia items API) before any shape works |
| Reddit | r/PKMS, *Does it seem… PKM fails as soon as the writing begins?* | reddit · Reddit JSON adapter (listing hand-assembled from the Arctic Shift archive: Reddit 403s this network), 2,254 chars | Post and all visible comments, with authors and the nested reply | **Attribution:** the second passage is u/theLightSlide's, not the poster's. The card now says "— u/theLightSlide, in the comments", derived from the adapter's `**u/name**` headings. Two replies are app plugs, and a machine summary would count them as agreement; his note flags them. Comment permalinks are lost |
| Image | Martin Howard, *Kintsugi art* (CC BY-SA 2.0, Wikimedia), shared without a link | web · direct image | The image *is* the card. A is right | Nothing else: no title (the file is named `image.md`), no text, no source. Kin sees only his notes, and attribution survives only because he typed it into one |
| Note | A thought typed on the phone | none | The whole clip; replies turn it into a conversation with himself | Nothing to lose. A note's "More" is hidden |

### Across types

- **The thread carries nuance a single note flattens.** Dates show a reading
  changing ("PG stops at clarity, Larry goes on to value" was written after a
  different clip). Short replies also invite the kind of note he wrote here:
  "this is an ad, but…", "don't quote those as agreeing", "attribution: …".
- **The 20,000-character source cap is the real nuance loss for long-form**
  (transcripts, papers, threads), and it's invisible on a card. Show what was
  kept ("18:56 of 81:51 kept") and consider storing the full transcript beside
  the clip (ingest allows 250,000 characters).
- **Deep links by type:** timestamps (YouTube, podcasts) and text fragments
  (articles) work today. X links to the post. PDFs need page markers from
  PDFKit (`#page=N`). HN and Reddit need comment permalinks from their
  adapters.
- **Media:** cover art and first pages are recognition, not content: they get
  a 44 px thumbnail. Video stills get 16:9. Images are shown whole. A square
  podcast cover at card width swamped everything else.
- **Kind and naming:** a link to a PDF stays `link`, and an audio URL stays
  `link`. Image-only shares are named `image.md`. Enrichment's kind correction
  needs an AI call, which headless runs skip.

## Note-thread file format (sketch, for KI-40; storage unchanged here)

The own-text section becomes the shared passages, then dated notes, each
introduced by an invisible marker in the same style as the source boundary:

```markdown
---
kind: "video"
title: "LEADERSHIP LAB: The Craft of Writing Effectively"
url: "https://www.youtube.com/watch?v=vtIzMaLkCaM"
captured: "2026-10-28T19:05"
…
---

> If it's clear and useless, it's useless.
> — [14:48](https://www.youtube.com/watch?v=vtIzMaLkCaM&t=888s)

<!-- kintsugi:note 2026-10-28T19:40 -->
14:48. The whole talk in one line.

<!-- kintsugi:note 2026-10-28T19:52 -->
Who is the community for the blog? I keep writing for "readers" in general,
which is his standardized-test reader.

<!-- kintsugi:source -->
## Source
…
```

- A note is any Markdown up to the next marker. The UI nudges toward about 280
  characters but doesn't enforce it. Times are local `YYYY-MM-DDTHH:MM`, like
  `captured`, and notes are kept in time order.
- **Passages** stay blockquotes above the first note. The link line under each
  quote is optional and holds the deep link (timestamp, text fragment, comment
  permalink). An `— u/name` line keeps a speaker who isn't the clip's author.
- **Legacy files** (no note markers) read as one note dated `captured`, so
  nothing needs rewriting. The first edit writes the marker.
- `<!-- kintsugi:note …` is reserved and escaped on capture, like
  `<!-- kintsugi:source -->`.
- In Obsidian, notes read as plain paragraphs (dates hidden). Alternatives
  considered: `### 2026-10-28 19:40` headings (visible, but they collide with
  headings inside notes and clutter the outline), and a `- date — text` list
  (compact, but multi-paragraph notes and quotes break it). Comment markers
  are the robust choice.
- API sketch: `ClipSummary.notes: { at, text }[]`. `clip_note_add({ path, text,
  at })`, `clip_note_edit({ path, at, text })` and `clip_note_delete({ path,
  at })` replace `clip_update({ note })` for own text. The phone API gets a
  version bump.

## How the fixtures were made

- `capture/` holds a standalone Rust harness (not a workspace member) that
  runs the real adapters: `XAdapter`, `RedditAdapter`, `YouTubeAdapter` (yt-dlp
  and Deno downloaded with consent into the scratch dir), `PodcastAdapter`,
  `PdfAdapter` with the PDFKit helper compiled from
  `crates/ingest/swift/pdf.swift`, and `WebAdapter`. It writes clips through
  `kintsugi_vault::clip_create` and `clip_enrich`, the way enrichment does.
  Reddit's `.json` listing (`capture/reddit-1rqzo93.json`) was assembled from
  the Arctic Shift archive, leaving out the two comments moderators removed,
  and served on loopback to the real adapter.

  ```sh
  cd apps/lab/entries/experiment/clip-shape/capture
  mkdir -p ../../../../../../.headless/ki21/bin
  xcrun swiftc -O -parse-as-library ../../../../../../crates/ingest/swift/pdf.swift -o ../../../../../../.headless/ki21/bin/kintsugi-pdf
  CARGO_TARGET_DIR=../../../../../../target/lab-capture cargo run --release -- "$(cd ../../../../../.. && pwd)/.headless/ki21"
  ```

- **Hand-written, not machine-made:** the summaries (headless runs read no AI
  credentials; the cards still label them "machine-made", because in the
  product they would be), tags, the chosen passages (tests check each one
  appears verbatim in the source), and the note threads, written in the
  owner's voice for the study. The owner's real vault was never read.
- Media is downscaled to 480 px. The fixtures hold the extracted text of
  public pages, as the ingest crate's own fixtures do; worth a look before
  this repository goes public.

## Screenshots

Taken headlessly with `capture/shots.mjs` (Playwright, the Lab's own preview
protocol, reduced motion). They're in `shots/`:

- A→B: `ab-desktop`, `ab-phone`, `ab-open-desktop`, `ab-dark-desktop`
- A: `a-phone`. B: `b-phone`, `b-open-phone`. C: `c-youtube-desktop`, `c-youtube-phone`
- With capture notes: `annotated-desktop`
- Per type, A→B opened at phone width: `type-youtube`, `type-paper`,
  `type-hn-thread`, `type-reddit`, `type-screenshot`, `type-note`
