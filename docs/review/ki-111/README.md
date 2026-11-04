# Versions you can find: the cursor shows them

Screenshots and the video come from `apps/desktop/test/runtime-versions.test.ts`. It runs in a scratch vault through the real headless backend. No model is involved.

| View | Light | Dark |
| --- | --- | --- |
| The cursor in "old": `‹ 1 of 3 ›` under the span's end | [Light](01-card-light.png) | [Dark](03-card-dark.png) |
| The Stash tab's versions: the innermost span, the others as tabs with their counts | [Light](02-tabs-light.png) | [Dark](04-tabs-dark.png) |

[finding.mp4](finding.mp4) shows arrowing into a selection's span, swapping with ⌥⌘] and ⌥⌘[, clicking into a word inside it, stepping with › and opening the list from the count. It is 14.2 seconds, H.264 at 1280 × 800.

## Verification

- All 52 tests passed in the versions, alternatives, editor and review runtime suites. The versions suite covers partial selections, nested spans sharing an end, typing, Escape before rest, focus leaving the editor, double-clicks and KI-108's flowed paragraphs.
- All 201 editor unit tests passed. Ask Kin follows the chosen tab; the selected-text shortcut keeps its exact range. Keyboard swaps follow a new cursor even before the old card moves.
- In a Volli Browser Tab, arrowed into the stored word, stepped by mouse, swapped back by keyboard and opened the list from the count. Inspected the card and tabs in light and dark. The console had no errors.
- `swift scripts/check-headless-macos.swift` reported zero native windows, no Dock registration and no focus activation. The background app was stopped.

## GUI review

The card reuses `StepCard` and the editor's `inlineCard`. Its count and arrows use the shared Graphical ghost button; tab counts use the existing spacing token. The tabs and list retain the existing versions panel. No fonts, icons or dependencies changed.

The card stays below the paragraph so it covers no text, but its arrival moves later paragraphs down. A click waits 300 ms to preserve double-click selection. These decisions and the selection-overlap policy are listed in PR #68.
