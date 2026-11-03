"use client"

import * as React from "react"
import { cn } from "cn"
import { ContextMenu as ContextMenuPrimitive } from "radix-ui"
import { ChevronRightIcon, CheckIcon } from "@kintsugi/ui/icons"

import { graphicalPart } from "./graphical"

const ThemedContent = graphicalPart(ContextMenuPrimitive.Content, "context-menu", "popover", "ui-menu ui-menu-detailed ki-popup")
const ThemedSubContent = graphicalPart(ContextMenuPrimitive.SubContent, "context-menu", "popover", "ui-menu ui-menu-detailed ui-menu-submenu ki-popup")
const ThemedItem = graphicalPart(ContextMenuPrimitive.Item, "context-menu", "option", "ui-option")
const ThemedSubTrigger = graphicalPart(ContextMenuPrimitive.SubTrigger, "context-menu", "option", "ui-option")
const ThemedCheckboxItem = graphicalPart(ContextMenuPrimitive.CheckboxItem, "context-menu", "option", "ui-option")
const ThemedRadioItem = graphicalPart(ContextMenuPrimitive.RadioItem, "context-menu", "option", "ui-option")
const ThemedLabel = graphicalPart(ContextMenuPrimitive.Label, "context-menu", "label", "ui-menu-group-label")
const ThemedSeparator = graphicalPart(ContextMenuPrimitive.Separator, "context-menu", "separator", "ui-separator")
const ThemedItemIndicator = graphicalPart(ContextMenuPrimitive.ItemIndicator, "context-menu", "indicator", "ui-mark")

function ContextMenu({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      className={cn("select-none", className)}
      {...props}
    />
  )
}

function ContextMenuGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return (
    <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
  )
}

function ContextMenuPortal({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  return (
    <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
  )
}

function ContextMenuSub({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return (
    <ContextMenuPrimitive.RadioGroup
      data-slot="context-menu-radio-group"
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left"
}) {
  return (
    <ContextMenuPrimitive.Portal>
      <ThemedContent
        data-slot="context-menu-content"
        className={cn("z-50 outline-none", className )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <ThemedItem
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      data-destructive={variant === "destructive" ? "" : undefined}
      className={cn(
        "group/context-menu-item relative flex cursor-default items-center outline-none select-none data-inset:pl-(--space-xl) data-disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <ThemedSubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center outline-none select-none data-inset:pl-(--space-xl) [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </ThemedSubTrigger>
  )
}

function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ThemedSubContent
      data-slot="context-menu-sub-content"
      className={cn("z-50 outline-none", className )}
      {...props}
    />
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem> & {
  inset?: boolean
}) {
  return (
    <ThemedCheckboxItem
      data-slot="context-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center pr-(--space-xl)! outline-none select-none data-inset:pl-(--space-xl) data-disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute right-(--space-xs)">
        <ThemedItemIndicator>
          <CheckIcon
          />
        </ThemedItemIndicator>
      </span>
      {children}
    </ThemedCheckboxItem>
  )
}

function ContextMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem> & {
  inset?: boolean
}) {
  return (
    <ThemedRadioItem
      data-slot="context-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center pr-(--space-xl)! outline-none select-none data-inset:pl-(--space-xl) data-disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-(--space-xs)">
        <ThemedItemIndicator>
          <CheckIcon
          />
        </ThemedItemIndicator>
      </span>
      {children}
    </ThemedRadioItem>
  )
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <ThemedLabel
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(
        "data-inset:pl-(--space-xl)",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ThemedSeparator
      data-slot="context-menu-separator"
      className={cn("my-(--space-xxs)", className)}
      {...props}
    />
  )
}

/** A key chip, the same as `Kbd` (see `.ui-menu-shortcut`). */
function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="context-menu-shortcut"
      className={cn(
        "ui-menu-shortcut ml-auto",
        className
      )}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
}
