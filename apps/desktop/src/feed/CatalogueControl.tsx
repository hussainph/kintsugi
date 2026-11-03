import { useState } from "react";
import { Button, Switch } from "@kintsugi/ui/graphical";
import { toast } from "sonner";
import { feed, type Source } from "./api";
import { catalogueStatus, sourceName } from "./model";

/** Discovery is independent of refresh; disabling it leaves new posts alone. */
export function CatalogueControl({ source, onChanged }: { source: Source; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  if (source.kind !== "feed" && source.kind !== "page") return null;
  const name = sourceName(source);
  const fetching = source.catalogueState === "discovering" || source.catalogueState === "queued";
  const update = async (enabled?: boolean, retry = false) => {
    setBusy(true);
    try {
      await feed.catalogue(source.id, enabled, retry);
      onChanged();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-(--space-s) ml-8 space-y-(--space-xxs)" data-catalogue={source.id}>
      <div className="flex items-center justify-between gap-(--space-xs)">
        <Switch.Row>
          <Switch.Root checked={source.catalogueEnabled} disabled={busy} aria-label={`Older writing from ${name}`} onCheckedChange={(enabled) => void update(enabled)} />
          <Switch.Label>Older writing</Switch.Label>
        </Switch.Row>
        <Button variant="ghost" disabled={busy || fetching || !source.catalogueEnabled || source.muted} aria-label={`Find older writing from ${name}`} onClick={() => void update(undefined, true)}>
          Find again
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">{catalogueStatus(source)}</p>
    </div>
  );
}
