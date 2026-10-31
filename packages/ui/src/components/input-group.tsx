"use client"

import * as React from "react"
import { cn } from "cn"
import { Button } from "@kintsugi/ui/components/button"
import { Input } from "@kintsugi/ui/components/input"
import { Textarea } from "@kintsugi/ui/components/textarea"
import { graphicalPart } from "./graphical"

// Graphical has no separate InputGroup specimen. The group owns the supplied
// Text field surface; native children retain their own values/events/refs.
const Group = graphicalPart("div", "input", "control", "ki-input-group")

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <Group data-slot="input-group" role="group" className={cn("group/input-group relative min-w-0", className)} {...props} />
}

function InputGroupAddon({
  className,
  align = "inline-start",
  onClick,
  ...props
}: React.ComponentProps<"div"> & {
  align?: "inline-start" | "inline-end" | "block-start" | "block-end" | null
}) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn("ki-input-group-addon flex cursor-text items-center justify-center select-none [&>svg]:size-[1em]", className)}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || (event.target as HTMLElement).closest("button, a")) return
        event.currentTarget.parentElement?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")?.focus()
      }}
      {...props}
    />
  )
}

function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "xs",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size"> & {
  size?: "xs" | "sm" | "icon-xs" | "icon-sm" | null
}) {
  return <Button type={type} size={size} variant={variant} className={cn(className)} {...props} />
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("flex items-center gap-(--space-xs) text-(--neutral-7) [&_svg]:pointer-events-none [&_svg]:size-[1em]", className)} {...props} />
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return <Input data-slot="input-group-control" className={cn("min-w-0 flex-1", className)} {...props} />
}

function InputGroupTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <Textarea data-slot="input-group-control" className={cn("w-full flex-1 resize-none", className)} {...props} />
}

export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupInput, InputGroupTextarea }
