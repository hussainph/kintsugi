import * as React from "react"
import { cn } from "cn"
import { graphicalPart } from "./graphical"

// No separate Textarea specimen is supplied: use the Text field control parts,
// keeping native multiline editing, form values and content sizing.
const TextareaControl = graphicalPart("textarea", "input", "control", "ui-input")

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <TextareaControl
      data-slot="textarea"
      data-invalid={props["aria-invalid"] === true || props["aria-invalid"] === "true" ? "" : undefined}
      data-readonly={props.readOnly ? "" : undefined}
      className={cn("flex field-sizing-content min-h-16 w-full disabled:cursor-not-allowed", className)}
      {...props}
    />
  )
}

export { Textarea }
