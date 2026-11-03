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
