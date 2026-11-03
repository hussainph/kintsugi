/**
 * An idea's inline citations (KI-76): Kin writes `[1]` after a claim for the
 * idea's first quote. The Mac and the phone show each as a small marker that
 * reveals the quote and its source.
 */

/** A run of text, or a citation of `quotes[quote]` (0-based). */
export type Piece = { text: string } | { quote: number };

/**
 * Splits Kin's text at its inline citations, `[1]` for the first of
 * `quotes` quotes. A number with no quote behind it stays text, and so do
 * wikilinks.
 */
export function cite(text: string, quotes: number): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(/(?<!\[)\[(\d{1,2})\](?!\])/g)) {
    const n = Number(m[1]);
    if (n < 1 || n > quotes) continue;
    const before = text.slice(last, m.index).replace(/\s+$/, "");
    if (before) out.push({ text: before });
    out.push({ quote: n - 1 });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Quotes no line cites: every quote, for ideas from before citations. */
export function uncited(idea: { hunch: string; observed: string[]; quotes: unknown[] }): number[] {
  const cited = new Set(
    [idea.hunch, ...idea.observed].flatMap((t) => cite(t, idea.quotes.length)).flatMap((p) => ("quote" in p ? [p.quote] : [])),
  );
  return idea.quotes.map((_, i) => i).filter((i) => !cited.has(i));
}
