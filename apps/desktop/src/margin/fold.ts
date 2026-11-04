import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";

/** Whether the open margin would cover the draft's text where the column
 *  sits now. The column already leaves the margin's room when the window
 *  allows (references.css), so this is true only when it can't: about
 *  about 1350 px wide or less with the sidebar open, at the default text
 *  size, and only while the column still has its full measure. */
export function marginCoversText(view: EditorView | null): boolean {
  if (!view) return false;
  const content = view.contentDOM;
  // A window narrower than the measure has squeezed the column already;
  // folding the sidebar would widen it again and re-wrap every line. The
  // margin covers the page there instead.
  if (content.getBoundingClientRect().width >= view.scrollDOM.clientWidth - 0.5) return false;
  const line = content.querySelector(".cm-line");
  if (!line) return false;
  const textRight = line.getBoundingClientRect().right - parseFloat(getComputedStyle(line).paddingRight || "0");
  const root = getComputedStyle(view.dom);
  const width = parseFloat(root.getPropertyValue("--ki-margin-width")) || 360;
  const gap = parseFloat(root.getPropertyValue("--ki-margin-gap")) || 0;
  return window.innerWidth - textRight < Math.min(width, window.innerWidth) + gap - 1;
}

/**
 * Folds the sidebar to icons while the margin is open, when `needed` says
 * the margin wouldn't fit beside the draft otherwise; closing the margin
 * unfolds it. `release` gives the sidebar back early (he opened it himself).
 * Checked when the margin opens or the draft comes into view, not on every
 * resize: past that, a too-narrow window gets the margin over the page.
 */
export function useMarginFold(open: boolean, needed: () => boolean, deps: unknown[] = []) {
  const [active, setActive] = useState(false);
  const latest = useRef(needed);
  latest.current = needed;
  useEffect(() => {
    if (!open) setActive(false);
    else if (latest.current()) setActive(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ...deps]);
  const release = useCallback(() => setActive(false), []);
  return { active, release };
}
