"use client"

import * as React from "react"
import { cn } from "cn"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { graphicalPart, usePartAppearance } from "./graphical"

const ThemedTrigger = graphicalPart(TooltipPrimitive.Trigger, "tooltip", "trigger", "ui-button")
const ThemedContent = graphicalPart(TooltipPrimitive.Content, "tooltip", "popover", "ui-tooltip ki-popup")

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const Trigger = props.asChild ? TooltipPrimitive.Trigger : ThemedTrigger
  return <Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const popup = usePartAppearance("tooltip", "popover")
  return (
    <TooltipPrimitive.Portal>
      <ThemedContent
        data-slot="tooltip-content"
        sideOffset={sideOffset ?? popup?.gap}
        className={cn(
          "z-50 inline-flex w-fit items-center gap-(--space-xs)",
          className
        )}
        {...props}
      >
        {children}
      </ThemedContent>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
