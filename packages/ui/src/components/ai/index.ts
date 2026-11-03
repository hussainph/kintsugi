// Kin's chat components (KI-79): the patterns and structure of Vercel's AI
// Elements (Apache-2.0, https://github.com/vercel/ai-elements), rebuilt on
// the Graphical theme and Base UI parts. Presentational and placement-
// agnostic: the floating pane today, a sidebar later.
export * from "./chain-of-thought"
export * from "./code-block"
export * from "./conversation"
export * from "./message"
export * from "./notice"
export * from "./prompt-input"
export * from "./response"
export * from "./shimmer"
export * from "./suggestion"
export { parseMarkdown, inlines as parseInlines, type Block as MarkdownBlock, type Inline as MarkdownInline } from "./markdown"
