import { graphicalPart } from "@kintsugi/ui/components/graphical";
import { Kbd } from "@kintsugi/ui/components/kbd";
import { cn } from "@kintsugi/ui/lib/utils";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { holdCommand } from "@/lib/holdCommand";
import { keysOf } from "@/lib/keys";
import { rowsOf, sections, SHORTCUTS, type Group, type Row, type ShortcutId } from "@/lib/shortcuts";

/** A shortcut as a key chip: in tooltips, menus and the held-⌘ list. */
export function Shortcut({ id, className }: { id: ShortcutId; className?: string }) {
  return <Kbd className={className}>{keysOf(SHORTCUTS[id].key)}</Kbd>;
}

/** A chip beside a control that only shows while ⌘ is held. `inline` sits
 *  in the row (at its end); the others float off the control, which must be
 *  positioned, so nothing moves when they appear. */
export function ShortcutHint({ id, keys, side = "inline", className }: {
  id?: ShortcutId;
  /** For a key that isn't an app shortcut, like a panel's own ⌘↩. */
  keys?: string;
  side?: "inline" | "above" | "below" | "end";
  className?: string;
}) {
  const text = keys ?? (id ? keysOf(SHORTCUTS[id].key) : "");
  return (
    <Kbd aria-hidden className={cn("ki-shortcut-hint", className)} data-side={side}>
      {text}
    </Kbd>
  );
}

/** The groups the held-⌘ list shows on each screen. */
const SCREENS: Record<"app" | "writing", Group[]> = {
  app: ["app"],
  writing: ["app", "document", "kin", "formatting", "alternatives"],
};

const Panel = graphicalPart("div", "popover", "popover", "ki-shortcuts");

/** Hold ⌘ to see what can be pressed here: the chips beside their controls
 *  (CSS, from the root's `data-shortcuts`) and this list. */
export function ShortcutsOverlay({ screen }: { screen: "app" | "writing" | "settings" }) {
  const [shown, setShown] = useState(false);
  useEffect(() => holdCommand(window, setShown), []);
  useEffect(() => {
    const root = document.documentElement;
    if (shown) root.dataset.shortcuts = "shown";
    else delete root.dataset.shortcuts;
  }, [shown]);
  if (!shown) return null;

  const groups: { title: string; rows: Row[] }[] =
    screen === "settings"
      ? [{ title: "Settings", rows: rowsOf([SHORTCUTS.back, SHORTCUTS.backAlt, SHORTCUTS.kin]) }]
      : sections(SCREENS[screen]);

  return createPortal(
    <Panel role="dialog" aria-label="Keyboard shortcuts" className="ki-shortcuts-panel" data-columns={groups.length}>
      {groups.map((group) => (
        <section key={group.title} className="ki-shortcuts-group">
          <h2 className="ki-shortcuts-heading">{group.title}</h2>
          <dl>
            {group.rows.map((row) => <ShortcutRow key={row.label} row={row} />)}
          </dl>
        </section>
      ))}
    </Panel>,
    document.body,
  );
}

/** A name and its key chips, in a `<dl>`. */
export function ShortcutRow({ row }: { row: Row }) {
  return (
    <div className="ki-shortcuts-row">
      <dt>{row.label}</dt>
      <dd>{row.keys.map((keys) => <Kbd key={keys}>{keys}</Kbd>)}</dd>
    </div>
  );
}
