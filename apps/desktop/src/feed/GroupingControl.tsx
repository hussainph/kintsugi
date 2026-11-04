import { useState } from "react";
import { Switch } from "@kintsugi/ui/graphical";
import { toast } from "sonner";
import { feed, type Source } from "./api";
import { groupable, sourceName } from "./model";

/** "Group with other coverage" (KI-105): on, a source's news can join stories Kin summarises; off, its posts always stand alone. */
export function GroupingControl({ source, onChanged }: { source: Source; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!groupable(source.kind)) return null;
  const change = async (enabled: boolean) => {
    setBusy(true);
    try {
      await feed.grouping(source.id, enabled);
      onChanged();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-(--space-s) ml-8" data-grouping={source.id}>
      <Switch.Row>
        <Switch.Root checked={source.grouping} disabled={busy} aria-label={`Group ${sourceName(source)} with other coverage`} onCheckedChange={(enabled) => void change(enabled)} />
        <Switch.Label>Group with other coverage</Switch.Label>
      </Switch.Row>
    </div>
  );
}
