import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"
import { useButtonVariables } from "./graphical"

const badgeVariants = cva(
  "ui-part ki-badge group/badge inline-flex w-fit shrink-0 items-center justify-center overflow-hidden whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-[1em]",
  {
    variants: {
      variant: {
        default: "", secondary: "", destructive: "", outline: "", ghost: "", link: "ki-button-link",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  style,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const appearance = useButtonVariables(
    variant === "default" ? "primary" : variant === "destructive" ? "danger" : variant === "link" ? "ghost" : variant ?? "primary",
  )
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      style={{ ...appearance, ...style }}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
