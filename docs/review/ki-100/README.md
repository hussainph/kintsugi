# KI-100 review

Paper: [Phone 1 and Desktop 1, round 2](https://app.paper.design/file/01M6EKE60JQ49GQAD7DD2ZY3B6/p-6-0).

## Mac

`desktop-light.png`, `desktop-dark.png` and `desktop-light-system.png` are
1440×900 captures of Settings › Appearance against the real headless Rust
backend on a seeded scratch vault. `desktop-size-150.png` shows the largest
text size. The column remains 640px wide.

Compared with Paper C0D-0 and C0E-0: the gallery, split System thumbnail,
stepper without its old note, read-only font and live sample follow Desktop 1.
The app uses its real Timeless Sans and LT Superior Serif, rather than
Paper's Inter and Source Serif 4 substitutes. Existing Settings surfaces
and Graphical control styles are retained.

The three desktop Appearance runtime tests cover live mode changes,
keyboard and whole-thumbnail selection, native theme command arguments,
all size steps, invalid storage, editor/sample sizing and persisted mode
and size in a fresh browser context. All 93 desktop runtime tests passed.

Also reviewed light and dark in a Volli Browser Tab; no console errors.
Native window appearance is wired through Tauri and is a no-op in headless
mode, so native titlebar rendering itself was not captured.

## Phone

`phone-web-light.png` and `phone-web-dark.png` render the production native
Appearance controls through React Native Web, over the production DOM editor.
The compact sheet starts at 520pt. The test shell supplies the grabber,
navigator and browser-backed preference storage.

`phone-web-accessibility.png` and `phone-web-accessibility-controls.png`
show a 320px-wide, 200% text-size model. The native Text adapter multiplies
font sizes and leading; it is not an iOS Dynamic Type capture. The sheet
expands, mode choices stack, and the controls remain reachable by scrolling.

Verified with `pnpm --filter @kintsugi/mobile test:appearance`: mode overrides,
live System changes, seven size steps, 44pt hit areas, reload persistence,
editor text and undo-history preservation, and the narrow expanded layout.

Native overflow presentation, keyboard dismissal, swipe detents, VoiceOver
and New York glyph fidelity were not exercised. The browser uses its serif
fallback; the shipped iOS editor and sample use the existing New York stack.
