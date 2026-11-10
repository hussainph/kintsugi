# KI-114 review

The fixed text column is centred between the sidebar and the reserved right margin. The margin keeps its 360 px width. Closing the sidebar moves the column left. Opening or switching the margin never changes its measure.

Screenshots use the real headless backend and a seeded scratch vault. Each window is 1000 px tall. At 1280 px, opening the margin folds the sidebar automatically. At 800 px, the margin overlays the page.

## Before and after

| Width and sidebar | Before, light | After, light | Before, dark | After, dark |
| --- | --- | --- | --- | --- |
| 2000, open | [Before](before-2000-light-expanded.jpg) | [After](after-2000-light-expanded.jpg) | [Before](before-2000-dark-expanded.jpg) | [After](after-2000-dark-expanded.jpg) |
| 2000, closed | [Before](before-2000-light-collapsed.jpg) | [After](after-2000-light-collapsed.jpg) | [Before](before-2000-dark-collapsed.jpg) | [After](after-2000-dark-collapsed.jpg) |
| 1440, open | [Before](before-1440-light-expanded.jpg) | [After](after-1440-light-expanded.jpg) | [Before](before-1440-dark-expanded.jpg) | [After](after-1440-dark-expanded.jpg) |
| 1440, closed | [Before](before-1440-light-collapsed.jpg) | [After](after-1440-light-collapsed.jpg) | [Before](before-1440-dark-collapsed.jpg) | [After](after-1440-dark-collapsed.jpg) |
| 1280, folded automatically | [Before](before-1280-light-expanded-auto-folded.jpg) | [After](after-1280-light-expanded-auto-folded.jpg) | [Before](before-1280-dark-expanded-auto-folded.jpg) | [After](after-1280-dark-expanded-auto-folded.jpg) |
| 800, open | [Before](before-800-light-expanded.jpg) | [After](after-800-light-expanded.jpg) | [Before](before-800-dark-expanded.jpg) | [After](after-800-dark-expanded.jpg) |
| 800, closed | [Before](before-800-light-collapsed.jpg) | [After](after-800-light-collapsed.jpg) | [Before](before-800-dark-collapsed.jpg) | [After](after-800-dark-collapsed.jpg) |

With the margin hidden: [2000 px](after-2000-light-collapsed-plain.jpg) and [800 px](after-800-light-collapsed-plain.jpg).

The [before](before-geometry.json) and [after](after-geometry.json) measurements record the text's left edge and width. At 2000 px with the sidebar closed, the left edge moves from 695.91 to 515.91 px. The text remains 660.16 px wide. At 1440 px, closing the sidebar now moves the column 104 px left instead of leaving it in the same place.

## Motion and theme

The column follows the sidebar's existing gap transition, using the existing large motion tokens. It has no separate transform: the text, selection rectangles and inline cards keep the same coordinate system. Under reduced motion, the sidebar and column change position immediately; the margin keeps its existing short fade.

Scoped theme review preserves the editor's type, line padding, colors, margin tabs and controls. No components, fonts, icons, theme values or UI copy were added.

## Checks

- `pnpm lint:copy`: passed; three existing report-only findings.
- `pnpm typecheck`: passed across the workspace.
- `pnpm test`: passed.
- `pnpm --filter @kintsugi/desktop build`: passed; existing bundle-size warning.
- `node --test --test-concurrency=1 --test-reporter=./test/reporter.ts test/runtime-writing-layout.test.ts` in `apps/desktop`: four passed. Covers the left edge, fixed width, sidebar restoration, auto-fold, narrow overlay, selection bounds, interruptible travel and reduced motion.
- `node --test test/runtime-catalogue.test.ts` in `apps/desktop`: two passed after the fixture correction below.
- `git diff --check`: passed.
- Review links: all screenshot and measurement files are present.

The first full headless run exposed an expired date in the catalogue fixture. Its recorded newest post crossed the 30-day archive cutoff on November 10, 2026. The fixture now gives that post a clock-relative recent date; the older entries keep their recorded dates. No feed behavior changed.

In a Volli Browser Tab, toggled the sidebar, opened the margin, selected the draft and switched to Stash and its versions section. The selection stayed inside the text padding. The console had no errors. `swift scripts/check-headless-macos.swift` reported zero native windows, no Dock registration and no focus activation. The visual-review backend was stopped.

The native app UI and iOS were not tested; this is a desktop layout change tested headlessly.
