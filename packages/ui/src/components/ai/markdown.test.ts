import assert from "node:assert/strict"
import { test } from "node:test"
import { inlines, parseMarkdown } from "./markdown"

test("blocks: paragraphs, headings, lists, quotes, rules and code", () => {
  const blocks = parseMarkdown("# Title\n\nOne line\nand the next.\n\n- a\n- b\n\n1. one\n2. two\n\n> quoted\n\n---\n\n```ts\nconst x = 1\n```")
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading", "paragraph", "list", "list", "quote", "rule", "code"],
  )
  const para = blocks[1]
  assert.ok(para.type === "paragraph" && para.children.some((c) => c.type === "break"), "a single newline is a line break")
  const ordered = blocks[3]
  assert.ok(ordered.type === "list" && ordered.ordered && ordered.items.length === 2)
  const code = blocks[6]
  assert.deepEqual(code, { type: "code", info: "ts", text: "const x = 1", complete: true })
})

test("an unclosed fence is a code block so far (a reply still streaming)", () => {
  const [code] = parseMarkdown("```edit drafts/a.md\n<<<<<<< SEARCH\nold")
  assert.deepEqual(code, { type: "code", info: "edit drafts/a.md", text: "<<<<<<< SEARCH\nold", complete: false })
})

test("inlines: code, emphasis, links, wikilinks; snake_case and stray markers stay text", () => {
  assert.deepEqual(inlines("Read `notes/a.md` now"), [
    { type: "text", text: "Read " },
    { type: "code", text: "notes/a.md" },
    { type: "text", text: " now" },
  ])
  assert.deepEqual(inlines("**bold** and *em*"), [
    { type: "strong", children: [{ type: "text", text: "bold" }] },
    { type: "text", text: " and " },
    { type: "em", children: [{ type: "text", text: "em" }] },
  ])
  assert.deepEqual(inlines("see [[posts/on-craft|On craft]]"), [
    { type: "text", text: "see " },
    { type: "wikilink", target: "posts/on-craft", label: "On craft" },
  ])
  assert.deepEqual(inlines("[site](https://example.com) and https://a.org/x."), [
    { type: "link", href: "https://example.com", children: [{ type: "text", text: "site" }] },
    { type: "text", text: " and " },
    { type: "link", href: "https://a.org/x", children: [{ type: "text", text: "https://a.org/x" }] },
    { type: "text", text: "." },
  ])
  assert.deepEqual(inlines("a snake_case_name, 2 * 3 * 4, and **unclosed"), [{ type: "text", text: "a snake_case_name, 2 * 3 * 4, and **unclosed" }])
})

test("only http(s) and mailto links become links", () => {
  assert.deepEqual(inlines("[x](javascript:alert(1))"), [{ type: "text", text: "[x](javascript:alert(1))" }])
})
