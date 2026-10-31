# Kintsugi font assets

The captured theme's family aliases and stacks are retained. The owner supplied
both vendor archives for the KI-20 follow-up; the original files in Downloads
were read only. Extraction/inspection happened in `.headless/font-import/`.

| Alias | Shipped faces / status | Source and license |
| --- | --- | --- |
| `Sidebar Geist Mono` | Loaded upright variable 100–900 (requested 400/500/600), Latin/Cyrillic/Vietnamese/symbol subsets | `@fontsource-variable/geist-mono@5.3.0`; SIL OFL in `geist-mono/LICENSE`; registered in `geist-mono.css`. Official family: https://vercel.com/font |
| `LT Superior Serif` | Original Regular/Medium/Bold OTFs; real OS/2 weights 400/500/700; registered under the exact alias in `superior-serif.css` | Owner-supplied `LTSuperiorSerif.zip`, LyonsType; SIL OFL 1.1, copyright LyonsType 2024, Reserved Font Name “LT Superior Serif”; complete notice beside faces in `superior-serif/OFL.txt` |
| `Timeless Sans` | **Not shipped: packaged license gate**. The authored `sans-serif` fallback currently renders. | Owner-supplied `Timeless-Type-Family-1.094.zip`; README and LICENSE.pdf both identify Timeless Free Font License **1.2**, not the newer website license. See below. |

## LT Superior Serif

Only the requested upright 400/500/700 faces are included. Their bytes are
identical to the supplied archive. No WOFF2 converter (`woff2_compress` or
fontTools) was installed, so the owner-authorized original OTF option is used;
there is no format/name modification. `font-display: swap` is configured.

**No italic face exists in the supplied archive.** Existing editor emphasis and
quotes request italic styling; any browser-generated slant is synthetic, not a
loaded vendor italic. No substitute family or invented italic face was added.
Semibold/ExtraBold were not copied because the captured roles do not request them.

The full OFL notices for both Superior Serif and Geist Mono are also copied to
`apps/{desktop,lab}/public/font-licenses/` so Vite distributions retain them.
The original Superior OFL's CRLF/whitespace bytes are preserved via narrowly
scoped `.gitattributes`; authored source keeps normal whitespace checks.
`font-assets.test.ts` checks source hashes, OS/2 weights, descriptors and identical
notice copies. `scripts/check-theme-assets.mjs --allow-blocked-timeless` checks
actual returned loaded FontFace objects at each requested weight; the blocked
family is reported separately rather than passing through a generic fallback.

## Timeless: license inspection and remaining step

The supplied README recommends variable WOFF2s for web serving. Companion TTF
`fvar` metadata confirms the matching `TimelessSansVF` family has:

- `wght`: 300–800 (covers requested 400/500/600)
- `STYL`: 0–100 (Sans = 100, not Grotesk = 0)
- `ital`: 0–100 (upright = 0)

Technically the supplied variable Sans face is suitable. However, the included
**v1.2** license §6 says:

> “Bundle, mirror or otherwise redistribute the fonts, in whole or in part,
> whether original, custom cut or embedding conversion”

is restricted. §8.4 says:

> “the version that came with your copy of the fonts keeps applying to that copy.”

§5.3 permits embedding as part of a work and §5.5 permits collaborator sharing,
but private code-repository bundling is not explicitly permitted to resolve §6.
Per the owner's instruction, Timeless shipping stopped pending a vendor archive
carrying the newer **v1.3** license (which explicitly allows repository/app
bundling), or written vendor permission for this repository. The online license
at https://www.timeless.co/type/license is not silently substituted for the
contract that accompanied these files. No Timeless font or PDF license was copied
into tracked assets; the supplied PDF/README were inspected only in gitignored
temp. No forms were submitted.

When cleared, include only `Sans-Grotesk/TimelessSansVF.woff2` and its applicable
license/README, register exact alias `Timeless Sans`, truthful weight range
300–800, and pin `STYL=100` / `ital=0` throughout the UI and portals. Do not ship
Grotesk statics or the Serif-Text family. Acquire italic faces/settings separately
if a UI use actually needs them. Official destination:
https://www.timeless.co/type/playground .
