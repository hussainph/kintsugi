import { onScreenChanged, screenChips } from "./chat";

type Target = { path: string; addReply: (text: string) => boolean };
let target: Target | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/** Only the writable, open editor registers. No reply writes a vault file itself. */
export function registerStashTarget(path: string, addReply: Target["addReply"]) {
  const mine = { path, addReply };
  target = mine;
  changed();
  return () => { if (target === mine) { target = null; changed(); } };
}
export function onStashTarget(listener: () => void) {
  listeners.add(listener);
  const offScreen = onScreenChanged(listener);
  return () => { listeners.delete(listener); offScreen(); };
}
export function stashTarget(): string | null {
  return target && screenChips().some((chip) => chip.path === target!.path) ? target.path : null;
}
/** An explicit owner action, unlike the rewrite-only proactive entry point. */
export function stashReply(text: string): boolean {
  return !!text.trim() && !!stashTarget() && !!target?.addReply(text);
}
