# Writing documents

The contract for writing in the vault: notes, drafts and posts. A document is
a plain `.md` or `.mdx` file anywhere in the vault except `inspiration/`
(clips, see `docs/inspiration.md`) and hidden folders. Folders on disk are
the only hierarchy; the Mac's sidebar and the phone both browse them.

## Frontmatter

All fields are optional. Kintsugi reads a few and leaves every other
property (Obsidian's, the blog's, Kin's `ideas:` metadata) exactly as written.

```markdown
---
title: "What repair costs"
status: draft
tags: [essay, craft]
---
```

| Field | Meaning |
| --- | --- |
| `title` | The name shown in lists. Without it, the file name (the phone uses the first line) |
| `status` | `draft` or `complete`. ⇧⌘D on the Mac, or the toggle on the phone, flips it |
| `tags` | The writer's own tags, for filtering. Never required |
| `captured` | When a note started on the phone, `YYYY-MM-DDTHH:MM` local time |
| `mirror` | Set on read-only mirrors of published posts (`docs/publishing.md`) |

### Tags

Tags follow the clip convention (`docs/inspiration.md`), so writing and
inspiration share one vocabulary:

- **Read** from the first top-level `tags` key: an inline list
  (`tags: [essay, "a, b"]`), an Obsidian block list (`tags:` followed by
  `  - essay` lines, indented or flush left), or a lone scalar (`tags: essay`).
  Quoted items and trailing `# comments` are understood. Anything else
  (nested maps, anchors, block scalars, `tags:` in the body) yields no tags
  rather than a guess.
- **Normalized:** whitespace collapsed, leading `#` dropped, lowercase, at
  most 64 characters, duplicates removed, written order kept. `#Craft` and
  `craft` are one tag.
- **Written** as one inline list, quoted only where YAML needs it
  (`tags: [essay, "reader's life"]`). Adding a tag to a block list rewrites it
  inline; removing the last tag removes the field. Nothing else in the block
  moves.

`crates/vault/src/tags.rs` (`doc_tags`) is the reader for the tree, search
and enrichment's vocabulary; `packages/core/src/tags.ts` mirrors it for the
editor and the phone, and adds the one write, `setTags`.

`vault_tree` (and the phone's `GET /v1/tree`) gives each document entry a
`tags` array beside `title` and `status`; older Macs omit it, and readers
treat it as empty.

## Dimmed text

Dim a passage to read the draft without it and keep it where it was. ⌘/
(or **Dim** in ⌘K) dims the selection; with nothing selected, it dims the
line the cursor is on, list marker or heading marker included. Over several
lines, each line is dimmed on its own. ⌘/ inside or right beside dimmed text
undims it. Each is one undo step.

On disk, dimmed text is a comment, so the file stays plain Markdown/MDX and
other tools hide it too:

- `.md`: `<!-- the passage -->`
- `.mdx`: `{/* the passage */}` (MDX rejects HTML comments)

The editor shows every comment form as dimmed text: those two and Obsidian's
`%%…%%`, whoever wrote them. It hides the markers and fades the text, which
stays selectable and editable. The cursor steps over a hidden marker in one
move, and deleting one marker (⌫ just after it) undims the passage.
Lines in code blocks and the frontmatter aren't dimmed.

Dimmed text doesn't count in the word count, and Publish and Export leave it
out (`docs/publishing.md`, `docs/export.md`). It's in the shared editor
(`packages/editor/src/dim.ts`, with the scanner in `packages/core/src/dim.ts`),
so the phone shows it the same way; the phone has no dim key. A dimmed line
syncs and merges like any other line.

## Organizing

Organizing is optional: nothing asks for a folder, tag or status, and
untagged documents work the same as tagged ones everywhere. Kin may later *suggest* tags,
but it never applies one; only the writer edits `tags`.

**On the Mac**

- The document's tags show in the footer beside its status. **Tag**
  (or **+**) adds one: type a new tag (commas separate several) or pick one in
  use. Each tag's **×** removes it. Mirrors show no tag controls.
- The tag button beside the vault name in the sidebar filters the tree to
  documents carrying every chosen tag; folders without a match hide. The
  chosen tags show as chips under the vault name; click one to remove it.
  The filter resets when another vault opens.
- In the ⌘P jump list, `#tag` keeps only documents with that tag (several
  `#tags` are ANDed) and the other words match titles and paths as before.
  Typing `#` suggests tags in use; each document lists its tags.

- Folders (KI-75): the folder button beside the vault name (or ⇧⌘N) makes
  one in the selected folder. Right-click a document or folder to rename it,
  move it to the Trash, or **Move to** another folder; or drag it onto a
  folder (or the vault name, for the root). Holding a drag over a closed
  folder opens it. Moves offer to update links, as renames do.
- An open folder and its contents sit in one rounded group, and folders nest
  as deep as they go. Which folders are closed is kept per vault. In the
  collapsed sidebar, the folder button expands it again.
- Right-click a folder for **Colour** and **Icon**. They're kept in
  `.kintsugi/folders.json`, so any device on the vault can show them:

  ```json
  { "version": 1, "folders": { "drafts": { "color": "amber", "icon": "pen" } } }
  ```

  Keys are folder paths. Colours: `red`, `amber`, `green`, `sage`, `sand`,
  `lavender`. Icons: `folder`, `inbox`, `pen`, `note`, `book`, `bulb`,
  `star`, `heart`, `quote`, `image`, `code`, `globe`, `music`, `camera`,
  `briefcase`, `archive` (`packages/core/src/folders.ts`, mirrored by
  `crates/vault/src/folders.rs`). A style follows its folder through a rename
  or move and goes with it to the Trash. Fields the app doesn't know are kept,
  and a file that doesn't parse leaves every folder plain.

**On the phone**

- The list opens on the vault's root: its folders (with how many documents
  each holds), then its own documents. Tap a folder to open it; folders nest.
  The phone keeps documents, not folders, so an empty folder doesn't show.
- Chips above the list filter by status (**Drafts**, **Complete**) and by
  tag (every chosen tag must match). Searching or filtering lists every match
  under the current folder, grouped by folder. The filter follows you into a
  folder and back, and resets when the app restarts.
- A link can open a filtered list: `kintsugi://?status=draft&tag=craft`,
  or a folder with `kintsugi://folder?path=essays&tag=craft` (several `tag`s
  are ANDed).
- Each document shows its tags faintly under its title. Tags are edited on
  the Mac (or in the frontmatter); the phone keeps whatever is there.

## The page and the margin

The draft keeps a fixed measure (KI-103). Its line length and left edge depend
only on the window's width and the text size, so opening or closing anything
never re-wraps a line.

- **The column** is centred when the margin fits beside it. Otherwise it moves
  left just enough for the margin to fit, and never closer to the sidebar than
  its own padding (`references/references.css`).
- **The margin** is one 360 px panel on the right with three tabs: Kin,
  References and Stash. It slides in over the empty gutter in 240 ms, with no
  line moving. Under reduced motion it fades instead.
- **Narrow windows.** When the margin wouldn't fit beside the draft with the
  sidebar open (below about 1350 px at the default text size), opening it
  folds the sidebar to icons. Closing it brings the sidebar back. If the
  window is too narrow even then, the margin covers the page's right edge,
  and the text still doesn't re-wrap.
- **Keys.** ⌥⌘\ opens and closes the margin. ⌘J, ⇧⌘R and ⇧⌘S open Kin,
  References and Stash, or close the margin when that tab is already showing.
  Escape inside the margin closes it and puts focus back in the draft.
- **Kin** holds the draft's threads (`docs/kin.md` › Threads). **References** lists what the draft links
  to, what's related to the cursor's paragraph, and what links here.
  **Stash** holds the cursor's versions and the draft's set-aside items.
- **Away from the editor** (Feed, a story, Ideas, Inspiration, Settings) the
  same margin holds Kin alone, over the page. A writing tab waits until he's
  back in the draft.
- Open or closed, and which tab, is kept across documents, screens and
  restarts.
- **Full screen.** The strip kept for the traffic lights (`--ki-titlebar` in
  `theme.css`, set from Tauri's full-screen state by `lib/chrome.ts`) closes
  in macOS full screen. The sidebar header, the margin's tabs and the pages'
  top padding move up with it.

## Stash

The Stash tab holds set-aside prose, notes and Kin's suggestions for the open
draft. Versions of the cursor's span sit above the list. Opening the margin
never re-wraps the draft.

- **Stash selection** at the top of the tab, ⌥⌘X, **Stash** in ⌘K and
  **Stash** in the selection menu move the selection, else the paragraph,
  into the stash. With nothing selected the button reads **Stash
  paragraph**; on a blank line, a read-only draft or with no draft open it's
  disabled. Dragging a selection from the draft onto the Stash tab, or onto
  its header, stashes it too. **Add a note** keeps a note without putting it
  in the draft.
- Stashing, including **Stash** on a Kin reply or a review's rewrite, never
  opens the margin and shows no toast. If the Stash tab is
  showing, the new row lights up briefly. If the margin is closed, the
  margin button's dot pulses once; if another tab is showing, the dot is on
  the Stash tab's header.
- Click or keyboard-focus a row to show its actions below the text. ↑/↓ move
  between rows; Enter inserts, Delete removes, and ⇧⌘J discusses it with Kin.
  ⌥⌘V opens the stash picker. Drag a row into the draft to put it there,
  or reorder the list by dragging or with ⌥↑/⌥↓ on a focused row.
- A rewrite replaces only the words it is anchored to. If they have changed
  or gone, it stays in the stash. Other items insert at the cursor.
  Stashing (by any route) and inserting each take one undo step; undo
  restores the item too.
- Kin's mark distinguishes its items. Rewrites show the original words
  struck above the replacement. **Ask Kin** reads the draft, its stash and
  the vault, and adds up to five items. **Stash** under a Kin reply saves it
  here. Neither changes the draft.
- Kin never adds anything unasked. Only **Ask Kin** and **Stash** on a reply
  add Kin's items. The stash has no suggestions setting or background job.

Stash files are plain Markdown at `.kintsugi/stash/<document path>.md`, with
items separated by `---` and metadata comments for authors and anchors.
They move with document and folder renames. Draft saves, renames and vault
switches wait for pending stash writes, never for Kin's answer. A failed write
can be retried or discarded with the draft's unsaved changes. Discard restores
the disk copy, including any unsaved cuts. Stash files never enter search
results, publishing or exports.

## Alternatives

Keep more than one version of a word, a selection, a sentence or a paragraph
and swap between them in place (KI-86). The document only ever holds the
version that's showing, so the file stays plain for Obsidian and publishing.

**On the Mac**

- ⌥⌘A opens the Stash tab in the right margin, with the cursor's versions
  above the stash. Word (or Selection), Sentence and Paragraph choose the span.
  In the version field, ←/→ switch spans, ↑/↓ and Enter pick a version,
  ⌫ removes it, and Escape closes. Type into **Add a version** and press Enter
  to add and show it.
- ⌥⌘] and ⌥⌘[ show the next and previous version without opening anything.
  Each swap is its own undo step.
- Accepting a ⌘K edit keeps the original one ⌥⌘[ away. ⇧↩ keeps the
  highlighted version without applying it. Both keep Kin's version marked
  with its icon.
- Ask Kin in the versions section, or press ⌥⇧⌘A, for synonyms, sentence rewordings or
  paragraph versions. One request adds up to three choices without changing
  the draft. Explicit asks work with suggestions off and use the edit model
  and cost cap. No alternatives are fetched in the background.
- A word, selection or sentence with versions has an ink dotted underline
  and position dots under its end. A paragraph has dots in the left gutter.
  The filled dot is the showing version. Click the dots to open its versions.
  These marks stay visible with Kin's suggestions off.
- The version showing is always one of the set. Typing inside it edits that
  version; replacing the whole span (a paste, an undo) keeps the new text as
  another version. One version left means no alternatives, and the set goes.

**Stored beside the document**

`.kintsugi/alternatives/<document path>.json`, one file per document
(`apps/desktop/src-tauri/src/alternatives.rs`):

```json
{ "version": 1, "path": "drafts/bowls.md", "sets": [{
  "id": "a-…", "level": "word", "current": "e-2",
  "anchor": { "exact": "ancient", "prefix": "…broke along an ", "suffix": " line. I…", "line": 5 },
  "entries": [{ "id": "e-1", "text": "old", "by": "owner", "created": "…" },
              { "id": "e-2", "text": "ancient", "by": "owner", "created": "…" }],
  "created": "…" }] }
```

- `level` is `word`, `phrase` (a selection), `sentence` or `paragraph`;
  `by` is `owner` or `kin`.
- Anchors work like comment threads' (`packages/editor/src/anchors.ts`, with
  words and sentences in `spans.ts`). On open, a set is found by any of its
  versions' text (the occurrence whose context and line fit best; a word
  that repeats needs some of its context), else, for a sentence or
  paragraph, the most similar one. A set whose text changed elsewhere (the
  phone, Obsidian) shows whichever version is there, or takes the edit.
- While the document is open, edits map the span and snap it to its word,
  sentence or paragraph. Deleting its text detaches the set; it's kept
  (`orphaned`) and comes back when the text does (an undo).
- Renaming or moving the document (or its folder) moves its file.

**For the host**

The editor's `alternatives` prop (`packages/editor/src/alternatives.ts`)
takes the loaded sets and an `onSave(path, sets)` that receives the whole
list once edits pause. `addAlternatives(view, { from, to, texts, by })` adds
versions to a span without showing them. `applyAlternative` accepts a
replacement and keeps the old version beside it. The optional `ask` callback
receives `{ doc, from, to, level }` and returns a promise of replacement
strings. `askForAlternatives` holds that span through edits, rejects answers
for changed text, and adds valid choices with `by: "kin"`.
`alternativesPanelModel` and `alternativePanelCommands` drive the panel
(`alternatives-panel.ts`), including authors, request state and `askKin`, so
another panel can replace it. The phone
doesn't show alternatives yet; edits made there are picked up when the Mac
re-resolves the anchors.
