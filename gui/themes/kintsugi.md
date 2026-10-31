# Kintsugi

Generated from the current project, including edits awaiting autosave. Return to the [theme index](../themes.md). Install the selected fonts and icons using the setup below; assets are acquired separately from their official sources.

## Font and icon setup

Follow [asset installation](../assets.md) when implementing this theme. Download and configure the selected free assets from their official sources; no font files or icon artwork are bundled. Weights below are the authored requests: load matching static faces or a variable range and report any unavailable weight. Register the exact family aliases below, or map the role tokens to the loader’s actual family.

| Selected font | Roles | Weights | Family stack | Setup |
| --- | --- | --- | --- | --- |
| <code>LT Superior Serif</code> (free) | brand, editorial | 400, 500, 700 | <code>"LT Superior Serif", Georgia, serif</code> | Download and load [LT Superior Serif](https://lyonstype.neocities.org/fonts) in the app. |
| <code>Timeless Sans</code> (free) | ui | 400, 500, 600 | <code>"Timeless Sans", sans-serif</code> | Download and load [Timeless Sans](https://timeless.co/type) in the app. Use the vendor’s Sans cut; if using Timeless Sans variable files, pin STYL to 100, with ital 0 for upright or 100 for required italic faces. |
| <code>Geist Mono</code> (free) | data | 400, 500, 600 | <code>"Sidebar Geist Mono", monospace</code> | Download and load [Geist Mono](https://vercel.com/font) in the app. |

### Icons

Selected: [Hugeicons](https://hugeicons.com/docs/integrations/react/pro), outlined. Selected variant: <code>stroke-rounded</code>. Use the receiving app’s own Hugeicons Pro license and [official registry setup](https://hugeicons.com/docs/integrations/react/pro). Reuse installed packages; add only missing <code>@hugeicons/react</code> and <code>@hugeicons-pro/core-stroke-rounded</code> using the app’s package manager and version policy. Keep the license key in a local environment variable, never in source, prompts, or downloads. With the all-components download, connect <code>createHugeiconsRenderer</code> to <code>IconRendererProvider</code>: supply <code>loadCatalog(variant)</code> for the selected package (variant is the exact name above) and <code>renderGlyph(icon, svgProps)</code> using <code>HugeiconsIcon</code>, forwarding SVG props and styles. Use named icon imports and defer the renderer and each selected catalog until Hugeicons is active; cache successful loads and avoid prefetching unused styles. If the license is missing, ask for the app’s licensed setup and name Lucide as the free fallback. Honor any existing answer; only switch to [Lucide](https://lucide.dev/guide/react/getting-started) when the user confirms the license is unavailable or chooses that fallback. Disclose the substitution and link [Hugeicons](https://hugeicons.com/docs/integrations/react/pro) with steps to obtain a license, configure the registry, install the selected catalog, and reconnect the adapter.

Preserve icon size, color, weight, style, and accessible names. Match the selected style only where the pack supports it; Lucide’s official pack supplies outlines, so report a filled-style gap rather than claiming exact filled artwork. Keep existing package versions and add only missing packages using the receiving project’s package manager.

## Foundations

These foundations describe the captured theme resolved by the bundled GraphicalProvider. The name below is document.theme.name, an internal style identity used by the components; displayName is the project’s visible name. Preserve it and the provider’s resolved --theme-name even when they differ from each other or from the project’s display name. Use document.name for visible labels.

```json
{
  "name": "Charter",
  "text": {
    "l": {
      "size": 23,
      "lineHeight": 31
    },
    "m": {
      "size": 16,
      "lineHeight": 23
    },
    "s": {
      "size": 14,
      "lineHeight": 19
    },
    "xl": {
      "size": 35,
      "lineHeight": 39
    },
    "xs": {
      "size": 12,
      "lineHeight": 16
    },
    "xxl": {
      "size": 47,
      "lineHeight": 51
    },
    "xxs": {
      "size": 10,
      "lineHeight": 14
    }
  },
  "fonts": {
    "ui": {
      "family": "\"Timeless Sans\", sans-serif",
      "weights": {
        "heavy": 600,
        "medium": 500,
        "regular": 400
      }
    },
    "data": {
      "family": "\"Sidebar Geist Mono\", monospace",
      "weights": {
        "heavy": 600,
        "medium": 500,
        "regular": 400
      }
    },
    "brand": {
      "family": "\"LT Superior Serif\", Georgia, serif",
      "weights": {
        "heavy": 700,
        "medium": 500,
        "regular": 400
      }
    },
    "editorial": {
      "family": "\"LT Superior Serif\", Georgia, serif",
      "weights": {
        "heavy": 700,
        "medium": 500,
        "regular": 400
      }
    }
  },
  "border": {
    "l": 1.26,
    "m": 0.6,
    "s": 0.5837239583333333,
    "none": 0
  },
  "radius": {
    "l": 15,
    "m": 10,
    "s": 5,
    "xl": 25,
    "xs": 2,
    "full": 9999,
    "zero": 0
  },
  "shadows": {
    "l": {
      "x": 0,
      "y": 16,
      "blur": 40,
      "color": {
        "dark": "neutral-1",
        "light": "neutral-10"
      },
      "spread": 0,
      "opacity": 30
    },
    "m": {
      "x": 0,
      "y": 8,
      "blur": 24,
      "color": {
        "dark": "neutral-1",
        "light": "neutral-10"
      },
      "spread": 0,
      "opacity": 20
    },
    "s": {
      "x": 0,
      "y": 2,
      "blur": 4,
      "color": {
        "dark": "neutral-1",
        "light": "neutral-10"
      },
      "spread": 0,
      "opacity": 10
    }
  },
  "spacing": {
    "l": 22,
    "m": 15,
    "s": 11,
    "xl": 30,
    "xs": 7,
    "xxl": 45,
    "xxs": 4,
    "zero": 0
  },
  "animation": {
    "large": {
      "easing": [
        0.22,
        1,
        0.37,
        1.01
      ],
      "duration": 320
    },
    "easing": [
      0.16,
      1,
      0.16,
      1
    ],
    "duration": 180,
    "popupScale": 0.98,
    "pressDistance": 1
  },
  "iconStyle": "outlined",
  "iconFamily": "Hugeicons",
  "iconWeight": 300,
  "neutralTone": "neutral",
  "buttonRadius": "s",
  "colorEmphasis": 8.372395833333334,
  "letterSpacing": {
    "l": -0.01,
    "m": -0.01,
    "s": -0.045,
    "xl": 0.005,
    "xs": -0.045
  },
  "hugeiconsVariant": "stroke-rounded",
  "primaryForeground": {},
  "primaryActionColor": "neutral-10",
  "displayName": "Kintsugi"
}
```

## light CSS variables

GraphicalProvider already defines these variables for this mode and carries them into portalled components. Use this table to verify the integration. Preserve its internal --theme-name value; do not rename it to match the project title. Keep application styles linked to these variables.

| Variable | Value |
| --- | --- |
| `--theme-name` | Paper |
| `--theme-icon-family` | Hugeicons |
| `--theme-icon-style` | outlined |
| `--theme-hugeicons-variant` | stroke-rounded |
| `--theme-icon-stroke-width` | 1.5 |
| `--theme-icon-thin-display` | none |
| `--theme-icon-light-display` | inline |
| `--theme-icon-regular-display` | none |
| `--theme-icon-bold-display` | none |
| `--toolbar-divider-bleed` | 0 |
| `--focus-ring-outline` | initial |
| `--icon-stroke-width` | var(--theme-icon-stroke-width, 2) |
| `--icon-light-display` | var(--theme-icon-light-display, none) |
| `--icon-regular-display` | var(--theme-icon-regular-display, inline) |
| `--icon-bold-display` | var(--theme-icon-bold-display, none) |
| `--motion-duration` | 180ms |
| `--motion-easing` | cubic-bezier(0.16, 1, 0.16, 1) |
| `--motion-type` | easing |
| `--motion-visual-duration` | 0.18 |
| `--motion-bounce` | 0.2 |
| `--motion-enabled` | 1 |
| `--motion-small-iterations` | infinite |
| `--motion-large-duration` | 320ms |
| `--motion-large-easing` | cubic-bezier(0.22, 1, 0.37, 1.01) |
| `--motion-large-type` | easing |
| `--motion-large-visual-duration` | 0.32 |
| `--motion-large-bounce` | 0.2 |
| `--motion-large-iterations` | infinite |
| `--motion-popup-scale` | 0.98 |
| `--motion-press-distance` | 1px |
| `--option-badge-background` | #f0f0f0 |
| `--option-badge-foreground` | #1f1f1f |
| `--navigation-active-foreground` | #1f1f1f |
| `--emphasis-chart-fill` | #0a0a0a33 |
| `--emphasis-balance-background` | #f0f0f0 |
| `--emphasis-rewards-background` | #f0f0f0 |
| `--emphasis-icon-background` | #f0f0f0 |
| `--emphasis-icon-foreground` | #1f1f1f |
| `--emphasis-type-background` | #f0f0f0 |
| `--emphasis-type-foreground` | #1f1f1f |
| `--navigation-active-background` | #f0f0f0 |
| `--surface-raised-image` | none |
| `--surface-raised-shadow` | 0 0 0 0 transparent |
| `--surface-recessed-image` | none |
| `--surface-recessed-shadow` | 0 0 0 0 transparent |
| `--space-zero` | 0px |
| `--space-xxs` | 4px |
| `--space-xs` | 7px |
| `--space-s` | 11px |
| `--space-m` | 15px |
| `--space-l` | 22px |
| `--space-xl` | 30px |
| `--space-xxl` | 45px |
| `--tracking-xs` | -0.045em |
| `--tracking-s` | -0.045em |
| `--tracking-m` | -0.01em |
| `--tracking-l` | -0.01em |
| `--tracking-xl` | 0.005em |
| `--size-xxs` | 10px |
| `--line-xxs` | 14px |
| `--letter-spacing-xxs` | 0.005em |
| `--size-xs` | 12px |
| `--line-xs` | 16px |
| `--letter-spacing-xs` | -0.01em |
| `--size-s` | 14px |
| `--line-s` | 19px |
| `--letter-spacing-s` | -0.01em |
| `--size-m` | 16px |
| `--line-m` | 23px |
| `--letter-spacing-m` | -0.01em |
| `--size-l` | 23px |
| `--line-l` | 31px |
| `--letter-spacing-l` | -0.045em |
| `--size-xl` | 35px |
| `--line-xl` | 39px |
| `--letter-spacing-xl` | -0.045em |
| `--size-xxl` | 47px |
| `--line-xxl` | 51px |
| `--letter-spacing-xxl` | -0.045em |
| `--radius-zero` | 0px |
| `--radius-xs` | 2px |
| `--radius-s` | 5px |
| `--radius-m` | 10px |
| `--radius-l` | 15px |
| `--radius-xl` | 25px |
| `--radius-full` | 9999px |
| `--border-none` | 0px |
| `--border-s` | 0.5837239583333333px |
| `--border-m` | 0.6px |
| `--border-l` | 1.26px |
| `--border-default-color` | #e0e0e033 |
| `--border-shadow-none` | 0 0 0 0 transparent |
| `--border-shadow-s` | 0 0 0 0.5837239583333333px #e0e0e033 |
| `--border-shadow-m` | 0 0 0 0.6px #e0e0e033 |
| `--border-shadow-l` | 0 0 0 1.26px #e0e0e033 |
| `--font-ui` | "Timeless Sans", sans-serif |
| `--weight-ui-regular` | 400 |
| `--weight-ui-medium` | 500 |
| `--weight-ui-heavy` | 600 |
| `--font-brand` | "LT Superior Serif", Georgia, serif |
| `--weight-brand-regular` | 400 |
| `--weight-brand-medium` | 500 |
| `--weight-brand-heavy` | 700 |
| `--font-editorial` | "LT Superior Serif", Georgia, serif |
| `--weight-editorial-regular` | 400 |
| `--weight-editorial-medium` | 500 |
| `--weight-editorial-heavy` | 700 |
| `--font-data` | "Sidebar Geist Mono", monospace |
| `--weight-data-regular` | 400 |
| `--weight-data-medium` | 500 |
| `--weight-data-heavy` | 600 |
| `--color-none` | transparent |
| `--color-1` | #0a0a0a |
| `--color-1-transparent` | #0a0a0a33 |
| `--color-2` | #c2d3b8 |
| `--color-2-transparent` | #c2d3b833 |
| `--color-3` | #e2d7bd |
| `--color-3-transparent` | #e2d7bd33 |
| `--color-4` | #c8bbd5 |
| `--color-4-transparent` | #c8bbd533 |
| `--neutral-1` | #ffffff |
| `--neutral-1-transparent` | #ffffff33 |
| `--neutral-2` | #f9f9f9 |
| `--neutral-2-transparent` | #f9f9f933 |
| `--neutral-3` | #f0f0f0 |
| `--neutral-3-transparent` | #f0f0f033 |
| `--neutral-4` | #e0e0e0 |
| `--neutral-4-transparent` | #e0e0e033 |
| `--neutral-5` | #cfcfcf |
| `--neutral-5-transparent` | #cfcfcf33 |
| `--neutral-6` | #a1a1a1 |
| `--neutral-6-transparent` | #a1a1a133 |
| `--neutral-7` | #737373 |
| `--neutral-7-transparent` | #73737333 |
| `--neutral-8` | #525252 |
| `--neutral-8-transparent` | #52525233 |
| `--neutral-9` | #333333 |
| `--neutral-9-transparent` | #33333333 |
| `--neutral-10` | #1f1f1f |
| `--neutral-10-transparent` | #1f1f1f33 |
| `--success` | #247052 |
| `--success-transparent` | #24705233 |
| `--warning` | #926318 |
| `--warning-transparent` | #92631833 |
| `--error` | #b34846 |
| `--error-transparent` | #b3484633 |
| `--shadow-none` | none |
| `--shadow-s` | 0px 0.5px 1px 0px #1f1f1f0b, 0px 2px 4px 0px #1f1f1f10 |
| `--shadow-m` | 0px 2px 6px 0px #1f1f1f16, 0px 8px 24px 0px #1f1f1f20 |
| `--shadow-l` | 0px 4px 10px 0px #1f1f1f22, 0px 16px 40px 0px #1f1f1f31 |
| `--cte-canvas` | #ffffff |
| `--cte-surface` | #f9f9f9 |
| `--cte-surface-muted` | #f0f0f0 |
| `--cte-text` | #1f1f1f |
| `--cte-text-muted` | #737373 |
| `--cte-border` | #e0e0e033 |
| `--cte-accent` | #0a0a0a |
| `--cte-accent-text` | #ffffff |
| `--cte-danger` | #b34846 |
| `--cte-focus` | #0a0a0a |
| `--cte-font` | "Timeless Sans", sans-serif |
| `--cte-font-size` | 14px |
| `--cte-font-weight` | 400 |
| `--cte-line-height` | 19px |
| `--cte-letter-spacing` | -0.01em |
| `--cte-detail-font-size` | 12px |
| `--cte-detail-line-height` | 16px |
| `--cte-detail-letter-spacing` | -0.01em |

## dark CSS variables

GraphicalProvider already defines these variables for this mode and carries them into portalled components. Use this table to verify the integration. Preserve its internal --theme-name value; do not rename it to match the project title. Keep application styles linked to these variables.

| Variable | Value |
| --- | --- |
| `--theme-name` | Paper |
| `--theme-icon-family` | Hugeicons |
| `--theme-icon-style` | outlined |
| `--theme-hugeicons-variant` | stroke-rounded |
| `--theme-icon-stroke-width` | 1.5 |
| `--theme-icon-thin-display` | none |
| `--theme-icon-light-display` | inline |
| `--theme-icon-regular-display` | none |
| `--theme-icon-bold-display` | none |
| `--toolbar-divider-bleed` | 0 |
| `--focus-ring-outline` | initial |
| `--icon-stroke-width` | var(--theme-icon-stroke-width, 2) |
| `--icon-light-display` | var(--theme-icon-light-display, none) |
| `--icon-regular-display` | var(--theme-icon-regular-display, inline) |
| `--icon-bold-display` | var(--theme-icon-bold-display, none) |
| `--motion-duration` | 180ms |
| `--motion-easing` | cubic-bezier(0.16, 1, 0.16, 1) |
| `--motion-type` | easing |
| `--motion-visual-duration` | 0.18 |
| `--motion-bounce` | 0.2 |
| `--motion-enabled` | 1 |
| `--motion-small-iterations` | infinite |
| `--motion-large-duration` | 320ms |
| `--motion-large-easing` | cubic-bezier(0.22, 1, 0.37, 1.01) |
| `--motion-large-type` | easing |
| `--motion-large-visual-duration` | 0.32 |
| `--motion-large-bounce` | 0.2 |
| `--motion-large-iterations` | infinite |
| `--motion-popup-scale` | 0.98 |
| `--motion-press-distance` | 1px |
| `--option-badge-background` | #282828 |
| `--option-badge-foreground` | #f9f9f9 |
| `--navigation-active-foreground` | #f9f9f9 |
| `--emphasis-chart-fill` | #0a0a0a33 |
| `--emphasis-balance-background` | #282828 |
| `--emphasis-rewards-background` | #282828 |
| `--emphasis-icon-background` | #282828 |
| `--emphasis-icon-foreground` | #f9f9f9 |
| `--emphasis-type-background` | #282828 |
| `--emphasis-type-foreground` | #f9f9f9 |
| `--navigation-active-background` | #282828 |
| `--surface-raised-image` | none |
| `--surface-raised-shadow` | 0 0 0 0 transparent |
| `--surface-recessed-image` | none |
| `--surface-recessed-shadow` | 0 0 0 0 transparent |
| `--space-zero` | 0px |
| `--space-xxs` | 4px |
| `--space-xs` | 7px |
| `--space-s` | 11px |
| `--space-m` | 15px |
| `--space-l` | 22px |
| `--space-xl` | 30px |
| `--space-xxl` | 45px |
| `--tracking-xs` | -0.045em |
| `--tracking-s` | -0.045em |
| `--tracking-m` | -0.01em |
| `--tracking-l` | -0.01em |
| `--tracking-xl` | 0.005em |
| `--size-xxs` | 10px |
| `--line-xxs` | 14px |
| `--letter-spacing-xxs` | 0.005em |
| `--size-xs` | 12px |
| `--line-xs` | 16px |
| `--letter-spacing-xs` | -0.01em |
| `--size-s` | 14px |
| `--line-s` | 19px |
| `--letter-spacing-s` | -0.01em |
| `--size-m` | 16px |
| `--line-m` | 23px |
| `--letter-spacing-m` | -0.01em |
| `--size-l` | 23px |
| `--line-l` | 31px |
| `--letter-spacing-l` | -0.045em |
| `--size-xl` | 35px |
| `--line-xl` | 39px |
| `--letter-spacing-xl` | -0.045em |
| `--size-xxl` | 47px |
| `--line-xxl` | 51px |
| `--letter-spacing-xxl` | -0.045em |
| `--radius-zero` | 0px |
| `--radius-xs` | 2px |
| `--radius-s` | 5px |
| `--radius-m` | 10px |
| `--radius-l` | 15px |
| `--radius-xl` | 25px |
| `--radius-full` | 9999px |
| `--border-none` | 0px |
| `--border-s` | 0.5837239583333333px |
| `--border-m` | 0.6px |
| `--border-l` | 1.26px |
| `--border-default-color` | #36363633 |
| `--border-shadow-none` | 0 0 0 0 transparent |
| `--border-shadow-s` | inset 0 0 0 0.5837239583333333px #36363633 |
| `--border-shadow-m` | inset 0 0 0 0.6px #36363633 |
| `--border-shadow-l` | inset 0 0 0 1.26px #36363633 |
| `--font-ui` | "Timeless Sans", sans-serif |
| `--weight-ui-regular` | 400 |
| `--weight-ui-medium` | 500 |
| `--weight-ui-heavy` | 600 |
| `--font-brand` | "LT Superior Serif", Georgia, serif |
| `--weight-brand-regular` | 400 |
| `--weight-brand-medium` | 500 |
| `--weight-brand-heavy` | 700 |
| `--font-editorial` | "LT Superior Serif", Georgia, serif |
| `--weight-editorial-regular` | 400 |
| `--weight-editorial-medium` | 500 |
| `--weight-editorial-heavy` | 700 |
| `--font-data` | "Sidebar Geist Mono", monospace |
| `--weight-data-regular` | 400 |
| `--weight-data-medium` | 500 |
| `--weight-data-heavy` | 600 |
| `--color-none` | transparent |
| `--color-1` | #0a0a0a |
| `--color-1-transparent` | #0a0a0a33 |
| `--color-2` | #779575 |
| `--color-2-transparent` | #77957533 |
| `--color-3` | #c3b58f |
| `--color-3-transparent` | #c3b58f33 |
| `--color-4` | #b0a0c0 |
| `--color-4-transparent` | #b0a0c033 |
| `--neutral-1` | #191919 |
| `--neutral-1-transparent` | #19191933 |
| `--neutral-2` | #202020 |
| `--neutral-2-transparent` | #20202033 |
| `--neutral-3` | #282828 |
| `--neutral-3-transparent` | #28282833 |
| `--neutral-4` | #363636 |
| `--neutral-4-transparent` | #36363633 |
| `--neutral-5` | #494949 |
| `--neutral-5-transparent` | #49494933 |
| `--neutral-6` | #757575 |
| `--neutral-6-transparent` | #75757533 |
| `--neutral-7` | #a7a7a7 |
| `--neutral-7-transparent` | #a7a7a733 |
| `--neutral-8` | #c8c8c8 |
| `--neutral-8-transparent` | #c8c8c833 |
| `--neutral-9` | #e0e0e0 |
| `--neutral-9-transparent` | #e0e0e033 |
| `--neutral-10` | #f9f9f9 |
| `--neutral-10-transparent` | #f9f9f933 |
| `--success` | #88cbaa |
| `--success-transparent` | #88cbaa33 |
| `--warning` | #ddbc74 |
| `--warning-transparent` | #ddbc7433 |
| `--error` | #ee9991 |
| `--error-transparent` | #ee999133 |
| `--shadow-none` | none |
| `--shadow-s` | 0px 0.5px 1px 0px #1919190b, 0px 2px 4px 0px #19191910 |
| `--shadow-m` | 0px 2px 6px 0px #19191916, 0px 8px 24px 0px #19191920 |
| `--shadow-l` | 0px 4px 10px 0px #19191922, 0px 16px 40px 0px #19191931 |
| `--cte-canvas` | #191919 |
| `--cte-surface` | #202020 |
| `--cte-surface-muted` | #282828 |
| `--cte-text` | #f9f9f9 |
| `--cte-text-muted` | #a7a7a7 |
| `--cte-border` | #36363633 |
| `--cte-accent` | #0a0a0a |
| `--cte-accent-text` | #ffffff |
| `--cte-danger` | #ee9991 |
| `--cte-focus` | #0a0a0a |
| `--cte-font` | "Timeless Sans", sans-serif |
| `--cte-font-size` | 14px |
| `--cte-font-weight` | 400 |
| `--cte-line-height` | 19px |
| `--cte-letter-spacing` | -0.01em |
| `--cte-detail-font-size` | 12px |
| `--cte-detail-line-height` | 16px |
| `--cte-detail-letter-spacing` | -0.01em |

## Authored component assignments

These are project edits. The [component reference](kintsugi-components.md) includes the effective assignments with defaults and shared parts resolved.

```json
{
  "componentTokens": {},
  "componentVariants": {}
}
```
