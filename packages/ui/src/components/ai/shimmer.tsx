import * as React from "react"
import { cn } from "cn"

/**
 * Text with a light passing over it, after AI Elements' Shimmer: something
 * is under way and has nothing to show yet. Still text under reduced motion.
 */
export function Shimmer({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="shimmer" className={cn("ki-shimmer", className)} {...props} />
}
