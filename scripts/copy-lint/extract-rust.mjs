// Pulls user-facing strings out of Rust source with a small lexer: prompts,
// phone API errors, notifications and error messages that reach the UI.
// Skips comments, `#[cfg(test)]` items, log/debug macros and strings that
// don't read like prose (keys, paths, SQL, JSON field names).

const SKIP_MACRO = /(?:^|[^\w])(?:debug|info|warn|error|trace|eprintln|println|eprint|print|dbg|assert|assert_eq|assert_ne|debug_assert|debug_assert_eq|unreachable|unimplemented|todo|panic|log|include_str|include_bytes|concat|env|option_env|stringify|matches|sql|json)!\s*[([{]\s*$|\.expect\(\s*$|(?:^|[^\w])(?:debug|info|warn|error|trace)!\s*\(\s*(?:target:\s*"[^"]*",\s*)?$/;

/** Rust literal tokens: { start, end, value, raw }. Comments and test items dropped. */
export function rustStrings(source) {
  const out = [];
  let i = 0;
  const n = source.length;
  const skipTo = []; // ranges inside #[cfg(test)] items
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && next === '*') {
      let depth = 1; i += 2;
      while (i < n && depth) {
        if (source[i] === '/' && source[i + 1] === '*') { depth++; i += 2; } else if (source[i] === '*' && source[i + 1] === '/') { depth--; i += 2; } else i++;
      }
      continue;
    }
    const cfg = /^#\[cfg\((?:test|all\(test\b[^\]]*)\)\]/.exec(source.slice(i, i + 120));
    if (cfg) {
      // Test-only item: skip it, up to its matching brace or the next `;`.
      const end = itemEnd(source, i + cfg[0].length);
      skipTo.push([i, end]);
      i = end;
      continue;
    }
    // Raw strings r"…", r#"…"#, br#"…"#
    const raw = /^(b?)r(#*)"/.exec(source.slice(i, i + 40));
    if (raw && !/[\w]/.test(source[i - 1] ?? '')) {
      const hashes = raw[2];
      const open = i + raw[0].length;
      const close = source.indexOf(`"${hashes}`, open);
      const end = close < 0 ? n : close + 1 + hashes.length;
      if (!raw[1]) out.push({ start: i, end, value: source.slice(open, close < 0 ? n : close), raw: source.slice(i, end), map: (k) => open + k });
      i = end;
      continue;
    }
    if (c === '"' || (c === 'b' && next === '"' && !/[\w]/.test(source[i - 1] ?? ''))) {
      const bytes = c === 'b';
      const open = i + (bytes ? 2 : 1);
      let j = open;
      let value = '';
      const offsets = [];
      while (j < n && source[j] !== '"') {
        if (source[j] === '\\') {
          const e = source[j + 1];
          if (e === '\n') { // line continuation: skip the newline and leading whitespace
            j += 2;
            while (j < n && /\s/.test(source[j])) j++;
            continue;
          }
          const map = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'" };
          if (e === 'u') {
            const m = /^\\u\{([0-9a-fA-F]+)\}/.exec(source.slice(j, j + 12));
            if (m) { offsets.push(j); value += String.fromCodePoint(parseInt(m[1], 16)); j += m[0].length; continue; }
          }
          if (e === 'x') { offsets.push(j); value += String.fromCharCode(parseInt(source.slice(j + 2, j + 4), 16)); j += 4; continue; }
          offsets.push(j); value += map[e] ?? e; j += 2; continue;
        }
        offsets.push(j); value += source[j]; j++;
      }
      const end = j + 1;
      if (!bytes) out.push({ start: i, end, value, raw: source.slice(i, end), map: (k) => offsets[k] ?? open });
      i = end;
      continue;
    }
    if (c === '\'') {
      // char literal or lifetime
      if (next === '\\') { const close = source.indexOf('\'', i + 2); i = close < 0 ? n : close + 1; continue; }
      if (source[i + 2] === '\'') { i += 3; continue; }
      const cp = source.codePointAt(i + 1);
      const w = cp > 0xffff ? 2 : 1;
      if (source[i + 1 + w] === '\'') { i += 2 + w; continue; }
      i++; continue;
    }
    i++;
  }
  return out;
}

function itemEnd(source, from) {
  let i = from;
  const n = source.length;
  // Skip further attributes and the item header to the first `{` or `;`.
  while (i < n && source[i] !== '{' && source[i] !== ';') i++;
  if (source[i] === ';') return i + 1;
  let depth = 0;
  for (const tok of rustTokens(source, i)) {
    if (tok === '{') depth++;
    else if (tok === '}') { depth--; if (depth === 0) return rustTokens.pos; }
  }
  return n;
}

// Yields structural braces while skipping strings, chars and comments.
function* rustTokens(source, from) {
  let i = from;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i < 0) return; continue; }
    if (c === '/' && source[i + 1] === '*') { const e = source.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    const raw = /^r(#*)"/.exec(source.slice(i, i + 40));
    if (raw && !/\w/.test(source[i - 1] ?? '')) { const e = source.indexOf(`"${raw[1]}`, i + raw[0].length); i = e < 0 ? n : e + 1 + raw[1].length; continue; }
    if (c === '"') { let j = i + 1; while (j < n && source[j] !== '"') j += source[j] === '\\' ? 2 : 1; i = j + 1; continue; }
    if (c === '\'') {
      if (source[i + 1] === '\\') { const e = source.indexOf('\'', i + 2); i = e < 0 ? n : e + 1; continue; }
      if (source[i + 2] === '\'') { i += 3; continue; }
      i++; continue;
    }
    if (c === '{' || c === '}') { rustTokens.pos = i + 1; yield c; }
    i++;
  }
}

const PLAIN_WORD = /^[(“"'‘]?[\p{L}][\p{L}'’-]*[.,!?:;…)”"'’]*$/u;

/** Prose test for Rust strings: sentences and labels, not keys, paths or format plumbing. */
export function rustProse(value) {
  const text = value.replace(/\{[^{}]*\}/g, 'X').trim();
  if (text.length < 2) return false;
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA|WITH|BEGIN|COMMIT|ROLLBACK|REPLACE)\b/.test(text)) return false;
  if (/\b(?:FROM|WHERE|IS (?:NOT )?NULL|CASE WHEN|ORDER BY|GROUP BY|JOIN|LIMIT|COALESCE|VALUES|ON CONFLICT|AND|OR)\b/.test(text) && /\b[a-z_]+\.[a-z_]+\b|\?\d?|\b[a-z]+_[a-z_]+\b/.test(text)) return false;
  if (/^(?:[a-z][\w+.-]*:\/\/|\/|\.\.?\/|--?[a-z]|#!|<\?xml)/i.test(text)) return false;
  const tokens = text.split(/\s+/);
  const plain = tokens.filter((tok) => PLAIN_WORD.test(tok));
  if (tokens.length === 1) return /^[A-Z][a-z’']+(?: [a-z]+)*[.!?…]?$/.test(text) && text.length > 3;
  if (plain.length < 2 || plain.length / tokens.length < 0.5) return false;
  return /^[A-Z“"‘(]/.test(text) || /[.?!…’',]/.test(text) || plain.length >= 3;
}

export function extractRust(file, source) {
  const texts = [];
  const lineAt = lineIndex(source);
  for (const lit of rustStrings(source)) {
    const before = source.slice(Math.max(0, lit.start - 120), lit.start);
    if (SKIP_MACRO.test(before)) continue;
    if (!rustProse(lit.value)) continue;
    texts.push({ line: lineAt(lit.start), text: lit.value, raw: lit.raw, rawLine: lineAt(lit.start), map: (k) => lineAt(lit.map(k)), context: 'rust', name: '' });
  }
  return { texts, styles: [] };
}

export function lineIndex(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}
