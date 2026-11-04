# Stash routes

Screenshots from `apps/desktop/test/runtime-stash-routes.test.ts`, using the real headless backend, a scratch vault and Kin's scripted mock model.

- [Stash paragraph button, light](01-stash-button-light.png) and [dark](02-stash-button-dark.png). The cursor is in a paragraph with nothing selected.
- [The stashed row lit up, light](03-stashed-row-light.png) and [dark](04-stashed-row-dark.png). The dark shot was taken later in the fade.
- [⌘K's Stash row in Edit, with ⌥⌘X](05-command-menu-light.png)
- [The margin button's dot after ⌥⌘X with the margin closed](06-margin-pulse-light.png)
- [Holding ⌘ while writing now lists the Stash keys](07-held-command-light.png), and the button shows ⌥⌘X.

The runtime scenario covers ⌥⌘X with the margin closed, the button for a paragraph, a selection and a blank line, ⌘K's row, and a drag onto the list and onto the Stash tab's header. Each one is a single undo step, and none shows a toast.
