import * as React from "react"
import { cn } from "cn"
import { Check, Copy } from "../../icons"
import { Button } from "../button"

/** Copies `text`, and says so for a moment. */
export function useCopy(timeout = 1500) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<number | undefined>(undefined)
  React.useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = React.useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), timeout)
        return true
      } catch {
        return false
      }
    },
    [timeout],
  )
  return { copied, copy }
}

/** A fenced block from a reply, after AI Elements' CodeBlock: monospace, scrolls sideways, with Copy. */
export function CodeBlock({ code, className, children, ...props }: React.ComponentProps<"div"> & { code: string }) {
  const { copied, copy } = useCopy()
  return (
    <div data-slot="code-block" className={cn("ki-code-block group/code", className)} {...props}>
      <pre>
        <code>{code}</code>
      </pre>
      <div className="ki-code-block-actions">
        {children}
        <Button type="button" variant="ghost" size="icon-xs" aria-label={copied ? "Copied" : "Copy"} title={copied ? "Copied" : "Copy"} onClick={() => void copy(code)}>
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  )
}
