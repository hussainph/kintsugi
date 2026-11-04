# Stash tab

Screenshots from `apps/desktop/test/runtime-stash.test.ts`, using the real headless backend, a scratch vault and Kin's scripted mock model.

- [Light](01-stash-light.png)
- [Dark](02-stash-dark.png)

The cursor's word versions sit above the shared stash. Owner text has an empty mark column; Kin's items have its avatar. The focused rewrite shows its original words above the replacement and its actions below. Hover leaves the row collapsed.

Rows use the existing theme's type, colors and spacing. The 28 px actions and disclosure timings follow the owner's Paper option A. Reduced motion removes the height animation.

The runtime scenario covers stashing and notes, version cycling with the margin open and closed, explicit Ask Kin, anchored replacement, picker and drag insertion, shared undo, reorder, dismiss, discuss and Stash on a Kin reply. Kin never adds items unasked.

`runtime-stash-safety.test.ts` checks rejected replies and pending or failed stash writes during draft saves, renames and vault switches.
