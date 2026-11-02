import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { COMPANIONS, megabytes, tools, ToolStatus } from "@/lib/tools";
import { Group, Row } from "./parts";

/** Settings › General › Optional tools: heavy helpers downloaded only after
 *  the writer agrees, by pressing the button. */
export function OptionalTools() {
  const [list, setList] = useState<ToolStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    tools.list().then(setList).catch((e) => toast.error(String(e)));
  }, []);

  useEffect(load, [load]);

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
    <Group title="Optional tools" data-testid="optional-tools">
      {shown.map((tool) => {
        const all = [tool, ...companions(tool.id)];
        const size = all.reduce((sum, t) => sum + t.approxBytes, 0);
        const ready = tool.kind === "system" ? tool.consented : tool.installed != null;
        const state = !tool.supported
          ? "Not available on this Mac"
          : ready
            ? tool.installed
              ? `${tool.name} ${tool.installed.version}`
              : "Allowed"
            : null;
        // What will be downloaded, from where, under which license: facts the button can't show.
        const source =
          tool.kind === "system"
            ? `${tool.name}, downloaded by macOS when first needed`
            : `${all.map((t) => `${t.name} (${t.license})`).join(" and ")} · ${new URL(tool.homepage).host} · ${megabytes(size)}`;
        return (
          <Row key={tool.id} label={tool.purpose} note={state ? `${state} · ${source}` : source} data-tool={tool.id}>
            {tool.supported && (
              <div className="ki-settings-inline">
                {!ready && (
                  <Button size="sm" variant="outline" disabled={busy != null} onClick={() => run(tool.id, tools.install, `${tool.purpose}: ready.`)}>
                    {busy === tool.id ? "Downloading…" : tool.kind === "system" ? "Allow" : "Download"}
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
          </Row>
        );
      })}
    </Group>
  );
}
