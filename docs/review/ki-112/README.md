# KI-112: Tab indentation

Tab and Shift-Tab now indent and outdent in the shared editor. List items move with their continuation lines and children. Ordered lists renumber in the same undo step. The phone uses this keymap too.

## Evidence

Real Rust headless runtime, seeded scratch vault, headless Chromium at 1440 × 900. No owner files or native windows.

| State | Light | Dark |
| --- | --- | --- |
| Before: Tab leaves focus; Markdown unchanged | [Screenshot](before-tab-light.png) | [Screenshot](before-tab-dark.png) |
| After: Child nested; Last renumbered | [Screenshot](after-tab-light.png) | [Screenshot](after-tab-dark.png) |
| After: outdented; tasks and selection exercised | [Screenshot](after-outdent-light.png) | [Screenshot](after-outdent-dark.png) |

Videos: [before](before.mp4), [after](after.mp4). The after clip shows nesting, reload, outdent, undo/redo, tasks and a multi-line selection.

## Decisions for the owner

- Ordinary lines use CodeMirror's existing two-space unit. Lists use the parent's Markdown content column: two for bullets/tasks, three for `1. `, four for `10. `. Repository Markdown and seed fixtures were inspected; the owner's vault was not read.
- Nesting a first item does nothing because there is no preceding item to nest under. Outdenting a top-level item also does nothing. Both keep focus in the editor.
- Move an item's whole subtree. Keep task checkboxes, quote prefixes, fences and continuation lines intact. Adjust continuation indentation when numbering crosses a digit boundary.
- Renumber affected ordered lists consecutively, retaining an existing first number; newly nested lists start at one. No unrelated lists change.
- Popups keep first refusal. Tab accepts `/` and reference choices; Shift-Tab moves backward. Empty reference popups consume both keys without editing. Focused card/composer controls retain normal focus traversal.
- Keep CodeMirror's native Escape-then-Tab escape hatch. No DOM capture handler or global keyboard trap.
- Frontmatter and code use ordinary line indentation, without automatic syntax correction. Indenting a top-level YAML key is an explicit source edit and can change its meaning; Shift-Tab reverses it.
- Finish the Markdown parse before changing list structure. A cold 10,000-paragraph regression case verifies tail-list handling rather than silently falling back to prose indentation.

## Checks

Passed locally:

- `pnpm lint:copy` (three existing report-only findings).
- `VOLLI_CONCURRENCY_HINT=2 pnpm typecheck` (all workspaces).
- `pnpm --filter @kintsugi/editor test` (243 tests; 36 indentation cases).
- `pnpm --filter @kintsugi/desktop test` (146 tests).
- `pnpm --filter @kintsugi/mobile test` (96 tests).
- `pnpm --filter @kintsugi/desktop test:headless` (29 tests).
- `CARGO_BUILD_JOBS=2 VOLLI_CONCURRENCY_HINT=2 pnpm --filter @kintsugi/desktop exec node --test --test-concurrency=1 test/runtime-indent.test.ts test/runtime-editor.test.ts test/runtime-marks.test.ts test/runtime-alternatives.test.ts` (40 passed, one baseline-only test skipped).
- Final `runtime-indent.test.ts` rerun (five passed, baseline-only test skipped).
- Baseline run with `KINTSUGI_INDENT_BEFORE=1` before binding Tab (one passed).
- `git diff --check`.

After rebasing onto KI-113 (`ee03f88`), the editor suite passed 250 tests, desktop units passed 147, all-workspace typechecking passed, and the indentation runtime passed five checks. KI-113's `runtime-counts.test.ts` also passed both checks. After screenshots and video were refreshed on this rebased build.

The runtime checks cover saves and reloads, undo/redo, focus retention and escape, tasks, selected lines, frontmatter, `/`, `@`, no-match references, ⌘K, Kin's composer, and inline version-card focus traversal. Existing marks and alternatives runtime suites also pass.

Visual audit: editor typography, colors, spacing, cards and Graphical controls intentionally preserved. Light/dark screenshots inspected; no style or component changes. Native iOS hardware-keyboard delivery was not tested; the phone imports the same shared editor, passes typechecking and its unit suite.
