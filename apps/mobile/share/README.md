# Capture from the iOS share sheet

The native share sheet previews one URL, text, or image (including a screenshot),
accepts an optional note, and saves without opening the app or waiting for the Mac.
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
  before encoding). There is no shared read-modify-write array to lose captures.
- Only a successful local write allows Save to dismiss. Storage failure keeps
  the sheet open. No pairing or network connection is required to save.
- `CaptureDelivery` claims the saved item and resumes a background URLSession
  upload **from the payload file** before dismissal. The system can finish it
  after the extension exits; an Expo app-delegate subscriber receives its events.
  Each extension launch uses its own session identifier; the app reconnects only
  for that callback and invalidates the session once its events are settled.
- Background uploads use 8-second request / 30-second resource timeouts. Only a
  2xx response with `{path: string}` removes the item. Any failure leaves it for
  the main app, which drains at launch/foreground, pull-to-refresh, and every
  30 seconds while Home is active. A 120-second lease excludes simultaneous
  app/extension delivery and expires if a sender dies. Queue listings contain
  metadata only; the app reads one image payload at a time. The extension encodes
  directly to JSON bytes off the main thread, without a JSON String roundtrip or
  another full parse. Rejected items stay queued with exponential backoff during
  the app session (30 seconds to 30 minutes); they never block later valid items.
  Connectivity and authorization failures stop the current pass.
- Pairing stays in `expo-secure-store` and is mirrored at launch/pair/unpair to
  a separate shared Keychain item. Its access group is expanded from
  `$(AppIdentifierPrefix)dev.phalasiya.kintsugi.capture` in both targets. The
  default app Keychain group stays first so existing pairings survive migration.
  Tokens never enter App Group preferences or payload files. The mirrored item
  is after-first-unlock, this-device-only, to permit background delivery.
- Plain text from the phone capture box still goes to the inbox. A complete
  HTTP(S) URL goes to `/v1/clips` with `via: phone`; share captures use `via: share`.
  Old SQLite inbox captures remain readable. Non-iOS URL captures use that
  existing durable SQLite outbox. An unreadable old SQLite queue is copied intact
  to an `outbox.recovery.<timestamp>` key before resetting it, with a visible
  warning; a storage failure never overwrites the original queue.

Delivery is **at least once**, not exactly once: the API has no idempotency key.
A crash after the Mac commits but before the phone records its reply, or a late
background completion after lease expiry, can create a duplicate. Queue data is
never discarded on an HTTP error. Damaged native captures are moved to
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

With a compatible Simulator installed, use the **actual device UUID** from that
list (not an assumed model name):

```sh
pnpm --filter @kintsugi/mobile exec expo run:ios --device <UUID>
```

Manual acceptance on Simulator/device:
1. Pair once; share a Safari URL. Check the source preview, add a note, Save.
   The host app should reappear without launching Kintsugi. Verify the Mac's
   `inspiration/` clip and `via: share`.
2. Share one image from Photos and a screenshot. Check the thumbnail and saved
   media, including a caption/note. Verify 15 MB+ images give a visible error.
3. Make the Mac unreachable; repeat URL and image shares; terminate the extension
   immediately after Save. Reopen the app with the Mac reachable and verify both
   drain. Also retry with the app left open and the Mac waking later.
4. Unpair, share, and Save: it must still persist. Pair again; verify delivery.
5. Paste a URL into the phone capture box: it should say **Save inspiration** and
   create a clip; ordinary prose still says **Save to inbox**.
6. Exercise light/dark mode, larger Dynamic Type, provider errors, repeated Save,
   cancellation, failed API replies, and a cold app launch during background upload.

For a supplemental syntax/API check when only the macOS SDK is available,
`Shared/*.swift` and `ShareViewController.swift` can be typechecked against
`arm64-apple-ios16.4-macabi` with the SDK's `System/iOSSupport` frameworks. This
checks the UIKit/SwiftUI sources, not the ExpoModulesCore bridge or iOS runtime.

The generated-project verifier is not an iOS compile or a real share test. Both
still need Xcode with a compatible iOS Simulator platform/runtime (and device
signing to validate Keychain groups on hardware).
