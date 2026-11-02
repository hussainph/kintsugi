// Markdown, HTML and CSS: prose for the text rules, CSS for the eyebrow rules.
import { checkCss } from './rules.mjs';
import { lineIndex } from './extract-rust.mjs';

/** Markdown prose, one item per line, with code fences, inline code, URLs and HTML comments blanked out. */
export function extractMarkdown(file, source) {
  const texts = [];
  let fence = null;
  let inComment = false;
  source.split('\n').forEach((line, i) => {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fence) { if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null; return; }
    if (fenceMatch) { fence = fenceMatch[1]; return; }
    if (/^ {4,}\S/.test(line) && !/^\s*[-*\d]/.test(line)) return; // indented code
    let text = line;
    if (inComment) { const e = text.indexOf('-->'); if (e < 0) return; text = ' '.repeat(e + 3) + text.slice(e + 3); inComment = false; }
    text = text.replace(/<!--.*?-->/g, (m) => ' '.repeat(m.length));
    const open = text.indexOf('<!--');
    if (open >= 0) { inComment = true; text = text.slice(0, open); }
    text = blankCode(text)
      .replace(/\]\([^)]*\)/g, (m) => ']' + ' '.repeat(m.length - 1))
      .replace(/<https?:[^>]*>|https?:\/\/\S+/g, (m) => ' '.repeat(m.length))
      .replace(/<\/?[a-zA-Z][^>]*>/g, (m) => ' '.repeat(m.length));
    if (/\p{L}/u.test(text)) texts.push({ line: i + 1, text, raw: line, rawLine: i + 1, column: true, context: 'doc', name: '' });
  });
  return { texts, styles: [] };
}

function blankCode(text) {
  return text.replace(/(`+)[\s\S]*?\1/g, (m) => ' '.repeat(m.length));
}

/** HTML: CSS in <style> and style="" for eyebrow rules; visible text, line by line, for text rules. */
export function extractHtml(file, source) {
  const styles = [];
  const lineAt = lineIndex(source);
  const cssSpans = [];
  for (const m of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) cssSpans.push([m.index + m[0].indexOf(m[1]), m[1]]);
  for (const m of source.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) cssSpans.push([m.index + m[0].indexOf(m[1]), m[1]]);
  for (const [at, css] of cssSpans) for (const f of checkCss(css)) styles.push({ line: lineAt(at + f.index), rule: f.rule, detail: f.detail });
  // Visible text: blank out style/script blocks, comments and tags, keep line structure.
  const visible = source
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<code\b[\s\S]*?<\/code>|<pre\b[\s\S]*?<\/pre>/gi, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<[^>]*>/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/&mdash;/g, '—').replace(/&amp;/g, '&').replace(/&[a-z]+;|&#\d+;/g, (m) => ' '.repeat(m.length));
  const texts = [];
  const raw = source.split('\n');
  visible.split('\n').forEach((line, i) => {
    if (/\p{L}/u.test(line)) texts.push({ line: i + 1, text: line, raw: raw[i], rawLine: i + 1, column: true, context: 'doc', name: '' });
  });
  return { texts, styles };
}

export function extractCss(file, source) {
  const lineAt = lineIndex(source);
  return { texts: [], styles: checkCss(source).map((f) => ({ line: lineAt(f.index), rule: f.rule, detail: f.detail })) };
}
