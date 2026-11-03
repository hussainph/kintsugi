// The copy rules from docs/voice.md, as data. Deterministic: plain regexes,
// no network, no model. Each rule has an id, a pattern and a short fix hint.

/** Words and phrases from the product-docs skill's voice.md (AI slop). */
export const SLOP = [
  ['delve', 'say "look at" or "read"'],
  ['foster', 'say what actually happens'],
  ['leverage', 'use "use"'],
  ['utilize', 'use "use"'],
  ['utilise', 'use "use"'],
  ['facilitate', 'name the real verb'],
  ['empower', 'say what the person can now do'],
  ['streamline', 'say what got shorter or faster'],
  ['robust', 'say what it survives, or cut it'],
  ['cutting-edge', 'cut it'],
  ['paradigm shift', 'cut it'],
  ['game changer', 'cut it'],
  ['game-changer', 'cut it'],
  ['this is huge', 'cut it'],
  ['this changes everything', 'cut it'],
  ['tapestry', 'cut the metaphor'],
  ['realm', 'name the area'],
  ['beacon', 'cut the metaphor'],
  ['multifaceted', 'cut it'],
  ['meticulous', 'cut it'],
  ['meticulously', 'cut it'],
  ['intricate', 'cut it'],
  ['paramount', 'say "most important", or cut it'],
  ['transformative', 'cut it'],
  ['elevate', 'say what changes'],
  ['embark', 'say "start"'],
  ['supercharge', 'cut it'],
  ['ever-evolving', 'cut it'],
  ['seamless', 'cut it'],
  ['seamlessly', 'cut it'],
  ['unlock', 'say what the person can now do'],
  ['next-level', 'cut it'],
  ['effortless', 'cut it'],
  ['effortlessly', 'cut it'],
  ['powerful', 'say what it does instead of praising it'],
  ['simply', 'cut it'],
  ['truly', 'cut it'],
  ['honestly', 'cut it'],
  ['literally', 'cut it'],
  ['fundamentally', 'cut it'],
  ['crucially', 'cut it'],
  ['importantly', 'cut it'],
  ['inherently', 'cut it'],
  ['it\'s worth noting', 'state the point'],
  ['it is worth noting', 'state the point'],
  ['it\'s important to note', 'state the point'],
  ['at the end of the day', 'cut it'],
  ['when it comes to', 'say "for"'],
  ['at its core', 'cut it'],
  ['in today\'s world', 'cut it'],
  ['in the age of', 'cut it'],
  ['the reality is', 'state the point'],
  ['the truth is', 'state the point'],
  ['with regard to', 'say "about"'],
  ['in order to', 'say "to"'],
  ['going forward', 'cut it'],
  ['let\'s dive in', 'cut it'],
  ['dive into', 'say "read" or "look at"'],
  ['whether you\'re', 'state the assumed level once'],
  ['plays a vital role', 'state the fact'],
  ['stands as a testament', 'state the fact'],
  ['pivotal', 'state the fact'],
];

/** Kintsugi's own tone list: mindful, poetic, marketing or metaphor words. */
export const TONE = [
  ['quietly', 'cut it'],
  ['quiet', 'say what it does: "silent", "no notification", or cut it'],
  ['gently', 'cut it'],
  ['gentle', 'cut it'],
  ['softly', 'cut it'],
  ['breathe', 'cut it'],
  ['breathing room', 'cut it'],
  ['sit with', 'say "read" or "think about"'],
  ['a little closer', 'say what changes'],
  ['space to think', 'cut it'],
  ['journey', 'name the actual steps'],
  ['journeys', 'name the actual steps'],
  ['sanctuary', 'name the thing'],
  ['ritual', 'say "routine" or name the steps'],
  ['rituals', 'say "routine" or name the steps'],
  ['=whisper', 'cut the metaphor (Whisper, the speech model, is fine)'],
  ['=whispers', 'cut the metaphor'],
  ['soul', 'cut the metaphor'],
  ['soulful', 'cut it'],
  ['craft', 'say "write" or "make"'],
  ['crafted', 'say "written" or "made"'],
  ['crafting', 'say "writing" or "making"'],
  ['craftsmanship', 'cut it'],
  ['seam', 'no seam metaphors; name the thing'],
  ['seams', 'no seam metaphors; name the thing'],
  ['gold', 'no gold metaphors; for the colour, say "accent"'],
  ['golden', 'no gold metaphors; for the colour, say "accent"'],
  ['mindful', 'cut it'],
  ['mindfully', 'cut it'],
  ['mindfulness', 'cut it'],
  ['intentional', 'cut it'],
  ['intentionally', 'cut it'],
  ['curated with love', 'cut it'],
  ['lovingly', 'cut it'],
  ['with love', 'cut it'],
  ['thoughtfully', 'cut it'],
  ['cozy', 'cut it'],
  ['cosy', 'cut it'],
  ['serene', 'cut it'],
  ['serenity', 'cut it'],
  ['tranquil', 'cut it'],
  ['stillness', 'cut it'],
  ['unhurried', 'cut it'],
  ['slow down', 'cut it'],
  ['wander', 'say "browse"'],
  ['wandering', 'say "browsing"'],
  ['garden', 'no garden metaphors; name the thing'],
  ['gardens', 'no garden metaphors; name the thing'],
  ['=muse', 'cut the metaphor (Muse, the app, is fine)'],
  ['kindred', 'cut it'],
  ['cherish', 'cut it'],
  ['cherished', 'cut it'],
  ['treasure', 'cut the metaphor'],
  ['treasured', 'cut it'],
  ['nurture', 'cut the metaphor'],
  ['mend', 'cut the metaphor'],
  ['magic', 'say what it does'],
  ['magical', 'say what it does'],
  ['delightful', 'cut it'],
  ['spark joy', 'cut it'],
  ['savor', 'say "read"'],
  ['savour', 'say "read"'],
  ['linger', 'cut it'],
  ['tender', 'cut it'],
  ['warmth', 'cut it'],
  ['awaits', 'say what is ready'],
  ['waiting for you', 'say what is ready'],
  ['fresh voices', 'give the count: "3 new posts"'],
  ['keep this close', 'say "Save"'],
  ['at your own pace', 'cut it'],
  ['thread that led', 'say "Why this?"'],
  ['the whole, in its parts', 'cut it'],
  ['home for your', 'say what it stores'],
  ['a place for', 'say what it stores'],
  ['beautifully', 'cut it'],
  ['wonder', 'cut it'],
  ['wistful', 'cut it'],
  ['poetic', 'cut it'],
  ['luminous', 'cut it'],
  ['resonate', 'say "match" or "relate to"'],
  ['resonates', 'say "matches" or "relates to"'],
  ['resonant', 'cut it'],
  ['companion', 'name the thing: Kin, the agent'],
  ['kiln', 'cut the metaphor'],
];

/** Abbreviations that are fine in capitals, even side by side. */
export const ACRONYMS = new Set([
  'AI', 'API', 'APIS', 'ASR', 'BM', 'CI', 'CLI', 'CPU', 'CSS', 'CSV', 'DB', 'DOM', 'DNS', 'EPUB', 'FAQ', 'FTS', 'GB', 'GET', 'GIF',
  'GPU', 'HEAD', 'HTML', 'HTTP', 'HTTPS', 'ID', 'IDS', 'II', 'III', 'IOS', 'IP', 'IPC', 'ISBN', 'JPEG', 'JPG', 'JS', 'JSON', 'JSX',
  'KB', 'LLM', 'LAN', 'MB', 'MCP', 'MD', 'MDX', 'MIME', 'OAUTH', 'OCR', 'OG', 'OK', 'OPML', 'OS', 'PATCH', 'PDF', 'PNG', 'POST',
  'PR', 'PUT', 'DELETE', 'RAM', 'RSS', 'SDK', 'SQL', 'SSH', 'SVG', 'TCP', 'TLS', 'TOML', 'TS', 'TSX', 'TTS', 'UI', 'URL', 'URLS',
  'USB', 'UTC', 'UTF', 'UX', 'VPN', 'WASM', 'XML', 'YAML', 'MIT', 'PM', 'AM', 'TODO', 'FTS5', 'XSS', 'CSRF', 'CORS', 'RGB', 'HEX',
  'NFC', 'NFD', 'YT', 'USER', 'NOTES', 'SKILL', 'README', 'AGENTS', 'CLAUDE', 'WAL', 'UDID', 'SF', 'SHA', 'UUID', 'FIFO', 'LRU',
  'TTL', 'TCC', 'ATS', 'OPDS', 'MP', 'MOV', 'WEBP', 'AVIF', 'HEIC', 'CDN', 'CMS', 'JWT', 'KV', 'GPT', 'IETF', 'RFC', 'ISO', 'EOF',
]);

// A leading "=" matches the lowercase word only, so a proper noun with the
// same spelling (Whisper the model, Muse the app) passes.
const words = (list) => list.map(([w, hint]) => ({ word: w.replace(/^=/, ''), hint, re: wordRe(w.replace(/^=/, ''), w.startsWith('=')) }));

function wordRe(w, exact = false) {
  const body = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]").replace(/ /g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${body}(?![\\p{L}\\p{N}_-])`, exact ? 'gu' : 'giu');
}

export const SLOP_WORDS = words(SLOP);
export const TONE_WORDS = words(TONE);

/** Binary contrasts that a regex can catch without many false hits. */
export const CONTRASTS = [
  /\bnot just\b/gi,
  /\bnot only\b/gi,
  /\bmore than just\b/gi,
  /\bisn['’]t (?:just |only |merely )?[^.;:!?\n]{1,40}?,\s*(?:it['’]s|it is|they['’]re)\b/gi,
  /\b(?:it['’]s|this is|that['’]s|they['’]re) not (?:just |only )?[^.;:!?\n]{1,40}?[,;—–]\s*(?:it['’]s|it is|they['’]re|but)\b/gi,
  /\bnot (?:a|an) [^.!?\n]{1,30}\.\s+not (?:a|an) /gi,
  /\bless [a-z]+, more [a-z]+\b/gi,
];

/** Colon reveals and throat-clearing set-ups. */
export const REVEALS = [
  /\b(?:the|here['’]s the) (?:best part|catch|twist|secret|trick|kicker|upshot|bottom line|truth|reality|good news|bad news|magic|punchline)\s*[:—]/gi,
  /\bhere['’]s the thing\b/gi,
  /\bhere['’]s (?:why|what|how)\s*:/gi,
  /\bthe best part\b/gi,
  /\bwhat (?:most people|nobody) (?:get wrong|tells you)\b/gi,
  /\blet me be clear\b/gi,
];

export const EM_DASH = /—/g;
// Two or more ALL CAPS words in a row: "ABOUT THIS NOTE".
export const ALL_CAPS = /(?<![\p{L}\p{N}_'’-])[A-Z]{2,}(?:[ \t]+[A-Z]{2,})+(?![\p{L}\p{N}_'’-])/gu;

export const HINTS = {
  'eyebrow-uppercase': 'no uppercase labels; delete the label or use a sentence-case heading',
  'eyebrow-tracking': 'no letter-spaced labels; drop the tracking (keyboard hints may use it inside <kbd> or a *Shortcut component)',
  'eyebrow-small-caps': 'no small-caps labels; delete the label or use a sentence-case heading',
  'all-caps': 'write it in sentence case',
  'slop-word': 'plain words only',
  'tone-word': 'no mindful, poetic or metaphor words',
  'em-dash': 'use a period, comma or colon instead of an em dash',
  'binary-contrast': 'say the positive thing directly',
  'colon-reveal': 'make it a plain sentence',
  'allow-reason': 'copy-lint-allow needs a reason: "copy-lint-allow: <why>"',
  'over-explaining': 'let the components do the talking: delete it, or keep one short line with a fact the UI can\'t show (a limit, a cost, what leaves the device)',
  'shortcut-note': 'a note is for a fact the control can\'t show, never a key: the hold-⌘ chips and the ⇧⌘/ list show those, so delete the note',
};

/** Text rules: run over a piece of user-visible text. Returns [{rule, index, length, detail}]. */
export function checkText(text, { emDash = true } = {}) {
  const out = [];
  const add = (rule, m, detail) => out.push({ rule, index: m.index, length: m[0].length, detail });
  for (const { word, hint, re } of SLOP_WORDS) for (const m of text.matchAll(re)) add('slop-word', m, `"${m[0]}": ${hint}`);
  for (const { word, hint, re } of TONE_WORDS) for (const m of text.matchAll(re)) add('tone-word', m, `"${m[0]}": ${hint}`);
  for (const re of CONTRASTS) for (const m of text.matchAll(re)) add('binary-contrast', m, `"${m[0]}"`);
  for (const re of REVEALS) for (const m of text.matchAll(re)) add('colon-reveal', m, `"${m[0]}"`);
  if (emDash) for (const m of text.matchAll(EM_DASH)) add('em-dash', m, '');
  for (const m of text.matchAll(ALL_CAPS)) {
    if (m[0].split(/[ \t]+/).every((w) => ACRONYMS.has(w))) continue;
    add('all-caps', m, `"${m[0]}"`);
  }
  // Overlapping words ("seam" inside "seams") report once.
  out.sort((a, b) => a.index - b.index || b.length - a.length);
  return out.filter((f, i) => !out.slice(0, i).some((g) => g.rule === f.rule && g.index <= f.index && g.index + g.length >= f.index + f.length));
}

// ---- Eyebrow styling ----------------------------------------------------

const TW_UPPERCASE = /(?<![\w-])(?:[\w-]+:)*uppercase(?![\w-])/g;
const TW_TRACKING = /(?<![\w-])(?:[\w-]+:)*tracking-(?:wide|wider|widest|\[(?!-)[^\]]*\])(?![\w-])/g;
const CSS_UPPERCASE = /text-transform\s*:\s*uppercase/gi;
const CSS_SMALL_CAPS = /font-variant(?:-caps)?\s*:\s*[^;"'}]*small-caps|fontVariant(?:Caps)?\s*:\s*\[?\s*["'][^"']*small-caps/gi;
const CSS_LETTER_SPACING = /letter-spacing\s*:\s*(\+?(?:\d*\.)?\d+)\s*(em|rem|px|pt|ch)?/gi;

/** Style rules over CSS text (CSS files, <style> blocks, CSS inside template literals). */
export function checkCss(text) {
  const out = [];
  for (const m of text.matchAll(CSS_UPPERCASE)) out.push({ rule: 'eyebrow-uppercase', index: m.index, length: m[0].length, detail: m[0] });
  for (const m of text.matchAll(CSS_SMALL_CAPS)) out.push({ rule: 'eyebrow-small-caps', index: m.index, length: m[0].length, detail: m[0] });
  for (const m of text.matchAll(CSS_LETTER_SPACING)) {
    if (Number(m[1]) > 0) out.push({ rule: 'eyebrow-tracking', index: m.index, length: m[0].length, detail: m[0] });
  }
  return out;
}

/** Style rules over a JS/TS string literal: Tailwind classes, RN/CSS-in-JS values, embedded CSS. */
export function checkStyleString(text, { allowTracking = false } = {}) {
  const out = checkCss(text);
  for (const m of text.matchAll(TW_UPPERCASE)) {
    // `text-transform: uppercase` is already reported by checkCss.
    if (out.some((f) => f.rule === 'eyebrow-uppercase' && f.index <= m.index && f.index + f.length >= m.index + m[0].length)) continue;
    out.push({ rule: 'eyebrow-uppercase', index: m.index, length: m[0].length, detail: m[0] });
  }
  if (/^(?:small-caps|all-small-caps|petite-caps|all-petite-caps)$/.test(text.trim())) out.push({ rule: 'eyebrow-small-caps', index: 0, length: text.length, detail: text });
  // Typst (the PDF export): upper(), smallcaps() and positive tracking.
  for (const m of text.matchAll(/(?<![\w-])upper\(/g)) out.push({ rule: 'eyebrow-uppercase', index: m.index, length: m[0].length, detail: 'upper(' });
  for (const m of text.matchAll(/(?<![\w-])smallcaps\(/g)) out.push({ rule: 'eyebrow-small-caps', index: m.index, length: m[0].length, detail: 'smallcaps(' });
  for (const m of text.matchAll(/(?<![\w-])tracking:\s*\+?((?:\d*\.)?\d+)\s*(?:em|pt)/g)) if (Number(m[1]) > 0 && !allowTracking) out.push({ rule: 'eyebrow-tracking', index: m.index, length: m[0].length, detail: m[0] });
  if (!allowTracking) for (const m of text.matchAll(TW_TRACKING)) out.push({ rule: 'eyebrow-tracking', index: m.index, length: m[0].length, detail: m[0] });
  return out;
}

/** A letterSpacing value in a style object: positive numbers and positive lengths are eyebrow tracking. */
export function positiveSpacing(value) {
  if (typeof value === 'number') return value > 0;
  const m = /^\s*\+?((?:\d*\.)?\d+)\s*(em|rem|px|pt|ch)?\s*$/.exec(String(value));
  return Boolean(m && Number(m[1]) > 0);
}

export const ALLOW = /copy-lint-allow(?::\s*(\S.*?))?\s*(?:\*\/|-->|\}|$)/;
