import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSlot, type MarginTab } from "./state";

/** Renders `children` into a tab of the margin, from wherever their state
 *  lives (the editor's references render in `Writing`). */
export function MarginPortal({ tab, children }: { tab: MarginTab; children: ReactNode }) {
  const slot = useSlot(tab);
  return slot ? createPortal(children, slot) : null;
}
