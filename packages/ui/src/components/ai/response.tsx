import * as React from "react"
import { cn } from "cn"
import { CodeBlock } from "./code-block"
import { type Block, type Inline, parseMarkdown } from "./markdown"

/**
 * An assistant's reply as Markdown, after AI Elements' Response: safe
 * (it never renders HTML), happy with half-written input while it streams,
 * and open to the host for links, [[wikilinks]], code blocks and plain text
 * (to turn paths into links, say).
 */
export type ResponseComponents = {
  /** A fenced block; return undefined for the default code block. */
  code?: (block: { info: string; code: string; complete: boolean }) => React.ReactNode | undefined
  link?: (link: { href: string; children: React.ReactNode }) => React.ReactNode
  wikilink?: (link: { target: string; label: string }) => React.ReactNode
  /** Plain text runs, for the host to find things in. */
  text?: (text: string) => React.ReactNode
  /** Inline code; return undefined for the default. */
  inlineCode?: (text: string) => React.ReactNode | undefined
}

type ResponseProps = Omit<React.ComponentProps<"div">, "children"> & {
  children: string
  /** Still arriving: a caret follows the last word. */
  streaming?: boolean
  components?: ResponseComponents
}

const Caret = () => <span aria-hidden className="ki-response-caret" data-slot="response-caret" />

function renderInlines(nodes: Inline[], components: ResponseComponents | undefined, key = ""): React.ReactNode[] {
  return nodes.map((node, i) => {
    const k = `${key}${i}`
    switch (node.type) {
      case "text":
        return <React.Fragment key={k}>{components?.text ? components.text(node.text) : node.text}</React.Fragment>
      case "break":
        return <br key={k} />
      case "code":
        return <React.Fragment key={k}>{components?.inlineCode?.(node.text) ?? <code className="ki-response-inline-code">{node.text}</code>}</React.Fragment>
      case "strong":
        return <strong key={k}>{renderInlines(node.children, components, `${k}.`)}</strong>
      case "em":
        return <em key={k}>{renderInlines(node.children, components, `${k}.`)}</em>
      case "link": {
        const children = renderInlines(node.children, components, `${k}.`)
        return (
          <React.Fragment key={k}>
            {components?.link?.({ href: node.href, children }) ?? (
              <a href={node.href} target="_blank" rel="noreferrer" className="ki-response-link">{children}</a>
            )}
          </React.Fragment>
        )
      }
      case "wikilink":
        return <React.Fragment key={k}>{components?.wikilink?.(node) ?? <span className="ki-response-wikilink">{node.label}</span>}</React.Fragment>
    }
  })
}

function renderBlocks(blocks: Block[], components: ResponseComponents | undefined, caret: boolean, key = ""): React.ReactNode[] {
  return blocks.map((block, i) => {
    const k = `${key}${i}`
    const last = caret && i === blocks.length - 1
    switch (block.type) {
      case "paragraph":
        return <p key={k}>{renderInlines(block.children, components, `${k}.`)}{last && <Caret />}</p>
      case "heading":
        return (
          <p key={k} role="heading" aria-level={Math.min(6, block.level + 2)} className="ki-response-heading" data-level={block.level}>
            {renderInlines(block.children, components, `${k}.`)}
            {last && <Caret />}
          </p>
        )
      case "quote":
        return <blockquote key={k}>{renderBlocks(block.children, components, last, `${k}.`)}</blockquote>
      case "list": {
        const List = block.ordered ? "ol" : "ul"
        return (
          <List key={k} start={block.ordered && block.start !== 1 ? block.start : undefined}>
            {block.items.map((item, j) => (
              <li key={j}>{renderBlocks(item, components, last && j === block.items.length - 1, `${k}.${j}.`)}</li>
            ))}
          </List>
        )
      }
      case "code": {
        const custom = components?.code?.({ info: block.info, code: block.text, complete: block.complete })
        return (
          <React.Fragment key={k}>
            {custom ?? <CodeBlock code={block.text} />}
            {last && !custom && <Caret />}
          </React.Fragment>
        )
      }
      case "rule":
        return <hr key={k} />
    }
  })
}

export function Response({ children, streaming, components, className, ...props }: ResponseProps) {
  const blocks = React.useMemo(() => parseMarkdown(children), [children])
  return (
    <div data-slot="response" data-streaming={streaming || undefined} className={cn("ki-response", className)} {...props}>
      {renderBlocks(blocks, components, !!streaming)}
      {streaming && !blocks.length && <Caret />}
    </div>
  )
}
