/** Hold ⌘ on its own and the shortcuts show; let go and they hide, like
 *  iPadOS. Any other key, a click, or the window losing focus cancels it, so
 *  typing ⌘-combos never shows them. Cheap: four listeners and one timer. */

export const HOLD_MS = 800;

type Timers = { set: (run: () => void, ms: number) => unknown; clear: (id: unknown) => void };

const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export function holdCommand(target: EventTarget, onChange: (shown: boolean) => void, timers: Timers = realTimers, ms = HOLD_MS): () => void {
  let timer: unknown = null;
  let shown = false;

  const reset = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    if (shown) {
      shown = false;
      onChange(false);
    }
  };

  const down = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.key === "Meta" && !e.shiftKey && !e.altKey && !e.ctrlKey) {
      // Key repeat while held: keep the timer that's running.
      if (e.repeat || timer !== null || shown) return;
      timer = timers.set(() => {
        timer = null;
        shown = true;
        onChange(true);
      }, ms);
      return;
    }
    reset();
  };
  const up = (event: Event) => {
    if ((event as KeyboardEvent).key === "Meta" || !(event as KeyboardEvent).metaKey) reset();
  };

  const events: [string, (event: Event) => void][] = [
    ["keydown", down],
    ["keyup", up],
    ["pointerdown", reset],
    ["blur", reset],
  ];
  for (const [name, run] of events) target.addEventListener(name, run, true);
  return () => {
    for (const [name, run] of events) target.removeEventListener(name, run, true);
    if (timer !== null) timers.clear(timer);
  };
}
