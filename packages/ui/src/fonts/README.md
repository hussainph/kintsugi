# Kintsugi font assets

The captured theme's stacks remain unchanged. Do not mistake fallback rendering
for completed font setup.

| Alias | Status | Source / remaining step |
| --- | --- | --- |
| `Sidebar Geist Mono` | Loaded, variable 100–900 upright (including requested 400/500/600), Latin/Cyrillic/Vietnamese/symbol subsets | Vendored from `@fontsource-variable/geist-mono@5.3.0`; SIL OFL notice in `geist-mono/LICENSE`. Registered in `geist-mono.css`. Official family: https://vercel.com/font |
| `LT Superior Serif` | **Missing binary assets**; authored `Georgia, serif` stack currently resolves to fallback | https://lyonstype.neocities.org/fonts links the public `LTSuperiorSerif.zip`: https://drive.google.com/file/d/1swtyP9YlpbQ1-aXX6O6MjFc2tmc_PBcj/view . The vendor states SIL OFL. Supply/download that archive, verify its included OFL, and add Regular/Medium/Bold (400/500/700) plus license here. Current web-read tools cannot acquire binary archives. No other font was substituted. |
| `Timeless Sans` | **Blocked: official email-gated download**; authored `sans-serif` fallback currently renders | https://www.timeless.co/type/playground . The owner must obtain and supply the variable Sans files and included license; no form was submitted. Register requested 400/500/600 via the variable range, pin `STYL` 100 and `ital` 0 (already configured in the theme scope). Static “Regular” is 420, not 400. |

Timeless's current vendor license is at https://www.timeless.co/type/license
(v1.3, 24 October 2026). It allows embedding/distribution with the app and
requires the contract to accompany the files. Keep the actual included license
beside the supplied assets. Do not use an unofficial standalone font package or
scrape the specimen's webfonts.

When the missing files arrive, add real `@font-face` declarations under the exact
aliases above, with `font-display: swap`, truthful weight ranges and styles,
and import their stylesheet from `../styles.css`. Do not add placeholder URLs
that produce 404s or register a system font under a selected font's alias.
