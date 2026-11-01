# Kintsugi

**The goal:** make it easy and delightful for Hussain to write for his blog.
Most finished pieces are published there. References come from anywhere,
but most often from his own work (earlier posts, drafts, notes, projects),
so his own writing is a first-class source everywhere: in references,
search and the margin. Captured outside inspiration sits alongside it.

Around that, Kintsugi is growing into the loop that feeds the writing: a
Feed of new work, a curated Inspiration library, Ideas, and Kin, the agent
that reads everything alongside him (see `docs/vision.md`).

Judge every feature by whether it makes writing and publishing a blog post
easier or more pleasant. Kin finds, connects and offers ideas, and never
ghostwrites: prose is his, apart from edits he explicitly asks for.

- The blog: hussain.ph, an Astro + MDX site at `~/Desktop/code/3d-portfolio`
  (github.com/hussainph/hussain.ph)
- Product direction: `docs/vision.md`
- Product and contracts: `README.md`, `docs/inspiration.md`
- Phone app conventions: `apps/mobile/AGENTS.md`

## Git hosting

- The repository lives on **GitHub**: `github.com/hussainph/kintsugi`
  (private for now). `origin` points there; `main` is the default branch.
- Use `gh` for forge work (repo, PRs, issues). Kintsugi is not hosted on
  Entire or any other forge; don't add other remotes.

## Toolchain

- Xcode 27.1 (iOS 27.1 SDK and Simulator runtime, with the iPhone Duo
  simulator in Device Hub). Device Hub replaces Simulator.app.
- iPhone Duo is a first-class target for the phone app: test folded, open,
  partially open and in Split View. Most app extensions don't run in the
  iPhone Duo simulator, so test the share extension on a standard iPhone
  simulator or a device.

## Testing without windows

Never run `pnpm desktop`, `pnpm --filter @kintsugi/desktop tauri dev`,
`pnpm ios`, or `expo run:ios` with a simulator selected while working on the
owner's Mac. Those open native windows, Dock icons and Device Hub/Simulator.
Agents test through Volli Browser Tabs and `xcrun simctl` instead.

### Mac app

Start the headless backend and frontend in a background shell:

```sh
pnpm desktop:headless
```

It creates a fresh, gitignored `.headless/run-<random>/{vault,config}` in this
worktree, seeds the default vault with `scripts/seed-desktop.mjs`, and prints a
per-run URL:

```
Open in a Volli Browser Tab (token is per-run):
http://127.0.0.1:1422/#headless=http://127.0.0.1:1423&token=…
```

Open exactly that URL with `browser_navigate`. The fragment carries the
per-run token; the dev bridge removes it from the address bar and keeps it in
that tab's session storage for reloads. Treat it as a local capability:
loopback only, never paste it into a public page, log or issue.

Drive the app with `browser_snapshot`, `browser_act`, `browser_console` and
`browser_screenshot`, and attach screenshots to the review comment. Stop the
background shell when finished. To verify the backend process itself, run
`swift scripts/check-headless-macos.swift <backend-pid>`: it is read-only and
reports native window count, Dock policy and focus.

- Defaults are frontend `1422` and backend `1423`; set
  `KINTSUGI_FRONTEND_PORT` and `KINTSUGI_BACKEND_PORT` to choose other ports
  per worktree. Both bind `127.0.0.1` only.
- The backend is the real Rust command registry on Tauri `MockRuntime`, built
  with `--no-default-features --features headless` (debug only). It has no OS
  runtime, event loop, window, menu or Dock presence; commands, events and
  Channels are the same ones the native app uses. See [docs/headless.md](docs/headless.md)
  for the transport and why MockRuntime was chosen over a hidden Wry window.
- `KINTSUGI_VAULT` and `KINTSUGI_CONFIG_DIR` override the scratch directories;
  the runner creates either one if it is missing, and they must be separate.
  The config directory holds the scratch `config.json`, phone token and clip
  receipt journal, so the real app's vault choice, phone pairing and
  credentials are untouched. KI-7's isolated-vault override skips config
  reads/writes, and headless config lookup never falls back to the real app
  directory even if the override is missing. `KINTSUGI_VAULT` is never persisted
  to `config.json`. The runner and backend refuse the owner's standard
  vault/config and credential folders, their ancestors, descendants and symlink
  aliases. The path prompt only opens folders inside the initial scratch vault;
  restart with another override to change the top-level scratch folder.
- AI is disabled by default: no Pi credentials are read and providers report
  no auth. Set `KINTSUGI_HEADLESS_PI_READONLY=1` only for a read-only AI check;
  Pi credentials are then read without lock, refresh or write, so an expired
  login cannot be refreshed in headless mode.
- To try Kin's chat without any provider, set `KINTSUGI_HEADLESS_KIN=mock`: a
  scripted local model answers (no credentials read, nothing leaves the
  machine, $0). See `docs/kin.md` › The chat.
- A supplied `KINTSUGI_VAULT` is not seeded automatically. Build a scratch
  vault first:

  ```sh
  VAULT="$PWD/.headless/my-vault-$(date +%s)"
  pnpm desktop:seed "$VAULT"
  KINTSUGI_VAULT="$VAULT" pnpm desktop:headless
  ```

  `pnpm desktop:seed` refuses any existing nonempty directory (there is no
  overwrite flag) and always refuses the owner's vault/config. It writes
  ordinary Markdown/MDX with wikilinks plus bare and enriched clips with
  deterministic PNG artwork; it never fetches images or writes SVG.
- Native-only behaviour adapts inside the tab: the folder picker becomes an
  in-page path prompt; `open_url`/`open_path` open a browser tab through the
  validated backend, while `reveal_item_in_dir` reports that Finder is
  unavailable; phone settings are unavailable, and window drag is a no-op.
  Trash commands move scratch files into `$KINTSUGI_CONFIG_DIR/trash/<batch>/`
  with an `original-paths.json` recovery manifest. They never invoke Finder,
  request Automation permission, play a sound or touch the owner's Trash.

### Phone app

The phone app has no browser-mode equivalent. Build and drive the Simulator
with `xcrun simctl`; never open or activate Device Hub/Simulator.

Checked in the installed `@expo/cli@58.1.17` source (not run): `expo run:ios`
with a simulator selected always calls `activateWindowAsync()` before opening
the app (`build/src/start/platforms/PlatformManager.js`, `openProjectInCustomRuntimeAsync`).
That calls `ensureSimulatorAppRunningAsync()`
(`build/src/start/platforms/ios/AppleDeviceManager.js`), which runs
`open -a Simulator` and, on Xcode 27, falls back to the Device Hub URL
`devices://device/open?id=<udid>`
(`build/src/start/platforms/ios/ensureSimulatorAppRunning.js`); only the final
`osascript` focus is gated by `isInteractive()`. The one build-only path is
`--device generic`: it resolves no device and returns after the build
(`build/src/run/ios/options/resolveDevice.js`, `build/src/run/ios/runIosAsync.js`).

```sh
UDID=<udid from: xcrun simctl list devices available>

# Build only; no device is booted and no UI opens.
pnpm --filter @kintsugi/mobile exec expo run:ios --device generic --output "$PWD/.headless/ios"

# Boot, install and launch headlessly.
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$PWD/.headless/ios/Kintsugi.app"

# Metro for the Debug development build, in another background shell. CI=1
# keeps Expo from trying to open a browser.
CI=1 pnpm --filter @kintsugi/mobile start

xcrun simctl launch "$UDID" dev.phalasiya.kintsugi
xcrun simctl io "$UDID" screenshot "$PWD/.headless/ios/screenshot.png"
xcrun simctl shutdown "$UDID"
```

To give the Simulator a Mac to talk to, serve the real phone API on a
scratch vault (no desktop app, Tailscale or owner config involved; it refuses
any vault outside a `.headless` folder) and pair through the link it prints:

```sh
pnpm desktop:seed "$PWD/.headless/phone-vault"
KINTSUGI_PHONE_DEV_VAULT="$PWD/.headless/phone-vault" \
  cargo test -p kintsugi phone_dev_server -- --ignored --nocapture
xcrun simctl openurl "$UDID" 'kintsugi://pair?url=http%3A%2F%2F127.0.0.1%3A47475&token=TEST-TOKEN'
```

Stop that shell to take the "Mac" offline.

`xcrun simctl` talks to CoreSimulator without showing a window. If Device Hub
is already open on the owner's screen, leave it alone; don't activate it and
don't use it to inspect the app. Use `simctl io … screenshot` for evidence.
`pnpm ios` is a human convenience only; it runs `expo run:ios` with a device
and opens the UI.
