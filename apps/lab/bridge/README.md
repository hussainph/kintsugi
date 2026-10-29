# Lab instance bridge integration

Frame bootstrap: `import { installLabBridge } from './bridge/install'; installLabBridge();` **before** dynamically importing the registry / product modules. (Export is `installLabBridge`, not a default.) There are no module-load window reads. Installation refuses an existing Tauri runtime.

Entries call `registerFixtureHandlers(entryId, handlers)` synchronously in a fixture boundary before product children mount. Registration replaces the entire command map, returns a disposer, and never installs catch-all handlers. Event listen/unlisten is built in; `labBridge().emit(event, payload)` delivers Tauri-shaped event objects. `labBridge().calls` is an in-memory command trace. No filesystem/native URL fallback exists.

Product styling required: `@kintsugi/ui/styles.css` (or `packages/ui/src/styles.css` via its export), Tailwind scanning desktop/editor/ui and entries. Writing imports its own `references.css`; the editor's theme installs via CodeMirror. Do NOT import desktop `index.css` wholesale: its body overflow / root rules belong to the desktop shell.

Fixtures live under `entries/page/inspiration-library/` and are shared explicitly by sibling entries. Images are deterministic embedded raster PNG bytes, served through the explicit `clip_image` handler, never an asset URL or vault read. Clip writes/captures/trash only mutate that frame's in-memory store. External source opens are recorded in memory, not sent to the OS.

Instance tests (no server/native UI):

```sh
pnpm --filter @kintsugi/lab-app exec tsx --test --test-concurrency="$VOLLI_CONCURRENCY_HINT" bridge/install.test.ts entries/page/inspiration-library/fixtures.test.ts
```

Real-headless embedding is deliberately absent. Use the separate KI-12 scratch-vault runner for real command exploration; a future transport integration must remain explicit and isolated.
