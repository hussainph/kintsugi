// The KI-28 spike documents (apps/mobile/src/components/editor-spike/samples.ts).

const post = `---
title: Mending with gold
date: 2026-10-02
status: draft
tags: [writing, craft]
---

# Mending with gold

Kintsugi repairs broken pottery with lacquer and gold, so the break becomes
part of the object's history instead of something to hide.

## Why it matters for writing

A draft is mostly breaks. The *first* version says the wrong thing in the
right order, or the right thing in the **wrong** order. See [[On writing in the margins]]
for the longer argument, and \`inbox/\` for the notes that started it.

> The point is not to hide the seam. It is to make it worth looking at.

- Write the ugly paragraph first.
- Fix the order before the sentences.
- Read it aloud on the phone, away from the desk.

`;

const section = (n: number) => `## Section ${n}

The quick brown fox jumps over the lazy dog while the writer, half awake on
the train, tries to remember what the paragraph was meant to say. Line ${n}
links to [[Kintsugi: mending with gold]] and has some *emphasis*, some
**strong text** and a bit of \`code\` so the highlighter has work to do.

Second paragraph of section ${n}: a phone editor has to stay quick when the
document is long, because the long ones are the ones worth finishing.

`;

export type SampleName = 'short' | 'long' | 'huge';

/** short: one post; long: ~10k words (a long essay); huge: ~100k words (a book). */
export function sample(name: SampleName): string {
  if (name === 'short') return post;
  const sections = name === 'long' ? 125 : 1250;
  return post + Array.from({ length: sections }, (_, i) => section(i + 1)).join('');
}
