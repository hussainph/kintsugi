# KI-113 review

Selected text automatically changes the footer to selected words, total words and selected characters. Clearing the selection restores the total.

- [Light](light-selection.png)
- [Dark](dark-selection.png)
- [Recording](selection-counts.mp4)

## Decisions for the owner

- Multiple selections are summed. A selected word fragment counts as one word.
- Words follow the existing draft rule, including its comment exclusion.
- Characters count selected source text, including whitespace and dimmed text, but never frontmatter. Unicode code points count once; combined emoji can contain several code points.
- No phone UI was added: the phone has no existing word count.
- The footer keeps its existing typography and theme. No new control, tooltip or setting.

## Checks

Passed locally:

- `pnpm typecheck`
- `pnpm lint:copy` (three existing report-only findings)
- `pnpm --filter @kintsugi/desktop build`
- `pnpm --filter @kintsugi/core test` (135)
- `pnpm --filter @kintsugi/editor test` (212)
- `pnpm --filter @kintsugi/desktop test` (147)
- `pnpm --filter @kintsugi/desktop test:references` (6)
- `pnpm --filter @kintsugi/desktop test:headless` (29)
- `node --test scripts/*.test.mjs` (48)
- `cargo test -p kintsugi --no-default-features --features headless -j 2` (480 passed, 43 ignored)
- `node --test test/runtime-counts.test.ts` in `apps/desktop` (2)
- `node --test --test-concurrency=1 test/runtime-dim.test.ts test/runtime-appearance.test.ts` in `apps/desktop` (6)
- `git diff --check`

The runtime tests use fresh scratch vaults and the real headless backend. They cover selecting and clearing, multiple selections, select-all across frontmatter, typing, undo, switching documents and stable editor/footer geometry at 1440 and 1000 pixels. A Volli Browser Tab also confirmed select-all and reset, with no console errors.

Selection changes reuse the document snapshot. Normal edits recount touched lines; changes involving comments use a full count. A local 100,000-word check took 1.7 ms for 100 selection changes and 82.5 ms for 20 edits, including the existing comment scan. These are measurements, not timing assertions.

Scoped visual review: the footer count retains the existing text role and light/dark colors. No assets or theme values changed.

## Reproduce evidence

Run from the repository root:

```sh
KINTSUGI_REVIEW_DIR="$PWD/docs/review/ki-113" CARGO_BUILD_JOBS=2 \
  pnpm --filter @kintsugi/desktop exec node --test test/runtime-counts.test.ts
```

Screenshots go to that directory; Playwright writes the recording under `video/`. The committed recording is converted to MP4.
