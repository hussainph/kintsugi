import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

/**
 * The window's chrome, as one attribute on <html> that the CSS reads
 * (`--ki-titlebar` in theme.css): `data-fullscreen="true"` in macOS full
 * screen, where the traffic lights and the title bar are gone, so nothing
 * keeps room for them. Windowed, the top strip holds the traffic lights.
 *
 * Read from Tauri on start and on every resize (entering or leaving full
 * screen resizes the window). The headless bridge answers `is_fullscreen`
 * from `data-headless-fullscreen` so runtime tests can simulate it.
 */
export function useWindowChrome() {
  useEffect(() => {
    let alive = true;
    let seq = 0;
    const apply = (full: boolean) => {
      document.documentElement.dataset.fullscreen = String(full);
    };
    const check = () => {
      const mine = ++seq;
      getCurrentWindow()
        .isFullscreen()
        .then((full) => {
          if (alive && mine === seq) apply(full);
        })
        .catch(() => {
          // No window to ask (a plain browser): windowed.
          if (alive && mine === seq) apply(false);
        });
    };
    check();
    const native = getCurrentWindow().onResized(check).catch(() => null);
    window.addEventListener("resize", check);
    return () => {
      alive = false;
      window.removeEventListener("resize", check);
      void native.then((off) => off?.());
    };
  }, []);
}
