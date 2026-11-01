# Kin's harness

What exists today (KI-26). `docs/vision.md` describes where Kin is going;
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
| `search` | Finds words in writing, `inbox/` and `inspiration/`; files ranked, with matching lines |
| `read` | A file with line numbers; `offset`/`limit` for long files |
| `list` | A folder's subfolders and documents, with titles |
| `tool` | Runs an extra tool by name; with only a name, returns its usage |

Extra tools, loaded on demand through `tool`: `outline` (a document's
headings) and `recent` (recently changed documents). New tools join this
list, so the tool array (part of the cached prefix) never changes mid-turn.

- Paths stay inside the vault: no `..`, absolute paths, hidden entries or
  symlinks.
- Nothing writes to the vault. Outputs over 8,000 characters are saved to
  `<config>/kin/outputs/<turn>/<call>.txt` and previewed; Kin reads the rest
  with `read @out/<turn>/<call>.txt`.
- Everything a tool returns is wrapped in `<data>…</data>`, with closing tags
  inside defused. The prefix tells Kin that this is content, never
  instructions.

## Context

1. **Prefix** (`prompt::system`): instructions, the extra-tool list, then
   memory. Identical on every request; tests check it across steps and turns.
   Anthropic gets `cache_control` on the system block and a rolling breakpoint
   on the newest message; OpenAI and Codex get `prompt_cache_key: "kin"`.
2. **Conversation**: only appended to within a turn.
3. **Dynamic context**, at the end of the user message: the date and
   on-screen chips as paths to read on demand.

Memory (`prompt::Memory`, loaded by `kin::memory`) is empty until KI-30.

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

## Settings

Settings (⌘, or the sidebar) shows the privacy statement, this month's
spend by task, the monthly cap and the model for each Kin task. ⇧⌘K opens a
minimal developer panel to run one turn; the real chat UI is KI-31.
