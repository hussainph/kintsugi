# KI-28 spike: the Mac's CodeMirror editor on the phone (Expo DOM components)

**Recommendation: go, with conditions.** `packages/editor` runs on the phone
unchanged inside an Expo DOM component. Typing, selection, the native edit
menu, undo, `[[` links and chips, dark mode and long documents all work. It
feels close to native once the phone wrapper does three things the WebView
won't do for it: a real native keyboard toolbar, turning the keyboard's text
features back on, and keeping one warm editor WebView instead of starting a
new one for each note. None of these is a blocker. Two things still need a
real device before the phone editor replaces `doc.tsx`: autocorrect/dictation
and opening time.

Everything below was measured in the iOS Simulator (iPhone 17 on iOS 27.0,
iPhone Duo on iOS 27.1). It was driven headlessly by XCUITest
(`apps/mobile/spikes/editor-uitest`) with real touches and the real software
keyboard, on a shared and busy Mac. The Simulator runs on the Mac's CPU, so
treat the timings as directional: good enough to find problems, not a
promise about an older iPhone.

## What was built

- `src/app/editor-spike.tsx` is a dev-only route (`kintsugi://editor-spike?doc=short|long|huge`).
  It redirects home in release builds unless the build sets
  `EXPO_PUBLIC_EDITOR_SPIKE=1`. Nothing links to it, and `doc.tsx` is
  untouched.
- `src/components/editor-spike/SpikeEditor.tsx` is the `'use dom'` component.
  It renders `@kintsugi/editor/Editor` as-is, with phone CSS variables and
  spacing (`spike.css`). It exposes commands (undo, redo, bold, `[[`, blur,
  bench) to native through `useDOMImperativeHandle`, and hands the text back
  through a native action, debounced, the way storage would.
- A native toolbar sits above the keyboard. It is positioned from RN keyboard
  events, and the screen pads by the keyboard height so the WebView shrinks.
- The on-screen metrics line shows keystroke→painted-frame latency, a
  200-keystroke synthetic bench, scroll frame drops, open time and
  save-bridge time.
- `metro.config.js` makes `react`/`react-dom` resolve from the app. Without
  it, `packages/editor`'s own React devDependency (19.3.1) loads next to the
  app's React (19.3.0) and hooks break.
- New dependencies, added with `expo install`: `@expo/dom-webview`,
  `@expo/metro-runtime`, `react-dom`, `react-native-web`. Also
  `@kintsugi/editor`, plus `@codemirror/{commands,state,view}` from the
  workspace catalog so only one copy of CodeMirror loads.

## Measurements

Keystroke latency is the time from `beforeinput` to the next painted frame;
one frame is 16.7 ms. "Bench" is 200 programmatic single-character inserts,
one per frame.

| Case (iPhone 17 sim) | Keystroke p50 / p95 / max | Bench p50 / p95 | Notes |
| --- | --- | --- | --- |
| Short post, 706 chars (debug) | 14 / 35 / 77 ms (n=90) | 17 / 37 ms | One frame. Feels instant. |
| Long essay, 57k chars, ~10k words, 1,275 lines (release) | 20 / 90 / 137 ms (n=59) | 17 / 42 ms | Typing at the end of the doc |
| Long essay, ship config (`ac=1&acc=0`, release) | 11 / 47 / 141 ms (n=38) | 17 / 30 ms | |
| Book, 571k chars, ~100k words, 12.5k lines (release) | 124 / 373 / 593 ms | 51 / 185 ms | Noticeably laggy |
| iPhone Duo, short (debug) | 17 / 35 / 92 ms | 17 / 56 ms | |

- **Scrolling:** a programmatic 4 s scroll through the whole long doc dropped
  6–20% of frames (14/218 debug, 35/174 release). The book scored about the
  same (21/183), because CodeMirror only renders the visible lines. Touch
  flings showed about 30% of frames over 20 ms in every document size. That
  is mostly the Simulator's rendering, so it needs a device check.
- **Saving:** sending the full text through a native action took 6–15 ms for
  the post and the essay, and 44 ms for the book.
- **Opening (release build, embedded bundle, no Metro):** from the native
  screen rendering to the editor being mounted took 1.5–7 s across 8 opens.
  Bundle evaluation → editor mounted was only 95–920 ms of that; the rest is
  creating the WebView and loading/parsing the 1.1 MB DOM entry bundle
  (`www.bundle`). Warm second opens were usually faster but noisy on the
  loaded Mac. Debug builds read 8–30 s because Metro serves the bundle; that
  number means nothing.

## Native feel, item by item

| Item | Result | Evidence |
| --- | --- | --- |
| Typing latency | ✅ About one frame for posts and essays. ⚠️ Books (100k words) lag: on every change, `Editor.tsx` calls `doc.toString()` and `references.ts` re-runs `parseWikilinks` on the whole document, so the cost grows with length. This also affects the Mac. | table above |
| Selection handles | ✅ Native iOS handles, loupe and edit menu (Cut/Copy/Paste…). Long press shows Paste / Select / Select All; double-tap selects a word. CodeMirror's selection agrees (`sel 54-59`). ⚠️ The menu includes WebKit's "AutoFill". | `ki-28/07`, `ki-28/08` |
| Scrolling | ✅ CodeMirror's own scroller has momentum. ⚠️ Frame drops while flinging in the Simulator; check on a device. | measurements |
| Keyboard | ✅ The keyboard opens on tap, and the WebView resizes because the RN screen pads by the keyboard height, so the caret stays visible. ❌ With the default WebView, iOS adds its own ⌃⌄✓ accessory bar on top. `hideKeyboardAccessoryView` removes it (`acc=0`). | `ki-28/02` vs `ki-28/03` |
| Accessory toolbar | ⚠️ The native RN toolbar works (Undo/Redo/B/`[[`/Done reach CodeMirror over the bridge), but it is positioned from keyboard events. When the keyboard height changes (the predictions bar appearing), it fell behind the WebView's accessory bar and the caret line ended up under the keyboard. `@expo/dom-webview` can hide the accessory view but can't supply one. | `ki-28/09`, `ki-28/14` |
| Undo / redo | ✅ CodeMirror history driven from native buttons, three undos then a redo. ❓ Shake-to-undo and three-finger undo can't be triggered in the headless Simulator. | `ki-28/05` |
| Autocorrect / predictions | ❌ Off by default: CodeMirror sets `autocorrect=off`, `autocapitalize=off` and `spellcheck=false`, so iOS shows no predictions bar. With `ac=1` the spike turns them back on (`EditorView.contentAttributes`) and the predictions bar appears. ❓ XCUITest's `typeText` doesn't trigger autocorrect or auto-capitalisation, and the suggestions didn't follow the typed word, which may mean WebKit's text context drifts from CodeMirror's DOM. Needs a device. | `ki-28/09` |
| Dictation | ❓ Not testable headlessly. CodeMirror handles composition input. Check on a device. | — |
| `[[` links / chips | ✅ The picker opens and filters as you type; chips render in long docs. ⚠️ The picker is wider than the phone and gets clipped on the right, and its hint row ("↑↓ Choose · Enter · Esc") is for a hardware keyboard. | `ki-28/06`, `ki-28/11`, `ki-28/13` |
| Long documents | ✅ The essay is fine. ⚠️ The book is laggy (see typing). | table |
| Dark mode | ✅ The phone palette carries through CSS variables, and `color-scheme` gives a dark keyboard. | `ki-28/12` |
| iPhone Duo | ✅ Renders and types at the Duo's wider default width. ⚠️ In one run, "focus end" plus typing didn't reach the editor, and the end of the doc sat under the keyboard (keyboard height from `Dimensions` is unreliable here). ❓ `simctl` can't change the fold posture, so folded, partly open and Split View weren't tested. | `ki-28/13`, `ki-28/14` |
| Dev-only noise | ⚠️ "Unable to find the 'DomWebView' view with tag N" shows in the dev overlay on the first mount. It's a race in the DOM wrapper; props still arrive. | `ki-28/01` |

## What needs native work on top

1. **A native keyboard toolbar** as a real `inputAccessoryView` on the
   WebView. This is a small Expo module or config plugin around
   `@expo/dom-webview`'s `WKWebView` subclass, which today only *hides* the
   accessory view. Alternatively use `react-native-keyboard-controller` for
   frame-accurate keyboard tracking. Positioning from RN keyboard events
   broke when the keyboard height changed.
2. **Keyboard text features:** a phone-only extension that sets
   `autocorrect`, `autocapitalize` and `spellcheck` on the content DOM.
   `Editor` needs an `extensions` prop for this, or a phone flag. Then test
   autocorrect, predictions, text replacement and dictation on a device.
3. **One warm editor WebView:** mount the DOM component once (for example in
   the root layout, hidden) and switch documents through props. `Editor`
   already keeps a separate `EditorState` and undo history per path. This
   hides the WebView startup and bundle parse. Also look at trimming the 1.1 MB
   entry bundle with Expo Atlas. It holds React DOM, CodeMirror, Expo's DOM
   runtime and the `language-data` registry; the language modes themselves
   already load lazily as separate chunks.
4. **Text over the bridge:** send changes (or debounced full text) to native
   storage. Full text costs 6–15 ms per save for an essay. For KI-27's sync,
   apply incoming text with the existing `external` prop, which makes a
   minimal, undoable diff.
5. **Phone treatment of the `[[` picker:** fit it to the screen width, make
   rows tap targets, and drop the hardware-keyboard hints.
6. **Long-document cost in `packages/editor`:** stop serialising and
   re-parsing the whole document on every keystroke (`onChange`'s
   `doc.toString()`, and `parseWikilinks` in `references.ts`). Debounce, or
   parse only the changed ranges. This helps the Mac too.
7. **Device pass before replacing `doc.tsx`:** typing feel, flings,
   autocorrect/dictation, opening time, and iPhone Duo postures.

## Reproduce

See `apps/mobile/spikes/editor-uitest/README.md`. Build the debug app per
`AGENTS.md` ("Phone app"), run Metro, then run the XCUITest cases
(`testShortDocument`, `testSelection`, `testAutocorrect`,
`testNoAccessoryBar`, `testShipConfig`, `testLongDocument`,
`testHugeDocument`, `testAppearance`). For opening times, build Release with
`EXPO_PUBLIC_EDITOR_SPIKE=1` and open
`kintsugi://editor-spike?doc=long&n=1`, `&n=2`, … with `xcrun simctl openurl`.
Each new `n` mounts a fresh WebView.

Screenshots are in `docs/spikes/ki-28/`.
