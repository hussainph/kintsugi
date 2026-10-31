import * as React from "react"
import { cn } from "cn"
import { Separator as SeparatorPrimitive } from "radix-ui"

import { graphicalPart } from "./graphical"

const ThemedRoot = graphicalPart(SeparatorPrimitive.Root, "separator", "separator", "ui-separator")

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <ThemedRoot
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
