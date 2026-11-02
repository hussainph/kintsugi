import type { ReactNode } from "react";
import { cn } from "@kintsugi/ui/lib/utils";

/** A section's page: its title, then groups of rows. */
export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ki-settings-page ki-stack-xl">
      <h1 className="ki-title">{title}</h1>
      {children}
    </div>
  );
}

/** Rows that belong together, under an optional sentence-case heading. */
export function Group({ title, children, className, ...props }: { title?: string; children: ReactNode; className?: string } & Omit<React.ComponentProps<"section">, "title">) {
  return (
    <section className={cn("ki-stack-xs", className)} {...props}>
      {title && <h2 className="ki-settings-heading">{title}</h2>}
      <div className="ki-settings-group">{children}</div>
    </section>
  );
}

/**
 * One setting: its name on the left, the control on the right. `note` is a
 * single short line for a fact the control can't show (a cost, a limit,
 * what leaves the Mac).
 */
export function Row({ label, note, children, htmlFor, className, ...props }: { label: ReactNode; note?: ReactNode; children?: ReactNode; htmlFor?: string; className?: string } & Omit<React.ComponentProps<"div">, "children">) {
  const Label = htmlFor ? "label" : "span";
  return (
    <div className={cn("ki-settings-row", className)} {...props}>
      <div className="ki-settings-label">
        <Label htmlFor={htmlFor} className="ki-text-s">{label}</Label>
        {note && <span className="ki-settings-note">{note}</span>}
      </div>
      {children !== undefined && <div className="ki-settings-control">{children}</div>}
    </div>
  );
}
