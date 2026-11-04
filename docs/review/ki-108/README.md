# KI-108 editor review

The seeded “Kintsugi and gold” draft, on the real headless runtime with a scratch vault. Source bytes stayed unchanged.

| View | Light | Dark |
| --- | --- | --- |
| Before, 1440 × 900 | [Before](before-light.png) | [Before](before-dark.png) |
| After, 1440 × 900 | [After](after-light.png) | [After](after-dark.png) |
| After, 1280 × 900 | [Folded sidebar](after-1280-light.png) | [Folded sidebar](after-1280-dark.png) |

Before captures temporarily omitted the new editor extension. All other code, typography, measure and fixture text were identical.

## Decisions for the owner

- Keep the fixed measure. Render soft newlines in prose paragraphs as spaces, without changing the Markdown.
- Keep explicit hard breaks, code, lists, quotes, frontmatter and apparent MDX code in source layout.
- A single Enter remains a Markdown soft break; two create a new paragraph. Copy keeps the source newlines.

## Verification

- The KI-108 runtime tests compare every character’s row against a space-joined source. They cover all margin tabs, light/dark, 1440/1280, reload, reference-chip selection, copy, typing, paragraph splitting and undo.
- The six KI-103 margin tests pass, including sidebar folding, narrow overlays, full screen and classic scrollbars.
- The KI-103 measurement helper now compares raw glyph coordinates. Inline version marks can change font rounding by 1/64 pixel; rounding first falsely reported half-pixel moves. Rows must match exactly; horizontal differences must stay below 1/16 pixel.
- The scoped Graphical review preserves the editor’s existing typography and measure. No theme values, controls, fonts or icons changed.
- Volli Browser review: no console errors. The backend reported zero native windows, no Dock registration and no focus activation.

Native iOS selection was not tested.
