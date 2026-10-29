# Headless share acceptance (KI-2)

Drives the **real system share sheet** on a booted-but-windowless iOS simulator
and proves that the installed Kintsugi share extension — not the app — saves a
capture and delivers it to the Mac. No Simulator.app, no Device Hub, no window,
no private APIs, no `idb`, no UI scripting: `xcodebuild test` + `xcrun simctl`
only.

**URL and image acceptance passed** on a dedicated standard iPhone 17,
iOS 27.0 (24A434), built with Xcode 27.1 (27A9275) / iOS Simulator SDK 27.1.
The signed Release app and embedded extension were installed, paired through
the real deep link (XCTest approved iOS's first-use Open confirmation), then
Kintsugi was terminated before each share. The fake Mac received authenticated
URL and PNG captures with the typed note and UUID; each acknowledged capture
left the App Group queue empty. The PNG decoded to 875,819 bytes. These are
real extension/Keychain/queue tests against a loopback stub, not a desktop or
hardware acceptance claim. The local run's summary, journal and exported UI
attachments were manually copied to `.expo/share-acceptance/evidence-happy/`;
the `url.xcresult` / `image.xcresult` bundles also remain under `results/`.
Subsequent runs overwrite the journal, summary and same-named result bundles.

The opt-in **drain case also passed**: the journal records a committed/lost
extension request, a 503 on its retry, then the app's 200 with the same UUID,
content digest and original path (`dedup: true`). The queue was empty after
acknowledgement. Its journal and summary were preserved in `evidence-drain/`.
Plain-text sharing also passed (24 UTF-8 bytes, `via: share`, no URL) on an
alternate port, with its evidence copied to `evidence-text/`. Phone URL capture
passed too: prose retained **Save to inbox**, the exact URL offered **Save
inspiration**, and the app delivered it with `via: phone` and a UUID. That
journal is in `evidence-phone/`. The strengthened URL/image assertions passed
again on port 8852 (`evidence-all/`), confirming the scheme's port plumbing.

## What it consists of

| Path | Role |
| --- | --- |
| `run.sh` | orchestrator: detects runtime/device, boots, installs, pairs, runs the cases, asserts |
| `project.yml` | xcodegen spec for the two small targets (generated into `.expo/share-acceptance/project`) |
| `Sources/ShareHarnessApp.swift` | a plain UIKit host app with Share URL / Share Image / Share Text buttons that present `UIActivityViewController` |
| `UITests/ShareSheetDriver.swift` | finds “Kintsugi” in the sheet, types a note, taps Save; attaches element trees on failure |
| `UITests/CaptureAcceptanceTests.swift` | deep-link confirmation, URL/image/text shares, phone capture box |
| `Mac/fake-mac.mjs` | dependency-free stand-in for the Mac API with a JSONL journal and fault modes |
| `Mac/fake-mac.test.mjs` | sender isolation, single commit, semantic digest and receipt tests for the stub |
| `Mac/guard-queue.test.mjs` | seven isolated tests for preserving existing native/legacy queues before pairing |

The host app deliberately declares **no App Group and no Keychain entitlement**,
so anything that appears in Kintsugi's queue or on the fake Mac can only have
been written by the real extension embedded in the real app.

Everything generated lives in `apps/mobile/.expo/share-acceptance/` (gitignored):
`project/`, `DerivedData-harness/`, `DerivedData-app/`, `results/`,
`screenshots/`, `logs/`, `journal/mac.jsonl`, `queue/`, `summary.md`.
`apps/mobile/ios/` is never read for edits and never regenerated here — this
script does not run `expo prebuild` or `pod install`.

## Running it

```sh
cd apps/mobile/share/acceptance
./run.sh preflight      # toolchain, runtime, device, artifact — boots nothing
./run.sh run            # boot + install + pair + url + image cases
```

`run` needs a built app. Either let the script build it (needs
`apps/mobile/ios/Pods`, i.e. `pod install` already done) or hand it one:

```sh
KI2_APP_PATH=/path/to/Kintsugi.app ./run.sh run
KI2_APP_PATH=… KI2_SKIP_APP_BUILD=1 ./run.sh run
```

A Release build embeds the JS bundle, so nothing else needs to run. A Debug
build needs Metro on port 8081 for the pairing screen and the outbox drain.

The script creates and reuses its **own** simulator, “KI-2 acceptance iPhone”
(iPhone 17, iOS 27.x, `bootstatus -b` headless), so it never boots or mutates
the owner's devices. `KI2_UDID` opts into a specific device instead: **pairing
is replaced with the test Mac**, even without `KI2_RESET=1`. Use a dedicated
simulator, not a personal app install. Before reset/install and again before
pairing, a read-only guard refuses existing shared captures, quarantined bytes,
legacy SQLite captures/recovery keys, or an unreadable legacy database. SQLite
inspection uses a worktree snapshot so no WAL files are created in the app
container. The simulator stays booted afterwards;
the script stops only its own fake Mac process. Runtime selection excludes
Duo-only images. The executed run used standard-iPhone iOS 27.0, since the
installed 27.1 image offered only Duo; both use Xcode's 27.1 SDK.

### What a pass means

* the queue was empty after pairing, and the share sheet ran from a real
  `UIActivityViewController` source;
* the extension appeared and enabled Save, so it understood the URL / PNG;
* the note was typed into the extension's own field and Save dismissed the sheet
  with the sharing app back in front;
* the extension process delivered `POST /v1/clips` to the fake Mac with
  `via: "share"`, the note, and (image case) `imageType: "image/png"` and a
  non-zero decoded image, after Kintsugi was **terminated** — starting that
  authenticated upload requires the extension to read the shared Keychain item.
  iOS may subsequently relaunch Kintsugi in the background for URLSession events;
  Save must never open its foreground UI;
* the capture was removed from the App Group queue only after a 2xx with
  `{path}`, which is the extension's acknowledgement rule.

### Artifact guards (fail loudly, never silently “pass”)

* no available standard-iPhone iOS runtime → exit 2 with the owner's install command;
* existing queued/recovery data → stop before reset/pairing, preserve it and
  request a fresh dedicated simulator; never redirect old captures to the stub;
* the device must be an available standard iPhone on that runtime; the Duo is
  rejected (`deviceTypeIdentifier` check);
* `KintsugiKeychainGroup` in the extension's built `Info.plist` must be a real
  group, not a literal `$(AppIdentifierPrefix)…` (that would make
  `CapturePairing.baseQuery()` throw, so shared pairing cannot work);
* app and extension must have valid bundle signatures and carry App Group /
  shared-Keychain entitlements in the built executable. Simulator builds often
  embed these in Mach-O's `__TEXT,__entitlements` section rather than the empty
  ad-hoc signature; the guard checks that section, not a source plist. Runtime
  delivery and App Group inspection are still required to prove functionality.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `KI2_UDID` | — | use this simulator instead of the owned one |
| `KI2_APP_PATH` | — | use an existing `Kintsugi.app` |
| `KI2_SKIP_APP_BUILD` | `0` | `1` requires `KI2_APP_PATH` |
| `KI2_RUNTIME_PREFIX` | `27.` | newest available iOS runtime with this prefix |
| `KI2_DEVICE_NAME` | `KI-2 acceptance iPhone` | the device the script owns |
| `KI2_DEVICE_TYPE` | `…SimDeviceType.iPhone-17` | device type used when creating it |
| `KI2_PORT` / `KI2_TOKEN` | `8848` / `test-token` | fake Mac; loopback only, test token only |
| `KI2_ONLY` | — | `url`, `image`, `text`, `phone`, or `drain` |
| `KI2_RESET` | `1` owned device, `0` given UDID | uninstall app + reset that device's keychain first |
| `VOLLI_CONCURRENCY_HINT` | — | passed to `xcodebuild -jobs` |

The default `run` is the minimum end-to-end proof: URL and image. `text`,
`phone` and `drain` are opt-in extras. `phone` checks that prose offers **Save
to inbox**, then replaces it with a URL and saves via **Save inspiration**.
The journal must receive that exact URL with `via: phone`, a UUID and app
User-Agent, and the queue must become empty.

`drain` uses one stateful `handoff` fault mode: the first extension upload is
committed and its reply dropped; subsequent extension retries get 503. After
a logged 503, the sole persisted payload must still carry the lost-response
UUID. A journal marker precedes explicit app launch. Only a later `Kintsugi/`
request can succeed; it must match the original UUID, semantic-content digest
and receipt path, with `dedup: true` and exactly one non-deduplicated commit.
The queue must then be empty. This forces extension failure to exercise app
handoff; it does not imply a dropped connection normally stops URLSession's
own retries. An earlier discovery run observed `KintsugiShare/` retrying and
receiving a deduplicated reply before the app launched.

### Fake Mac

`./run.sh server` runs it in the foreground. `GET /v1/hello` answers
`{app:"kintsugi", api:2, vault:"acceptance"}`; `GET /v1/tree` and `/v1/clips`
answer `[]`; `POST /v1/clips` validates the bearer token and the capture shape,
answers `{path}`, and dedupes by `id`. Faults switch at runtime through
`POST /_control {"mode": …}`: `offline` (drop before reading), `lost` (commit,
then drop the reply), `500`, `400`, and `handoff` (described above). Unknown
or missing User-Agents fail closed with 503 during handoff. Every request is
journaled to `journal/mac.jsonl`:

| Event | Evidence fields |
| --- | --- |
| `clips` | `id`, `via`, `url`, `note`, byte counts, `imageType`, `capturedAt`, `userAgent`, `status`, `outcome` |
| commit / duplicate | original `path` and `dedup` (false only on the first commit) |
| body | raw `bodySha256` plus a full `captureSha256` ignoring JSON key order and escaped slashes |
| `control` | mode and UTC time; repeated handoff mode marks explicit app launch without clearing receipts |

Run all eight harness regression tests without booting a simulator:

```sh
node --test apps/mobile/share/acceptance/Mac/*.test.mjs
```

These passed, including fail-closed native/SQLite safety fixtures. The guard
also passed against the actual dedicated simulator's empty outboxes.

## Limitations / not covered here

* Share-sheet driver failures attach the harness and SpringBoard element trees
  to `.xcresult`; read those if accessibility labels differ on another iOS
  version. Each UI test has a 180-second execution ceiling. Xcode's verbose
  sysdiagnose collection is disabled; explicit screenshots/trees are retained.
* Only the URL and image happy paths are in the default run. Rejection
  (`400/413/422` → `rejection` marker), the >15 MB image error, Safari and Photos
  as share sources, dark mode / Dynamic Type, and the opt-in phone/drain cases
  are not asserted by default.
* The Mac is a local stub, not the desktop app over Tailscale: real TLS, the real
  vault, and the real server's bounded dedupe are outside this harness.
* Simulator ad-hoc signing validates shared-Keychain access on the simulator,
  not hardware provisioning or a locked-device (`AfterFirstUnlock`) upload.
  Do not use unsigned artifacts for acceptance (`run.sh` requires valid signatures).
* Background `URLSession` scheduling and app relaunch on hardware remain
  unverified. `drain` proves queue persistence and app-side same-UUID delivery
  when the stub forces extension retries to fail; it does not simulate the
  device being locked or prove a callback after an OS-killed extension.
* The iPhone Duo and foldable/Split View extension behaviour are out of scope
  (extensions do not run there), and third-party share sources (X, Instagram,
  YouTube) need a device with those apps installed.

## Ownership handoff

This directory is owned by the KI-2 harness work; nothing outside it is edited
by these files. To take over:

1. `./run.sh preflight` — confirm runtime, device and artifact.
2. `KI2_APP_PATH=… ./run.sh run` (or let it build once Pods exist).
3. Read `apps/mobile/.expo/share-acceptance/summary.md`, `journal/mac.jsonl`,
   `screenshots/*.png`, `queue/*/captures.txt`; `.xcresult` bundles hold the UI
   trees and screenshots on failure.
4. If the sheet's accessibility labels differ, adjust only
   `UITests/ShareSheetDriver.swift`; the assertions live in `run.sh`.
