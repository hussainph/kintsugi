import * as React from "react"
import { cn } from "cn"
import { AlertCircle, Check, ChevronDown, Loader2, type IconComponent } from "../../icons"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../collapsible"
import { Shimmer } from "./shimmer"

/**
 * What an assistant did on the way to a reply, after AI Elements'
 * ChainOfThought, Reasoning and Tool: while it works, each step appears as
 * it starts (searching, reading) under a live status; once it's done, the
 * steps fold into one line with how long it took.
 */
type ChainProps = Omit<React.ComponentProps<typeof Collapsible>, "children"> & {
  children?: React.ReactNode
}

export function ChainOfThought({ className, ...props }: ChainProps) {
  return <Collapsible data-slot="chain-of-thought" className={cn("ki-chain", className)} {...props} />
}

/** The fold's one line. `live` shows it shimmering, with no toggle. */
export function ChainOfThoughtHeader({ className, children, live, icon: Icon, ...props }: React.ComponentProps<"button"> & { live?: boolean; icon?: IconComponent }) {
  if (live) {
    return (
      <div data-slot="chain-of-thought-header" data-shimmer className={cn("ki-chain-header", className)}>
        {Icon && <Icon className="ki-chain-header-icon" />}
        <Shimmer>{children}</Shimmer>
      </div>
    )
  }
  return (
    <CollapsibleTrigger asChild>
      <button type="button" data-slot="chain-of-thought-header" className={cn("ki-chain-header ki-chain-toggle", className)} {...props}>
        {Icon && <Icon className="ki-chain-header-icon" />}
        <span className="ki-chain-header-label">{children}</span>
        <ChevronDown className="ki-chain-chevron" />
      </button>
    </CollapsibleTrigger>
  )
}

export function ChainOfThoughtContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent className={className} {...props}>
      <ol className="ki-chain-steps">{children}</ol>
    </CollapsibleContent>
  )
}

/** The steps, always shown (while the assistant is still working). */
export function ChainOfThoughtSteps({ className, ...props }: React.ComponentProps<"ol">) {
  return <ol data-slot="chain-of-thought-steps" className={cn("ki-chain-steps", className)} {...props} />
}

export type StepStatus = "running" | "done" | "error"

const STATUS_ICON: Record<StepStatus, IconComponent> = { running: Loader2, done: Check, error: AlertCircle }

/** One step: what it did, with its status. */
export function ChainOfThoughtStep({ status, icon: Icon, label, children, className, ...props }: Omit<React.ComponentProps<"li">, "children"> & {
  status: StepStatus
  icon?: IconComponent
  label: React.ReactNode
  children?: React.ReactNode
}) {
  const Status = STATUS_ICON[status]
  return (
    <li data-slot="chain-of-thought-step" data-status={status} className={cn("ki-chain-step", className)} {...props}>
      <span className="ki-chain-step-icon" aria-hidden>
        {Icon ? <Icon /> : <Status />}
      </span>
      <span className="ki-chain-step-body">
        <span className="ki-chain-step-label">{label}</span>
        {children}
      </span>
      <span className="ki-chain-step-status">
        <Status aria-hidden />
        {status !== "done" && <span className="sr-only">{status === "running" ? "Working" : "Failed"}</span>}
      </span>
    </li>
  )
}
