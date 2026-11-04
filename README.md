# Kintsugi

Kintsugi brings everything you read, watch and hear into one place: a feed of new work from sources you follow, and a curated library of what's worth keeping, all in a local vault of plain files. Kin, its agent, reads it all alongside you and offers ideas. You write in a focused Markdown and MDX editor on the Mac, or in a phone app that works like a notes app. Kin finds, connects and suggests, but it never writes for you. See [docs/vision.md](docs/vision.md) for where it's going.

Your writing lives in a **vault**: a plain folder of `.md` / `.mdx` files (by default `~/Documents/Kintsugi`). Each document's frontmatter holds a `status` of `draft` or `complete`, and any `tags` you like (`tags: [essay, craft]`; Obsidian's block lists work too). Organize in folders and tags when you want to; nothing asks you to. Add or remove a document's tags from the footer beside its status, filter the sidebar with the tag button beside the vault name, and type `#tag` in ⌘P to jump among tagged documents. See [docs/writing.md](docs/writing.md).

## Appearance

Choose Light, Dark or System in Settings › Appearance on the Mac, or Appearance in the phone's overflow menu. System is the default. Each device keeps its own mode and editor text size (80–150%). The text sample updates immediately; the current editor font is read-only. See [docs/appearance.md](docs/appearance.md).

## Shortcuts

Hold ⌘ for a moment to see the shortcuts that work where you are, beside their buttons and in a list. ⇧⌘/ or the keyboard button under a document lists them all; type to filter. Right-click a selection (or press ⇧F10) for what you can do with it, each with its key.

⌥⌘T, ⌥⌘R, ⌥⌘P, ⌥⌘F and ⌥⌘S run ⌘K's edits on the selection (or the paragraph) straight away, and show the result to accept or discard like ⌘K. ⌘/ dims the selection (or the line) in place, and dimmed text is left out of publish and export. In ⌘P, `#tag` filters by tag. Text size is also in Settings › Appearance.

Every shortcut is defined once, in `apps/desktop/src/lib/shortcuts.ts` (the editor's formatting keys in `packages/editor/src/format.ts`). The tests fail on a key that's taken twice, CodeMirror's and the Mac's own keys included, and on tables below that don't match; `pnpm shortcuts:readme` rewrites them.

<!-- shortcuts:start (generated from apps/desktop/src/lib/shortcuts.ts; run pnpm shortcuts:readme) -->

### App

| Keys | Action |
| --- | --- |
| ⌘N | New document |
| ⇧⌘N | New folder |
| ⌘P | Open a document |
| ⇧⌘F | Feed |
| ⇧⌘I | Inspiration |
| ⇧⌘E | Ideas |
| ⌘J | Kin |
| `⌘\` | Sidebar |
| ⌘, | Settings |
| ⇧⌘O | Open another vault |
| `⇧⌘/` | Keyboard shortcuts |

### Document

| Keys | Action |
| --- | --- |
| ⌘S | Save |
| ⇧⌘D | Toggle status |
| ⇧⌘P | Publish |
| ⌥⌘E | Export |
| ⌘= | Larger text |
| ⌘− | Smaller text |
| ⌘0 | Actual size |

### Kin

| Keys | Action |
| --- | --- |
| ⌘K | Edit with Kin |
| ⌥⌘T | Tighten |
| ⌥⌘R | Rephrase |
| ⌥⌘P | Simplify |
| ⌥⌘F | Fix grammar and spelling |
| ⌥⌘S | Synonyms |
| ⇧F10 | Selection menu |

### Alternatives

| Keys | Action |
| --- | --- |
| ⌥⌘A | Alternatives |
| `⌥⌘]` | Next alternative |
| `⌥⌘[` | Previous alternative |
| ⌥⇧⌘A | Kin's alternatives |

### Formatting

| Keys | Action |
| --- | --- |
| `/` | Insert a block |
| `@` `[[` | Link a document or clip |
| ⌘B | Bold |
| ⌘I | Italic |
| ⌘U | Underline |
| ⌘E | Code |
| ⇧⌘X | Strikethrough |
| ⌘L | Link |
| ⌥⌘1–6 | Heading |
| ⌥⌘0 | Plain text |
| ⇧⌘7 | Numbered list |
| ⇧⌘8 | Bulleted list |
| ⇧⌘9 | To-do list |
| ⇧⌘. | Quote |
| `⌘/` | Dim |

### Text

| Keys | Action |
| --- | --- |
| ⌘X | Cut |
| ⌘C | Copy |
| ⌘V | Paste |
| ⌘Z | Undo |
| ⇧⌘Z | Redo |
| ⌘F | Find |
| ⌘G | Find next |
| ⇧⌘G | Find previous |
| ⌘D | Select next match |
| ⇧⌘L | Select all matches |
| ⌥↑ | Move line up |
| ⌥↓ | Move line down |
| ⌥⌘G | Go to line |

### Reviewing an edit

| Keys | Action |
| --- | --- |
| ↩ | Accept |
| ⇧↩ | Keep as alternative |
| ⌘R | Another version |
| ← | Previous version |
| → | Next version |
| 1–6 | Pick a synonym |
| ⌫ | Back to the list |
| Esc | Discard |

### Sidebar

| Keys | Action |
| --- | --- |
| F2 | Rename |
| ⌘⌫ | Move to Trash |

### Settings

| Keys | Action |
| --- | --- |
| Esc `⌘[` | Back |

<!-- shortcuts:end -->

## Your phone

The Kintsugi phone app is a notes app for your vault. It keeps its own copy of your writing (text only), so you can open, edit and start documents anywhere, and it syncs with Kintsugi on your Mac whenever the Mac is reachable. It connects over [Tailscale](https://tailscale.com), so nothing is exposed to the internet and there's no cloud copy of your writing.

1. Install Tailscale on the Mac and the phone, signed in to the same tailnet. In the Tailscale admin console, turn on **DNS → HTTPS Certificates**.
2. In Kintsugi on the Mac, click the phone icon at the bottom of the sidebar (green when phone access is on, red when off) and turn on phone access. Kintsugi runs `tailscale serve` to publish `https://<your-mac>.<tailnet>.ts.net:47474`.
3. Scan the QR code with the phone's camera, or click **Copy link** and paste it into the app.

Your folders are browsable, and chips above the list filter by **Drafts**, **Complete** and your tags. It opens where you left off. Tap the pencil, or type into **Capture an idea…**, to start a note; new notes go to `inbox/`, named after their first line. Paste a URL, or share a URL, text, image or screenshot into Kintsugi from another iPhone app, to save inspiration in `inspiration/`. Shares save on the phone first, then send to your Mac. If the Mac is asleep, they wait on the phone and send when it's back. **Inspiration** on the home screen shows your clips as a grid of cards with their images, kept on the phone so you can browse and search them offline; a clip opens to its source link, its summary and your notes, which you can edit there. The full source comes from the Mac when you ask for it. Edits carry the version they started from, so the phone never overwrites something you changed on the Mac. If both devices changed a document, edits to different parts merge on their own; only when both changed the same paragraph are you asked which version to keep. **Unpair phones** makes a new pairing code and signs out every phone that used the old one.

## Develop

A pnpm + Cargo monorepo:

| Path | What |
| --- | --- |
| `apps/desktop` | The Mac app: Tauri 2 (Rust) + React + CodeMirror 6 + shadcn/ui |
| `apps/mobile` | The phone app: Expo (React Native) + Expo Router |
| `packages/core` | Shared TypeScript: vault types, frontmatter, the phone API client |
| `packages/editor` | The CodeMirror editor |
| `packages/ui` | shadcn/ui components and the theme (`pnpm exec shadcn add …` from here) |
| `crates/vault` | The vault on disk: reading, versioned writes, captures |
| `crates/ingest` | The ingestion engine: source adapters to normalized Markdown items ([docs/ingest.md](docs/ingest.md)) |
| `crates/search` | Local hybrid search: FTS5 plus on-device model2vec embeddings, fused by rank ([docs/search.md](docs/search.md)) |
| `crates/rank` | Feed ranking: taste vectors, online logistic regression, exploration and diversity, offline replay; no LLM calls ([docs/ranking.md](docs/ranking.md)) |

```sh
pnpm install
pnpm desktop          # the Mac app; opens a native window (humans only)
pnpm desktop:headless # the Mac app in a browser tab against the real backend
pnpm desktop:seed <dir> # a deterministic scratch vault for screenshots
pnpm ios              # the phone app in the iOS Simulator (a development build)
pnpm test             # Rust and TypeScript tests
pnpm typecheck
```

To pair the Simulator with a development build of the Mac app, turn on phone access and click **Simulator link**, then open it in the Simulator: `xcrun simctl openurl booted "<link>"`.

### Testing without windows

Agents must not put the Mac app, Device Hub or Simulator on the owner's
screen. `pnpm desktop:headless` runs the real Rust command handlers on Tauri's
`MockRuntime` (no OS runtime, native window, Dock icon or focus) beside the
Vite frontend. It creates a fresh, gitignored
`.headless/run-<random>/{vault,config}` in this worktree, seeds the default
vault, and prints a per-run URL shaped like
`http://127.0.0.1:1422/#headless=http://127.0.0.1:1423&token=…`. Open exactly
that URL in a Volli Browser Tab; the fragment token is a local capability and
is removed from the address bar after load.

The frontend defaults to `1422` and the backend to `1423`; set
`KINTSUGI_FRONTEND_PORT` and `KINTSUGI_BACKEND_PORT` per worktree. Both bind
`127.0.0.1` only. The runner creates its scratch dirs (and any supplied
`KINTSUGI_VAULT`/`KINTSUGI_CONFIG_DIR`) when missing. Its config directory is
separate from the real app's, so the owner's vault choice, phone token and
clip receipts are untouched; `KINTSUGI_VAULT` is never persisted. Supplying
`KINTSUGI_VAULT` uses that vault as-is and does not seed it, so seed it first:

```sh
VAULT="$PWD/.headless/my-vault-$(date +%s)"
pnpm desktop:seed "$VAULT"
KINTSUGI_VAULT="$VAULT" pnpm desktop:headless
```

`desktop:seed` refuses any existing nonempty directory (there is no overwrite
flag) and never writes into the owner's real vault or config. AI is off by
default in headless mode; `KINTSUGI_HEADLESS_AI_READONLY=1` (old name:
`KINTSUGI_HEADLESS_PI_READONLY=1`) opts into read-only OpenCode, Pi and
environment credentials for an AI check. For the phone app, build with
`expo run:ios --device generic` and drive the Simulator with `xcrun simctl`;
never run `pnpm ios` or `expo run:ios` against a device. See
[Testing without windows](AGENTS.md#testing-without-windows) for the exact
commands, and [docs/headless.md](docs/headless.md) for the transport.

## CI

GitHub Actions runs `.github/workflows/ci.yml` on every pull request and every push to `main`, from a fresh checkout. A newer push cancels the run it replaces. `main` only takes changes whose four jobs pass:

| Job | Runner | What it runs |
| --- | --- | --- |
| TypeScript | Ubuntu | `pnpm install --frozen-lockfile`, `pnpm typecheck`, the unit tests (scripts, core, editor, desktop, mobile), `expo lint`, the phone's `export:check` and `pnpm lint:copy` |
| Rust | macOS (Xcode 27) | `cargo test --workspace`, then `cargo fmt --check`. Apple Vision doesn't work in GitHub's macOS VMs, so the Vision helper's fixture test is skipped there. |
| Runtime (headless) | macOS (Xcode 27) | `cargo test -p kintsugi --no-default-features --features headless`, then `pnpm --filter @kintsugi/desktop test:runtime` in headless Chromium |
| Packaged app | macOS (Xcode 27) | Builds a debug `Kintsugi.app` with `pnpm tauri build --debug --bundles app` and launches it on a scratch home, config and vault. It passes when the app's real webview has loaded the vault: with `KINTSUGI_SMOKE=1` the frontend calls `app_ready` and the app prints `KINTSUGI_SMOKE_READY` and quits (`scripts/smoke-app.mjs`). |

`.github/workflows/phone.yml` builds the phone app in Release for the iOS Simulator. It runs nightly, on demand and on pull requests that touch the phone app, and isn't required.

CI pins Rust to the version on the owner's Mac (1.94.1). Bump the `dtolnay/rust-toolchain@…` lines in `ci.yml` after `rustup update`.

CI needs no secrets. Kin uses its scripted mock model (`KINTSUGI_HEADLESS_KIN=mock`), and nothing is signed.

## Releasing

Releases are signed, notarized and published to [GitHub Releases](https://github.com/hussainph/kintsugi/releases). Installed copies check there at launch and every six hours, show a notice offering the update, and restart only after your edits are saved.

1. Bump `version` in `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/package.json` and the root `Cargo.toml`.
2. With `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `APPLE_ID` and `APPLE_PASSWORD` (an app-specific password) in the environment, the updater key at `~/.tauri/kintsugi-updater.key`, and the Developer ID identity in your keychain:

```sh
pnpm release:desktop             # build, sign and notarize into target/release/bundle
pnpm release:desktop --publish   # …and create the GitHub release with latest.json
```

The updater's public key lives in `tauri.conf.json`; keep the private key out of the repo. Losing it means installed copies can't verify future updates.
