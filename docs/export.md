# Export

MDX is the source format; each destination is an exporter (`docs/vision.md`,
Export). v1 has four: publishing to hussain.ph (`docs/publishing.md`) and,
from KI-44, **PDF**, **LinkedIn-ready text** and **HTML**. No social media
APIs: a file is saved where Hussain chooses, or text goes on the clipboard,
and he posts it himself.

## Using it

- **Export…** in the editor footer opens a menu of the destinations chosen in
  Settings → Export. **⌥⌘E** opens the Export dialog on the last one used.
  Picking **hussain.ph** opens Publish (⇧⌘P), which is unchanged.
- The dialog has a segment per destination, the two provenance switches,
  the checks, a real preview, and one button: **Save PDF…**, **Copy text**
  or **Save HTML…**. Pending saves are flushed first.
- Any document can be exported, drafts and blog mirrors included (a mirror
  just can't be published again). Nothing is written into the vault.

| Destination | Delivered as | Preview |
| --- | --- | --- |
| PDF | a `.pdf` where the save panel chooses | the typeset pages (SVG of the first six) |
| LinkedIn text | the clipboard | the post text, with LinkedIn's "…see more" fold at ~210 characters and a count against its 3,000 limit |
| HTML | one `.html` where the save panel chooses | the file itself, in a sandboxed frame (no scripts, no network) |

## Settings → Export

Stored as `export.json` in the app's config folder, beside `blog.json`, so
scratch configs (headless, isolated runs) never touch the owner's settings.

- **In the Export menu:** a switch per destination, all on by default.
  Stored as a list of ids; an id the app doesn't know yet is kept, so a
  destination added later needs no migration.
- **Sources appendix by default** (moved here from Settings → Blog; an
  existing `blog.json` `appendix` is still honoured until this is set).
- **Add a "written by a human" statement:** off by default, with editable
  wording (600 characters at most; empty or **Reset** returns to the
  default). The default is
  *"Written by a human. I use AI to find sources and to question my drafts,
  not to write the words."* Settings says plainly that Kintsugi can't verify
  it: text accepted from ⌘K is the AI's. Both switches are defaults; the
  Export and Publish dialogs override them per piece.

## The exporter model

```
document (MDX + frontmatter)
   │  preparePiece   packages/core/src/export.ts   (shares publish.ts's resolveLinks,
   ▼                                                 protectedSpans, appendix, statement)
 Piece  ── plain data: title, date, tags, url, blocks, appendix, statement, assets, checks
   │  destination.render(piece, context)
   ├─▶ PDF       export-typst.ts → Typst source ──▶ backend typesets → .pdf
   ├─▶ LinkedIn  export-text.ts  → text ──────────▶ clipboard
   └─▶ HTML      export-html.ts  → one file ──────▶ backend writes .html
```

**The Piece is read once for every destination.** `preparePiece` takes the
document's text and does what Publish does, minus the blog's specifics:

- the title is `title:` or a leading `# Heading` (which isn't repeated);
- `[[links]]` resolve exactly as in Publish (`resolveLinks`, documents before
  clips), but to absolute URLs: a published post or mirror links to
  `https://hussain.ph/…`, a clip to its source, and anything unpublished
  becomes its words, with a warning naming it;
- images (`![](path)`, `![[file.png]]`) are found in the vault by the backend
  (`export_images`, the same resolver Publish uses) and become *assets*
  (`asset:image-1.png` in the blocks). A missing image is a warning, not an
  error: exporting a draft shouldn't stop on it;
- HTML comments, MDX `import`/`export` lines and components, `%%comments%%`
  go; `==highlights==` keep their words. Each MDX component left out is a
  warning (it only renders on the blog);
- the body is read into blocks by `markdown.ts`, a small destination-neutral
  tree over `@lezer/markdown` (the editor's parser, CommonMark + GFM):
  paragraphs, headings, quotes, `[!NOTE]`-style callouts, lists and tasks,
  code with `title="…"`, rules, figures (an image alone in its paragraph,
  its title the caption), tables. Destinations never re-read Markdown;
- provenance is attached as data: the sources appendix (`SourceItem`s, from
  the clips referenced, in order) and the statement.

**A destination** is `{ id, label, hint, delivery, render }`
(`DESTINATIONS` in `export.ts`). `delivery` says how the result leaves:

- `file` with a `format`: `text` is written as it is (`export_write`),
  `typst` is typeset into a PDF (`export_pdf`); plus the extension for the
  save panel;
- `clipboard`;
- `publish`: the blog's own flow, which plans files in a repository.

**Adding one later.** A built-in destination is one entry and one render
function. One that lives outside the app (Kin plugging into something like
MCP, since every place he posts works differently) is the seam this leaves:
a new `delivery` kind that hands the `Piece` (plain JSON by design) to a
tool and reports what it did. Settings already stores destination ids as an
open list. Not built yet.

## Destinations

### PDF

Typeset in-process by [Typst](https://typst.app) 0.15 (`typst`,
`typst-pdf`, `typst-svg`, `typst-assets` in the desktop crate;
`src/export/pdf.rs`). The frontend renders the piece to Typst source; the
backend compiles it in a **closed world**: that one file plus the piece's
images read from the vault, with Typst's bundled fonts (Libertinus Serif for
text, DejaVu Sans Mono for code). No packages, no system fonts, no other
files, so a piece typesets the same in the app and in headless runs.

- A4, justified and hyphenated, Libertinus Serif at 11.5 pt; title, date and
  (if published) its address; headings, numbered figures ("Fig. 1") scaled to
  the measure, callouts, highlighted code, tables, gold links that stay live
  PDF links, page numbers, the sources appendix and the statement after a
  rule.
- Every word the writer typed enters Typst as a string literal (`#"…"`),
  never as markup, so nothing in a document can be read as Typst code.
  Quotes become typographic (“ ” ’).
- Images from other sites aren't fetched; their description is shown
  instead, with a warning.

**Why Typst, with evidence (2026-11).**

| Option | Result |
| --- | --- |
| WebKit print-to-PDF of the app's webview (Tauri `print()`, or `WKWebView.printOperation` to a file through objc2) | Best fidelity to the HTML export, no new dependency. But it needs a native window, so it can't run in headless mode (MockRuntime has no webview) and couldn't be tested at all under AGENTS.md; `print()` also shows the system print panel. Rejected. |
| A JS PDF library in the webview (pdfmake/jsPDF) | Headless-friendly, but greedy line breaking, no hyphenation, and fonts shipped to the webview. Weaker typesetting than the bar "typeset nicely". |
| **Typst in the backend** (chosen) | Pure Rust, works identically on MockRuntime, Knuth–Plass line breaking with hyphenation, ligatures, real PDF links and metadata, tagged PDF, SVG pages for the preview from the same layout. Spike (`.headless/typst-spike`, not committed): a clean build of the Typst crates took 7 m 13 s at `-j 1`; it adds ~170 crates to `Cargo.lock` and ~10 MB of bundled fonts; an essay with a figure typesets in ~2–4 s in a debug build (much faster in release). Rendered pages were checked by eye (`sips` → PNG). |

### LinkedIn-ready text

`export-text.ts`. No Markdown syntax survives: emphasis keeps its words,
links are spelled out as `words (https://…)` (or the bare URL when the words
are the URL) because LinkedIn only links bare URLs, headings are their own
paragraph, lists use `•`/`◦` and `1.`, tasks `☐`/`☑`, quotes are wrapped in
“ ”, callouts start `Note:`/`Tip:`, tables become `a · b` rows, code is kept
as typed, figures leave their caption in brackets. The title is the first
line; paragraphs are separated by a blank line. Checks warn past LinkedIn's
3,000 characters and note images to attach by hand.

### HTML

`export-html.ts`. One file: a reading layout like the blog's (a serif
measure, numbered figures, callouts, code labels), light and dark, a print
stylesheet, a `description` meta and `generator: Kintsugi`. Images are
embedded as data URLs (`export_assets`, up to 25 MB each); there is no
script, and only `http(s):`, `mailto:` and `#` links are kept (a
`javascript:` link keeps its words). An image from another site still loads
from there, with a warning.

## Backend commands

| Command | Does |
| --- | --- |
| `export_settings`, `export_configure` | Settings → Export (`export.json`) |
| `export_images` | image refs → vault paths (Publish's resolver) |
| `export_assets` | assets → data URLs (vault images only, size-capped) |
| `export_pdf` | Typst source + assets → SVG preview pages, or a PDF written to `path` |
| `export_write` | writes HTML/text to `path` |

Writes go only to an absolute path with the destination's extension, as the
save panel returned it, atomically. **Headless runs only write inside the
run's scratch vault or config folder** (`headless::scratch_file`, as OPML
export does); the save panel is the in-page path prompt there.

## Testing

- `packages/core/src/export.test.ts`: the piece (links, images, MDX,
  comments, published date and URL), provenance shared with Publish, and each
  renderer (no Markdown in the LinkedIn text, HTML escaping and no
  `javascript:` links, Typst string literals).
- `export::` tests in the desktop crate: settings, file targets, assets, and
  `export::pdf` typesetting a piece with an image into a PDF and SVG in a
  closed world (no disk files, no packages).
- `apps/desktop/test/runtime-export.test.ts` (`pnpm --filter
  @kintsugi/desktop test:runtime`): Settings → Export, the menu, and a PDF,
  the clipboard text and an HTML file exported through the real app into the
  run's scratch config. Set `KINTSUGI_SHOTS=<dir>` for screenshots.

## Not doing (yet)

- Posting anywhere, or any social API.
- Destinations added by Kin (the seam is above).
- Page size, fonts or themes as settings (A4 and Libertinus for now).
- Fetching remote images into a PDF.
- Exporting from the phone.
