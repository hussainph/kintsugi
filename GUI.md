# GUI — Kintsugi design language

This file contains the saved theme and instructions for using it. The **Theme values** sections are readable, editable JSON and can restore the theme in Graphical. The accompanying `gui/` references describe component structure, behavior, and resolved styles; `skills/` contains workflows for using them. The full-component selection also includes Graphical’s actual themed component source and runtime. The default theme-and-skills selection includes guidance only and adds no runtime source or dependencies.

## Start here

Keep `GUI.md` and `gui/` at the project root. The install command puts the three skills in `.agents/skills/`; for a ZIP, copy the folders from `skills/` there, preserving existing files and local edits. Add this pointer to the project’s active agent instructions without replacing them: “For UI work, follow GUI.md and use graphical-ui, graphical-convert, or graphical-audit as appropriate.” Agents with other conventions can read these files directly.

Inspect the app’s styling, shared components, and consumers before making changes. Honor the selected setup recorded below and any scope the user already gave. Otherwise ask once: **“How would you like to apply this theme?”**

- **Convert the whole app:** update shared components and their usage across screens.
- **Convert selected areas:** establish the pages or components and contain shared changes using the app’s existing mechanisms.
- **Keep the current UI:** install the guidance and instruction pointer, then stop without changing styles or runtime dependencies.

Wait for a missing scope choice before changing application styles. A component request does not authorize whole-app conversion. These rules apply equally to prompt, terminal, and ZIP setup.

## Apply the theme

Use `graphical-convert` for existing UI, including its shadcn mapping when relevant. Use `graphical-ui` for new UI and future interface edits, even when the user does not mention Graphical. New screens use the current design system by default.

Implement the chosen scope in the app’s existing styling system and shared components. Use the values below, [foundations](gui/foundations.md), and each relevant [component specification](gui/components.md). Preserve authored component edits across parts, variants, sizes, states, modes, and portals. Global tokens alone do not complete conversion; an approximate preset or unchanged library defaults do not replace the supplied specifications.

Preserve content, behavior, routing, public component APIs, and intentional local customizations. After deliberate customization, the app’s active definitions take precedence over this downloaded snapshot. Preserve dependency versions, ranges, overrides, and lockfiles. Add only missing packages using the project’s package manager and version policy; verify APIs against installed versions and report incompatibilities instead of silently migrating dependencies.

### Set up all Base UI components

An explicit request for all Base UI components, including a recorded selection below, authorizes theme conversion, asset setup, and reusable modules across the existing app. Proceed without another scope question, honoring any narrower scope already supplied.

Integrate the bundled Graphical components and theme runtime; use their actual source rather than reconstructing the library from specifications. Import the bundled stylesheet, connect the theme provider to the supplied document and the app’s active color mode, and expose usable component imports. Reuse or adapt compatible existing shared components without discarding their public APIs or behavior. Use the [component specifications](gui/components.md) to verify the selected edits and [Base UI guidance](gui/base-ui.md) for integration. Check the receiving version’s [official catalog](https://base-ui.com/llms.txt) for additional primitives; use the same foundations where source is not supplied and disclose that coverage gap. Installing source files or dependencies alone does not complete setup until the components and existing app use the selected theme.

The source lives in `components/graphical/`. Import components, `GraphicalProvider`, and `theme` through its `index.ts`; `theme.ts` contains the captured document with the user’s component customizations. Import `components/graphical/styles.css` once at the framework’s supported stylesheet entry. Wrap the intended scope with `GraphicalProvider document={theme} colorMode={colorMode}`, using the app’s real light/dark state. Keep the bundled shared runtime with the components so their resolver, motion, and portal behavior remain connected. Configure the selected icons with `IconRendererProvider` under [Base UI integration](gui/base-ui.md), and fonts with the app’s loader; artwork and font files are not included. Do not silently leave Lucide active when a different free pack was selected.

Add only missing `@base-ui/react`, `motion`, and `lucide-react` packages required by the bundled source, using the receiving project’s package manager and version policy. Preserve its installed framework, React, dependency ranges, overrides, and lockfile decisions. Adapt source to supported APIs or report concrete incompatibilities; do not silently replace package versions. Install the selected fonts and icon pack separately under the asset instructions below. Guidance-only installation adds none of these runtime dependencies.

Before running an install command, check the receiving app’s installed APIs and dependency constraints. The supplied runtime uses React 19 context/provider and ref APIs and is verified against Base UI 1.7; this is a compatibility baseline, not a version-pinning requirement. Existing React 18 apps need compatible context/provider and ref-forwarding adaptations, or a concrete blocker report. Never upgrade existing dependencies automatically to make the source work.

## Rules for UI work

- Locate the active theme, mode, shared components, and nearby patterns first. Use existing tokens or verified aliases; report missing choices instead of inventing theme values. Keep named references at use sites and literals in token definitions. Typography includes family, weight, size, line height, and letter spacing.
- Reuse components and variants, then compose available primitives. New components fill missing capabilities using existing tokens. Consolidate equivalent roles without changing established values unless requested.
- Keep interfaces minimal: useful titles, content, and actions; no decorative eyebrows, filler subtitles, slogans, or redundant explanations. Default wrapping text to `text-wrap: pretty`.
- Treat grid tracks, breakpoints, content widths, aspect ratios, and positioning as structural choices. Preserve meaningful data encodings and external widgets in context.
- Preserve keyboard focus, labels, form values, interaction states, and theme propagation into portals. Use composed box shadows for edges with zero native border width, retaining opacity and the theme’s stroke placement.
- Fonts and icon artwork are acquired separately. Follow the selected assets and official links below. Preserve font names, weights, fallback stacks, and icon style/weight. Use licensed files when supplied; ask for missing files or their location before a fallback decision, honoring an existing answer. Use the documented free fallback only for unavailable paid selections, disclose substitutions, and explain how to restore licensed assets. System fonts need no download; report unresolved or gated sources without silently substituting.

## Verify and hand off

Finish conversion with `graphical-audit`: find and fix gaps within the agreed scope. Report each component as converted, already matches, intentionally preserved, or blocked, with evidence or a reason. For full library setup, also list module import paths and catalog coverage. Report actual checks, substitutions, and remaining gaps; source inspection alone does not establish rendered equivalence. Follow the receiving project’s testing and browser-review policy. A small edit does not trigger an app-wide audit.

## Focused references

| Need                                                   | Read                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| Token ownership, aliases, and deliberate theme changes | [Theme contract](gui/theme-contract.md)                                   |
| Hierarchy, composition, navigation, and controls       | [Interface judgment](gui/interface-judgment.md)                           |
| Colors, typography, spacing, effects, and motion       | [Foundations](gui/foundations.md)                                         |
| Asset installation and licensed fallbacks              | [Font and icon setup](gui/assets.md)                                      |
| Component anatomy, assignments, states, and modes      | [Component specifications](gui/components.md)                             |
| Primitives and existing libraries                      | [Base UI](gui/base-ui.md) · [Custom components](gui/custom-components.md) |
| Resolved CSS variables and component assignments       | [Theme references](gui/themes.md)                                         |
| Proportional checks                                    | [Verification](gui/verification.md)                                       |

| Task                                    | Skill               |
| --------------------------------------- | ------------------- |
| Build or edit UI with the current theme | `graphical-ui`      |
| Apply this theme to existing UI         | `graphical-convert` |
| Find and repair theme drift             | `graphical-audit`   |


## Selected setup for this download

The user selected **Install theme, skills, and all Base UI components**. The actual preview components, shared styling runtime, stylesheet, and current theme snapshot are included in `components/graphical/`. Use these files directly; do not recreate them from specifications. Follow [the component setup guide](gui/base-ui.md): import `components/graphical/styles.css` once, wrap the app with `GraphicalProvider` using the exported `theme`, and use the public components from `components/graphical/index.ts`. Apply the theme across existing app styles and components, preserving behavior and authored refinements. This is an explicit setup request: proceed without another conversion-scope question, honoring any narrower scope already supplied. Add only missing dependencies with the receiving package manager; preserve existing versions and report API incompatibilities. Install the chosen fonts and icons separately. Report component coverage, import paths, actual verification, and any visual or asset gaps. Copying files or installing Base UI alone is not completion.

## Fonts and icons

Follow [asset installation](gui/assets.md) when implementing this theme. Download and configure the selected free assets from their official sources; no font files or icon artwork are bundled. Weights below are the authored requests: load matching static faces or a variable range and report any unavailable weight. Register the exact family aliases below, or map the role tokens to the loader’s actual family.

| Selected font | Roles | Weights | Family stack | Setup |
| --- | --- | --- | --- | --- |
| <code>LT Superior Serif</code> (free) | brand, editorial | 400, 500, 700 | <code>"LT Superior Serif", Georgia, serif</code> | Download and load [LT Superior Serif](https://lyonstype.neocities.org/fonts) in the app. |
| <code>Timeless Sans</code> (free) | ui | 400, 500, 600 | <code>"Timeless Sans", sans-serif</code> | Download and load [Timeless Sans](https://timeless.co/type) in the app. Use the vendor’s Sans cut; if using Timeless Sans variable files, pin STYL to 100, with ital 0 for upright or 100 for required italic faces. |
| <code>Geist Mono</code> (free) | data | 400, 500, 600 | <code>"Sidebar Geist Mono", monospace</code> | Download and load [Geist Mono](https://vercel.com/font) in the app. |

### Icons

Selected: [Hugeicons](https://hugeicons.com/docs/integrations/react/pro), outlined. Selected variant: <code>stroke-rounded</code>. Use the receiving app’s own Hugeicons Pro license and [official registry setup](https://hugeicons.com/docs/integrations/react/pro). Reuse installed packages; add only missing <code>@hugeicons/react</code> and <code>@hugeicons-pro/core-stroke-rounded</code> using the app’s package manager and version policy. Keep the license key in a local environment variable, never in source, prompts, or downloads. With the all-components download, connect <code>createHugeiconsRenderer</code> to <code>IconRendererProvider</code>: supply <code>loadCatalog(variant)</code> for the selected package (variant is the exact name above) and <code>renderGlyph(icon, svgProps)</code> using <code>HugeiconsIcon</code>, forwarding SVG props and styles. Use named icon imports and defer the renderer and each selected catalog until Hugeicons is active; cache successful loads and avoid prefetching unused styles. If the license is missing, ask for the app’s licensed setup and name Lucide as the free fallback. Honor any existing answer; only switch to [Lucide](https://lucide.dev/guide/react/getting-started) when the user confirms the license is unavailable or chooses that fallback. Disclose the substitution and link [Hugeicons](https://hugeicons.com/docs/integrations/react/pro) with steps to obtain a license, configure the registry, install the selected catalog, and reconnect the adapter.

Preserve icon size, color, weight, style, and accessible names. Match the selected style only where the pack supports it; Lucide’s official pack supplies outlines, so report a filled-style gap rather than claiming exact filled artwork. Keep existing package versions and add only missing packages using the receiving project’s package manager.

Kintsugi's setup (owner decision, 2026-11-02): Hugeicons **free**, stroke-rounded (`@hugeicons/core-free-icons`, MIT), with no Pro package and no Lucide. The bundled source's Lucide imports were replaced with the same free set, and `lucide-react` is not installed. Import app icons from `@kintsugi/ui/icons`. See `docs/graphical-coverage.md`.

## Theme values

These sections contain the complete saved theme: both color modes, foundation values, and authored component edits. Import this GUI.md from Theme → Edit → Import theme to restore it. Shared palette catalogs and editor preferences are not part of the theme.

Lengths are pixels, letter spacing is em, motion durations are milliseconds, and opacity values are percentages. Text sizes, line heights, spacing, and radii render at the nearest whole pixel; the saved precision below preserves editing values. Color translucency defaults to 20% when omitted. Component edits use named tokens; the companion component specifications resolve inherited styles and behavior.

<!-- graphical-theme:start -->

### Identity

```json
{
  "format": "graphical-theme",
  "version": 1,
  "preset": "charter",
  "schemaVersion": 2,
  "name": "Kintsugi"
}
```

### Colors

```json
{
  "colors": {
    "dark": {
      "error": "#ee9991",
      "color-1": "#0a0a0a",
      "color-2": "#779575",
      "color-3": "#c3b58f",
      "color-4": "#b0a0c0",
      "success": "#88cbaa",
      "warning": "#ddbc74",
      "neutral-1": "#191919",
      "neutral-2": "#202020",
      "neutral-3": "#282828",
      "neutral-4": "#363636",
      "neutral-5": "#494949",
      "neutral-6": "#757575",
      "neutral-7": "#a7a7a7",
      "neutral-8": "#c8c8c8",
      "neutral-9": "#e0e0e0",
      "neutral-10": "#f9f9f9"
    },
    "light": {
      "error": "#b34846",
      "color-1": "#0a0a0a",
      "color-2": "#c2d3b8",
      "color-3": "#e2d7bd",
      "color-4": "#c8bbd5",
      "success": "#247052",
      "warning": "#926318",
      "neutral-1": "#ffffff",
      "neutral-2": "#f9f9f9",
      "neutral-3": "#f0f0f0",
      "neutral-4": "#e0e0e0",
      "neutral-5": "#cfcfcf",
      "neutral-6": "#a1a1a1",
      "neutral-7": "#737373",
      "neutral-8": "#525252",
      "neutral-9": "#333333",
      "neutral-10": "#1f1f1f"
    }
  },
  "primaryForeground": {},
  "primaryActionColor": "neutral-10",
  "neutralTone": "neutral",
  "colorEmphasis": 8.372395833333334,
  "keyColorPalette": [
    "#321b46",
    "#174d38",
    "#233c56",
    "#754c37",
    "#655082",
    "#4d5c96",
    "#496a55",
    "#5d632f",
    "#805f26",
    "#98533a",
    "#793b55",
    "#4a6169",
    "#2a2926"
  ]
}
```

### Typography

```json
{
  "fonts": {
    "ui": {
      "family": "\"Timeless Sans\", sans-serif",
      "weights": { "heavy": 600, "medium": 500, "regular": 400 }
    },
    "data": {
      "family": "\"Sidebar Geist Mono\", monospace",
      "weights": { "heavy": 600, "medium": 500, "regular": 400 }
    },
    "brand": {
      "family": "\"LT Superior Serif\", Georgia, serif",
      "weights": { "heavy": 700, "medium": 500, "regular": 400 }
    },
    "editorial": {
      "family": "\"LT Superior Serif\", Georgia, serif",
      "weights": { "heavy": 700, "medium": 500, "regular": 400 }
    }
  },
  "text": {
    "l": { "size": 23.338, "lineHeight": 31.117 },
    "m": { "size": 15.559, "lineHeight": 23.338 },
    "s": { "size": 13.614, "lineHeight": 19.448 },
    "xl": { "size": 35.007, "lineHeight": 38.897 },
    "xs": { "size": 11.669, "lineHeight": 15.559 },
    "xxl": { "size": 46.676, "lineHeight": 50.566 },
    "xxs": { "size": 9.724, "lineHeight": 13.614 }
  },
  "letterSpacing": { "l": -0.01, "m": -0.01, "s": -0.045, "xl": 0.005, "xs": -0.045 }
}
```

### Spacing and corners

```json
{
  "spacing": {
    "l": 22.265,
    "m": 14.844,
    "s": 11.133,
    "xl": 29.686,
    "xs": 7.421,
    "xxl": 44.53,
    "xxs": 3.711,
    "zero": 0
  },
  "radius": { "l": 15, "m": 10, "s": 4.67, "xl": 25, "xs": 2, "full": 9999, "zero": 0 },
  "buttonRadius": "s"
}
```

### Borders and effects

```json
{
  "border": { "l": 1.26, "m": 0.6, "s": 0.5837239583333333, "none": 0 },
  "shadows": {
    "l": {
      "x": 0,
      "y": 16,
      "blur": 40,
      "color": { "dark": "neutral-1", "light": "neutral-10" },
      "spread": 0,
      "opacity": 30
    },
    "m": {
      "x": 0,
      "y": 8,
      "blur": 24,
      "color": { "dark": "neutral-1", "light": "neutral-10" },
      "spread": 0,
      "opacity": 20
    },
    "s": {
      "x": 0,
      "y": 2,
      "blur": 4,
      "color": { "dark": "neutral-1", "light": "neutral-10" },
      "spread": 0,
      "opacity": 10
    }
  }
}
```

### Motion

```json
{
  "animation": {
    "large": { "easing": [ 0.22, 1, 0.37, 1.01 ], "duration": 320 },
    "easing": [ 0.16, 1, 0.16, 1 ],
    "duration": 180,
    "popupScale": 0.98,
    "pressDistance": 1
  }
}
```

### Icons

Package weight: **1.5px**. The iconWeight value below preserves Graphical’s setting.

```json
{
  "iconFamily": "Hugeicons",
  "iconStyle": "outlined",
  "iconWeight": 300,
  "hugeiconsVariant": "stroke-rounded"
}
```

### Component edits

```json
{ "componentTokens": {}, "componentVariants": {} }
```

<!-- graphical-theme:end -->
