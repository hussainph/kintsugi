# KI-108 editor review

The seeded “Kintsugi and gold” draft and a test note, on the real headless runtime with a scratch vault. Source bytes stayed unchanged.

| View | Light | Dark |
| --- | --- | --- |
| Before, 1440 × 900 | [Before](before-light.png) | [Before](before-dark.png) |
| After, 1440 × 900 | [After](after-light.png) | [After](after-dark.png) |
| After, 1280 × 900 | [Folded sidebar](after-1280-light.png) | [Folded sidebar](after-1280-dark.png) |
| A note wrapped at 75, a poem, an address | [Note](note-light.png) | [Note](note-dark.png) |
| Enter typed after “decision:” | [Enter](enter-light.png) | [Enter](enter-dark.png) |

Before captures temporarily omitted the new editor extension. All other code, typography, measure and fixture text were identical.

## The rule

A paragraph's soft newlines show as spaces only when its lines look machine-wrapped. Each run of lines between explicit breaks is judged on its own:

- The run's longest line is at least 60 characters. Tools wrap at 60 to 100.
- Every line but the last is at least 60 characters, within 15% of the longest, or too short only because the next word wouldn't fit, such as a long link.

Typed short lines never reach the width, so a poem, an address or a list of short lines keeps its line breaks.

Explicit breaks end a run and always show: two trailing spaces, a backslash, or an Enter typed in this editor. While he edits a paragraph, its other lines hold their layout until the cursor leaves it; then the rule judges it again. Pasted text is judged at once.

## Decisions for the owner

- Keep the fixed measure. Render soft newlines in machine-wrapped prose as spaces, without changing the Markdown.
- Length rule: the 60-character floor stops the 15% test from flowing a poem whose lines are all about the same length. The pushed-word test keeps a note flowing when a long link moves to the next line.
- An Enter he types shows as a new line for as long as the note is open. After reopening, the rule alone decides, because the file can't record which newlines were typed.
- An Enter in the middle of a wrapped paragraph usually leaves a short line after it. Once he moves on, that part of the paragraph shows its source lines, as the rule says.
- Enter removes the space at the cursor, as it does everywhere in the editor.
- Keep hard breaks, code, lists, quotes, frontmatter and MDX code in source layout. Only code-shaped MDX lines count, so prose starting with “import the” still flows.
- Copy keeps the source newlines.

## Verification

- Unit tests cover the rule (75-, 62- and 100-column wraps, poems, addresses, a short line among long ones, a pushed link) and the MDX guard. They also cover typing Enter, holding the edited paragraph, pasting, undo and hard breaks.
- The runtime tests compare every character's row against a space-joined source at 1440 and 1280, light and dark, on every margin tab. They check that a poem and an address keep their lines and that a typed Enter shows at once and survives leaving the paragraph. Copy, undo and reference-chip selection are covered too.
- No line starts with a soft-break space. CodeMirror puts a zero-width image on each side of an inline widget. Under the editor's `break-spaces`, a space at the measure then wrapped alone to the next line. The widget uses `pre-wrap`, so the space hangs at the line end.
- The KI-103 margin tests and KI-107's selection tests pass.

Native iOS selection was not tested.
