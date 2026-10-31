"use client"

import * as React from "react"
import { Command as CommandPrimitive, defaultFilter as commandFilter } from "cmdk"
import { cn } from "cn"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@kintsugi/ui/components/dialog"
import {
  InputGroup,
  InputGroupAddon,
} from "@kintsugi/ui/components/input-group"
import { SearchIcon, CheckIcon } from "@kintsugi/ui/icons"

import { graphicalPart } from "./graphical"

// cmdk owns filtering, active descendant and selection. Reuse the bundled
// Combobox appearances instead of migrating its incompatible value API.
const Root = graphicalPart(CommandPrimitive, "combobox", "popover", "ki-command")
const SearchInput = graphicalPart(CommandPrimitive.Input, "input", "control", "ui-input")
const Item = graphicalPart(CommandPrimitive.Item, "combobox", "option", "ui-option")
const Divider = graphicalPart(CommandPrimitive.Separator, "separator", "separator", "ui-separator")

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <Root
      data-slot="command"
      className={cn(
        "flex size-full flex-col overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title = "Command palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn(
          "top-1/3 translate-y-0 overflow-hidden p-0",
          className
        )}
        showCloseButton={showCloseButton}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="p-(--space-xxs) pb-0">
      <InputGroup >
        <SearchInput
          data-slot="command-input"
          className={cn(
            "w-full min-w-0 bg-transparent outline-none disabled:cursor-not-allowed",
            className
          )}
          {...props}
        />
        <InputGroupAddon>
          <SearchIcon className="size-[1em] shrink-0 text-(--neutral-6)" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "no-scrollbar max-h-72 scroll-py-(--space-xxs) overflow-x-hidden overflow-y-auto outline-none",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-(--space-l) text-center", className)}
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "ki-command-group overflow-hidden p-(--space-xxs)",
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <Divider
      data-slot="command-separator"
      className={cn("my-(--space-xxs)", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex cursor-default items-center outline-none select-none data-[disabled=true]:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-[1em]",
        className
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </Item>
  )
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ui-menu-shortcut ml-auto",
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
  commandFilter,
}
