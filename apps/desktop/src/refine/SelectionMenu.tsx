import type { EditorView } from "@codemirror/view";
import { Fragment, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { formatShortcuts, isDimmed, openAlternatives, toggleDimRange } from "@kintsugi/editor/Editor";
import { Menu } from "@kintsugi/ui/graphical";
import { stashSelection } from "@kintsugi/editor/stash";
import { discuss } from "@/lib/chat";
import { ariaKeys, keysOf, matches } from "@/lib/keys";
import { SHORTCUTS, type ShortcutId } from "@/lib/shortcuts";
import { passageChips } from "@/kin/screen";
import { editKey, fits } from "./direct";
import { ACTIONS, type Action } from "./prompts";

type Props = {
  viewRef: RefObject<EditorView | null>;
  /** The open document, for Kin's chips. */
  path: string;
  /** Opens ⌘K on the range, running `action` straight away when given. */
  onRefine: (from: number, to: number, action?: Action) => void;
};

/** ⌘/, from the editor's keymap. */
const DIM = formatShortcuts.find((s) => s.label === "Dim")!.key;

type Place = { x: number; y: number; from: number; to: number; keyboard?: boolean };
type Row = { id: string; label: string; keys?: string; spec?: string; run: () => void };

/** Right-click on a selection, or ⇧F10 (the context-menu key too): what can
 *  be done with it, each row with its key, which is how the keys are learnt.
 *  Anywhere else the Mac's own menu shows, with its spelling suggestions.
 *  Stash (KI-89) adds its row here. */
export function SelectionMenu({ viewRef, path, onRefine }: Props) {
  const [at, setAt] = useState<Place | null>(null);
  // An item that moves focus itself (⌘K, Kin's chat) keeps it.
  const chosen = useRef(false);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const open = (place: Place) => {
      chosen.current = false;
      setAt(place);
    };
    const onContextMenu = (e: MouseEvent) => {
      const { from, to, empty } = view.state.selection.main;
      if (empty) return;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
      if (pos < from || pos > to) return;
      e.preventDefault();
      open({ x: e.clientX, y: e.clientY, from, to });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.key === "ContextMenu" || matches(e, SHORTCUTS.selectionMenu.key))) return;
      const { from, to, empty, head } = view.state.selection.main;
      if (empty) return;
      e.preventDefault();
      e.stopPropagation();
      const coords = view.coordsAtPos(head, head === from ? 1 : -1) ?? view.coordsAtPos(to);
      if (coords) open({ x: coords.left, y: coords.bottom, from, to, keyboard: true });
    };
    view.contentDOM.addEventListener("contextmenu", onContextMenu);
    view.contentDOM.addEventListener("keydown", onKeyDown, true);
    return () => {
      view.contentDOM.removeEventListener("contextmenu", onContextMenu);
      view.contentDOM.removeEventListener("keydown", onKeyDown, true);
    };
  }, [viewRef]);

  // Opened from the keyboard: the first row has focus, so ↩ runs it and
  // ↓ goes on from there, as in a Mac menu opened with keys.
  useEffect(() => {
    if (!at?.keyboard) return;
    let frame = 0;
    let tries = 0;
    const focusFirst = () => {
      const first = document.querySelector<HTMLElement>(".ki-selection-menu [role=menuitem]");
      if (first) first.focus();
      else if (tries++ < 30) frame = requestAnimationFrame(focusFirst);
    };
    frame = requestAnimationFrame(focusFirst);
    return () => cancelAnimationFrame(frame);
  }, [at]);

  const anchor = useMemo(
    () => at && { getBoundingClientRect: () => DOMRect.fromRect({ x: at.x, y: at.y, width: 0, height: 0 }) },
    [at],
  );

  const view = viewRef.current;
  if (!at || !view) return null;
  const { from, to } = at;
  const passage = view.state.sliceDoc(from, to);
  const locked = view.state.readOnly;
  const key = (id: ShortcutId) => ({ keys: keysOf(SHORTCUTS[id].key), spec: SHORTCUTS[id].key });
  const leave = (run: () => void) => () => {
    chosen.current = true;
    run();
  };
  // Cut and copy go through the editor, so the clipboard gets what ⌘C gives.
  const clip = (command: "cut" | "copy") => () => {
    view.focus();
    if (!document.execCommand(command)) toast.error(`Couldn’t ${command} the selection. Try ${keysOf(SHORTCUTS[command].key)}.`);
  };

  const groups: Row[][] = [
    locked
      ? []
      : ACTIONS.filter((a) => fits(a, passage, false) === null).map((a) => ({
          id: a.id,
          label: a.label,
          keys: editKey(a.id),
          spec: SHORTCUTS[a.id as ShortcutId]?.key,
          run: leave(() => onRefine(from, to, a)),
        })),
    // Writes the passage's comment markers; no model involved (KI-88).
    locked ? [] : [{ id: "dim", label: isDimmed(view.state, from, to) ? "Undim" : "Dim", keys: keysOf(DIM), spec: DIM, run: () => { toggleDimRange(view, from, to); view.focus(); } }],
    // Other versions of the selection, swapped in place (KI-86). The panel takes focus.
    locked ? [] : [{ id: "alternatives", label: "Versions…", ...key("alternatives"), run: leave(() => { view.dispatch({ selection: { anchor: from, head: to } }); openAlternatives(view); }) }],
    locked ? [] : [{ id: "stash", label: "Stash", ...key("stash"), run: leave(() => { view.dispatch({ selection: { anchor: from, head: to } }); stashSelection(view); }) }],
    [
      { id: "refine", label: "Edit with Kin…", ...key("refine"), run: leave(() => onRefine(from, to)) },
      { id: "ask", label: "Ask Kin", ...key("kin"), run: leave(() => discuss(passageChips(view, path, from, to))) },
    ],
    [
      ...(locked ? [] : [{ id: "cut", label: "Cut", ...key("cut"), run: clip("cut") }]),
      { id: "copy", label: "Copy", ...key("copy"), run: clip("copy") },
    ],
  ].filter((rows) => rows.length > 0);

  return (
    <Menu.Root open onOpenChange={(open) => { if (!open) setAt(null); }}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" sideOffset={4} collisionPadding={8}>
          <Menu.Popup
            className="ki-selection-menu"
            aria-label="Selection"
            finalFocus={() => (chosen.current ? false : view.contentDOM)}
          >
            {groups.map((rows, i) => (
              <Fragment key={rows[0].id}>
                {i > 0 && <Menu.Separator />}
                {rows.map((row) => (
                  <Menu.Item key={row.id} onClick={row.run} aria-keyshortcuts={row.spec && ariaKeys(row.spec)} data-action={row.id}>
                    <Menu.ItemContent shortcut={row.keys}>{row.label}</Menu.ItemContent>
                  </Menu.Item>
                ))}
              </Fragment>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
