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

Captures go to `inbox/` as new drafts. If the Mac is asleep, they wait on the phone and send when it's back. Edits carry the version they started from, so the phone never overwrites something you changed on the Mac; you'll be asked which copy to keep. **Unpair phones** makes a new pairing code and signs out every phone that used the old one.

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
pnpm desktop          # the Mac app
pnpm ios              # the phone app in the iOS Simulator (a development build)
pnpm test             # Rust and TypeScript tests
pnpm typecheck
```

For an isolated desktop run, use an existing scratch folder:

```sh
mkdir -p target/scratch-vault
KINTSUGI_VAULT="$PWD/target/scratch-vault" pnpm desktop
```

Debug builds open that vault without reading or persisting the normal app
config, and skip phone/enrichment services. An invalid scratch path fails
instead of falling back to `~/Documents/Kintsugi`. Release builds ignore the
override. If another dev server is on port 1420, pass a Tauri `--config`
override with a different `build.devUrl` and `build.beforeDevCommand` port.

To pair the Simulator with a development build of the Mac app, turn on phone access and click **Simulator link**, then open it in the Simulator: `xcrun simctl openurl booted "<link>"`.
