import { useState } from "react";
import { toast } from "sonner";
import { DESTINATIONS } from "@kintsugi/core/export";
import { Popover, PopoverContent, PopoverTrigger } from "@kintsugi/ui/components/popover";
import { exporting, openExport, type ExportSettings } from "@/lib/exporting";
import "./export.css";

/** The footer's Export… menu: the destinations chosen in Settings → Export.
 *  A mirror of a blog post can be exported, but not published again. */
export function ExportMenu({ mirror }: { mirror: boolean }) {
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [open, setOpen] = useState(false);
  const shown = DESTINATIONS.filter((d) => settings?.destinations.includes(d.id) && !(mirror && d.delivery.kind === "publish"));
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) exporting.settings().then(setSettings, (e) => toast.error(String(e))); }}>
      <PopoverTrigger asChild>
        <button className="hover:text-foreground" title="Export (⌥⌘E)">Export…</button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64 p-1.5" aria-label="Export to">
        <div className="export-menu" role="menu">
          {settings && shown.length === 0 && <p className="p-2 text-xs text-muted-foreground">No destinations are on. Choose them in Settings → Export.</p>}
          {shown.map((d) => (
            <button key={d.id} role="menuitem" onClick={() => { setOpen(false); openExport(d.id); }}>
              {d.label}
              <span>{d.hint}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
