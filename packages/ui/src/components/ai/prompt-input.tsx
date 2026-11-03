import * as React from "react"
import { cn } from "cn"
import { ArrowUp, Square, X, type IconComponent } from "../../icons"
import { Button } from "../button"

/**
 * A chat's composer, after AI Elements' PromptInput: one surface holding
 * the context chips, a field that grows with what's typed (Enter sends,
 * Shift+Enter adds a line) and a toolbar with the submit button.
 */
export function PromptInput({ className, onSubmit, ...props }: React.ComponentProps<"form">) {
  return (
    <form
      data-slot="prompt-input"
      className={cn("ki-prompt-input", className)}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit?.(e)
      }}
      {...props}
    />
  )
}

/** Above the field: what goes with the message. */
export function PromptInputHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="prompt-input-header" className={cn("ki-prompt-input-header", className)} {...props} />
}

type TextareaProps = React.ComponentProps<"textarea"> & {
  /** Enter without Shift; the form submits. */
  onSubmitKey?: () => void
}

export const PromptInputTextarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function PromptInputTextarea(
  { className, onKeyDown, onSubmitKey, rows = 1, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      data-slot="prompt-input-textarea"
      className={cn("ki-prompt-input-textarea", className)}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (e.defaultPrevented) return
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          if (onSubmitKey) onSubmitKey()
          else e.currentTarget.form?.requestSubmit()
        }
      }}
      {...props}
    />
  )
})

export function PromptInputToolbar({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="prompt-input-toolbar" className={cn("ki-prompt-input-toolbar", className)} {...props} />
}

/** The toolbar's left side: pickers and options. */
export function PromptInputTools({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="prompt-input-tools" className={cn("ki-prompt-input-tools", className)} {...props} />
}

/** Sends, or stops the reply under way. */
export function PromptInputSubmit({ status = "ready", onStop, disabled, className, ...props }: Omit<React.ComponentProps<typeof Button>, "children"> & {
  status?: "ready" | "streaming"
  onStop?: () => void
}) {
  if (status === "streaming" && onStop) {
    return (
      <Button type="button" variant="outline" size="icon-sm" aria-label="Stop" title="Stop" className={cn("ki-prompt-input-submit", className)} data-status="streaming" onClick={onStop} {...props}>
        <Square className="ki-prompt-input-stop" />
      </Button>
    )
  }
  return (
    <Button type="submit" size="icon-sm" aria-label="Send" title="Send" disabled={disabled} className={cn("ki-prompt-input-submit", className)} data-status="ready" {...props}>
      <ArrowUp />
    </Button>
  )
}

/** Something attached to the message: a document, a passage, a clip. */
export function PromptInputChip({ icon: Icon, label, title, onRemove, className, ...props }: Omit<React.ComponentProps<"span">, "children"> & {
  icon?: IconComponent
  label: string
  onRemove?: () => void
}) {
  return (
    <span data-slot="prompt-input-chip" title={title} className={cn("ki-prompt-chip", className)} {...props}>
      {Icon && <Icon className="ki-prompt-chip-icon" />}
      <span className="ki-prompt-chip-label">{label}</span>
      {onRemove && (
        <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} className="ki-prompt-chip-remove">
          <X />
        </button>
      )}
    </span>
  )
}
