# Kintsugi Lab

A browser-only design workbench for the craft pass: the writer's words stay at the center, while the system around them can be explored safely. Lab imports the product; the product never imports Lab. This document is the first committed slice of KI-15.

## Information architecture

A quiet, searchable catalog has five kinds: **foundation**, **component**, **pattern**, **page**, **experiment**. Group names describe where a writer meets something (Writing, Inspiration, Navigation, System), rather than implementation folders. Home shows recent activity and work in progress. Kind, group and lifecycle filters narrow the catalog; archived work is hidden until searched or explicitly included. Archive, never delete an exploration.

An entry opens a workspace with named stories, live typed controls, source links, a persistent note/critique/decision thread and a compare grid. Compare can place stories, variants and committed snapshots side by side. The global scenario sets light/dark theme, desktop/phone width, text scale, reduced motion and density. Previews are isolated in same-origin frames so product selectors, portals and viewport queries operate at the actual scenario width. The shell stays quiet; transitions are not decoration.

Analyze is a source-derived inventory, not a second manually maintained catalog: token declarations and their consumers, literal colors/px/durations to investigate, uncovered component/page files, contrast ratios, and type/spacing/motion scales. Findings are candidates, not automatic edits. Browser checks render every story and capture screenshots.

## Registry and schema

`packages/lab` is the reusable framework. `apps/lab` is its first consumer and owns product fixtures, imports and configuration. There is one discovery rule:

```
apps/lab/entries/<kind>/<kebab-case-slug>/entry.tsx
```

Helpers and fixtures live in the entry's folder, never as discoverable scratches. Each entry exports a literal `meta` object and a default `defineEntry({ meta, controls, stories, variants? })`. Metadata has `id` (`kind/slug`), title, kind, kebab-case group, status, sources (workspace-relative live files), tickets, related IDs and summary. Experiments must state a question. Stories and variants have unique kebab-case IDs. Sources must exist; related IDs must resolve. Invalid/missing metadata, duplicates and misplaced entries fail loudly in development and tests, never disappear. CLI/server metadata is derived from those same entry files, not another registry.

Lifecycle: `idea → exploring → refining → ready → shipped`, or `archived`. Status can be deliberately moved backward as exploration reopens; it is not a review verdict pipeline. Typed scalar controls carry defaults, number bounds/steps or select options, plus source/property targets for an agent handoff. A story receives `{ scenario, values }`. Dialkit-specific types never enter entry definitions.

## State and persistence

Each entry has one small, human-readable `thread.jsonl`. Every line is a versioned immutable event `{ version, id, at, action }`. Actions add notes, critiques or decisions; update lifecycle; save named control snapshots; or add/update/delete/resolve annotations. Annotation changes append history rather than erase earlier critique. The derived open-critique view folds annotation IDs, retaining the full audit trail. Snapshots capture values and scenario, not source commits or image baselines.

One pure reducer and action validator serve both CLI and UI. The framework store validates the complete log on read, serializes writes, and atomically replaces a same-directory temporary file. Optimistic revision checks reject stale browser edits; failures remain visible and can be retried. Inputs and entry paths are bounded/validated; middleware is loopback-only, checks origin/host and JSON requests, and exposes no arbitrary filesystem write. Schema versions are explicit, with in-code migration dispatch; unknown/future versions fail closed. Migrations replace the existing file on its next write, leaving no legacy sidecars. There is no global state blob.

`pnpm lab:cli list|show|note|status|snapshot` works directly on the same registry and state, without a running browser. The UI uses the Vite middleware; it never writes localStorage as the source of truth. “Copy for agent” includes entry identity, live source paths, tuned values/targets and open critiques as Markdown.

## Adapter boundaries

- **ControlsAdapter** renders controls through a neutral typed-control contract. The shipped adapter uses **dialkit 2.1.0 (MIT)** and **motion** (peer >=11): DialRoot, useDialKitController, versions and a timeline adapter for motion studies. Lab's named, committed snapshots are authoritative; dialkit's transient versions are useful while tuning but are not the state store. Explicit production enablement keeps a standalone Lab build useful without adding it to product builds.
- **CritiqueAdapter** normalizes annotation add/update/delete/clear events into the reducer's append-only events. The shipped adapter uses **agentation 3.1.2 (PolyForm Shield 1.0.0, source-available, not MIT/open-source)**. It must remain replaceable and optional: publishing or commercializing Lab requires a license review or a different adapter. Lab's thread persists independently of any external server.
- Agentation MCP is optional and is **not** a workspace dependency. Run `npx -y agentation-mcp@1.3.2 server` in the agent's MCP configuration; point the explicitly enabled toolbar endpoint at `http://localhost:4747`. Confirm a test annotation through `agentation_get_all_pending`; a healthy server alone does not prove sync. The Lab works with no endpoint.
- Kintsugi's bridge adapter installs before product modules load. Unhandled Tauri commands reject by default. Entry setup explicitly declares fixture handlers; writes affect only in-memory fixtures. Nothing reads the owner's config, credentials or vault. For real-backend exploration use KI-12's separate `pnpm desktop:headless` isolated scratch run; real-backend embedding requires an explicit safe transport integration, never a fallback from fixtures.

## Tooling and verification

`pnpm lab` runs Vite on loopback port **4315**, strict-port, separate from 1420/1422/1423. `pnpm lab --open` is for the owner; agents use Volli Browser Tabs only. No native app or Simulator launches. `pnpm lab:check` validates discovery, metadata, sources and state. `pnpm lab:boot` boots every story, rejects browser/page/console errors, and writes per-story headless PNGs under gitignored `.lab-artifacts/`; `pnpm lab:shots` is the screenshot-oriented alias. Worker concurrency respects `VOLLI_CONCURRENCY_HINT`. Review evidence also includes screenshots taken in a Volli Browser Tab.

## Extraction and non-goals

The framework receives registry modules, branding and analysis source configuration. It has no Kintsugi imports, vault knowledge or app aliases. Public entry/schema/state APIs and server/CLI/adapter entry points are separate exports. The instance owns all real components, tokens, fixtures and source roots. Extraction means publishing the package, choosing adapters with suitable licenses and installing it into another Vite/React workspace—not untangling app-internal scaffolding.

No review clearance/send-back pipeline, commit attempts, baseline server, verdict buckets or global-fix tracing. A Lab MCP server, live-build comparison, remote collaboration and real-backend embedded transport are follow-up work, not reasons to grow this slice into infrastructure.
