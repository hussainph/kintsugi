import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@kintsugi/ui/components/dialog";
import { Input } from "@kintsugi/ui/components/input";
import { ShortcutRow } from "@/components/Shortcuts";
import { filterSections, sections } from "@/lib/shortcuts";

/** Every shortcut, grouped as in README, filtered as he types (⇧⌘/, or the
 *  keyboard button under a document). */
export function Cheatsheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const all = useMemo(() => sections(), []);
  const shown = filterSections(all, query);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { onClose(); setQuery(""); } }}>
      <DialogContent showCloseButton={false} className="ki-cheatsheet" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Keyboard shortcuts</DialogTitle>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search shortcuts"
          aria-label="Search shortcuts"
          autoFocus
          className="ki-cheatsheet-search"
        />
        <div className="ki-cheatsheet-groups">
          {shown.length === 0 && <p className="ki-text-s ki-muted">No shortcuts match.</p>}
          {shown.map((section) => (
            <section key={section.group} className="ki-shortcuts-group ki-cheatsheet-group" aria-label={section.title}>
              <h2 className="ki-shortcuts-heading">{section.title}</h2>
              <dl>
                {section.rows.map((row) => <ShortcutRow key={row.label} row={row} />)}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
