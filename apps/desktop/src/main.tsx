// First, so a dev build in a plain browser tab has its Tauri runtime stand-in
// before any app module runs. A no-op in `tauri dev` and in production.
import "./headless/install";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { KintsugiProvider } from "@kintsugi/ui/provider";
import "./index.css";

import { useAppearanceMode } from "@/lib/appearance";

function ThemedApp() {
  const colorMode = useAppearanceMode();
  return <KintsugiProvider colorMode={colorMode}><App /></KintsugiProvider>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemedApp />
  </React.StrictMode>,
);
