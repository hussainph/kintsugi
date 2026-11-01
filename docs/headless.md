# Headless desktop transport (development only)

See **Testing without windows** in `AGENTS.md` for the agent workflow.

## Why MockRuntime

We evaluated a hidden/windowless Wry runtime with `Prohibited`/`Accessory`
activation policy against Tauri's `test` feature. The latter is safer: there is
**no OS runtime or event loop at all**, so no race with macOS application
activation, default windows, Dock registration or a plugin showing a dialog.
The launcher uses `--no-default-features --features headless`; `tauri/wry` is not
linked. `mock_builder` also disables Tauri's macOS default menu. A mock webview
is only an IPC identity, not a native window.

`lib.rs::builder` owns one `generate_handler!` registry and one set of managed
states for both runtimes. Commands use a runtime-selected `AppHandle` alias.
HTTP invokes call `tauri::test::get_ipc_response`, which drives Tauri's argument
deserialization, state injection, real command and error serialization. There
is no mock vault, parallel command implementation, or per-command HTTP table.
`tests/command_registry.rs` fails if any declared application command is absent
from that registry. New handlers taking a default Wry `tauri::AppHandle` instead
of the shared alias fail the headless compile, rather than silently disappearing.

The browser installs a DEV-only `__TAURI_INTERNALS__` adapter **before** app
imports, only if Tauri is absent. The React/editor code uses the same `invoke`,
`listen`, and `Channel` APIs as the native app.

## Transport

- Frontend: `127.0.0.1:1422`; backend: `127.0.0.1:1423`. Both configurable.
- A 256-bit random per-run token is printed in a URL fragment (never a Vite
  query/access log). The shim removes the fragment and keeps it in that tab's
  session storage for reloads. Treat the printed URL as a local capability.
- `POST /invoke`: Bearer token; `{client, cmd, args}`; returns
  `{ok:true,value}` or `{ok:false,error}`.
- `GET /events`: token and client id query; SSE starts with `{ready:true}` then
  sends `{callback,payload}`. Invoke waits for that handshake to avoid losing
  initial channel messages.
- Native Rust `Listener` registrations back the event adapter. Tauri's channel
  interceptor forwards `{index,message}` directly, including large payloads
  (avoiding the native JS eval/fetch optimization). Binary channel messages use
  a byte envelope decoded to `ArrayBuffer` by the shim. Raw invoke responses
  (including `clip_image`) use that same generic envelope.
- Each tab has its own mock webview, callback namespace, bounded SSE queue and
  listeners. Disconnect tears down listeners and the identity. Overflow closes
  the stream rather than silently dropping ordered channel messages.
- Tauri's interceptor does not expose a channel's drop/end notification (it is
  JS eval in the SDK). Streamed data/errors work; a dropped channel's callback
  can remain registered until tab teardown. This dev-only limitation doesn't
  affect the native transport. Reload tabs between long streaming test runs.

## Isolation and native adapters

The runner creates `.headless/run-*/vault` and `config` inside this worktree and
seeds the default vault. Explicit vault/config overrides must be separate
scratch directories. `KINTSUGI_VAULT` is never persisted into `config.json`.
`KINTSUGI_CONFIG_DIR` covers config and capture receipt files. KI-7's shared
`isolated_dev` override skips app-config reads/writes altogether; headless config
and receipt lookup also fails closed if its config override is absent. Tests
point Tauri's normal config location at a synthetic owner sentinel and verify
it is never read or modified, even with missing overrides. Both the launcher
and Rust startup reject the owner's standard vault/config and credential
directories, descendants, ancestors and symlink aliases. The folder prompt can
only open subdirectories of this run's initial vault; restart with another
`KINTSUGI_VAULT` to choose a different top-level scratch folder.

AI is disabled by default, including environment-provider credentials. No
OpenCode or Pi credential file is read. `KINTSUGI_HEADLESS_AI_READONLY=1` (or
its old name, `KINTSUGI_HEADLESS_PI_READONLY=1`) opts into real AI and
enrichment. In this mode OpenCode and Pi credentials are read-only: no lock,
refresh or write is allowed; an expired login must be refreshed outside
headless mode (open OpenCode, or the native app for Pi). Both credential
folders (`~/.pi`, OpenCode's `$XDG_DATA_HOME/opencode` or
`~/.local/share/opencode`) are refused as scratch paths, with their ancestors. Phone
restoration is skipped and enabling phone access is refused because Tailscale
configuration is machine-global. The daily Ideas batch never starts on its own in
headless runs unless `KINTSUGI_HEADLESS_IDEAS_DAILY=1`, so a real-AI check
spends nothing on work nobody asked for.

Folder dialogs become path prompts. The opener adapter validates URLs/paths in
Rust and opens only within the headless browser, never via LaunchServices or
Finder. File previews/assets are confined to canonical files in the current
scratch vault; executable formats are served as plain text with `nosniff`.
Trash still goes through the real document/clip handlers and emits their
normal events, but the filesystem adapter moves files into
`$KINTSUGI_CONFIG_DIR/trash/<batch>/` with an `original-paths.json` recovery
manifest. It never invokes the trash crate's Finder AppleScript default,
requests Automation permission, plays a sound, or touches the owner's Trash.
Window dragging is a no-op. Other unsupported platform APIs fail explicitly.

The backend accepts only its exact loopback Host and frontend Origin, never
wildcard CORS. All content endpoints require the token; only CORS preflight is
unauthenticated. A release build cannot enable `headless` (compile-time error),
and ordinary release builds do not include the server or browser adapter.

## Checks

```sh
pnpm test:headless
cargo test --workspace -j "$VOLLI_CONCURRENCY_HINT"
pnpm --filter @kintsugi/core test
pnpm typecheck
```

`pnpm test:headless` includes `pnpm --filter @kintsugi/desktop test:runtime`:
it starts `pnpm desktop:headless` on free ports with a fresh seeded scratch
vault and drives the real app in headless Chromium (Playwright; no native
window). It makes a save fail with a read-only folder and checks that
switching documents, switching vaults and closing the window wait until a
retry succeeds or the writer discards the change (KI-14). It also edits, deletes
and renames files on disk while they are open, to check that the vault watcher
reloads, merges or asks, and never writes over another app's edit (KI-49).
The first run builds the headless backend; set `KINTSUGI_RUNTIME_TIMEOUT` (ms) if that is slow.
It needs Playwright's headless shell once:
`pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`
(set `PLAYWRIGHT_BROWSERS_PATH`, e.g. to `.headless/ms-playwright`, to keep it
in the worktree).

Headless integration tests exercise authenticated HTTP/SSE, command errors,
real document writes and clip events, the real `ai_stream` Channel's disabled
error, and config/receipt isolation without credentials or native windows.
