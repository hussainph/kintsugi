#!/usr/bin/env node
// Builds a deterministic scratch vault for headless desktop runs and
// screenshots: Markdown/MDX documents with wikilinks, plus bare and enriched
// inspiration clips with locally generated PNG artwork.
//
//   pnpm desktop:seed <dir>
//
// The command refuses an existing nonempty directory and never writes into
// the owner's real vault or app config. It does no network I/O: images are
// generated raster PNGs, never SVG.

import { deflateSync } from "node:zlib";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const SEED_DATE = "2026-10-29";

/** The real app's standard vault and config. Never seed into these, or into
 *  their ancestors/children. Tauri's macOS app config is the bundle identifier;
 *  the product-name directory is included as a belt-and-braces alias. */
export function ownerRoots(home = homedir()) {
  return [
    { label: "the owner's vault", path: join(home, "Documents", "Kintsugi") },
    {
      label: "the owner's app config",
      path: join(home, "Library", "Application Support", "dev.phalasiya.kintsugi"),
    },
    {
      label: "the owner's app config",
      path: join(home, "Library", "Application Support", "Kintsugi"),
    },
  ];
}

const normal = (path) => {
  const absolute = resolve(path);
  return platform() === "darwin" ? absolute.toLowerCase() : absolute;
};

/** True when child is parent or below it. Both paths are already absolute. */
function within(parent, child) {
  const p = normal(parent);
  const c = normal(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Resolve a path through existing symlinks, tolerating a missing tail. */
async function realpathNearest(path) {
  let current = resolve(path);
  const missing = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return resolve(real, ...missing.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

export class SeedError extends Error {}

/**
 * Resolve and validate a scratch directory. Refuses the owner's vault/config
 * (and anything containing them), the home folder or its ancestors, and the
 * repository root itself. A subdirectory of the repository — `.headless/…` —
 * is allowed, because that is where headless runs live.
 */
export async function assertSafeTarget(target, { home = homedir(), repoRoot = REPO_ROOT } = {}) {
  if (typeof target !== "string" || target.trim() === "") {
    throw new SeedError("a scratch directory path is required");
  }
  const absolute = resolve(target.trim());
  if (absolute === parse(absolute).root) {
    throw new SeedError("refusing to seed the filesystem root");
  }
  if (normal(absolute) === normal(home) || within(absolute, home)) {
    throw new SeedError("refusing to seed the home folder or one of its ancestors");
  }
  if (normal(absolute) === normal(repoRoot) || within(absolute, repoRoot)) {
    throw new SeedError("refusing to seed the repository root itself; choose a scratch subdirectory");
  }

  const real = await realpathNearest(absolute);
  for (const candidate of [absolute, real]) {
    for (const forbidden of ownerRoots(home)) {
      const realForbidden = await realpathNearest(forbidden.path);
      for (const f of [forbidden.path, realForbidden]) {
        if (within(f, candidate) || within(candidate, f)) {
          throw new SeedError(
            `refusing to seed ${forbidden.label} or its ancestors/children: ${candidate}`,
          );
        }
      }
    }
    if (normal(candidate) === normal(repoRoot) || within(candidate, repoRoot)) {
      throw new SeedError("refusing to seed the repository root itself; choose a scratch subdirectory");
    }
    if (within(candidate, home) && normal(candidate) === normal(home)) {
      throw new SeedError("refusing to seed the home folder");
    }
  }
  return real;
}

/** Create the root or insist that it is empty (ignoring Finder's .DS_Store). */
export async function prepareRoot(root) {
  let info = null;
  try {
    info = await stat(root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (info && !info.isDirectory()) {
    throw new SeedError(`not a directory: ${root}`);
  }
  if (!info) {
    await mkdir(root, { recursive: true });
    return;
  }
  const entries = (await readdir(root)).filter((name) => name !== ".DS_Store").sort();
  if (entries.length > 0) {
    const sample = entries.slice(0, 5).join(", ");
    throw new SeedError(
      `refusing to seed a nonempty directory: ${root} (${sample}${entries.length > 5 ? ", …" : ""}); use a fresh directory`,
    );
  }
}

// ---------------------------------------------------------------------------
// Documents

/** @returns {{ path: string, content: string }[]} */
export function documentFiles() {
  return [
    {
      path: "welcome.mdx",
      content: `---
title: Start here
status: complete
tags: [welcome]
---

# Start here

This is a scratch vault for Kintsugi's headless dev mode. Nothing here is your
writing, and nothing here touches the real vault.

The sidebar holds a few **drafts** and **complete** documents, in \`.md\` and
\`.mdx\`. Open [[posts/on-craft]] for a finished essay, or
[[inspiration/why-we-sleep]] from the inspiration library.

Good places to start:

- Press ⌘P to jump between documents.
- Press ⇧⌘D to flip draft/complete.
- Press ⌘K on a selection to try the AI margin (disabled by default in
  headless mode).
- Open the Inspiration library to see clips, images and tags.

The files are ordinary Markdown. Link with wikilinks: [[notes/repair]],
[[posts/the-quiet-web]] and [[inspiration/golden-joinery]].
`,
    },
    {
      path: "posts/on-craft.mdx",
      content: `---
title: "On craft and repair"
status: complete
tags: [writing, craft]
---

# On craft and repair

There is a moment, somewhere in the second hour of sanding, when the work stops
being an idea and becomes a material fact. The grain decides. The joint
decides. You can argue with a board, but it will not agree.

I wrote about this before in [[notes/repair]], and I keep returning to
[[inspiration/golden-joinery]] because it says the same thing without words:
a repair is not a cover-up. It is a record of care.

## Practice

The practice is unglamorous. You cut the same joint until your hands understand
it. You read the paragraph aloud until the sentence stops hiding. You keep the
failed version, because the failed version is the only proof that the next one
is better.

[[notes/attention#The cost|What attention costs]] is part of the same argument.
Craft is not a personality trait. It is what remains after you have given a
thing enough time to become itself.

> The gold seam is not the flaw. It is the place where the object admits it was
> handled.

What I keep returning to is [[inspiration/golden-joinery]]: the repair is
visible, and that visibility is the point. A thing that has been cared for is
not the same as a thing that has never been broken.

Related: [[posts/the-quiet-web]], [[posts/series/field-notes]].
`,
    },
    {
      path: "posts/the-quiet-web.mdx",
      content: `---
title: "The quiet web"
status: draft
tags: [web, attention]
---

# The quiet web

Most of the web is designed to keep you moving. The quiet web does the
opposite: it gives you a place to stop.

I have been collecting examples: a reading room with no recommendation rail,
a weather page that is only weather, a personal site whose index is a
hand-written list. None of them are trying to win a contest for my attention.
They are trying to deserve the attention I already have.

The sleep piece ([[why-we-sleep|kept in the library]]) makes a useful
distinction between rest and recovery. A quiet site is not empty; it is
recovering something that the loud web spends.

I still owe myself a note on [[a-book-about-walking]]. The link is here so the
gap stays visible. Unresolved links are allowed; they are a kind of bookmark
for a thought that has not arrived yet.

See also [[inspiration/golden-joinery]] and [[posts/on-craft]].
`,
    },
    {
      path: "posts/series/field-notes.mdx",
      content: `---
title: "Field notes: the long way home"
status: draft
tags: [walking, notes]
---

# Field notes: the long way home

A series of small observations, kept on the walk between the train station and
the house. The rule is simple: no destination, no headphones, one sentence
before the door opens.

## Monday

The plane trees have started to lose their leaves, but the pavement is still
warm. A man is repairing a bicycle bell with a tiny screwdriver and the
patience of someone who has done it before.

This is [[on-craft]], in miniature. The practice is not the repair; it is
noticing that the repair is worth doing. I wrote more about that in
[[posts/on-craft#Practice|the practice section]].

## Tuesday

The bakery on the corner has a new sign. The old one is still visible under
the paint, a ghost of a different name. It is the kind of thing I would have
photographed a year ago; now I just walk past and let it be a thing that
happened.

Later: [[morning-pages]].
`,
    },
    {
      path: "notes/repair.md",
      content: `---
title: "Repair is a kind of attention"
status: draft
tags: [repair, attention]
---

# Repair is a kind of attention

We tend to think of repair as restoration: make it look as if nothing happened.
But the more interesting repair makes the history legible. The patch is not
hidden. The seam is not sanded away. The object becomes more itself, not less.

[[on-craft#Practice|Practice]] is the same shape. You do not erase the failed
draft; you learn to see what it was trying to do. The final version carries the
evidence of the attempt, even when the reader cannot name it.

The note from the phone, [[reader-note-on-attention]], is a good example of a
thought that arrived before it was ready. I am leaving it unfinished on
purpose. It is closer to the truth than a polished paragraph would be.

Compare [[golden-joinery]] and [[inspiration/the-quiet-web|the quiet web clip]].
`,
    },
    {
      path: "notes/attention.md",
      content: `---
title: "Attention has a cost"
status: complete
tags: [attention]
---

# Attention has a cost

Every yes is a no to something else. This is obvious in calendars and almost
invisible in the small decisions of a working day: the tab left open, the
notification checked, the paragraph reread because the first reading never
landed.

## The cost

The cost is not the time itself. It is the residue. A interrupted hour does not
resume where it stopped; it resumes in a slightly different mental weather, and
the work has to find its footing again.

[[why-we-sleep]] is useful here because it treats rest as part of the system,
not as the absence of work. A mind that never idles cannot notice what it is
looking at.

I want to write more about this, but the note is already doing its job: it
reminds me to close the other tabs. See [[inspiration/the-quiet-web|the quiet
web clip]] for the design version of the same argument.
`,
    },
    {
      path: "notes/reading-list.md",
      content: `---
title: Reading list
status: draft
tags: [reading, inspiration]
---

# Reading list

- [ ] [[why-we-sleep]] — finish the section on memory.
- [x] [[golden-joinery]] — the history is better than the metaphor.
- [ ] [[the-quiet-web]] — look for the small-sites directory mentioned near
      the end.
- [ ] [[a-short-film-about-rain]] — watch it with the sound off first.
- [x] [[reader-note-on-attention]] — my own note, still undecided.

Still missing: [[a-book-about-walking]]. I have not found the right edition.

A code fence is not a link:

~~~
[[not-a-real-link]]
~~~

Nor is inline code: \`[[also-not-a-real-link]]\`.

<!-- [[commented-out-link]] -->
`,
    },
    {
      path: "drafts/kintsugi-and-gold.md",
      content: `---
title: "Kintsugi and gold"
status: draft
tags: [kintsugi, repair]
---

# Kintsugi and gold

The first time I saw a kintsugi bowl I thought the gold was decoration. It is
not. The gold is a decision: this break is part of the object now, and we are
not going to pretend otherwise.

> The bowl is more valuable because it can show you what happened to it.

That sentence belongs in [[repair]], or maybe in [[posts/on-craft]]. I am not
sure yet which essay it is for. The clip [[inspiration/golden-joinery]] has the
history; the note has the feeling.

A workshop rule I want to keep:

~~~
Make the repair visible. Make it strong. Do not make it loud.
~~~

The rest of this draft is still in the notebook. [[inspiration/why-we-sleep]]
is not relevant, but it is the tab I keep leaving open.
`,
    },
    {
      path: "inbox/morning-pages.mdx",
      content: `---
title: Morning pages
status: draft
captured: "2026-10-29T07:12"
---

# Morning pages

The light on the kitchen wall at 7:40 is the reason I started writing in the
morning. It is not a metaphor. It is a rectangle of pale yellow that moves
across the tiles and disappears before the kettle boils.

I want to keep [[window-light]] for the essay about attention, not because the
image is good but because it is evidence. The camera was pointed at the wall
before I had a sentence.

Later, after coffee: [[on-craft]].
`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Clips

/** @returns {{ path: string, content: string }[]} */
export function clipFiles() {
  return [
    {
      path: "inspiration/why-we-sleep.md",
      content: `---
kind: link
title: "Why we sleep"
url: "https://www.newyorker.com/magazine/2026/10/12/why-we-sleep"
site: "The New Yorker"
author: "Jane Doe"
image: media/why-we-sleep.png
captured: 2026-10-26T21:14
via: mac
tags: [science, sleep, attention]
summary: "A report on how sleep debt quietly reshapes attention, memory and mood."
enriched: 2026-10-26T21:16
---

> Sleep is not a luxury; it is the substrate attention is built on.

I keep coming back to this for [[notes/attention]]. The point is not that rest
makes us more productive. It is that a tired mind cannot tell the difference
between what matters and what is merely loud.

<!-- kintsugi:source -->
## Source

The article follows a group of night-shift workers through a week of shortened
sleep, then through a week of recovery. The reporting is careful about what
sleep debt does and does not do: it does not simply accumulate like a bank
balance, and a single long night does not undo a month of short ones.

The most useful section is about attention. Participants did not report feeling
worse at first; their performance on a simple vigilance task fell before their
own sense of alertness did. The gap between how tired we feel and how tired we
are is the part that makes the piece worth keeping.
`,
    },
    {
      path: "inspiration/golden-joinery.md",
      content: `---
kind: quote
title: "Golden joinery"
url: "https://www.britannica.com/art/kintsugi"
site: "Encyclopaedia Britannica"
author: "The editors"
image: media/golden-joinery.png
captured: 2026-10-27T08:42
via: share
tags: [craft, repair, materials]
summary: "The history of kintsugi, and why a visible repair can make an object more valuable."
enriched: 2026-10-27T08:44
---

> The repair is not hidden. It is given a color of its own.

The image is the argument: the bowl is not restored to its old self. It is a
new object with a history. I want this beside [[posts/on-craft]] when I write
about practice.

<!-- kintsugi:source -->
## Source

Kintsugi is the Japanese practice of repairing broken pottery with lacquer
mixed or dusted with powdered gold, silver, or platinum. The technique is
associated with the idea that breakage and repair are part of an object's
history rather than something to disguise.

The article traces the practice through tea culture and the aesthetics of
imperfection. It is careful to note that kintsugi is not a license to break
things on purpose: the value comes from the care of the repair, not from the
break itself. That distinction is the part I want to keep.
`,
    },
    {
      path: "inspiration/the-quiet-web.md",
      content: `---
kind: link
title: "The quiet web"
url: "https://www.are.na/blog/the-quiet-web"
site: "Are.na Editorial"
author: "Sam Rivera"
captured: 2026-10-27T19:05
via: phone
tags: [web, attention, design]
summary: "A case for small, slow websites that ask for attention instead of harvesting it."
enriched: 2026-10-27T19:07
---

> A quiet website is not an empty one.

This is the design companion to [[notes/attention]]. The examples are less
important than the criteria: no infinite feed, no autoplay, no recommendation
rail pretending to be a friend.

<!-- kintsugi:source -->
## Source

The essay begins with a distinction between attention and engagement. Engagement
is measurable; attention is not. A quiet site may have neither comments nor
analytics, and still be doing more for its reader than a feed that knows exactly
when to interrupt.

The middle section collects examples: personal libraries, hand-maintained link
lists, weather pages, and a reading room that closes at a reasonable hour. The
author is not nostalgic for an earlier web. The point is that the same
technologies can be arranged to leave room for a thought.
`,
    },
    {
      path: "inspiration/a-short-film-about-rain.md",
      content: `---
kind: video
title: "A short film about rain"
url: "https://www.youtube.com/watch?v=rainfilm26"
site: "YouTube"
author: "Studio Umbrella"
image: media/a-short-film-about-rain.png
captured: 2026-10-28T12:30
via: mac
tags: [film, weather, silence]
summary: "Six minutes of rain on different surfaces, with almost no narration."
enriched: 2026-10-28T12:32
---

> The sound of rain on a window is not one sound.

Watching this with the sound off is a different film. I want to try writing
about weather without using it as a mood. Maybe it belongs with
[[posts/series/field-notes]].

<!-- kintsugi:source -->
## Source

A six-minute film composed of static shots: rain on a tin roof, on a car
window, in a drained fountain, on a page left outside. There is no narration
and no music until the final minute, when a low drone enters under the image.

The description says the film was shot over three weeks in the same
neighbourhood. The constraint is visible in a good way: the locations begin to
feel familiar, and the differences between them become the subject.
`,
    },
    {
      path: "inspiration/reader-note-on-attention.md",
      content: `---
kind: note
captured: 2026-10-28T22:18
via: phone
tags: [attention]
---

A note from the phone, still undecided. The thing I keep noticing is that I do
not need more time; I need fewer open loops. Every unfinished thought is a tab
somewhere in my head, and the cost is not the time it takes to close it. The
cost is the part of me that is still holding it open.

I will leave this here until the essay knows what it wants.

<!-- kintsugi:source -->
`,
    },
    {
      path: "inspiration/window-light.md",
      content: `---
kind: image
image: media/window-light.png
captured: 2026-10-29T07:40
via: share
tags: [light, kitchen]
---

The light on the kitchen wall at 7:40. Not a metaphor yet.

<!-- kintsugi:source -->
`,
    },
    {
      path: "inspiration/a-post-that-vanished.md",
      content: `---
kind: post
title: "A post that vanished"
url: "https://x.com/khosla/status/1234567890"
site: "X"
author: "@khosla"
captured: 2026-10-29T09:12
via: share
tags: [social, deletion]
enrich_error: "The post could not be fetched (404); it may have been deleted."
---

I wanted to keep the reply about repair, but the post is gone. The clip is
still useful as a reminder that a capture is not a promise that the source
will stay put.

<!-- kintsugi:source -->
`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Images: deterministic truecolour PNGs, built with Node's zlib only.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @returns {{ file: string, width: number, height: number, palette: [number[], number[]], pattern: string, seed: number }[]} */
export function artworkSpecs() {
  return [
    {
      file: "inspiration/media/why-we-sleep.png",
      width: 720,
      height: 480,
      palette: [
        [12, 18, 38],
        [78, 96, 140],
      ],
      pattern: "rings",
      seed: 11,
    },
    {
      file: "inspiration/media/golden-joinery.png",
      width: 720,
      height: 480,
      palette: [
        [34, 25, 20],
        [190, 140, 76],
      ],
      pattern: "seams",
      seed: 23,
    },
    {
      file: "inspiration/media/a-short-film-about-rain.png",
      width: 720,
      height: 405,
      palette: [
        [28, 42, 50],
        [108, 128, 136],
      ],
      pattern: "rain",
      seed: 37,
    },
    {
      file: "inspiration/media/window-light.png",
      width: 640,
      height: 640,
      palette: [
        [44, 36, 28],
        [228, 192, 134],
      ],
      pattern: "window",
      seed: 51,
    },
  ];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(body), 8 + data.length);
  return chunk;
}

function hash(x, y, seed) {
  let h = Math.imul(x + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(y + 0x7f4a7c15, 0xc2b2ae35) ^ seed;
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 15;
  return (h >>> 0) / 0x100000000;
}

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));

function blend(from, to, t) {
  return from.map((value, index) => value + (to[index] - value) * t);
}

function pixel(spec, x, y) {
  const [top, bottom] = spec.palette;
  const u = x / Math.max(1, spec.width - 1);
  const v = y / Math.max(1, spec.height - 1);
  let color = blend(top, bottom, 0.25 * u + 0.75 * v);

  // A little deterministic grain keeps flat gradients from banding.
  const grain = (hash(x, y, spec.seed) - 0.5) * 7;
  color = color.map((value) => value + grain);

  if (spec.pattern === "rings") {
    const dx = (u - 0.5) * 1.4;
    const dy = (v - 0.5) * 1.1;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const ring = Math.exp(-Math.pow((distance - 0.28) * 22, 2));
    const glow = Math.exp(-Math.pow(distance * 3.2, 2));
    color = color.map((value, index) => value + ring * (index === 2 ? 90 : 55) + glow * 12);
  } else if (spec.pattern === "seams") {
    const diagonal = (x + y * 0.62 + spec.seed * 11) % 190;
    const seam = Math.exp(-Math.pow((diagonal - 95) / 2.4, 2));
    const second = Math.exp(-Math.pow((diagonal - 24) / 1.6, 2));
    color = color.map((value, index) => value + seam * (index === 0 ? 125 : index === 1 ? 105 : 55) + second * 28);
  } else if (spec.pattern === "rain") {
    const streak = hash(Math.floor(x / 2), Math.floor((y + x * 0.35) / 18), spec.seed);
    const line = hash(Math.floor(x / 3), 0, spec.seed + 7) > 0.72 ? 0.35 : 0;
    color = color.map((value, index) => value + (index === 2 ? streak * 26 + line * 34 : streak * 12 + line * 22));
  } else if (spec.pattern === "window") {
    const inWindow = u > 0.2 && u < 0.8 && v > 0.18 && v < 0.82;
    const frame = u > 0.2 && u < 0.8 && v > 0.18 && v < 0.82 && (Math.abs(u - 0.5) < 0.008 || Math.abs(v - 0.5) < 0.008);
    if (inWindow && !frame) {
      const warmth = 42 + 25 * Math.sin(v * Math.PI);
      color = color.map((value, index) => value + (index === 0 ? warmth : index === 1 ? warmth * 0.8 : warmth * 0.45));
    } else if (frame) {
      color = color.map((value) => value * 0.55);
    }
    const falloff = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) * 1.7);
    color = color.map((value) => value * (0.55 + falloff * 0.6));
  }

  return color.map(clamp);
}

/** Encode one artwork spec as a valid RGB PNG (colour type 2, 8-bit). */
export function generateArtwork(spec) {
  const { width, height } = spec;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new SeedError("artwork dimensions must be positive integers");
  }
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(spec, x, y);
      const offset = y * stride + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Validate the bytes we just made before touching the vault. */
function assertPng(bytes, file) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new SeedError(`${file} is not a PNG`);
  }
  if (bytes.length < 33 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new SeedError(`${file} has no IHDR`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) throw new SeedError(`${file} has empty dimensions`);
  return { width, height };
}

// ---------------------------------------------------------------------------
// Writing

async function writeFileSafely(root, relativePath, data) {
  const target = join(root, relativePath);
  if (!within(root, target)) throw new SeedError(`refusing to write outside ${root}: ${relativePath}`);

  // Check before creating parents (never traverse an existing symlink), then
  // again afterwards in case anything appeared concurrently.
  const check = async () => {
    let current = root;
    for (const part of relativePath.split("/")) {
      current = join(current, part);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (error.code === "ENOENT") break;
        throw error;
      }
      if (info.isSymbolicLink()) {
        throw new SeedError(`refusing to write through a symlink: ${relativePath}`);
      }
      if (current === target) {
        throw new SeedError(`refusing to overwrite an existing path: ${relativePath}`);
      }
      if (!info.isDirectory()) {
        throw new SeedError(`parent is not a directory: ${relativePath}`);
      }
    }
  };

  await check();
  await mkdir(dirname(target), { recursive: true });
  await check();
  // O_EXCL refuses a final symlink or file that appeared after the check.
  await writeFile(target, data, { flag: "wx" });
}

async function writeText(root, relativePath, content) {
  await writeFileSafely(root, relativePath, content);
}

async function writeBytes(root, relativePath, bytes) {
  await writeFileSafely(root, relativePath, bytes);
}

/**
 * Seed a vault at `target`. Returns the files written so callers (and tests)
 * can report or inspect them.
 */
export async function seedVault(target, { home, repoRoot } = {}) {
  const root = await assertSafeTarget(target, { home, repoRoot });
  await prepareRoot(root);

  const documents = documentFiles();
  const clips = clipFiles();
  const images = artworkSpecs();

  for (const document of documents) await writeText(root, document.path, document.content);
  for (const clip of clips) await writeText(root, clip.path, clip.content);
  let imageBytes = 0;
  for (const spec of images) {
    const bytes = generateArtwork(spec);
    const { width, height } = assertPng(bytes, spec.file);
    if (width !== spec.width || height !== spec.height) {
      throw new SeedError(`${spec.file} has the wrong dimensions`);
    }
    await writeBytes(root, spec.file, bytes);
    imageBytes += bytes.length;
  }

  return {
    root,
    documents: documents.map((file) => file.path),
    clips: clips.map((file) => file.path),
    images: images.map((file) => file.file),
    imageBytes,
  };
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `Build a deterministic scratch Kintsugi vault.

Usage:
  pnpm desktop:seed <dir>

<dir> is created when missing and must be empty. The command never writes
into the owner's vault or app config, only makes local Markdown, MDX, PNG
images and clip files, and does no network I/O. Open the result with
KINTSUGI_VAULT=<dir> pnpm desktop:headless.
`;

function parseArgs(argv) {
  let help = false;
  let target = null;
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") help = true;
    else if (argument.startsWith("-")) throw new SeedError(`unknown option: ${argument}`);
    else if (target !== null) throw new SeedError("expected one scratch directory");
    else target = argument;
  }
  return { help, target };
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`desktop:seed: ${error.message}\n\n${USAGE}`);
    return 1;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (!options.target) {
    console.error(`desktop:seed: a scratch directory is required\n\n${USAGE}`);
    return 1;
  }
  try {
    const result = await seedVault(options.target);
    console.log(`Seeded ${result.documents.length} documents and ${result.clips.length} clips (${result.images.length} PNG images) in ${result.root}`);
    console.log(`Next: KINTSUGI_VAULT="${result.root}" pnpm desktop:headless`);
    return 0;
  } catch (error) {
    console.error(`desktop:seed: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
