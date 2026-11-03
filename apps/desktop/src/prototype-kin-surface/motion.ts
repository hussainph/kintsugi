// PROTOTYPE (KI-96), throwaway: the motion every candidate shares.
//
// Stepping between suggestions ("< 1 of 3 >") scrolls the draft so the next
// one sits a third of the way down the window:
// - 240 ms for a short hop, up to 320 ms for a long one, on an ease-out
//   quart (cubic-bezier(0.25, 1, 0.5, 1)): fast start, soft landing.
// - Farther than one window away, it first jumps silently to one window
//   short of the target, then glides the rest, so the glide never takes
//   longer and the eye still sees which way the page went.
// - The card travels with it on the same curve, and the target words flash
//   once (a 400 ms wash fading out) so the eye lands on them.
// - Reduced motion: no scroll animation. The page cuts to the spot and only
//   the 400 ms wash marks where to look.
import type { EditorView } from "@codemirror/view";

export type Speed = "normal" | "slow" | "reduced";
let speed: Speed = "normal";
export const setSpeed = (s: Speed) => {
  speed = s;
  document.documentElement.dataset.kpSpeed = s;
};
export const reduced = () => speed === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Slow plays every motion at a third of the speed, to judge the curves. */
export const factor = () => (speed === "slow" ? 3 : 1);

export const EASE = "cubic-bezier(0.25, 1, 0.5, 1)";
const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;

let running = 0;
/** Brings `pos` to a third of the way down the draft's window. */
export function teleport(view: EditorView, pos: number): Promise<void> {
  const scroller = view.scrollDOM;
  const block = view.lineBlockAt(pos);
  const target = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, block.top - scroller.clientHeight * 0.33));
  const start = scroller.scrollTop;
  const distance = target - start;
  const id = ++running;
  if (Math.abs(distance) < 4) return Promise.resolve();
  if (reduced()) {
    scroller.scrollTop = target;
    return Promise.resolve();
  }
  const window = scroller.clientHeight;
  let from = start;
  if (Math.abs(distance) > window) {
    from = target - Math.sign(distance) * window;
    scroller.scrollTop = from;
  }
  const span = target - from;
  const duration = (240 + Math.min(80, (Math.abs(span) / window) * 80)) * factor();
  const began = performance.now();
  return new Promise((resolve) => {
    const frame = (now: number) => {
      if (id !== running) return resolve();
      const t = Math.min(1, (now - began) / duration);
      scroller.scrollTop = from + span * easeOutQuart(t);
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

/** Text leaving the draft (or a reply) flies into the stash: 380 ms, the
 *  same ease-out, shrinking as it goes. Reduced motion: nothing flies. */
export function fly(text: string, from: DOMRect | null, to: Element | null) {
  if (!from || !to || reduced()) return;
  const end = to.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = "kp-fly";
  ghost.textContent = text.length > 90 ? text.slice(0, 88) + "…" : text;
  Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${Math.min(420, Math.max(160, from.width))}px` });
  document.body.append(ghost);
  const dx = end.left + 12 - from.left;
  const dy = end.top + 8 - from.top;
  const anim = ghost.animate(
    [
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.6)`, opacity: 0.2 },
    ],
    { duration: 380 * factor(), easing: EASE },
  );
  anim.onfinish = () => ghost.remove();
}
