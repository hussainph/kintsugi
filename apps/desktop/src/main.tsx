// First, so a dev build in a plain browser tab has its Tauri runtime stand-in
// before any app module runs. A no-op in `tauri dev` and in production.
import "./headless/install";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import "./index.css";

// shadcn's dark theme hangs off a `.dark` class; follow the system setting.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
