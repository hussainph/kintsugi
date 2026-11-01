# Kin's harness

What exists today (KI-26, and KI-31's chat). `docs/vision.md` describes where Kin is going;
this file describes what is built. Code: `apps/desktop/src-tauri/src/ai/`.

## The loop

`agent::run` takes a question, asks the model, runs the tools it calls,
feeds the results back and repeats until the model answers (at most 24
model calls). Text, tool calls, tool results and per-step costs stream to
the webview over a Tauri Channel (`kin_turn`); `kin_cancel` stops a turn,
dropping any request in flight. The loop is independent of Tauri and runs
against any `agent::Model`, so tests use a scripted model and a local mock
HTTP provider.

All three wire formats carry tool calls: Anthropic Messages, OpenAI-style
chat completions (OpenAI, OpenRouter, Z.AI, Ollama) and the ChatGPT Codex
Responses backend. Keys are resolved in Rust from Pi's credentials and never
reach the webview.

## Tools

Read-only, over the open vault. The core tools are always loaded and have
short schemas:

| Tool | Does |
| --- | --- |
| `search` | Hybrid search ([search.md](search.md)) over writing, `inbox/`, `inspiration/` and Feed items: `{query, k?, in?, kind?}` → a JSON array of `{id, kind, title?, source?, snippet, score}`, best first, never full text |
| `read` | A file with line numbers; `offset`/`limit` for long files |
| `list` | A folder's subfolders and documents, with titles |
| `memory` | Batched add / patch / remove on `USER.md` or `NOTES.md` |
| `skill` | Loads a skill's body by name; `write` / `delete` change one |
| `tool` | Runs an extra tool by name; with only a name, returns its usage |

Extra tools, loaded on demand through `tool`: `outline` (a document's
headings), `recent` (recently changed documents) and `history` (searches
the whole conversation log, or reads around one entry with `{"around": seq}`). New tools join this
list, so the tool array (part of the cached prefix) never changes mid-turn.

- `search` uses the app's shared index (`Tools::with_searcher`). Without
  one, as in tests, it indexes the vault in memory, by words only.
- Paths stay inside the vault: no `..`, absolute paths, hidden entries or
  symlinks.
- Nothing writes to the vault except Kin's own memory and skills in
  `.kintsugi/agent/` (below). Outputs over 8,000 characters are saved to
  `<config>/kin/outputs/<turn>/<call>.txt` and previewed; Kin reads the rest
  with `read @out/<turn>/<call>.txt`.
- Everything a tool returns is wrapped in `<data>…</data>`, with closing tags
  inside defused. The prefix tells Kin that this is content, never
  instructions.

## Context

1. **Prefix** (`prompt::system`): instructions, the extra-tool list, then
   memory: About Hussain, your notes and the skills index. Identical on every request; tests check it across steps and turns.
   Anthropic gets `cache_control` on the system block and a rolling breakpoint
   on the newest message; OpenAI and Codex get `prompt_cache_key: "kin"`.
2. **Conversation**: only appended to within a turn.
3. **Dynamic context**, at the end of the user message: the date,
   on-screen chips as paths to read on demand (a selected paragraph carries
   its line range), and the thread's running summary.

A chat turn's conversation is its thread's latest answered exchanges (at
most six, newer than the summary), then the new message. Interrupted and
failed replies stay in the log but are never sent back to the model.

## Memory and skills

Modelled on Hermes Agent (KI-30). Code: `ai/memory.rs` (the store) and
`ai/about.rs` (commands and the snapshot seam).

```
.kintsugi/agent/
  USER.md                  About you: taste, voice, themes, dislikes (1,500 chars)
  NOTES.md                 where to look, how things are organized (2,000 chars)
  skills/<name>/SKILL.md   frontmatter description + command, then the procedure
```

- **Entries.** The memory files are Markdown lists, one line per entry
  (headings and blank lines are ignored and not kept on rewrite). The cap
  counts the entries' characters plus one per separator.
- **Edits.** `memory` takes a batch of `add {text}`, `patch {old, text}` and
  `remove {old}` (`old` is a unique part of the line). The batch applies
  together or not at all. A batch over the cap, a duplicate (ignoring case
  and spacing), an ambiguous `old` or a line that fails the injection scan is
  rejected, and Kin gets the current entries back so it can consolidate.
- **Injection scan** (`memory::scan`): hidden or direction-changing
  characters, phrases that address a model ("ignore previous…", `<system`,
  `</data`, `<|`), and secrets ("api key", "password"). It runs on every
  write, and on load: a hand-edited line or skill that fails it stays in the
  file, is marked "Not loaded" in About you, and never reaches the prompt.
- **Skills.** The index (name, description, `[/ command]`) is in the prefix;
  bodies load with `skill`. `command: true` marks skills for the editor's `/`
  menu; `kin_skills` / `kin_skill` list and read them for it (KI-37). Kin can
  write skills itself, and is told to when Hussain repeats a request. At most
  40 skills, 160-character descriptions, 6,000-character bodies.
- **Frozen snapshot.** `Store::snapshot` reads all of it once when a
  conversation starts; the prompt prefix is a pure function of that
  snapshot, so it is byte-stable for the whole conversation. Writes apply on
  disk at once and show from the next conversation.
- **No approval queue.** Changes apply automatically. Every change, by Kin
  (`chat`), a background review (`review`), Hussain in About you (`owner`), or
  any other editor (`outside`, noticed on the next read), is appended to
  `<config>/kin/memory/<vault key>/log.jsonl` with the file before and after.
  Usage (conversations that loaded a line, times a skill was used) is in
  `usage.json` beside it. An isolated dev run without a config dir keeps
  both in memory.
- **Undo** reverts one change's own edits, as a new change; a line edited
  since can't be undone underneath and is refused. Undoing an undo redoes.
- **Don't remember this.** A turn with `remember: false` tells Kin so in the
  dynamic context, and `memory` / `skill write|delete` refuse.
- **Only vault writes.** All of them go through `Store::set`, which resolves
  inside `.kintsugi/agent/` and follows no links; source-audit tests in
  `tools.rs` and `memory.rs` and an end-to-end vault diff check it.

For helper jobs (KI-31): `about::snapshot(app, root)` returns the snapshot
(USER.md, NOTES.md, skills index) for a job's prefix. A background review
that updates memory runs the loop with that snapshot and
`Tools::with_memory(Access { store, source: Source::Review { .. }, remember: true })`,
and skips conversations marked "don't remember this". Today each dev-panel
turn takes its own snapshot; the conversation log should take one per
conversation and reuse it.

### About you

The sidebar's **About you** (also linked from Settings) shows both files
with their caps, each line's origin (click it to find the change) and how
many conversations loaded it, the skills with their `/` flag and use count,
and the change log with undo per change. Hussain can forget a line or add
one; his edits pass the same caps and checks.

## Models per task

`src/lib/models.json` lists preferences per task: `edit` and `complete`
(the webview), and Kin's `chat`, `ideas` (strong) and `triage` (cheap). The
first preference with usable credentials wins, unless the owner picks a
model for a Kin task in Settings.

## Cost and the cap

Every call (Kin turns, enrichment through `ai::complete`, the webview's
`ai_stream`) is priced and appended to `<config>/kin/usage.jsonl`. The cap
and model choices live in `<config>/kin/settings.json`. An isolated dev run
without `KINTSUGI_CONFIG_DIR` keeps both in memory.

- Prices are estimates per model family (`cost::FAMILIES`). Subscription
  logins (Codex, the Z.AI coding plan) and Ollama cost $0; an unknown paid
  model is priced high and the month is marked estimated.
- When the month's spend reaches the cap, background work stops:
  `ai::complete` returns `AiError::CapReached`, and a background turn ends
  with `stop: "capReached"` before its next step. A turn the owner asked
  for still runs and reports `capReached: true`.
- A cancelled request's tokens are unknown and aren't recorded.

## The chat (KI-31)

Code: `ai/history.rs` (the log), `ai/chat.rs` (the live conversation),
`ai/jobs.rs` (helpers); webview: `src/kin/Chat.tsx`, `src/lib/chat.ts`.

- **One avatar, one chat.** A placeholder avatar (KI-23/KI-41 design the
  real one) sits bottom-right on every screen; it and ⌘J open the chat.
  Screens say what they show through `useScreenContext` (the editor: the
  selection, then the document; an open clip), and the chat attaches it as
  removable chips. `discuss(chip)` from `src/lib/chat.ts` opens the chat with
  an item pinned first: clips use it, and the Feed's Discuss (KI-25) calls it
  with `{ kind: "feed", path: <item id>, label: <title> }`.
- **One log.** `<config>/kin/conversation/log.jsonl`, append-only, never in
  the vault and never shortened. Each owner message's topic is inferred: the
  first chip's subject (a paragraph belongs to its document), else a known
  thread the message names, else the previous topic if it was under 30
  minutes ago, else general. A thread is the entries sharing a topic, with a
  running summary in `threads.json`; opening the chat on draft X shows X's
  thread, and the next turn sends X's summary and recent exchanges.
- **Batching and interrupts.** Messages land in the log at once. Kin answers
  after 1.2 s of quiet, every waiting message in one turn. A keystroke
  (`kin_chat_typing`, throttled) or a new message cancels the running turn;
  its partial reply is logged as interrupted, and its messages are answered
  by the next turn, 3.5 s after typing stops or 1.2 s after the next message.
  Stop ends the turn and settles its messages.
- **Idle summaries.** Two minutes after the last activity, threads with six
  or more new entries get a new running summary from the chat model. It's
  background work: it stops at the cap and when he comes back.
- **Helper jobs.** `kin_job_create({ kind, brief, task?, topic? })` (or
  `jobs.create` in `src/lib/chat.ts`) records a job in `<config>/kin/jobs.json`
  and runs it as its own agent: one at a time, `background: true` (so it
  waits as `waiting` at the cap and resumes when a cap change or the
  five-minute check allows), with only its brief plus the memory snapshot
  (`about::snapshot`) in the prefix, and no memory-writing tools. Chat turns
  take a fresh snapshot and can update memory like any conversation. A job running when the app quit is queued again on start. It
  reports back quietly as a helper entry in the log (a dot on the avatar, no
  popup). Feed ranking and Ideas are meant to use this.
- Headless runs can try it all without a provider: `KINTSUGI_HEADLESS_KIN=mock`
  swaps in a scripted local model that reads the first chip (or searches),
  then answers slowly, word by word. `KINTSUGI_HEADLESS_KIN_IDLE_MS` shortens
  the idle wait. `test/runtime-kin.test.ts` drives it in headless Chromium.

## Ideas (KI-39)

Code: `ai/ideas/` (store, grounding, briefs, Adopt); webview: `src/ideas/`.
Ideas opens from the sidebar or ⇧⌘E.

- **A helper makes them.** A batch is a helper job of kind `ideas` on the
  `ideas` model task, so it is background work and waits at the monthly
  cap. Once a day (checked shortly after start, then every half hour) Kin
  asks for up to five, if a model for Ideas is set up and the cap allows;
  "Ask for more" and "Find ideas for this draft" ask for up to three on
  demand. The brief (`ideas/brief.rs`) carries the rules (never draft prose;
  observed facts apart from the hunch; 2–4 verbatim quotes), the titles
  offered in the last two weeks, what Hussain did with earlier ideas, and
  the Feed items he liked, noted or saved. The helper searches and reads
  with Kin's tools and replies with JSON between `<ideas>` tags.
- **Checked before he sees them** (`ideas/ground.rs`). Every quote must
  appear in the vault file or Feed item it names (typographic quotes,
  spacing, emphasis and blockquote markers aside; `…` marks an omission).
  One quote that isn't there drops the whole idea, as do fewer than two
  quotes, hidden or outside paths, a hunch with paragraphs, headings or
  lists, and over-long fields. A reason's About you line is kept only if it
  is really in USER.md. What was dropped, and why, goes in the helper's
  report in the conversation log. The footprint (searches, files read,
  seconds, cost) comes from the run itself, not from the model.
- **App data, not the vault.** `<config>/kin/ideas/<vault key>/ideas.json`
  (rewritten atomically) and `signals.jsonl` (append-only): dismissed (with
  optional reasons), undismissed, a reason removed or restored, adopted,
  discussed, refined, refine undone, and faded (unused for a week, a faint
  no). The next brief reads the newest 40 back.
- **Fading** is computed: fresh for three days, thinner until day seven,
  then "faded this week" until day fourteen. Unused ideas are deleted after
  30 days. Adopted ideas never fade. Headless runs can move the clock with
  `KINTSUGI_HEADLESS_IDEAS_DAYS_AHEAD=<days>`.
- **Adopt** is the one vault write, and only on his click: a new draft in
  `drafts/` (if the vault has one) with the working title, an empty body and
  the idea in frontmatter, or the idea added to a draft's frontmatter
  without touching its body or other fields:

  ```yaml
  ideas:
    - id: idea-20261101-090000-1
      from: kin
      offered: 2026-11-01
      title: "You've written about what repair is, never what it costs"
      hunch: "The essay you haven't written is the cost side…"
      clips:
        - "[[posts/on-craft]]"
        - "[[inspiration/golden-joinery]]"
  ```

  A draft never links to itself; Feed quotes aren't clips and stay out of
  the list. An open draft sees the change through `vault:changed`, and the
  idea and its clips sit beside it (`src/ideas/Beside.tsx`). The reference
  index reads those clip links as edges (`idea_clip_links` in
  `crates/vault/src/references.rs`), so the draft shows under each clip's
  Used in.
- **Refine** is a helper job of kind `ideas-refine` with the idea and his
  request. The result passes the same checks, replaces the idea and keeps
  the earlier version; Undo restores it. **Discuss** opens the chat with an
  `idea` chip; Kin reads it with the `idea` extra tool. **Why this?** lists
  the reasons: "Not a reason" is a signal (with undo), and "Fix" opens About
  you.
- **Ideas for this draft.** `openIdeas(path)` / `ideasForDraft(path)` in
  `src/ideas/api.ts` open Ideas filtered to ideas about, quoting or adopted
  into that document. The editor footer has an "Ideas" link; KI-37's `/`
  menu and ⌘K can call the same function.
- **The layout** is KI-22's Ledger (`src/ideas/Ledger.tsx`), the only
  layout-specific file: `useIdeas` and `parts.tsx` serve any layout, so Desk
  or Letter is a sibling file swapped in `Ideas.tsx`.
- Headless: `KINTSUGI_HEADLESS_KIN=mock` makes ideas too. The scripted
  helper searches, reads the top documents and offers ideas quoting them,
  plus one with an invented quote that the checks must drop.
  `test/runtime-ideas.test.ts` drives it in headless Chromium.

## Settings

Settings (⌘, or the sidebar) shows the privacy statement, this month's
spend by task, the monthly cap and the model for each Kin task. ⇧⌘K opens a
minimal developer panel to run one turn (with a "don't remember this" box).
