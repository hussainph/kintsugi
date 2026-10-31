import * as React from "react"
import { cn } from "cn"
import { Popover as PopoverPrimitive } from "radix-ui"

import { graphicalPart, usePartAppearance } from "./graphical"

const ThemedTrigger = graphicalPart(PopoverPrimitive.Trigger, "popover", "trigger", "ui-button")
const ThemedTitle = graphicalPart("h2", "popover", "title", "ui-title")
const ThemedDescription = graphicalPart("p", "popover", "description", "ui-copy")
const ThemedContent = graphicalPart(PopoverPrimitive.Content, "popover", "popover", "ki-popover ki-popup")

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const Trigger = props.asChild ? PopoverPrimitive.Trigger : ThemedTrigger
  return <Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const popup = usePartAppearance("popover", "popover")
  return (
    <PopoverPrimitive.Portal>
      <ThemedContent
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset ?? popup?.gap}
        className={cn(
          "z-50 flex w-[300px] flex-col outline-none",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-(--space-xs)", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <ThemedTitle
      data-slot="popover-title"
      className={cn(className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <ThemedDescription
      data-slot="popover-description"
      className={cn(className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}
