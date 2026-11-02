# Kintsugi font assets

All selected upright families and requested weights are now installed under the
captured aliases/stacks. Owner-supplied archives in Downloads were read only.
No fonts are installed into the operating system.

| Alias | Shipped faces | Source and license |
| --- | --- | --- |
| `Sidebar Geist Mono` | Upright variable 100–900; requested 400/500/600 | `@fontsource-variable/geist-mono@5.3.0`; SIL OFL in `geist-mono/LICENSE`; `geist-mono.css`. https://vercel.com/font |
| `LT Superior Serif` | Original Regular/Medium/Bold OTFs, true weights 400/500/700 | Owner-supplied `LTSuperiorSerif.zip`; LyonsType, SIL OFL1.1 / Reserved Font Name “LT Superior Serif”; `superior-serif/OFL.txt`; `superior-serif.css` |
| `Timeless Sans` | Original `Sans-Grotesk/TimelessSansVF.woff2`, variable 300–800; requested 400/500/600; Sans/upright axes | Owner elected Timeless Free Font License **v1.3 (24 October 2026)** on **2026-10-31**; complete `timeless-sans/LICENSE.txt` and provenance/election `NOTICE.txt`; `timeless-sans.css` |

## Timeless Sans — owner-elected v1.3

Source contract: https://www.timeless.co/type/license (checked 2026-10-31).
The full readable text is copied, including §7 (confirmed in the vendor's browser
page because the text-only reader omitted that section's paragraphs).

The owner re-downloaded `Timeless-Type-Family-1.094 (1).zip`; its SHA-256 matches
the earlier archive, and the packaged PDF is still v1.2. **The v1.2 §8.4 does not
contain the later-version election wording.** This was checked, not assumed.
The owner expressly chose the vendor's current **v1.3**, whose §8.4 says:

> The version that came with your copy of the fonts keeps applying to that copy,
> unless you choose to follow a later version instead.

The installation follows that explicit election, recorded in `NOTICE.txt`.
v1.3 §5.3 expressly permits distribution as part of a work, including its public
or private code repository; §5.5 requires a copy of the contract when files are
passed on. No v1.2 PDF is committed as the governing contract. v1.3 is not an OFL
or open-source license: standalone redistribution, renaming, unauthorized font
modification and AI training remain prohibited by §6.

Only the original WOFF2 member is shipped, byte-identical to the archive
(SHA-256 `353b3fbb75b8e9b927db12d520ff8d446d89c36897b47a90d70dbe36e9eeb23a`).
No conversion, subsetting, extraction of outlines or font modification occurred.
Companion vendor VF metadata confirms `wght` 300–800, `STYL` 0–100, `ital` 0–100.
CSS registers exact alias `Timeless Sans`, weight 300–800, normal style and swap.
**Only upright use is configured: no Timeless italic face is registered.**
No Grotesk statics or Serif-Text files are included.

The default `STYL=0` is Grotesk, so UI scopes **and portalled roots** inherit
`font-variation-settings: "STYL" 100, "ital" 0`. The font-face descriptor repeats
those values, but is not the only mechanism: WebKit does not support that
descriptor. Other shipped families ignore these unsupported axes. `wght` is not
pinned: normal CSS weights select 400/500/600 from the actual variable range.

## LT Superior Serif

Only the requested upright 400/500/700 faces are included, byte-identical to the
supplied archive. No WOFF2 converter was installed, so the owner-authorized
original OTFs are used without format/name modification; `font-display: swap`.
**No italic face exists in the supplied archive.** Editor emphasis/quotes may
therefore use a browser-synthesized slant, not a genuine vendor italic. No
substitute family or invented italic face was added.

## Notices and verification

Source contracts accompany the font files. Complete copies (and Timeless's
NOTICE) under `apps/desktop/public/font-licenses/` accompany app builds too.
The original Superior OFL's CRLF/whitespace bytes are preserved by narrowly
scoped `.gitattributes`; authored source retains normal whitespace checks.

`font-assets.test.ts` (run by `pnpm --filter @kintsugi/ui test`) checks font
hashes, descriptors, contracts and distribution copies.
`scripts/check-desktop-theme.mjs` checks, in a running headless app, that the
fonts actually load and that the UI text renders with the Sans/upright axes.
