// First, so a dev build in a plain browser tab has its Tauri runtime stand-in
// before any app module runs. A no-op in `tauri dev` and in production.
import "./headless/install";
import React, { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { KintsugiProvider } from "@kintsugi/ui/provider";
import { useAppearance, useAppearanceMode } from "@/lib/appearance";
import "./index.css";

function ThemedApp() {
  const appearance = useAppearance();
  const colorMode = useAppearanceMode();
  useEffect(() => {
    // Match native titlebar/menus too. Clearing the override lets macOS drive
    // prefers-color-scheme again; the appearance store observes that change.
    void getCurrentWindow().setTheme(appearance === "system" ? null : appearance)
      .catch((error) => console.error("Kintsugi couldn't set the window appearance", error));
  }, [appearance]);
  return <KintsugiProvider colorMode={colorMode}><App /></KintsugiProvider>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemedApp />
  </React.StrictMode>,
);
