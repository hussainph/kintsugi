# KI-112: repeated indentation

Follow-up to PR #70. First items and single-item lists now indent. Repeated Tab keeps moving the item deeper; Shift-Tab reverses each level.

## Decisions for the owner

- Keep the draft as space-indented Markdown. Use the previous item's content column when there is one. Otherwise add the editor's existing two-space unit. No extra parent text is saved.
- A different list directly above can supply the parent. Blank lines are allowed; prose and changes in quote depth stop the search. A newly nested numbered list starts at one.
- Over-indented markers remain list items in the editor, even when CommonMark would parse them as code or paragraph text. Children and continuation lines move with them. Shift-Tab removes one extra level before returning to the real parent's level; an orphan eventually returns to column zero.
- Normalize only for reading and delivery. Missing parent levels become empty list containers in standard Markdown. This preserves the visible depth without inventing parent prose. Export and the phone reader share the Markdown parser; publishing normalizes the outgoing body. The draft is unchanged.
- HTML, LinkedIn text and the phone reader hide empty parent markers while retaining indentation. PDF and the blog retain empty parent bullets at skipped levels. This keeps delivery portable without adding a blog-specific component or modifying the blog.
- Indented list-shaped text is ambiguous with indented code. Treat it as a list; use fenced code for literal list examples. Fenced examples, frontmatter and HTML remain literal.
- Keep popup priority, Escape then Tab, ordinary line indentation and one-step undo. A number continuing a prose paragraph stays prose and is never renumbered. Affected source and destination lists renumber together, including previously non-consecutive numbers in those lists. No helper copy or toasts.

## Obsidian research

Obsidian's help documents both space-indented ordered lists and tab-indented tasks, with Tab and Shift-Tab for nesting. Its implementation is not a portable rendering contract:

- [Basic formatting syntax](https://raw.githubusercontent.com/obsidianmd/obsidian-help/master/en/Editing%20and%20formatting/Basic%20formatting%20syntax.md).
- [Obsidian 1.8.9 discussion](https://forum.obsidian.md/t/broken-numbered-nested-lists-in-version-1-8-9/97775): staff describe one literal tab or four spaces per Tab, configurable, and limitations around delimiter-based indentation.
- [Over-indentation discussion](https://forum.obsidian.md/t/issue-with-nested-list-indentation-and-style-in-v1-8-10/102941): a skip-level item can render as a code block.

These are documentation and reported behavior, not a test against the owner's Obsidian installation. Kintsugi keeps its existing delimiter-based indentation and normalizes delivery rather than copying that rendering failure.

## Evidence

Headless Chromium, real Rust backend, scratch vault only, light mode. No owner vault, native window or running app was used.

- [Mixed lists, three levels](multilevel-light.png).
- [Ordered child, three levels](ordered-three-levels-light.png).
- [Repeated Tab and Shift-Tab](multilevel.mp4).

The shared editor typography and controls are preserved. List-shaped indented code uses the existing editorial font rather than the code font. Native iOS keyboard delivery is not exercised here; the phone imports the shared editor.

## Checks

- `pnpm --filter @kintsugi/core test`: 166 passed.
- `pnpm --filter @kintsugi/editor test`: 273 passed.
- `pnpm typecheck`: all workspaces passed.
- `pnpm lint:copy`: passed; three existing report-only findings.
- `pnpm --filter @kintsugi/desktop test`: 147 passed.
- `pnpm --filter @kintsugi/desktop test:headless`: 29 passed.
- `pnpm --filter @kintsugi/mobile test`: 97 passed.
- `pnpm --filter @kintsugi/mobile lint`: passed.
- `node .headless/verify-blog.mjs`: 15 publish cases passed against the blog's installed Satteri 0.10.5, imported read-only. Checked one, two and three levels for orphan, bullet, ordered, mixed and quoted lists. The HTML retained every level without code blocks or accidental headings. No blog files were written.
- `cargo build -p kintsugi --bin kintsugi --no-default-features --features headless -j "$VOLLI_CONCURRENCY_HINT"` with `CARGO_BUILD_JOBS=2` and `VOLLI_CONCURRENCY_HINT=2`: passed.
- `CARGO_BUILD_JOBS=2 VOLLI_CONCURRENCY_HINT=2 KINTSUGI_INDENT_EVIDENCE=1 pnpm --filter @kintsugi/desktop exec node --test --test-concurrency=1 test/runtime-indent.test.ts test/runtime-editor.test.ts`: 28 passed; one baseline-only test skipped.
- `CARGO_BUILD_JOBS=2 VOLLI_CONCURRENCY_HINT=2 pnpm --filter @kintsugi/desktop exec node --test --test-concurrency=1 test/runtime-indent.test.ts test/runtime-export.test.ts`: 11 passed; one baseline-only test skipped. Real PDF compilation passed; HTML kept four nested list containers; LinkedIn text kept three indentation levels.
- `cargo fmt --all --check`: passed.
- `git diff --check`: passed.

The first runtime run found a test locator that also matched the new fixture headings. The locator was narrowed and both suites passed on rerun. Light-mode screenshots and the 8.44-second video were inspected. A separate Volli Browser Tab check showed multi-level source indentation in the existing editorial font and no console errors.
