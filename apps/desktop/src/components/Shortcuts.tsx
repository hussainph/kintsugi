import { formatShortcuts } from "@kintsugi/editor/Editor";
import { graphicalPart } from "@kintsugi/ui/components/graphical";
import { Kbd } from "@kintsugi/ui/components/kbd";
import { cn } from "@kintsugi/ui/lib/utils";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { holdCommand } from "@/lib/holdCommand";
import { keysOf } from "@/lib/keys";
import { SHORTCUTS, type ShortcutId, type Where } from "@/lib/shortcuts";

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

type Row = { label: string; keys: string[] };

function rows(where: Where): Row[] {
  return Object.values(SHORTCUTS)
    .filter((s): s is typeof s & { where: Where } => "where" in s && s.where === where)
    .map((s) => ({ label: s.label, keys: [keysOf(s.key)] }));
}

/** The editor's keys, with runs of one label ("Heading" ⌥⌘1 … ⌥⌘6) as one row. */
function formatRows(): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < formatShortcuts.length;) {
    const { label, key } = formatShortcuts[i];
    let j = i;
    while (j + 1 < formatShortcuts.length && formatShortcuts[j + 1].label === label) j++;
    const first = keysOf(key);
    out.push({ label, keys: [j > i ? `${first}–${keysOf(formatShortcuts[j].key).slice(-1)}` : first] });
    i = j + 1;
  }
  return out;
}

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
      ? [{ title: "Settings", rows: [
          { label: SHORTCUTS.back.label, keys: [keysOf(SHORTCUTS.back.key), keysOf(SHORTCUTS.backAlt.key)] },
          { label: SHORTCUTS.kin.label, keys: [keysOf(SHORTCUTS.kin.key)] },
        ] }]
      : [
          { title: "App", rows: rows("anywhere") },
          ...(screen === "writing"
            ? [
                { title: "Document", rows: rows("writing") },
                { title: "Formatting", rows: formatRows() },
              ]
            : []),
        ];

  return createPortal(
    <Panel role="dialog" aria-label="Keyboard shortcuts" className="ki-shortcuts-panel" data-columns={groups.length}>
      {groups.map((group) => (
        <section key={group.title} className="ki-shortcuts-group">
          <h2 className="ki-shortcuts-heading">{group.title}</h2>
          <dl>
            {group.rows.map((row) => (
              <div key={row.label} className="ki-shortcuts-row">
                <dt>{row.label}</dt>
                <dd>{row.keys.map((keys) => <Kbd key={keys}>{keys}</Kbd>)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Panel>,
    document.body,
  );
}
