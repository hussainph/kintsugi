# Kin's harness

What exists today (KI-26, and KI-31's chat). `docs/vision.md` describes where Kin is going;
this file describes what is built. Code: `apps/desktop/src-tauri/src/ai/`.

## The loop

`agent::run` takes a question, asks the model, runs the tools it calls,
feeds the results back and repeats until the model answers (at most 24
model calls). With three calls left, a note appended after the last tool
results tells Kin to stop looking and answer with what it has. A step that
ends with neither text nor tool calls (a reasoning model that spent its
whole reply thinking) is asked once more for the answer. Text, tool calls, tool results and per-step costs stream to
the webview over a Tauri Channel (`kin_turn`); `kin_cancel` stops a turn,
dropping any request in flight. The loop is independent of Tauri and runs
against any `agent::Model`, so tests use a scripted model and a local mock
HTTP provider.

Every wire format carries tool calls and streams text (below, Providers
and wire formats). A step's reasoning is sent back within the turn, in the
form its wire needs; across turns only the visible text is sent. Keys are
resolved in Rust (below, Credentials) and never reach the webview.

Every model call (`wire::send`, Kin's steps and the webview's `ai_stream`)
gives up after 120 s with nothing from the provider, before the response
starts or between streamed chunks. A rate limit (429), a server error (5xx),
a lost connection or such a stall is tried again up to three times, waiting
1, 2 then 4 s (or the provider's `Retry-After`, up to 20 s; a longer one
fails the call), but only while no text has streamed: once the owner has
seen part of a reply, a failure ends the step rather than repeating it. A stream that
ends before the wire's own end of a reply (a finish reason, a terminal
event) is such a failure, never a short answer with half a tool call; a
model that stops without answering (a refusal, a content filter, a Gemini
safety stop) is an error.

## Providers and wire formats (KI-60)

Code: `ai/providers.rs` (the providers), `ai/catalog.rs` (the models),
`ai/wire/` (one module per wire format). Kin supports the providers Pi
supports, over the wire formats Pi uses, ported from Pi's source
(`@earendil-works/pi-ai` 1.5.0, `packages/ai/src/api/`) without running Pi:

| Wire (Pi's API id) | Module | Used by |
| --- | --- | --- |
| Chat completions (`openai-completions`) | `wire/chat.rs` | OpenRouter, Groq, Cerebras, Mistral, DeepSeek, Z.AI, Together, Fireworks, Moonshot, Kimi For Coding, Hugging Face, NVIDIA, Baseten, Ant Ling, Xiaomi, the Qwen and Xiaomi token plans, OpenCode's open models, Copilot's, and any OpenAI-compatible server |
| Responses (`openai-responses`) | `wire/responses.rs` | OpenAI, xAI, Meta, OpenCode's GPT and Grok models, Copilot's GPT models |
| Codex Responses (`openai-codex-responses`) | `wire/responses.rs` | ChatGPT (Codex) |
| Anthropic Messages (`anthropic-messages`) | `wire/anthropic.rs` | Anthropic, MiniMax, Vercel AI Gateway, OpenRouter's, OpenCode's, Fireworks' and Copilot's Claude models |
| Gemini (`google-generative-ai`, `google-vertex`) | `wire/google.rs` | Google Gemini, Vertex AI (API key), OpenCode's Gemini models |

The catalog names each model's wire and base URL, so one provider can use
several: OpenCode serves Claude over Messages, GPT over Responses, Gemini
over Gemini and the rest over chat completions, as Pi does. A model the
catalog doesn't list uses its provider's default wire and URL. Mistral's
own API is its chat completions with Mistral's quirks (Pi served it that way
until March 2026; its native module posts to the same endpoint).

Each wire follows Pi's per-model quirks, read from the catalog's `compat`
and `thinkingLevelMap` (Pi's `detectCompat` fills the gaps from the provider
and URL):

- **Chat completions.** The max-tokens field (`max_tokens` or
  `max_completion_tokens`), `store: false`, the system or developer role,
  `strict` on tools, how thinking is asked for (`reasoning_effort`,
  `thinking: {type}` for DeepSeek and Z.AI, `reasoning: {effort}` for
  OpenRouter, `enable_thinking`, `reasoning: {enabled}` for Together, chat
  template arguments), Z.AI's `tool_stream`, session headers (OpenRouter's
  `x-session-id`, `session_id`/`x-session-affinity` where Pi sends them),
  cache markers on OpenRouter's Claude models. Streamed reasoning
  (`reasoning_content`, `reasoning`, OpenRouter's `reasoning_details`) goes
  back on the step's assistant message; DeepSeek-style models get an empty
  `reasoning_content` on every other one. Mistral gets nine-character tool
  call ids, named tool results and its thinking chunks. A server on this
  Mac (Ollama and the like) gets `max_tokens` and nothing OpenAI-only.
- **Responses and Codex.** `store: false`; reasoning comes back encrypted
  (`include: ["reasoning.encrypted_content"]`) and each step's `reasoning`
  items go back verbatim, before its function calls, on every later request
  of the turn; it's asked for whenever the model reasons, at any effort.
  Plain Responses sends the system prompt as a developer message and
  `max_output_tokens`; Codex sends `instructions` and runs tools one at a
  time.
- **Anthropic.** `x-api-key` (a bearer token for Copilot),
  `anthropic-version: 2023-06-01`, cache breakpoints on the system prompt
  and the newest block of Kin's agent calls, tool schemas trimmed to
  `properties` and `required`. Thinking is a token budget on older models
  (1,024 to 16,384 by level, added to `max_tokens`, with the
  interleaved-thinking beta) or adaptive with an effort on newer ones.
  Thinking blocks and their signatures go back in front of the step's text
  and tool calls. A Claude subscription token (`sk-ant-oat…`) given as a key
  is refused.
- **Gemini.** The key in `x-goog-api-key`, tools as JSON Schema
  (`parametersJsonSchema`, `const` written as `enum`), thinking as a level
  on Gemini 3 and later and a budget before. The model's parts, with their
  thought signatures, go back verbatim within the turn. Vertex AI is used
  with an API key (express mode); Kin doesn't mint Google Cloud tokens, so
  application-default credentials aren't read.
- **Thinking levels.** A model choice's `reasoning` is one of Pi's levels
  (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; `none` means
  `off`), moved to the nearest one the model supports, as Pi does. Without
  one, nothing about thinking is sent and the provider's default applies;
  every model choice Kin resolves names one (see Models per task › Effort).
- **Copilot.** The catalog's editor headers, `X-Initiator` and
  `Openai-Intent` on every request; a login's token names its own API host.
- **OpenCode.** Every request carries `x-opencode-session`, a hash of the
  model and the fixed prompt prefix, so a conversation is routed and cached
  together (Go requires one).

Left out, as Pi needs more than a key for them: Amazon Bedrock (AWS
request signing), Azure and Cloudflare (per-account URLs). Pi's Radius
gateway uses Pi's own API.

### The model catalog

`ai/catalog.json` lists every chat model of those providers: provider, id,
name, wire, base URL, context window, maximum output, input, output and
cache prices (with input-size tiers), reasoning, image input and Pi's
per-model quirks. Pi keeps only models that call tools. It's generated from
Pi's catalog and checked in:

```sh
pnpm gen:models          # the version pinned in scripts/gen-models.mjs
pnpm gen:models 1.6.0    # another published version of @earendil-works/pi-ai
```

The script downloads the package tarball with `npm pack` (no install, no
dependencies), reads `dist/providers/data/*.json` and writes the catalog,
noting the version and its integrity hash. Entries in
`ai/catalog.extra.json` are added for models Pi lacks (empty today: Pi has
OpenCode Zen's and Go's models). `scripts/gen-models.test.mjs` checks the
checked-in file is in the generated shape, and a Rust test checks every
catalog provider and wire is one Kin speaks.

### Listing models (`ai_models`)

`invoke("ai_models", { all?: boolean })` (`models()` in `src/lib/ai.ts`)
returns the providers with a usable credential, in Settings order, each
with its models sorted by name. `all: true` lists every provider, with
`usable: false` and the reason where there's no credential. Code:
`ai/models.rs`.

```ts
type ProviderModels = {
  id: string; name: string;
  auth: "api_key" | "login" | "local" | "mock" | "unsupported_login" | "expired_login" | "none";
  source: "opencode" | "pi" | "env" | "local" | null;
  usable: boolean;
  subscription: boolean;   // calls cost $0 in the ledger
  models: {
    id: string; name: string;
    api: string;           // the wire, e.g. "openai-completions"
    contextWindow: number; maxOutput: number;
    reasoning: boolean;
    thinkingLevels: ("off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")[];
    tools: boolean; images: boolean;
    price: { input: number; output: number; cacheRead: number; cacheWrite: number;
             tiers?: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[] };
  }[];
}[];
```

A model choice is `{ provider, model: <id>, reasoning?: <thinking level> }`,
as `kin_set_model` takes it. Nothing in the answer is secret. `ai_providers`
(Settings' list) keeps to the providers the default models use and any
other with a credential.

The model picker (`src/kin/ModelMenu.tsx`, KI-61, KI-77) is built on it:
the chat's composer and Settings' default models list only the models
turned on in Settings (`KinSettings.enabled`) whose provider is usable,
each with its price per million tokens (input · output). A provider name
heads its models only when more than one provider is listed, and a filter
field appears past 12 models. The composer's menu ends with "Choose
models", which opens Settings › Kin and models. The webview hides Ollama
(`shown()` in `src/lib/ai.ts`): Kin can still speak to a local server, but
Kintsugi doesn't offer one.

## Credentials (KI-48)

Code: `ai/credentials.rs` (the order), `ai/opencode_auth.rs`, `ai/pi_auth.rs`.
Kintsugi stores no credentials and never signs in itself; the owner logs in
with OpenCode (`opencode auth login`, or `/connect` in its TUI) or Pi. For
each provider the first usable credential wins, in this order:

1. **OpenCode login.** OpenCode 2 keeps logins in its SQLite database,
   `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share/opencode/`,
   `$OPENCODE_DB` overrides it), table `credential`: per provider the active
   row, else the newest, with a JSON value `{type: "key", key}` or
   `{type: "oauth", methodID, access, refresh, expires, metadata.accountID}`.
   OpenCode 1's `auth.json` beside it (`{type: "api", key}` /
   `{type: "oauth", access, refresh, expires, accountId}`) is read only when
   there is no database: OpenCode 2 imports it once and never updates it.
   Verified against OpenCode v2.0.32's source (`packages/core/src/credential.ts`,
   `integration.ts`, the `import_legacy_credentials` migration).
2. **Pi login**, `~/.pi/agent/auth.json` (or `$PI_CODING_AGENT_DIR`).
3. **Environment**: the provider's key, by Pi's names (below). GUI apps
   rarely inherit these.

| Provider | Environment | Logins |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | refused (a Claude subscription) |
| ChatGPT (Codex) | | OpenCode, Pi |
| OpenAI | `OPENAI_API_KEY` | Pi ("Sign in with ChatGPT") |
| OpenRouter | `OPENROUTER_API_KEY` | Pi |
| Z.AI, Z.AI Coding (China) | `ZAI_API_KEY`, `ZAI_CODING_CN_API_KEY` | |
| OpenCode Zen and Go | `OPENCODE_API_KEY` | |
| Google Gemini | `GEMINI_API_KEY` | |
| Google Vertex AI | `GOOGLE_CLOUD_API_KEY` | |
| xAI | `XAI_API_KEY` | Pi |
| Groq | `GROQ_API_KEY` | |
| Cerebras | `CEREBRAS_API_KEY` | |
| Mistral | `MISTRAL_API_KEY` | |
| DeepSeek | `DEEPSEEK_API_KEY` | |
| Together | `TOGETHER_API_KEY` | |
| Fireworks | `FIREWORKS_API_KEY` | |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` | OpenCode, Pi |
| Moonshot AI, Moonshot AI (China) | `MOONSHOT_API_KEY` | |
| Kimi For Coding | `KIMI_API_KEY` | Pi |
| MiniMax, MiniMax (China) | `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY` | |
| Meta | `META_API_KEY` | Pi |
| Hugging Face | `HF_TOKEN` | |
| NVIDIA | `NVIDIA_API_KEY` | |
| Baseten | `BASETEN_API_KEY` | |
| Ant Ling | `ANT_LING_API_KEY` | |
| Xiaomi and its token plans | `XIAOMI_API_KEY`, `XIAOMI_TOKEN_PLAN_{AMS,CN,SGP}_API_KEY` | |
| Qwen token plans | `QWEN_TOKEN_PLAN_API_KEY`, `QWEN_TOKEN_PLAN_CN_API_KEY` | |
| Ollama (local) | none | |

Pi's `auth.json` can hold an API key for any of them, by the same ids. A
key stored as `$VAR` is read from the environment; one stored as
`!command` would need a shell command run, which Kintsugi never does, so it
counts as absent. Pi's logins are refreshed the way Pi does it, under Pi's
lock, natively only: ChatGPT for Codex and for the OpenAI API, Copilot (its
GitHub token is exchanged for a Copilot token), Kimi, xAI and Meta (a
day-long key); an OpenRouter login is a key that doesn't expire.

OpenCode ids map to Kintsugi's: most as they are (`anthropic`, `openrouter`,
`opencode`, `opencode-go`, `groq`, `xai`, `mistral`, `deepseek`, `google`,
`github-copilot`, …); `openai` is an OpenAI API key, or as an OAuth login
ChatGPT on the Codex backend (`openai-codex`); `zai-coding-plan`, else `zai`,
is `zai` (the coding-plan endpoint); `togetherai`, `fireworks-ai`, `vercel`,
`kimi-for-coding` and `zhipuai-coding-plan` are Together, Fireworks, Vercel
AI Gateway, Kimi For Coding and Z.AI Coding (China). Only keys are read for
the providers OpenCode logs in to by OAuth other than OpenAI and Copilot.

- **What can't be used.** A Claude subscription login (OpenCode's or Pi's)
  is refused: Kintsugi uses only Anthropic API keys. OpenCode's newer ChatGPT
  sign-in (`chatgpt-token-sharing`, which calls api.openai.com with a scoped
  token) isn't the Codex backend and is refused too; the ChatGPT browser or
  headless login works. A login Kintsugi can't use doesn't stop the search:
  a key further down the order is still used.
- **OpenCode logins are read-only.** The database is opened read-only and
  nothing is ever written to OpenCode's folder. OpenCode 2.0.32 refreshes
  OAuth tokens and writes them back with no cross-process lock (a later
  OpenCode adds a private flock), and OpenAI rotates refresh tokens, so a
  refresh here could race OpenCode's and log one of them out. An expiring
  OpenCode login (under five minutes left) is shown as expired: open OpenCode
  once and it refreshes it. Pi's file has a lock both sides respect, so Pi's
  Codex login is still refreshed and written back as before (natively only).
- **OpenCode Zen and Go** serve each model on its native API under
  `https://opencode.ai/inference/` (Zen, pay as you go) and
  `https://opencode.ai/inference/go/` (Go, the subscription), as the
  catalog says. Go counts as a subscription ($0 in the ledger); Zen is
  priced from the catalog.
- **Settings** lists every provider and where its credential comes from:
  "OpenCode login", "Pi login" or "environment", or why it can't be used.


## Tools

Read-only, over the open vault. The core tools are always loaded and have
short schemas:

| Tool | Does |
| --- | --- |
| `search` | Hybrid search ([search.md](search.md)) over writing, `inbox/`, `inspiration/` and Feed items: `{query, k?, in?, kind?}` → a JSON array of `{id, kind, title?, source?, snippet, score}`, best first, never full text |
| `read` | A file with line numbers; `offset`/`limit` for long files. `feed:<id>` reads a Feed item (Discuss's chip, a `search` or `shortlist` hit). A long clip's whole source is `inspiration/sources/<slug>.txt` (its `full_source`); the prompt says so |
| `list` | A folder's subfolders and documents, with titles |
| `memory` | Batched add / patch / remove on `USER.md` or `NOTES.md` |
| `skill` | Loads a skill's body by name; `write` / `delete` change one |
| `tool` | Runs an extra tool by name; with only a name, returns its usage |

Extra tools, loaded on demand through `tool`: `outline` (a document's
headings), `recent` (recently changed documents), the Feed's ranking tools
`shortlist`, `similar_to`, `top_topics`, `taste_profile` and `explain`
(compact JSON, ranked locally with no model calls; see
[ranking.md](ranking.md)) and `history` (searches
the open vault's whole conversation log, or reads around one entry with `{"around": seq}`). New tools join this
list, so the tool array (part of the cached prefix) never changes mid-turn.

- `search` uses the app's shared index (`Tools::with_searcher`). Without
  one, as in tests, it indexes the vault in memory, by words only.
- `search`'s `in` is a vault-relative folder however it's written
  (`./posts`, `/posts/`, `posts`); `.`, `./` and `/` mean the whole vault.
  `kind: note` means `inbox/` only, and the schema says so: a `notes/`
  folder is `writing`. When `in` or `kind` hides every match, the result is
  `[]` plus one line naming up to five matches without the filter, so an
  empty answer never reads as "nothing in the vault".
- Feed items and the ranking tools go through `Tools::with_feed`
  (`feed::kin_hook`): the Feed lives in app data, not the vault. Items Kin's
  `shortlist` and `similar_to` return are logged as `kin_pick` events, which
  ranking never learns from, so Kin can't train the ranker on its own picks.
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
`ai/about.rs` (commands and the `snapshot` function).

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
  menu; `kin_skills` / `kin_skill` list and read them for it (KI-37, below). Kin can
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
(the webview), and Kin's `chat`, `ideas` and `triage`. Settings › Kin and
models sets a default for each of the five (`kin_set_model`, kept in
`<config>/kin/settings.json`); without one, or while the default's provider
has no usable credential, the first usable preference wins
(`ai::chosen_model`). The webview asks `ai_model_for(task)` before an edit,
so a change in Settings applies to the next one. A test checks every
preference is in the catalog. Requests ask for at most the model's maximum
output.

The first preferences (KI-61) are lighter than Kimi K3, which has OpenCode
Go's smallest allowance ($15 a month at $3 / $15 per million tokens):
Qwen3.7 Plus for chat, Ideas and edits ($60 a month at $0.40 / $1.60) and
GLM-5.3-Flash for completions and triage ($60 a month at $0.15 / $0.50).

**Enabled models (KI-77).** The pickers offer a short list rather than the
whole catalog. By default it holds every task's preferences and
`models.json`'s `enabled` alternatives (one or two strong models per
provider); Settings › Kin and models lists the ones on, searches the usable
providers' whole catalog, and turns any of them on or off
(`kin_set_enabled({ provider, model }, on)`). Changes are kept as
differences from the default set (`enabled` and `disabled` in
`settings.json`), so a provider set up later brings its own defaults. Each
task's default, as it resolves now, is always on (`ai::enabled_models`).

**Effort (KI-77).** Every resolved model choice names a thinking level for
a model that thinks (`ai::with_effort`): the one he picked (per
conversation, or per task in Settings with `kin_set_effort(task, level |
null)`, kept as `efforts` in `settings.json`), else the preference's own,
else the task's: `medium` for chat and Ideas (Pi's default), `low` for
edits, and as little as the model allows for completions and triage. It's
moved to the nearest level the model supports. A model that doesn't think
gets none. The effort control (`src/kin/Effort.tsx`) is a stepped slider
over the model's `thinkingLevels`, hidden for a model with one level or
none; it sits beside the model in the composer and in each Settings row.

**Per conversation.** The chat's model picker sets the model for one
conversation (a thread's key, `""` for general): `kin_chat_model(topic)`,
`kin_chat_set_model(topic, model | null)` and, beside it, the effort with
`kin_chat_set_effort(topic, level | null)` (KI-77), kept in
`<vault>/.kintsugi/kin/models.json` (`ai/picks.rs`), beside that vault's
`log.jsonl` and `threads.json`, so it moves with the vault and another
vault's thread of the same name keeps its own. A turn runs on the pick of
its conversation in the vault it started in, while that provider is usable,
else on the chat default, at the conversation's effort, else the chat's
default effort. An entry is `{ provider?, model?, reasoning? }`: an effort
alone runs the chat default model at that level. The picker
(`src/kin/ModelPicker.tsx`) loads and saves its own state and reloads the
pick on `switched`.

## Cost and the cap

Every call (Kin turns, enrichment through `ai::complete`, the webview's
`ai_stream`) is priced and appended to `<config>/kin/usage.jsonl`. The cap
and model choices live in `<config>/kin/settings.json`. An isolated dev run
without `KINTSUGI_CONFIG_DIR` keeps both in memory.

- Prices come from the catalog, per model, with its input-size tiers: a
  request whose input (fresh, cached and cache-written together) is over a
  tier's size is billed at that tier's rates, as Pi computes it.
  Subscriptions (Codex, the Z.AI coding plans, OpenCode Go, Copilot, Kimi
  For Coding, the token plans) and Ollama cost $0. A model the catalog
  doesn't list under its provider is priced like the same model elsewhere,
  else high, and the month is marked estimated.
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
- **One log per vault (KI-59).** `<vault>/.kintsugi/kin/log.jsonl`,
  append-only and never shortened, beside `.kintsugi/comments/` and Kin's
  memory. Hidden like them, so Kin's tools, search and the phone's library
  never see it, and the watcher ignores it. Each owner message's topic is inferred: the
  first chip's subject (a paragraph belongs to its document), else a known
  thread the message names, else the previous topic if it was under 30
  minutes ago, else general. A thread is the entries sharing a topic, with a
  running summary in `threads.json` (beside the log); opening the chat on
  draft X shows X's thread, and the next turn sends X's summary and recent
  exchanges.
- **Switching vaults switches the conversation.** The engine opens the open
  vault's log on first use after a switch (`vault_open` also asks it to at
  once): the running turn and comment replies stop, the chat and comment
  margins reload (`kin:chat` `switched`), and history, summaries and the
  phone's routes all read the new vault's log. A turn, review or helper job
  that finishes after the switch writes to the log of the vault it started
  in. The job table and spend stay in app data, shared by every vault.
- **Moving the old log (KI-59).** Before KI-59 one log in
  `<config>/kin/conversation/` served every vault. The first time a log is
  opened after the update, it moves into that vault (the one open, or last
  used); other vaults start empty. `history::migrate` claims it by renaming
  the folder to `conversation.moving/` (a backup no other vault picks up),
  copies `threads.json` then `log.jsonl` into the vault atomically, reads
  the copy back to check it starts with every byte of the old log, and only
  then deletes the backup. A crash at any step leaves the old log whole and
  the next launch finishes the move. A vault that already has a log of its
  own is never overwritten: the old one is set aside as
  `conversation.unmoved-<time>/` instead.
- **Batching and interrupts.** Messages land in the log at once. Kin answers
  1.2 s after the last message, every waiting message in one turn. A keystroke
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
  reports back as a helper entry in the log (a dot on the avatar, no
  popup). Feed ranking and Ideas are meant to use this. Helpers get 16k
  output tokens per call (chat turns 4k): a batch of ideas is long, and a
  reasoning model's thinking counts against the same budget. Each run's step
  trace (tools called, stop reason, text length and output tokens per call;
  no content) is kept on the job in `jobs.json` and printed to stderr as a
  `kin: helper …` line, and a helper that ends without a report says why
  (out of steps, its reply spent on thinking, or empty).
- Headless runs never start the daily Ideas batch on their own unless
  `KINTSUGI_HEADLESS_IDEAS_DAILY=1`, so a real-AI smoke test spends nothing
  unasked; "Ask for more" still works. `KINTSUGI_HEADLESS_WIRE_TRACE=1` prints
  each model request's shape (item kinds, reasoning items carried, stop
  reason, output tokens; never content) to stderr.
- Headless runs can try it all without a provider: `KINTSUGI_HEADLESS_KIN=mock`
  swaps in a scripted local model that reads the first chip (a document,
  clip or `feed:<id>`), or calls `shortlist` when asked for one, or searches,
  then answers slowly, word by word, quoting the start of what the tool returned. `KINTSUGI_HEADLESS_KIN_IDLE_MS` shortens
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
  discussed, refined, refine undone, and faded (unused for a week, a weak
  negative signal). The next brief reads the newest 40 back.
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
  into that document. The editor footer has an "Ideas" link, and ⌘K's
  "Ideas for this draft" calls the same function.
- **The layout** is KI-22's Ledger (`src/ideas/Ledger.tsx`), the only
  layout-specific file: `useIdeas` and `parts.tsx` serve any layout, so Desk
  or Letter is a sibling file swapped in `Ideas.tsx`.
- Headless: `KINTSUGI_HEADLESS_KIN=mock` makes ideas too. The scripted
  helper searches, reads the top documents and offers ideas quoting them,
  plus one with an invented quote that the checks must drop.
  `test/runtime-ideas.test.ts` drives it in headless Chromium.

## In the editor (KI-37)

Code: `packages/editor/src/commands.ts` (`/`), `references.ts` (`[[` and
`@`), `menu.ts` (their shared look); webview: `src/refine/` (⌘K) and
`src/references/Writing.tsx` (the wiring).

- **`/`** at a line start or after a space opens the block menu: Markdown and
  MDX blocks that turn the line into a heading, list, to-do, quote, callout
  (`> [!NOTE]`), code block, divider, table, image, footnote or `<Component />`,
  as one undoable change. Skills with `command: true` (`kin_skills`) follow
  under "Kin skills"; one runs on the paragraph (or, on a blank line, the one
  above) through ⌘K's rewrite path, so the result is a diff he accepts with
  Enter. Nothing is written until then. Host actions (`Commands.actions`)
  come last under "Kin": the desktop adds *Ideas for this draft*.
- **`@`** opens the `[[` picker and writes the same `[[link]]`; title matches
  lead in both. **Kin** is first while the query could be "kin": choosing it
  takes `@Kin` back out and calls `References.onKin(anchor)` with the
  paragraph's range, which the desktop turns into a comment thread on that
  paragraph (KI-38, below). `@` never
  opens mid-word (email addresses), and a space closes it unless a title still
  matches, so "@karpathy said" stays prose.
- **⌘K** (the selection, else the paragraph) keeps its edits and lists the
  command skills, then Kin's actions, which write nothing themselves: *Find
  supporting clips* (one `clip_search` per paragraph term, ranked by terms
  matched; choosing one adds its link after the passage), *Who disagrees?*
  (sends that question to the chat with the paragraph, via
  `discuss(chips, text, { send: true })`), *Discuss this paragraph* (opens a
  comment thread's composer on it, unsent), *Kin, review this draft* and
  *Ideas for this draft* (`ideasForDraft(path)`).
  In a read-only mirror (KI-9) only the actions that write nothing are
  offered, and a supporting clip can only be opened.
- **Phone width.** Both menus fit `100vw − 16px`, rows are at least 44 px
  on a coarse pointer, and touch hints replace the key hints there.
- **Headless.** With `KINTSUGI_HEADLESS_KIN=mock`, `ai_providers` offers the
  first edit model as `mock` and `ai_stream` answers with `scripted::edit`
  (drops filler words), so ⌘K and skills can be reviewed without a provider.
  `test/runtime-editor.test.ts` drives all of it in headless Chromium.

## Comment threads (KI-38)

Code: `packages/editor/src/anchors.ts` (anchoring, pure) and `comments.ts`
(the CodeMirror extension); `ai/comments.rs` (storage) and
`ai/chat/comments.rs` (turns, review, commands); webview: `src/comments/`.

- **Starting one.** `@Kin` in a paragraph and ⌘K's *Discuss this paragraph*
  open a composer on the paragraph (`startComment`). Nothing is saved until
  he sends; Escape leaves nothing behind. *Kin, review this draft* (⌘K, the
  `/` menu's Kin actions, or the comments bar) is one turn that reads the
  document and leaves up to five threads on the paragraphs that most need a
  note. Kin's reply comes back as `<comments>[{"paragraph": n, "comment": …}]</comments>`
  against a numbered list of the body's paragraphs; anything else is logged
  as a failed review and leaves no threads.
- **The familiar UX.** A marker in the right margin of each commented
  paragraph (a count when there are several), a popover with the thread
  (reply, Resolve/Reopen, Stop while Kin is replying, Ask again after a
  failed or stopped reply), and a comments bar under the editor with counts,
  *Show resolved*, the review action and the detached threads. Kin's
  messages carry KI-23's Kin accent colour (`--kin`, `--kin-ink` in `@kintsugi/ui`) and
  the placeholder avatar (the host's `kinMark`; KI-41 replaces it).
- **References.** Any `[[link]]` or vault path in Kin's reply is a chip:
  drag it into the draft (the same drop as the reference margin), tap `+` to
  add it after the paragraph's last word, or click to open it. Nothing else
  of Kin's ever lands in the document.
- **Stored outside the document.** `.kintsugi/comments/<document path>.json`
  in the vault, one file per document: each thread's id, anchor, status,
  origin and whether it's detached. Renaming or moving a document (or its
  folder) moves its file. The MDX is never touched.
- **Anchors.** A text quote of the paragraph with up to 48 characters of
  context either side and its first line. On open it's re-resolved: the exact
  quote (the occurrence whose context and line fit best), else the most
  similar paragraph (word overlap ≥ 0.5), else none. While the document is
  open, CodeMirror's change mapping moves it and snaps it to the paragraph
  its start is in, so typing inside or above it, merging or splitting keep it
  on its paragraph. The editor sends the new quotes back after 0.7 s.
- **Orphans.** Deleting a paragraph outright detaches its threads. They are
  kept with the last text they were on (shown as "Was on: …") and their
  messages, listed in the comments bar, and still answerable; an undo, or a
  paragraph with that exact text later, re-attaches them.
- **One log.** A thread's messages are rows in the conversation log with
  the document as their `topic`, the thread's id in `comment` and the
  paragraph as a chip (with its current lines). The chat shows them in the
  document's thread, tagged "Comment on a paragraph", and `history` finds
  them. Each thread has its own turns (not the chat's batching): the
  thread's exchanges are the turn's history, a new message interrupts its
  running reply and the next answers both, and comment replies don't light
  the chat's unread dot. The review's request and Kin's note on it are
  `review: true` rows.
- **Phone.** All of the UI is plain DOM in `packages/editor`, sized for a
  phone (the popover fits `100vw − 16px`, larger markers on a coarse
  pointer), behind the `comments` prop on `Editor`, so the phone's shared
  editor can adopt it with a host like `src/comments/useComments.ts`.
- **Headless.** With `KINTSUGI_HEADLESS_KIN=mock` the scripted model answers
  comment turns (searches the paragraph's longest word, replies naming the
  first hit as a `[[link]]`) and reviews (comments on the first and last
  paragraphs). `test/runtime-comments.test.ts` drives it all in headless
  Chromium.

## On the phone (KI-42)

Kin runs on the Mac; the phone reads and asks through the phone API
(version 6, `phone/sections.rs`, each route the Mac's own command through
`phone/desk.rs`). No key, model call or prompt is ever on the phone.

| Route | Command |
| --- | --- |
| `GET /v1/kin?before&limit` | `kin_chat_log` over every thread of the open vault's log (limit 1–500, default 100) |
| `POST /v1/kin {id, text, chips}` | `kin_chat_send`, once per `id`: `{entry, duplicate: false}`, or `{seq, duplicate: true}` for an id already sent. The last 500 ids are kept in `<config>/phone-kin-ids.json`, so a resend after a restart still lands once. Chips are `doc`, `clip`, `feed` or `idea` (others are 400) |
| `POST /v1/kin/stop` | `kin_chat_stop` |
| `GET /v1/kin/jobs` | `kin_jobs` |
| `GET /v1/ideas` | `ideas_list` |
| `POST /v1/ideas/more` | `ideas_generate` (no focus): "Ask for more" |
| `POST /v1/ideas/adopt {id, title?}` | `ideas_adopt` into a new draft; an idea already adopted answers with its draft, so a retried Adopt never makes a second one |
| `POST /v1/ideas/dismiss {id, undo?}` | `ideas_dismiss` / `ideas_undismiss` |
| `POST /v1/ideas/discussed {id}` | `ideas_discussed` |

**The phone app.** One avatar (`components/KinAvatar.tsx`, the Mac's
placeholder bowl) floats bottom right on every screen but the chat and
pairing, and hides while typing. Screens say what they show with
`useScreenContext` (`lib/screen-context.ts`): a document, a clip, a feed
item being read, an open idea. Tapping the avatar opens the chat
(`app/kin.tsx`) with those as removable chips.

- **Offline.** Messages are written to a queue on the phone first
  (`lib/kin.ts`, with a UUID each) and sent in order when the Mac answers.
  While it doesn't, the chat says "Kin runs on your Mac, which isn't
  reachable", each waiting message says "Waiting for your Mac", and they go
  when it's back (the next sync from any screen). A message the Mac refuses
  stays, marked, with Try again and Discard.
- The conversation (the latest 100 entries, every thread, with thread labels
  where the subject changes and paragraph comments tagged) and the jobs are
  kept to read offline. While Kin is answering the chat asks every 1.5 s
  (else every 6 s); replies arrive whole, not streamed. "Kin's jobs on your
  Mac" lists running and recent helper jobs.
- **Ideas** (`app/ideas.tsx`, `lib/ideas.ts`): the Ledger
  (`components/ideas/Ledger.tsx`, the only layout-specific file;
  `components/ideas/parts.tsx` serves any layout). A row opens in place:
  what Kin noticed, its hunch, the quoted evidence (tap to open a document
  or clip), how it got here and Why this?, then Adopt, Discuss and Dismiss
  (with Undo). Adopt, Dismiss and Ask for more wait for the Mac like Kin's
  messages; an adopted draft is fetched into the phone's library and opens.

**Testing.** `cargo test -p kintsugi phone::` covers the routes against a
stand-in app; with `--no-default-features --features headless`,
`phone::dev::the_phone_reaches_the_real_feed_ideas_and_kin` drives them
against the real app on a scratch vault with the mock model. The phone's
stores are tested in `apps/mobile/src/lib/sections.test.ts`, and
`apps/mobile/test/browse-acceptance/run.sh` with `ONLY=sections` runs the
XCUITest (screenshots in `docs/screenshots/ki-42/`).

## Settings

Settings is a page (`src/settings/`, KI-61). ⌘, or the sidebar opens it
over the app, at the section last shown; Esc, ⌘[ or Back returns to where
he was. Its sections:

- **General**: the vault, and optional tools.
- **Kin and models**: the default model for chat, Ideas, edits,
  completions and Feed triage; this month's spend by task and the monthly
  cap; About you and the developer panel.
- **Providers**: where each credential comes from (above, Credentials),
  for the providers the default models use and any other with a
  credential.
- **Phone**, **Blog**, **Export** and **Privacy** (the privacy statement).

⇧⌘K opens a minimal developer panel to run one turn (with a "don't
remember this" box).
