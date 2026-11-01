# Capture from the iOS share sheet

The native share sheet previews one URL, text, image (including a screenshot), or
PDF/EPUB file, accepts an optional note, and saves without opening the app or
waiting for the Mac.
Its neutral light/dark palette follows `src/theme.ts`, with system Dynamic Type
and a serif text preview. It does not fetch previews over the network.

## Native generation

`app.json` enables `plugins/with-capture.js`. Expo prebuild generates the
`KintsugiShare` target, embeds it in the app, and copies the Swift sources from
`share/` and `modules/capture/ios/Shared/`. **Do not edit `ios/`.** The local Expo
module is autolinked from `modules/capture/` into the containing app only.

Why a local plugin: SDK 58's built-in `expo-sharing` incoming-share flow opens
the main app (the versioned docs explicitly call this experimental and not
Apple-supported). `expo-share-extension` runs a separate React Native bundle;
we need neither a second JS runtime nor its memory/startup cost for this tiny
form. `@bacons/apple-targets` can create native targets, but a single fixed target
only needs Expo's existing config-plugin/Xcode support. At evaluation,
`expo-share-extension`'s compatibility table stopped at SDK 54 and
`@bacons/apple-targets` 5.0.0 pinned SDK 55 prebuild tooling; neither documented
a verified SDK 58 release. The local implementation
has no extra native runtime dependency. This is a native development build,
not an Expo Go feature.

References reviewed:
- https://docs.expo.dev/versions/v58.0.0/sdk/sharing/
- https://docs.expo.dev/versions/v58.0.0/sdk/securestore/
- https://docs.expo.dev/build-reference/app-extensions/
- https://docs.expo.dev/modules/get-started/
- https://github.com/MaxAst/expo-share-extension
- https://github.com/EvanBacon/expo-apple-targets

## Persistence, pairing, delivery

- The app and extension have App Group `group.dev.phalasiya.kintsugi.capture`.
  Each capture is an atomically committed directory with a flushed payload and
  small metadata file. Image bytes are base64 in the payload (API limit: 15 MB
  before encoding; only the API's raster MIME allowlist is accepted). There is
  no shared read-modify-write array to lose captures. The POST payload carries
  a separate UUID `id` (not the sortable queue-directory ID). Swift uses
  `UUID().uuidString`; phone capture uses SDK 58 `expo-crypto.randomUUID()`.
  It is generated before persistence, never in the delivery callback.
- **PDFs and EPUBs** (`com.adobe.pdf`, `org.idpf.epub-container`, or a `.pdf`/`.epub`
  file URL from Files), one per share. The activation rule adds
  `NSExtensionActivationSupportsFileWithMaxCount: 1`; it can't name file types, so
  any single file shows Kintsugi and the sheet refuses other types, empty files,
  files over 50 MiB (`MAX_CLIP_FILE_BYTES`) and files whose first bytes aren't a
  PDF (`%PDF-` in the first KiB) or a ZIP (EPUB), with a message and without saving.
  A file is the whole capture: a URL, text or image the host adds beside it
  (Safari's page URL, a thumbnail) is dropped; the note still applies. The sheet
  previews the file name, a document/book glyph, the type and size.
  At load the file is copied (an APFS clone, no bytes in memory) into the
  extension's temporary folder. Save calls `CaptureStore.enqueue(fields:file:)`,
  which writes the small fields as JSON, then base64-encodes the file straight into
  `payload.json` 192 KiB at a time, so neither the file nor its encoding is ever
  whole in memory (a 50 MiB file peaks at ~9 MiB resident in the standalone tests;
  the extension limit is ~120 MB). The payload carries `file`, `fileType`
  (`application/pdf` / `application/epub+zip`) and `fileName` (the original name,
  never a path, ending in `.pdf`/`.epub`), up to 70 MiB committed. `meta.json`
  records `"file": true`, and `pending()` lists such captures with `file: true`.
- **The app delivers files, never the extension's background upload.**
  `CaptureDelivery.start` refuses a file capture (`needsApp`): only the app knows the
  Mac's `hello.api`, and a 67 MiB upload would outlast the 30-second resource
  timeout and 120-second lease. The app sends one only to a Mac with
  `hello.api >= 4` (`CLIP_FILE_API`). An older Mac leaves it queued, unclaimed and
  unrejected (flagged captures aren't even read; an unflagged payload with `file`
  is released after reading), and Home says *Update Kintsugi on your Mac to send
  files.* The sheet says the app sends it the next time it opens. 400/413/422
  rejections preserve the file payload like any other.
- Only a successful local write allows Save to dismiss. Storage failure keeps
  the sheet open. No pairing or network connection is required to save.
- `CaptureDelivery` claims the saved item and resumes a background URLSession
  upload **from the payload file** before dismissal. The system can finish it
  after the extension exits; an Expo app-delegate subscriber receives its events.
  Each extension launch uses its own session identifier; the app reconnects only
  for that callback and invalidates the session once its events are settled.
- Background uploads use 8-second request / 30-second resource timeouts. Only a
  2xx response with `{path: string}` removes the item. Connectivity failures leave
  it for the main app, which drains at launch/foreground, pull-to-refresh, and every
  30 seconds while Home is active. A 120-second lease excludes simultaneous
  app/extension delivery and expires if a sender dies. Queue listings contain
  metadata only; the app reads one image payload at a time. The extension encodes
  directly to JSON bytes off the main thread, without a JSON String roundtrip or
  another full parse. Native HTTP 400/413/422 replies write a durable `rejection`
  marker: bytes remain in place, the app shows a warning, and automatic claims
  stop. Other captures keep sending. Connectivity and authorization failures
  stop the current pass and remain retryable.
- The main app uses `Remote.captureClip`, `HttpError`,
  `isPermanentCaptureStatus` and `ClipCapture` from core (KI-1/KI-10). Only
  400/413/422 mark a capture rejected. 500/503/408/429, unknown errors and
  malformed success acknowledgements preserve the bytes and release the lease
  for another attempt. Retries back off while the app is open (30 seconds up to
  30 minutes); restart may retry sooner, always with the same persisted UUID.
  `Offline` remains retryable; `Unpaired` pauses delivery for pairing again.
  Rejected payloads are at `Captures/captures/<queue-id>/payload.json` in the App
  Group; they are never deleted or silently retried, including after restart.
- Old native captures missing a UUID are migrated atomically under the queue
  lock before claim/read/upload handoff. A crash after updating the payload but
  before metadata keeps that same UUID on recovery. The native Data overload
  scans top-level fields without copying the large image string; the app's
  String entry point still validates JSON fully. Private SQLite URL captures
  migrate in a single value write at load, before sending; a failed write blocks
  delivery instead of creating an ephemeral per-attempt ID. Existing rejection
  flags stay paused: their historical generic HTTP status cannot be recovered.
- Pairing stays in `expo-secure-store` and is mirrored at launch/pair/unpair to
  a separate shared Keychain item. Its access group is expanded from
  `$(AppIdentifierPrefix)dev.phalasiya.kintsugi.capture` in both targets. The
  default app Keychain group stays first so existing pairings survive migration.
  Tokens never enter App Group preferences or payload files. The mirrored item
  is after-first-unlock, this-device-only, to permit background delivery.
- Plain text from the phone capture box still goes to the inbox. A complete
  HTTP(S) URL goes to `/v1/clips` with `via: phone`; share captures use `via: share`.
  A bare ISBN-10/13 (`parseIsbn` in `@kintsugi/core/books`; hyphens and an `ISBN`
  prefix allowed, check digit verified) is captured as `url: isbnUrl(isbn)`
  (`https://openlibrary.org/isbn/<isbn>`); the button says **Save book** and the
  Mac's enrichment makes it a book clip. An ISBN inside prose stays a note.
  Macs advertising `hello.api < 2` leave clips queued and show an update hint.
  Old SQLite inbox captures remain readable. Non-iOS URL captures use that
  existing durable SQLite outbox. An unreadable old SQLite queue is copied intact
  to an `outbox.recovery.<timestamp>` key before resetting it, with a visible
  warning; a storage failure never overwrites the original queue.

Delivery is **at least once**, with bounded server-side deduplication. Deploy
KI-10 on the Mac: it remembers the latest 1024 distinct capture UUIDs per vault
and returns the original path without another clip/media/event, including after
trash. The same payload UUID survives extension-to-app handoff, process restart,
lost-response retries and lease expiry. Older in-flight requests sent without
an ID cannot be deduplicated retroactively; receipt eviction/deletion or sending
to a different vault ends that deduplication guarantee. Queue data is never
discarded on an HTTP error. Damaged native captures are moved to
`Captures/malformed/` in the App Group for recovery rather than overwritten.

Apple signing must provision the App Group and shared Keychain entitlement for
both bundle IDs (`dev.phalasiya.kintsugi`, `dev.phalasiya.kintsugi.share`). The
plugin also declares the extension for EAS credential discovery.

## Checks

From the repository root:

```sh
pnpm install
pnpm --filter @kintsugi/mobile typecheck
pnpm --filter @kintsugi/mobile lint
pnpm --filter @kintsugi/mobile test
bash apps/mobile/modules/capture/ios/Tests/run.sh
pnpm --filter @kintsugi/mobile exec expo prebuild --platform ios --no-install
(cd apps/mobile && node plugins/verify-capture.cjs)
xcrun simctl runtime list
xcrun simctl list devices available
```

Use a **standard iPhone on a compatible iOS 27.x runtime**, not the iPhone Duo
(its simulator does not support most app extensions). Choose the newest runtime
that offers a standard iPhone: if 27.1 is Duo-only, use 27.0 with Xcode's 27.1
SDK. Keep all acceptance runs headless: do not open Device Hub or Simulator.app. Use the **actual device UUID** from that list, not
an assumed model name. Build with `xcodebuild`, boot via `xcrun simctl boot`, and
install/launch/open URLs via `simctl`. Screenshots use `simctl io … screenshot`.
The Expo command below is for interactive development only, not the owner's
headless acceptance run:

```sh
pnpm --filter @kintsugi/mobile exec expo run:ios --device <UUID>
```

Automated headless acceptance uses a separate UIKit share source and XCTest,
not a custom capture entry point. See [`acceptance/README.md`](acceptance/README.md)
for the signed-build guards, loopback Mac stub, run commands, evidence and
hardware limitations. URL/PNG/text shares, phone URL capture and same-UUID
app handoff passed on iPhone 17 / iOS 27.0, built with Xcode 27.1. Delivery used
a loopback stub; this does not claim Safari/Photos, Tailscale or hardware testing.

Additional manual acceptance on Simulator/device:
1. Pair once; share a Safari URL. Check the source preview, add a note, Save.
   The host app should reappear without launching Kintsugi. Verify the Mac's
   `inspiration/` clip and `via: share`.
2. Share one image from Photos and a screenshot. Check the thumbnail and saved
   media, including a caption/note. Verify 15 MB+ images give a visible error.
2a. Share a PDF from Files and from Safari, and an EPUB from Files. Check the file
   name/glyph preview and the note. A 50 MB+ PDF, a `.docx` and a `.zip` must show
   an error and save nothing. With a Mac at `hello.api` 3 the capture stays
   queued with the update note; at API 4 the app sends it on open and a
   `document`/`book` clip appears. Type `978-0-306-40615-7` in the capture box:
   **Save book**, and a book clip on the Mac.
3. Make the Mac unreachable; repeat URL and image shares; terminate the extension
   immediately after Save. Reopen the app with the Mac reachable and verify both
   drain. Also retry with the app left open and the Mac waking later.
4. Unpair, share, and Save: it must still persist. Pair again; verify delivery.
5. Paste a URL into the phone capture box: it should say **Save inspiration** and
   create a clip; ordinary prose still says **Save to inbox**.
6. Exercise light/dark mode, larger Dynamic Type, provider errors, repeated Save,
   cancellation, failed API replies, and a cold app launch during background upload.
7. Drop a successful response after the Mac commits. Retry the queued capture:
   its payload UUID and returned path must match, with one clip and one event.
   Retry again after trash: do not recreate the clip. Check 400/413/422 pause
   and preserve, whereas 500/503/408/429 release and retry with the same UUID.
   A malformed 2xx body must not acknowledge/remove the capture.

A quick headless check of the extension alone (no pods, simulator or signing),
after prebuild:

```sh
cd apps/mobile
xcodebuild -project ios/Kintsugi.xcodeproj -target KintsugiShare -sdk iphonesimulator \
  CODE_SIGNING_ALLOWED=NO SYMROOT="$PWD/.headless/share-build" OBJROOT="$PWD/.headless/share-build/obj" build
rm -rf .headless/share-build
```

For a supplemental syntax/API check when only the macOS SDK is available,
`Shared/*.swift` and `ShareViewController.swift` can be typechecked against
`arm64-apple-ios16.4-macabi` with the SDK's `System/iOSSupport` frameworks. This
checks the UIKit/SwiftUI sources, not the ExpoModulesCore bridge or iOS runtime.

The generated-project verifier is not an iOS compile or a real share test. Both
still need Xcode with a compatible iOS Simulator platform/runtime (and device
signing to validate Keychain groups on hardware).
