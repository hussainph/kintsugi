/** Three-way merge of two edits of the same text, line by line.
 *
 *  `base` is the copy both sides started from. Changes that touch different
 *  lines combine; the same change made on both sides counts once. Only edits
 *  to the same or neighbouring lines that differ are a collision, and then
 *  nothing is guessed: the caller asks which version to keep. */
export type Merge = { clean: true; text: string } | { clean: false };

/** A run of base lines [start, end) replaced by `lines`. */
type Hunk = { start: number; end: number; lines: string[] };

export function merge3(base: string, mine: string, theirs: string): Merge {
  if (mine === theirs || theirs === base) return { clean: true, text: mine };
  if (mine === base) return { clean: true, text: theirs };
  const b = base.split("\n");
  const ours = hunks(b, mine.split("\n")).map((h) => ({ ...h, side: 0 }));
  const other = hunks(b, theirs.split("\n")).map((h) => ({ ...h, side: 1 }));
  const all = [...ours, ...other].sort((x, y) => x.start - y.start || x.end - y.end);

  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < all.length; ) {
    // A group: hunks whose base ranges overlap, changes to neighbouring
    // lines, or additions at the same place. An addition next to a changed
    // line is not a collision: it goes before or after it.
    const group = [all[i]];
    let end = all[i].end;
    const added = (h: Hunk) => h.start === h.end;
    for (i++; i < all.length; i++) {
      const h = all[i];
      const last = group[group.length - 1];
      if (!(h.start < end || (h.start === end && added(h) === added(last)))) break;
      group.push(h);
      end = Math.max(end, h.end);
    }
    const start = group[0].start;
    out.push(...b.slice(at, start));
    at = end;
    const sides = new Set(group.map((h) => h.side));
    const apply = (side: number) => {
      const lines: string[] = [];
      let pos = start;
      for (const h of group.filter((g) => g.side === side)) {
        lines.push(...b.slice(pos, h.start), ...h.lines);
        pos = h.end;
      }
      return [...lines, ...b.slice(pos, end)];
    };
    if (sides.size === 1) {
      out.push(...apply(group[0].side));
      continue;
    }
    const a = apply(0);
    const t = apply(1);
    if (a.join("\n") !== t.join("\n")) return { clean: false };
    out.push(...a);
  }
  out.push(...b.slice(at));
  const text = out.join("\n");
  // A safety net: the same addition can line up a line apart on each side
  // (blank lines between paragraphs) and land twice. A merge never holds a
  // line more often than either side does, so that is a collision instead.
  const result = counts(text);
  const [m, t] = [counts(mine), counts(theirs)];
  for (const [line, n] of result) {
    if (n > Math.max(m.get(line) ?? 0, t.get(line) ?? 0)) return { clean: false };
  }
  return { clean: true, text };
}

function counts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) if (line.trim()) out.set(line, (out.get(line) ?? 0) + 1);
  return out;
}

/** Above this many cells the table would cost too much memory on a phone;
 *  the changed middle is then one change, which collides more but is safe. */
const MAX_TABLE = 4_000_000;

/** The changes that turn `a` into `b`, from a longest common subsequence. */
function hunks(a: string[], b: string[]): Hunk[] {
  // Trim the common ends first; most edits are small, so this keeps the
  // quadratic table tiny.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const x = a.slice(pre, a.length - suf);
  const y = b.slice(pre, b.length - suf);
  const n = x.length;
  const m = y.length;
  if (n * m > MAX_TABLE) return [{ start: pre, end: pre + n, lines: y }];
  // lcs[i][j]: length of the LCS of x[i..] and y[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Hunk[] = [];
  let current: Hunk | null = null;
  const flush = () => {
    if (current) out.push(current);
    current = null;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      current ??= { start: pre + i, end: pre + i, lines: [] };
      current.lines.push(y[j++]);
    } else {
      current ??= { start: pre + i, end: pre + i, lines: [] };
      current.end = pre + ++i;
    }
  }
  flush();
  // Slide additions and removals up as far as they go, so the same change
  // sits at the same place whichever side made it.
  let floor = 0;
  for (const h of out) {
    if (h.lines.length === 0) {
      while (h.start > floor && a[h.start - 1] === a[h.end - 1]) h.start--, h.end--;
    } else if (h.start === h.end) {
      while (h.start > floor && a[h.start - 1] === h.lines[h.lines.length - 1]) {
        h.lines = [a[h.start - 1], ...h.lines.slice(0, -1)];
        h.start--;
        h.end--;
      }
    }
    floor = h.end;
  }
  return out;
}
