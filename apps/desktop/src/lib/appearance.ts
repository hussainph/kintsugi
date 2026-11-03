import { useSyncExternalStore } from "react";

export type Appearance = "light" | "dark" | "system";
export type ColorMode = "light" | "dark";
const KEY = "kintsugi:appearance";
const listeners = new Set<() => void>();

export function appearancePreference(value: unknown): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveAppearance(preference: Appearance, systemDark: boolean): ColorMode {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

function read(): Appearance {
  try { return appearancePreference(localStorage.getItem(KEY)); } catch { return "system"; }
}

const system = typeof window === "undefined" ? undefined : window.matchMedia("(prefers-color-scheme: dark)");
let preference = read();
let mode = resolveAppearance(preference, system?.matches ?? false);

function apply() {
  mode = resolveAppearance(preference, system?.matches ?? false);
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", mode === "dark");
    document.documentElement.style.colorScheme = mode;
  }
}
apply();
system?.addEventListener("change", () => {
  const previous = mode;
  apply();
  if (mode !== previous) for (const listener of listeners) listener();
});

export function setAppearance(value: Appearance) {
  const next = appearancePreference(value);
  if (next === preference) return;
  preference = next;
  apply();
  try { localStorage.setItem(KEY, next); } catch { /* A device preference only. */ }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => preference, () => "system");
}

export function useAppearanceMode(): ColorMode {
  return useSyncExternalStore(subscribe, () => mode, () => "light");
}
