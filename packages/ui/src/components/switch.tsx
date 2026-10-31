import * as React from "react"
import { cn } from "cn"
import { Switch as SwitchPrimitive } from "radix-ui"
import { graphicalPart } from "./graphical"

const Track = graphicalPart(SwitchPrimitive.Root, "switch", "control", "ui-choice ki-switch")
const Thumb = graphicalPart(SwitchPrimitive.Thumb, "switch", "thumb", "ki-switch-thumb")

function Switch({
  className,
  size = "default",
  checked,
  defaultChecked = false,
  onCheckedChange,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & { size?: "sm" | "default" }) {
  // Mirror Radix's uncontrolled value only to expose its checked state to the
  // shared Graphical CSS; Radix still owns the input, keyboard and form behavior.
  const [uncontrolledChecked, setUncontrolledChecked] = React.useState(defaultChecked)
  const isChecked = checked ?? uncontrolledChecked
  return (
    <Track
      data-slot="switch"
      data-size={size}
      data-checked={isChecked ? "" : undefined}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={(value) => {
        setUncontrolledChecked(value)
        onCheckedChange?.(value)
      }}
      className={cn("peer group/switch", className)}
      {...props}
    >
      <Thumb data-slot="switch-thumb" data-checked={isChecked ? "" : undefined} />
    </Track>
  )
}

export { Switch }
