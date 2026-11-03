/**
 * A small Markdown reader for chat replies: the blocks and inlines a model
 * writes (paragraphs, headings, lists, quotes, fenced code, rules; code,
 * bold, italics, links, autolinks and [[wikilinks]]). It never produces
 * HTML, so a reply can't inject markup, and it reads half-written input
 * (a reply still streaming: an unclosed fence is a code block so far).
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "wikilink"; target: string; label: string }
  | { type: "break" }

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "code"; info: string; text: string; complete: boolean }
  | { type: "rule" }

const FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const BULLET = /^(\s*)([-*+])\s+(.*)$/
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/

export function parseMarkdown(source: string): Block[] {
  return blocks(source.replace(/\r\n?/g, "\n").split("\n"))
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const [, indent, marks, info] = fence
      const body: string[] = []
      let complete = false
      i++
      while (i < lines.length) {
        const close = lines[i].trim()
        if (close.startsWith(marks[0].repeat(marks.length)) && !close.replace(new RegExp(`^\\${marks[0]}+`), "").trim()) {
          complete = true
          i++
          break
        }
        body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i])
        i++
      }
      out.push({ type: "code", info: info.trim(), text: body.join("\n"), complete })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ type: "heading", level: heading[1].length, children: inlines(heading[2]) })
      i++
      continue
    }
    if (RULE.test(line)) {
      out.push({ type: "rule" })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i])![1])
        i++
      }
      out.push({ type: "quote", children: blocks(body) })
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = NUMBERED.exec(line)
    if (bullet || numbered) {
      const ordered = !bullet
      const item = ordered ? NUMBERED : BULLET
      const base = (bullet ?? numbered)![1].length
      const items: string[][] = []
      while (i < lines.length) {
        const current = lines[i]
        const match = item.exec(current)
        if (match && match[1].length <= base + 1) {
          items.push([match[3]])
          i++
          continue
        }
        // A continuation: indented under the item, or a lazy line of its paragraph.
        if (current.trim() && items.length && (/^\s{2,}/.test(current) || !(BULLET.test(current) || NUMBERED.test(current) || FENCE.test(current) || HEADING.test(current) || QUOTE.test(current)))) {
          items[items.length - 1].push(current.replace(/^\s{2,4}/, ""))
          i++
          continue
        }
        // A blank line inside a list continues it if the next line is another item or indented.
        if (!current.trim() && i + 1 < lines.length && (item.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) {
          items[items.length - 1]?.push("")
          i++
          continue
        }
        break
      }
      out.push({ type: "list", ordered, start: ordered ? Number(numbered![2]) : 1, items: items.map((body) => blocks(body)) })
      continue
    }
    const body: string[] = []
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !QUOTE.test(lines[i]) && !RULE.test(lines[i]) && !(body.length && (BULLET.test(lines[i]) || NUMBERED.test(lines[i])))) {
      body.push(lines[i].trim())
      i++
    }
    out.push({ type: "paragraph", children: inlines(body.join("\n")) })
  }
  return out
}

const SAFE_URL = /^(https?:|mailto:)/i
const BARE_URL = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"”’]/

/** Inline Markdown. Unmatched markers stay as text. */
export function inlines(text: string): Inline[] {
  const out: Inline[] = []
  let plain = ""
  const flush = () => {
    if (plain) out.push({ type: "text", text: plain })
    plain = ""
  }
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    const c = text[i]
    if (c === "\n") {
      flush()
      out.push({ type: "break" })
      i++
      continue
    }
    if (c === "\\" && i + 1 < text.length && /[\\`*_[\]()#+\-.!>~|]/.test(text[i + 1])) {
      plain += text[i + 1]
      i += 2
      continue
    }
    if (c === "`") {
      const ticks = /^`+/.exec(rest)![0]
      const end = text.indexOf(ticks, i + ticks.length)
      if (end > 0) {
        flush()
        out.push({ type: "code", text: text.slice(i + ticks.length, end).replace(/^ (.*) $/, "$1") })
        i = end + ticks.length
        continue
      }
    }
    if (rest.startsWith("[[")) {
      const end = text.indexOf("]]", i + 2)
      const inner = end > 0 ? text.slice(i + 2, end) : ""
      if (inner && !inner.includes("\n") && !inner.includes("[")) {
        flush()
        const [target, label] = inner.split("|")
        out.push({ type: "wikilink", target: target.trim(), label: (label ?? target).trim() })
        i = end + 2
        continue
      }
    }
    if (c === "[") {
      const link = /^\[([^\]\n]+)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest)
      if (link && SAFE_URL.test(link[2])) {
        flush()
        out.push({ type: "link", href: link[2], children: inlines(link[1]) })
        i += link[0].length
        continue
      }
    }
    if (c === "<") {
      const auto = /^<(https?:\/\/[^\s>]+)>/.exec(rest)
      if (auto) {
        flush()
        out.push({ type: "link", href: auto[1], children: [{ type: "text", text: auto[1] }] })
        i += auto[0].length
        continue
      }
    }
    if ((c === "h" || c === "H") && (i === 0 || /[\s(]/.test(text[i - 1]))) {
      const bare = BARE_URL.exec(rest)
      if (bare) {
        flush()
        out.push({ type: "link", href: bare[0], children: [{ type: "text", text: bare[0] }] })
        i += bare[0].length
        continue
      }
    }
    if (c === "*" || c === "_") {
      const double = rest.startsWith(c + c)
      const marker = double ? c + c : c
      const before = i > 0 ? text[i - 1] : " "
      const after = text[i + marker.length] ?? " "
      // Opens before a non-space; `_` doesn't open inside a word (snake_case).
      if (after.trim() && !(c === "_" && /\w/.test(before))) {
        const close = findClose(text, i + marker.length, marker)
        if (close > 0) {
          flush()
          const children = inlines(text.slice(i + marker.length, close))
          out.push(double ? { type: "strong", children } : { type: "em", children })
          i = close + marker.length
          continue
        }
      }
    }
    plain += c
    i++
  }
  flush()
  return out
}

/** Where `marker` closes emphasis opened before `from`, or -1. */
function findClose(text: string, from: number, marker: string) {
  let at = from
  while (at < text.length) {
    const found = text.indexOf(marker, at)
    if (found < 0) return -1
    const before = text[found - 1]
    const after = text[found + marker.length] ?? " "
    const doubled = marker.length === 1 && (text[found + 1] === marker || before === marker)
    if (found > from && before.trim() && !doubled && !(marker[0] === "_" && /\w/.test(after))) return found
    at = found + marker.length
  }
  return -1
}
