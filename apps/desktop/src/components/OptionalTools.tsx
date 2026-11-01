import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { COMPANIONS, megabytes, tools, ToolStatus } from "@/lib/tools";

/** Settings › Optional tools: heavy helpers downloaded only after the
 *  writer agrees, by pressing the button that says what will happen. */
export function OptionalTools({ open }: { open: boolean }) {
  const [list, setList] = useState<ToolStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    tools.list().then(setList).catch((e) => toast.error(String(e)));
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const run = async (id: string, action: (id: string) => Promise<ToolStatus[]>, done: string) => {
    setBusy(id);
    try {
      setList(await action(id));
      toast(done);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const shown = (list ?? []).filter((t) => !COMPANIONS[t.id]);
  const companions = (id: string) => (list ?? []).filter((t) => COMPANIONS[t.id] === id);

  return (
    <section className="space-y-3 text-sm" data-testid="optional-tools">
      <h3 className="font-medium">Optional tools</h3>
      <p className="text-xs text-muted-foreground">
        Downloaded only when you ask, checked against the publisher's SHA-256, kept in Kintsugi's app data and updated
        automatically. Nothing is bundled.
      </p>
      {shown.map((tool) => {
        const extra = companions(tool.id);
        const size = [tool, ...extra].reduce((sum, t) => sum + t.approxBytes, 0);
        const ready = tool.kind === "system" ? tool.consented : tool.installed != null;
        const label =
          tool.kind === "system"
            ? "Allow macOS to download it"
            : `Download ${[tool, ...extra].map((t) => t.name).join(" + ")} (about ${megabytes(size)})`;
        return (
          <div key={tool.id} className="space-y-1 rounded-md border p-3" data-tool={tool.id}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{tool.purpose}</span>
              <span className="text-xs text-muted-foreground">
                {!tool.supported
                  ? "Not available on this Mac"
                  : ready
                    ? tool.installed
                      ? `${tool.name} ${tool.installed.version}`
                      : "Allowed"
                    : "Not installed"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {tool.kind === "system"
                ? `${tool.name}, downloaded and updated by macOS the first time a podcast needs transcribing.`
                : `${[tool, ...extra].map((t) => `${t.name} (${t.license})`).join(" and ")}, from ${new URL(tool.homepage).host}.`}
            </p>
            {tool.supported && (
              <div className="flex gap-2 pt-1">
                {!ready && (
                  <Button size="sm" variant="outline" disabled={busy != null} onClick={() => run(tool.id, tools.install, `${tool.purpose}: ready.`)}>
                    {busy === tool.id ? "Downloading…" : label}
                  </Button>
                )}
                {ready && tool.kind === "download" && (
                  <Button size="sm" variant="ghost" disabled={busy != null} onClick={() => run(tool.id, tools.update, `${tool.name} is up to date.`)}>
                    {busy === tool.id ? "Checking…" : "Check for updates"}
                  </Button>
                )}
                {(ready || tool.consented) && (
                  <Button size="sm" variant="ghost" disabled={busy != null} onClick={() => run(tool.id, tools.remove, `${tool.name} removed.`)}>
                    Remove
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
