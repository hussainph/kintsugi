# Voice

This is the owner's rule for every word Kintsugi shows: Mac app, phone app, editor, exports, Kin's replies, and these docs. The writing rules come from the `product-docs` skill (`~/.agents/skills/product-docs/references/voice.md`). Read it before you write copy.

Kin's own prose (Feed summaries, Ideas, chat replies) follows [Kin's writing](kin.md#kins-writing-ki-102): its tone setting, never-do list and slop lint.

## No eyebrow text

Don't put a small label above or beside a heading, card, panel or section. That means no uppercase, no letter-spacing and no tiny muted kicker such as "INSPIRATION", "ABOUT THIS NOTE", "HELPER REPORT", "THE WHOLE, IN ITS PARTS".

- Delete the label if the content or the heading already says what it is. That's most of the time.
- If a group needs a name, give it a normal sentence-case heading at body or heading size.
- Never use `uppercase`, `textTransform: 'uppercase'` or wide `tracking`/`letterSpacing` as a label style. Keyboard shortcut hints such as `⌘K` are fine.

## Let the components do the talking

Don't explain the interface. A button, field, list or toggle shows what it does, so don't add a sentence that says it again.

- No subtitles under page or section headings that restate the heading ("Inspiration: links, quotes, images and notes you've saved").
- No helper text under a field, toggle or setting unless it carries a fact the control can't show, such as a limit, a cost or what leaves the Mac. One short line at most.
- No descriptions in dialogs that repeat the title and the buttons.
- No tooltips on controls whose label already says it.
- An empty state is one short line and, at most, one action.
- When in doubt, delete the sentence and look at the screen again. If nothing is lost, leave it deleted.

## Say it plainly

Name the thing, or say what it does, in ordinary words.

| Write | Not |
|---|---|
| Save | Keep this close |
| 3 new posts | Fresh voices are waiting |
| Nothing saved yet. Share a link from Safari to add one. | Your library is a quiet place, waiting to be filled |
| Kin couldn't reach your Mac. It'll send when the Mac is back. | Kin rests while your Mac is away |
| Why this? | The thread that led here |

- Use sentence case for buttons, headings and menu items.
- An empty state says what's empty and how to fill it.
- An error says what failed and what to do next.
- No taglines, mottos or marketing voice.
- No mindful, wistful or poetic tone: "quietly", "gently", "breathe", "sit with", "a little closer", "space to think".
- No metaphors about gold, seams, repair, craft, journeys or gardens. The name Kintsugi is the only one allowed.
- Avoid the banned words, binary contrasts ("not X, it's Y"), colon reveals and fake-profound endings listed in the skill's `voice.md`.
- No em dashes in short UI copy.

## Kin

Kin talks like a sharp, direct friend who has read everything Hussain saved. It gets to the point, names its sources, and says "I don't know" when it doesn't. It doesn't flatter, philosophize, or wrap up with a lesson.

## Docs

Docs follow the same rules. Lead with what the reader needs, use the same name for a thing every time, and stop when the useful part ends.
