import { cn } from "@kintsugi/ui/lib/utils";

/**
 * Kin's placeholder avatar: a plain bowl with one gold seam. KI-23 and KI-41
 * design the real one (and let the owner customize it); swap it here.
 */
export function KinAvatar({ className, talking = false }: { className?: string; talking?: boolean }) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden className={cn("size-10", className)} data-kin-avatar="placeholder">
      <circle cx="20" cy="20" r="19" className="fill-foreground" />
      <path
        d="M11 9 L17 17 L14 22 L21 27 L19 33"
        fill="none"
        stroke="#d4a53c"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn(talking && "motion-safe:animate-pulse")}
      />
      <circle cx="26" cy="16" r="1.8" className="fill-background" />
    </svg>
  );
}
