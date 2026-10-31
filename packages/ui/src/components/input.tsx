import * as React from "react"
import { cn } from "cn"
import { graphicalPart } from "./graphical"

// A native control preserves the existing onChange/event/ref contract. The
// Graphical Base UI Input has a different onValueChange contract.
const InputControl = graphicalPart("input", "input", "control", "ui-input")

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputControl
      type={type}
      data-slot="input"
      data-invalid={props["aria-invalid"] === true || props["aria-invalid"] === "true" ? "" : undefined}
      data-readonly={props.readOnly ? "" : undefined}
      className={cn("w-full min-w-0 disabled:cursor-not-allowed file:border-0 file:bg-transparent file:font-[inherit] placeholder:text-(--neutral-6)", className)}
      {...props}
    />
  )
}

export { Input }
