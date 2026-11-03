# Refine after another surface

Recorded in a scratch vault through the real headless backend, with Kin's local mock model.

| After scrolling away and closing the palette | Screenshot |
| --- | --- |
| Light | [Refine](refine-light.png) |
| Dark | [Refine](refine-dark.png) |

Before the fix, Refine opened above the window at y = -472. The shortcut had run, but the popup was invisible. Opening an edit now reveals its passage before measuring the anchor. Long selections reveal their end; the selection and text stay unchanged.

The regression test keeps the same editor mounted across About you, Appearance, the shortcuts list, both selection menus, alternatives, dim, held Command, Kin, the comment composer, the palette, Feed, Ideas, Inspiration, and cancelled edits. It also checks the five direct edits and the editor's writing keys.

A Volli Browser Tab check also opened Refine after scrolling and closing the palette. The popup was visible and the console had no errors. The backend process had zero native windows, no Dock registration, and no foreground activation.

No styling, theme values, icons, fonts, or focus ownership changed.
