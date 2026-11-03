# Headless desktop transport (development only)

See **Testing without windows** in `AGENTS.md` for the agent workflow.

## Why MockRuntime

We evaluated a hidden/windowless Wry runtime with `Prohibited`/`Accessory`
activation policy against Tauri's `test` feature. The `test` feature is safer
because it has **no OS runtime or event loop at all**, so there is no race with
macOS application activation, default windows, Dock registration or a plugin
showing a dialog.
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
`~/.local/share/opencode`) are refused as scratch paths, with their ancestors.
Kintsugi's own credentials (Settings › Providers) are held in memory, never
written to the scratch config, and "Sign in" plays a scripted sign-in with no
network (see `docs/kin.md` › Credentials; `KINTSUGI_HEADLESS_SIGN_IN_MS` sets
how long its device code waits). Phone
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
Right after startup, the Library's and Kin's first searches find by words (KI-52).
The first run builds the headless backend; set `KINTSUGI_RUNTIME_TIMEOUT` (ms) if that is slow.
It needs Playwright's headless shell once:
`pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`
(set `PLAYWRIGHT_BROWSERS_PATH`, e.g. to `.headless/ms-playwright`, to keep it
in the worktree).

Headless integration tests exercise authenticated HTTP/SSE, command errors,
real document writes and clip events, the real `ai_stream` Channel's disabled
error, and config/receipt isolation without credentials or native windows.

## Flaky runtime tests (KI-47)

The runtime suite's reporter (`test/reporter.ts`) prints one line per test
and, for a failure, its file and line and the error's first lines (a
Playwright call log is cut to the locator it was waiting for). Every failure
is listed again at the end, so the tail of one log says what broke.

Patterns that made the suite fail now and then, mostly on a loaded machine:

- **Measuring a node the editor is about to replace.** The `[[` picker and
  `/` menu rebuild their rows and hint on every update, including when the
  search answers ~120 ms later. `boundingBox()` on a row taken before then
  can come back `null` (the row was detached). Wait for the settled state
  (the hint no longer says "Searching…") and measure inside the page in one
  `evaluate`.
- **Sleeping for background writes.** Feed impressions are batched and sent
  1.5 s after the first one; a 2 s sleep before reading `feed.sqlite` is a
  500 ms margin, gone under load. Undo, unlike and open events are also
  separate invokes. Poll the database (or file) until the state is there,
  with a deadline, rather than sleeping.
- **Reading a file the app writes after the event the test waited for.**
  A Kin helper's report is logged (and shown) before `jobs.json` marks the
  job done, on purpose. Wait for the table, since the message comes first.
- **Waiting on a status that runs ahead of the work.** Settings → Blog
  shows "2 posts, mirrored read-only" as soon as the folder is saved, from a
  count of the repository; the import that writes the mirror runs after it.
  Wait for the import's summary toast before reading the mirror.
- **Waiting for something that was already there.** After narrowing a
  list (⌘P `#craft` → `#craft kiln`), waiting for a row that both lists
  share passes at once, and a count can read the list from before the
  filter. Wait for a row that must go to be detached, then count.
- **Counting before a batch is in.** Wait for the status that says the
  batch has arrived ("Two from Kin today"), then count rows.
- **App races that look like flakiness.** As in KI-39, check the app before
  the test: `openDoc` let an earlier, slower read win, so the startup open
  of the last document could replace one he clicked while the vault loaded.
  Opens are now sequenced (only the latest lands), and the startup open is
  skipped once anything else has been opened.
  Settings → Blog had the same shape: the stored path, loading when the
  dialog opened, overwrote a folder typed before it arrived, so Save sent
  an empty path. A late load no longer replaces what he typed or saved.

Sleeps that remain are for screenshots or before checking that something
did *not* happen; those can only pass wrongly, never fail spuriously.

KI-82 found more of the same:

- **Reading the file instead of the screen.** Settings writes
  `kin/settings.json` before the save answers, and the effort slider shows
  the new level only then. After the file changes, wait for the slider too.
- **Counting on the layout.** An impression counts once half an item is on
  screen. Picked for you, above the Feed's list, can arrive before the list
  was first seen and push all but its top item below the fold. Scroll the
  items you expect into view.
- **Racing a timer in a Rust test.** A test that typed every 100 ms to keep
  a 300 ms idle timer from firing failed when its thread was paused for
  longer. The timer's check (`idle_since`) is now a method the test calls
  itself, so the outcome no longer depends on scheduling.
- **Leaving the app running after the file ends.** `after` used to send
  SIGTERM and return. The app then stopped while node:test was already
  finishing the file, or while the next file started beside it (or, in the
  Ideas test, a restarted app on the same vault). `stopRunner` in
  `test/headless-app.ts` now waits until the runner, backend and Vite have
  exited.
- **An app race behind Escape.** Reopen on a resolved comment focused the
  reply box on the next frame. The box stays hidden until the new status
  arrives, and when that came later, focus fell to the page. Escape then
  never reached the popover. The reply box now takes focus when the
  reopened thread is drawn, and the test waits for that focus before
  pressing Escape.
- **Letting a test's first step wait for the app to load.** Once both
  Links tests timed out on their first locator in a full run. A first load
  that never finishes looked like a failing step. `openApp` now waits in
  setup until the sidebar lists the vault, and if it doesn't, it fails with
  the page's errors and the runner's output.
- **Errors after a test ends.** node:test reports those as a diagnostic and
  fails the file with only "test failed". The reporter used to drop that
  diagnostic. It now prints it (with a ⚠) and says how the file's process
  ended (exit code or signal).
