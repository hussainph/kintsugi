import * as React from "react"
import { cn } from "cn"
import { Button } from "../button"

/**
 * One message in a chat, after AI Elements' Message: the owner's on the
 * right in a bubble, the assistant's on the left as plain text beside its
 * avatar, a helper's report as a quieter card.
 */
export type MessageFrom = "owner" | "assistant" | "helper"

type MessageProps = React.ComponentProps<"div"> & {
  from: MessageFrom
  /** Arrived while the log was on screen: it enters rather than appearing. */
  fresh?: boolean
}

export function Message({ from, fresh, className, ...props }: MessageProps) {
  return <div data-slot="message" data-from={from} data-fresh={fresh || undefined} className={cn("ki-message group/message", className)} {...props} />
}

export function MessageAvatar({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-avatar" className={cn("ki-message-avatar", className)} {...props} />
}

/** The message's body: the bubble, the reply or the card. */
export function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-content" className={cn("ki-message-content", className)} {...props} />
}

/** What sits under a message: its chips, its status, its actions. */
export function MessageFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-footer" className={cn("ki-message-footer", className)} {...props} />
}

/** Actions on a message, after AI Elements' Actions. Shown on hover and
 *  focus, and always on the latest reply (`pinned`). */
export function MessageActions({ className, pinned, ...props }: React.ComponentProps<"div"> & { pinned?: boolean }) {
  return <div data-slot="message-actions" data-pinned={pinned || undefined} className={cn("ki-message-actions", className)} {...props} />
}

export function MessageAction({ label, className, children, ...props }: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Button type="button" variant="ghost" size="icon-xs" aria-label={label} title={label} className={cn("ki-message-action", className)} {...props}>
      {children}
    </Button>
  )
}

/** A short status beside a message: "Waiting", "Interrupted". */
export function MessageStatus({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="message-status" className={cn("ki-message-status", className)} {...props} />
}
