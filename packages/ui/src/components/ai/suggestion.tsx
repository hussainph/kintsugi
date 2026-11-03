import * as React from "react"
import { cn } from "cn"

/** Ready-made asks, after AI Elements' Suggestion: one tap sends one. */
export function Suggestions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="suggestions" className={cn("ki-suggestions", className)} {...props} />
}

export function Suggestion({ suggestion, onPick, className, children, ...props }: Omit<React.ComponentProps<"button">, "onClick"> & {
  suggestion: string
  onPick: (suggestion: string) => void
}) {
  return (
    <button type="button" data-slot="suggestion" className={cn("ki-suggestion", className)} onClick={() => onPick(suggestion)} {...props}>
      {children ?? suggestion}
    </button>
  )
}
