import { useEffect, useRef, useState, type DragEvent } from "react";
import { draftSelectionMime, stashDropped } from "@kintsugi/editor/stash";
import { Tabs } from "@kintsugi/ui/graphical";
import { PanelRight } from "@kintsugi/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@kintsugi/ui/components/tooltip";
import { ShortcutHint } from "@/components/Shortcuts";
import { KinLauncher } from "@/kin/Chat";
import { KinTab } from "@/kin/KinTab";
import { onDiscuss, onOpenKin, onOpenThread, openKin } from "@/lib/chat";
import { keysOf, matches } from "@/lib/keys";
import { SHORTCUTS, type ShortcutId } from "@/lib/shortcuts";
import { hideMargin, setSlot, showMargin, TABS, tabsFor, toggleMargin, toggleTab, useMargin, useStashPulse, visibleTab, type MarginTab, type MarginWhere } from "./state";
import type { MarginWriting } from "./Stash";
import "./margin.css";

const referencesSlot = (element: HTMLDivElement | null) => setSlot("references", element);
const stashSlot = (element: HTMLDivElement | null) => setSlot("stash", element);
const TAB_KEYS: Record<MarginTab, ShortcutId> = { kin: "kin", references: "referencesTab", stash: "stashTab" };

/**
 * The right margin (KI-103): Kin, References and the Stash in tabs, over the
 * empty gutter right of the draft. The draft's column is placed so the
 * margin fits beside it (`margin.css`), so opening it never moves or
 * re-wraps a line. Away from the editor it holds Kin alone, over the page.
 *
 * Always mounted, panels included, so what's inside keeps listening while
 * the margin is closed. `bottom` keeps it above the document bar.
 */
export function Margin({ where, bottom, writing }: { where: MarginWhere; bottom: number; writing: MarginWriting }) {
  const margin = useMargin();
  const tabs = tabsFor(where);
  const value = margin.tab ?? (tabs.includes(margin.chosen) ? margin.chosen : "kin");
  const aside = useRef<HTMLElement>(null);
  const pulse = useStashPulse();
  // A selection dragged from the draft onto the Stash tab's header (KI-110).
  const [dropOnTab, setDropOnTab] = useState(false);
  const draftDrag = (e: DragEvent) => !!writing && e.dataTransfer.types.includes(draftSelectionMime);

  // Anything that opens Kin opens the margin on it.
  useEffect(() => {
    const show = () => showMargin("kin");
    const offs = [onOpenKin(show), onDiscuss(show), onOpenThread(show)];
    return () => {
      for (const off of offs) off();
    };
  }, []);

  // Closing it with focus inside puts focus back in the draft.
  const refocus = () => {
    if (!visibleTab() && aside.current?.contains(document.activeElement)) writing?.viewRef.current?.focus();
  };
  const close = () => {
    hideMargin();
    refocus();
  };

  // Its keys, in the capture phase so they win over the editor's keymap.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    const run = (action: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      action();
      refocus();
    };
    if (matches(e, SHORTCUTS.kin.key)) return run(() => (margin.showing("kin") ? hideMargin() : openKin()));
    if (matches(e, SHORTCUTS.margin.key)) return run(toggleMargin);
    if (where !== "writing") return;
    if (matches(e, SHORTCUTS.referencesTab.key)) return run(() => toggleTab("references"));
    if (matches(e, SHORTCUTS.stashTab.key)) return run(() => toggleTab("stash"));
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  return (
    <>
      {(where === "writing" || margin.open) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="ki-margin-toggle"
              aria-label="Margin"
              aria-pressed={margin.open}
              onClick={() => (margin.open ? close() : toggleMargin())}
            >
              <PanelRight />
              {pulse?.at === "margin" && <span key={pulse.n} className="ki-margin-pulse" data-testid="margin-pulse" aria-hidden />}
              <ShortcutHint id="margin" side="below" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Margin {keysOf(SHORTCUTS.margin.key)}</TooltipContent>
        </Tooltip>
      )}
      <aside
        ref={aside}
        className="ki-margin"
        aria-label="Margin"
        data-open={margin.open || undefined}
        data-where={where}
        inert={!margin.open}
        style={{ bottom }}
        onKeyDown={(e) => {
          // A menu's Esc (in a portal, outside the margin) closes only the menu.
          if (e.key === "Escape" && !e.defaultPrevented && e.currentTarget.contains(e.target as Node)) {
            e.stopPropagation();
            close();
          }
        }}
      >
        <Tabs.Root value={value} onValueChange={(next) => showMargin(next as MarginTab)} className="ki-margin-tabs">
          <div className="ki-margin-head" data-tauri-drag-region>
            <Tabs.List aria-label="Margin tabs" className="ki-margin-list">
              {TABS.filter((t) => tabs.includes(t.tab)).map(({ tab, label }) => (
                <Tabs.Tab
                  key={tab}
                  value={tab}
                  className="ki-margin-tab"
                  data-tab={tab}
                  data-drop={tab === "stash" && dropOnTab ? "" : undefined}
                  {...(tab === "stash" && {
                    onDragOver: (e: DragEvent) => {
                      if (!draftDrag(e)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDropOnTab(true);
                    },
                    onDragLeave: () => setDropOnTab(false),
                    onDrop: (e: DragEvent) => {
                      setDropOnTab(false);
                      const view = writing?.viewRef.current;
                      if (!draftDrag(e) || !view) return;
                      e.preventDefault();
                      stashDropped(view, e.dataTransfer.getData(draftSelectionMime));
                    },
                  })}
                >
                  {label}
                  {tab === "stash" && pulse?.at === "tab" && <span key={pulse.n} className="ki-margin-pulse" data-testid="stash-tab-pulse" aria-hidden />}
                  <ShortcutHint id={TAB_KEYS[tab]} side="below" />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </div>
          <Tabs.Panel value="kin" keepMounted className="ki-margin-panel" data-tab="kin">
            {margin.showing("kin") && <KinTab onHide={close} />}
          </Tabs.Panel>
          {where === "writing" && (
            <>
              <Tabs.Panel value="references" keepMounted className="ki-margin-panel ki-margin-scroll" data-tab="references" ref={referencesSlot} />
              <Tabs.Panel value="stash" keepMounted className="ki-margin-panel" data-tab="stash" ref={stashSlot} />
            </>
          )}
        </Tabs.Root>
      </aside>
      <KinLauncher hidden={margin.open && where === "away"} />
    </>
  );
}
