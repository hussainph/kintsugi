# KI-96 prototype: Kin and the writing surface

Throwaway. This lives only on `prototype/KI-96-kin-surface` and never merges.

**The question.** Chat, references, versions, the stash, Kin's suggestions and
Kin's working state all want the space beside the draft. How do they share
the screen without crowding the page or re-wrapping its lines? And how does
the same Kin show up on Feed, Ideas and Inspiration?

Run it: `pnpm prototype:kin-surface` (add `--open` to open it in the browser).
It starts the headless app on a fresh scratch vault with Kin's scripted mock
model: no credentials, nothing leaves the Mac, nothing is saved. Switch
candidates with the bar at the top (or ← → when not typing). The same bar
switches light and dark and plays the motion at normal speed, three times
slower, or reduced.

## Keys (the same in all three)

| Keys | What |
| --- | --- |
| ⌥⌘K | Suggestions on or off (also the footer's Suggestions button) |
| ⌘' / ⇧⌘' | Next / previous suggestion |
| ⌥↵ / ⌥⌘⌫ / ⇧⌘J | Accept / dismiss / discuss the suggestion showing |
| ⌥⌘] / ⌥⌘[ | Next / previous version, in place |
| ⌥⌘A | Versions for the cursor's word or sentence |
| ⌥⌘X | Move the selection (else the paragraph) to the stash |
| ⌘J | Kin; with text selected, ask about it |
| Esc | Close the card, pill or popover |

## The candidates

- **A. One margin.** The draft column is pinned left, so a 360 px margin fits
  in the right gutter. Opening it slides it in over empty space. Tabs: Kin,
  References, Stash. The Stash tab is p-8-0's C: the cursor's versions on
  top, the stash under them. A paragraph's chat opens in the Kin tab. Off the
  editor, the same margin.
- **B. Two gutters.** Write_On's layout. The column is centred at a fixed
  measure. His words go on the left: versions (the rest of the draft fades
  while they're open) and the stash. Kin goes on the right, with "Along this
  paragraph" above the chat. When a panel needs room, the whole column slides
  sideways and never re-wraps. A paragraph's chat opens under the paragraph
  and pushes the rest down. Off the editor, a floating Kin box.
- **C. Kin at the text.** Nothing sits beside the page. Kin is a floating
  sheet over the right gutter, versions are a popover at the word, the stash
  is a shelf that rises from the bottom. An inline ask answers in its pill. A
  paragraph's chat floats beside its paragraph. Off the editor, the same sheet.

- **R. The recommendation.** A, with B's chat pane under the paragraph.

Kin's suggestions are the same in all of them: off by default. When they're
on, cuts are gold strikes in the text and rewrites wait in the stash, pinned
to their words by a thin gold underline. One small card steps through all of
them.

## Motion

- Panels: 240 ms slide plus fade, `cubic-bezier(0.25, 1, 0.5, 1)`. The text
  never moves, except in B, where the column slides 280 ms on the same curve.
- `< 1 of 3 >`: the page scrolls the next suggestion a third of the way down
  in 240–320 ms on the same ease-out. Over one window away, it jumps silently
  to one window short first, so the glide stays short. The card moves with
  it and the words flash once (450 ms). Reduced motion: cut to the place,
  flash only.
- Cycle in place: the new version fades up from 35% over 450 ms with a gold
  wash, and a strip shows "2 of 4" for 1.6 s.
- Kin working: KI-62's band (1.6 s, linear) in A and C; KI-62 B's gutter rule
  in B. Under reduced motion both are still.

## Recordings and stills

`docs/review/ki-96/` on this branch holds the recordings (mp4, light and dark,
two clips per candidate) and the stills on the Paper page. To make them again
against a running prototype:

```sh
node apps/desktop/src/prototype-kin-surface/record.mjs '<the printed URL>'
node apps/desktop/src/prototype-kin-surface/shots.mjs '<the printed URL>'
```
