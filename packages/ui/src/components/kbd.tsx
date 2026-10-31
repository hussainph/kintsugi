import { cn } from "cn"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "ki-kbd pointer-events-none inline-flex w-fit items-center justify-center select-none [&_svg]:size-[1em]",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-(--space-xxs)", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
