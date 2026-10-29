# Kintsugi

A writing app where your words stay at the center. Kintsugi is a minimal macOS editor for long-form Markdown and MDX, with a phone app for capturing and editing while you're away from the desk. The AI will help in the margins (suggestions, rewrites, research threads), but it never writes for you.

Your writing lives in a **vault**: a plain folder of `.md` / `.mdx` files (by default `~/Documents/Kintsugi`). Each document's frontmatter holds a `status` of `draft` or `complete`.

## Shortcuts

| Keys | Action |
| --- | --- |
| ⌘N / ⇧⌘N | New document / folder |
| ⌘P | Jump to a document |
| ⌘\ | Toggle the sidebar |
| ⌘K | Edit the selection with AI: tighten, rephrase, synonyms… |
| ⇧⌘D | Toggle draft / complete |
| ⌘F | Find in document |
| ⇧⌘O | Open a different vault |
| ⇧⌘I | Open the Inspiration library |
| F2, ⌘⌫ (in the sidebar) | Rename, move to Trash |

## Your phone

The Kintsugi phone app reads, edits and captures into your vault while Kintsugi is open on your Mac. It connects over [Tailscale](https://tailscale.com), so nothing is exposed to the internet and there's no cloud copy of your writing.

1. Install Tailscale on the Mac and the phone, signed in to the same tailnet. In the Tailscale admin console, turn on **DNS → HTTPS Certificates**.
2. In Kintsugi on the Mac, click **Connect your phone** at the bottom of the sidebar and turn on phone access. Kintsugi runs `tailscale serve` to publish `https://<your-mac>.<tailnet>.ts.net:47474`.
3. Scan the QR code with the phone's camera, or click **Copy link** and paste it into the app.

Ideas captured as text go to `inbox/` as new drafts. Paste a URL, or share a URL, text, image or screenshot into Kintsugi from another iPhone app, to save inspiration in `inspiration/`. Shares save on the phone first, then send to your Mac. If the Mac is asleep, they wait on the phone and send when it's back. Edits carry the version they started from, so the phone never overwrites something you changed on the Mac; you'll be asked which copy to keep. **Unpair phones** makes a new pairing code and signs out every phone that used the old one.

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
`MockRuntime` — no OS runtime, native window, Dock icon or focus — beside the
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
default in headless mode; `KINTSUGI_HEADLESS_PI_READONLY=1` opts into read-only
Pi credentials for an AI check. For the phone app, build with
`expo run:ios --device generic` and drive the Simulator with `xcrun simctl`;
never run `pnpm ios` or `expo run:ios` against a device. See
[Testing without windows](AGENTS.md#testing-without-windows) for the exact
commands, and [docs/headless.md](docs/headless.md) for the transport.
