# Lab

A local, file-backed design workbench for React/Vite. The framework has no product imports: an instance provides entries, source roots, branding and optional control/critique adapters. Kintsugi's instance lives in `apps/lab`.

## Kintsugi quick start

```sh
pnpm install
pnpm lab                 # http://127.0.0.1:4315; browser only
pnpm lab --open          # owner convenience, not for agents
pnpm lab:check           # strict discovery, metadata, sources and state
pnpm lab:cli list
pnpm lab:cli show component/button
pnpm lab:cli note component/button "Try the quiet variant" --kind critique
pnpm lab:cli status component/button refining
pnpm lab:cli snapshot component/button "Quiet direction" --values '{"label":"Keep thought"}'
pnpm lab:boot            # running Lab required; every story + headless PNGs
pnpm lab:shots           # alias; .lab-artifacts/manifest.json and PNGs
```

Snapshot control names must exist in the entry. Partial values/scenario merge over declared defaults. `--json` gives machine-readable CLI output; `--revision N` makes an agent's mutation explicitly optimistic. CLI commands work without the server. Run `pnpm lab:cli --help` for syntax.

Agents use Volli Browser Tabs, never native app windows or `--open`. The boot tool uses headless Chromium only, honors `VOLLI_CONCURRENCY_HINT`, and accepts `--url`, `--out`, `--executable` and `--timeout` when called directly. If no Chromium executable is installed, install Playwright Chromium in an approved environment or supply an existing executable; it never downloads one implicitly.

## Make an instance

1. Discover exactly `entries/*/*/entry.tsx` with `import.meta.glob`, fail on missing default exports, and call `validateRegistry`.
2. Each file exports literal `meta` and `controls`, and a default `defineEntry({meta, controls, stories, variants?})`. Use `satisfies EntryMeta` / `satisfies Record<string, Control>` to preserve literal inference. Metadata is JSON-compatible literal data so the offline CLI can inspect it without executing app modules. Entry identity must match `<kind>/<slug>` in its directory.
3. Mount `Shell` from `@kintsugi/lab/shell` with the entries, branding and optional adapters. Route `?preview=<id>&story=<id>` to `Preview` from `@kintsugi/lab/preview`. Frames communicate only with their same-origin parent. The instance installs any platform stubs **before** dynamically importing its registry.
4. Add `labPlugin({root, entriesDir, analysis?})` from `@kintsugi/lab/server` to a dedicated loopback Vite server. The optional analysis callback calls `analyze({root, tokenFiles, sourceDirs, entries})`; source inventory is instance configuration, never a manual coverage registry.
5. Import framework chrome CSS and your real product CSS. Ensure Tailwind scans the entry and product folders explicitly. Keep `thread.jsonl` and temporary files out of watchers and Tailwind scanning.

```tsx
import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
export const meta = {
  id: "component/button",
  title: "Button",
  kind: "component",
  group: "writing",
  status: "exploring",
  sources: ["src/Button.tsx"],
  tickets: [],
  related: [],
  summary: "The small action at the end of a thought.",
} satisfies EntryMeta;
export const controls = {
  label: {
    type: "text",
    default: "Keep thought",
    target: "src/Button.tsx#children",
  },
} satisfies Record<string, Control>;
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "Default",
      render: ({ values }) => <button>{String(values.label)}</button>,
    },
  ],
});
```

Kinds: foundation, component, pattern, page, experiment (question required). Lifecycle: idea, exploring, refining, ready, shipped, archived. Archive old explorations rather than deleting them. Metadata, control values, stories, variants and related links are validated; server/CLI also verify real source files and reject symlinks.

## State and transports

One versioned append-only `thread.jsonl` per entry contains note, critique, decision, status, snapshot and annotation events. One immutable reducer validates and derives all state. Both transports use the same atomic store with cross-process locks and revision checks; no localStorage blob is authoritative. Annotation edits/deletes/resolutions and text-critique resolutions append new events. Future schema versions and corrupt logs fail closed. Supported migrations happen in code, and the next write replaces the original file—no legacy sidecars.

Middleware provides `/__lab/catalog`, `/__lab/state?id=...` (GET), `/__lab/state` (POST `{entryId,revision,action}`), and `/__lab/analysis`. It is development-only and loopback-only, checks host/origin/content type, bounds request bodies, and cannot write arbitrary paths. Do not expose the dev server remotely. On an interrupted process, inspect an abandoned `thread.jsonl.lock` before removing it; locks are never stolen automatically. Keep saved exploration state small and review it like source.

## Adapters and licensing

`ControlsAdapter` and `CritiqueAdapter` are neutral component interfaces, separate from entry metadata. The neutral types are available from `@kintsugi/lab/adapters`. Opt into vendors independently from `@kintsugi/lab/adapters/dialkit` and `@kintsugi/lab/adapters/agentation`; neither the neutral entry point nor schema/store/CLI imports a vendor.

- **Dialkit 2.1.0 — MIT.** Inline live typed controls, transient version menu, and `MotionStudy` / DialTimeline for sampled opening studies. Lab's named snapshots capture values **and scenario** into the committed thread. Transient vendor versions do not replace them. Snapshots are story-independent settings; Restore and Compare use the currently selected story. Historical settings remain readable after control changes, with explicit fallback warnings rather than a broken thread. Production enablement is explicit so a dedicated Lab bundle retains its tools.
- **Agentation 3.1.2 — PolyForm Shield 1.0.0, source-available.** Optional click-to-annotate toolbar; add/update/delete/clear callbacks persist normalized events into the Lab thread. Resolve from the thread; Copy for agent combines tuned values, source targets and critiques. Commercial extraction needs license review or a replacement adapter.
- **Agentation MCP 1.3.2 is not installed.** Optional: configure your MCP client to run `npx -y agentation-mcp@1.3.2 server`; explicitly supply `mcpEndpoint="http://localhost:4747"` to Shell. Verify a test annotation with `agentation_get_all_pending`. Normal Lab use has no endpoint or external service.

See [the design document](../../docs/lab.md) for IA, safety, extraction boundaries and non-goals. The Lab imports the product, never the reverse, and has no product build script. Real-backend embedded transport, live-build comparisons and a Lab MCP server are follow-ups.
