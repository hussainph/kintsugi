import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"
import { useButtonVariables } from "./graphical"

const buttonVariants = cva(
  "ui-part ui-button ki-button group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap select-none disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "",
        outline: "",
        secondary: "",
        ghost: "",
        destructive: "",
        link: "ki-button-link",
      },
      size: {
        default: "",
        xs: "ki-button-xs",
        sm: "ki-button-sm",
        lg: "ki-button-lg",
        icon: "ki-button-icon",
        "icon-xs": "ki-button-icon ki-button-xs",
        "icon-sm": "ki-button-icon ki-button-sm",
        "icon-lg": "ki-button-icon ki-button-lg",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  style,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & {
  asChild?: boolean
}) {
  const appearance = useButtonVariables(
    variant === "default" ? "primary" : variant === "destructive" ? "danger" : variant === "link" ? "ghost" : variant ?? "primary",
  )
  const Comp = asChild ? Slot.Root : "button"
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      style={{ ...appearance, ...style }}
      {...props}
    />
  )
}

export { Button, buttonVariants }
