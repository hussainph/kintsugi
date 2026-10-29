import { useEffect, useState } from "react";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
const roles = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "sidebar",
  "sidebar-foreground",
  "sidebar-accent",
  "sidebar-border",
  "editor-faint",
  "editor-selection",
];
export function ColorPreview({
  selected,
  theme,
}: {
  selected: string;
  theme: string;
}) {
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [message, setMessage] = useState(
    "Keep the thought. Let the interface recede.",
  );
  useEffect(() => {
    // Preview applies the scenario on its root effect; read after that commit.
    const frame = requestAnimationFrame(() => {
      const styles = getComputedStyle(document.documentElement);
      setResolved(
        Object.fromEntries(
          roles.map((role) => [
            role,
            styles.getPropertyValue(`--${role}`).trim(),
          ]),
        ),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [theme]);
  return (
    <div className="mx-auto max-w-5xl space-y-10 p-8">
      <header>
        <p className="text-xs text-muted-foreground">
          Live CSS custom properties · {theme}
        </p>
        <h1 className="mt-2 text-2xl font-medium">One quiet palette.</h1>
        <p className="mt-3 max-w-lg text-sm text-muted-foreground">
          These are the product’s declared roles, read from the active theme. No
          Lab-only palette or guessed semantic tokens.
        </p>
      </header>
      <section
        className="space-y-4 rounded-xl border bg-card p-6 text-card-foreground"
        aria-label="Theme in use"
      >
        <h2 className="font-medium">A thought worth keeping</h2>
        <Input
          aria-label="Thought title"
          placeholder="Give the thought a title…"
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setMessage("Kept in this preview.")}>
            Keep something
          </Button>
          <Button
            variant="outline"
            onClick={() => setMessage("A quieter alternative.")}
          >
            Keep writing
          </Button>
          <Button
            variant="destructive"
            onClick={() =>
              setMessage("Destructive emphasis, without a real deletion.")
            }
          >
            Move to Trash
          </Button>
        </div>
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      </section>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {roles.map((role) => (
          <article
            key={role}
            className={`overflow-hidden rounded-lg border ${role === selected ? "ring-2 ring-ring ring-offset-2" : ""}`}
          >
            <div
              className="h-16 border-b"
              style={{ background: `var(--${role})` }}
            />
            <div className="space-y-1 p-3">
              <code className="text-xs">--{role}</code>
              <p className="break-words font-mono text-[10px] text-muted-foreground">
                {resolved[role] || "Theme-derived value"}
              </p>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
