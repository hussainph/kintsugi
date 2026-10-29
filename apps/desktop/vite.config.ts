import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// Headless dev (KI-12): the app runs in a browser tab against a headless
// backend, beside any `tauri dev` on 1420, and only on loopback.
const headless = process.env.KINTSUGI_HEADLESS === "1";
const port = frontendPort(process.env.KINTSUGI_FRONTEND_PORT, headless ? 1422 : 1420);

function frontendPort(value: string | undefined, fallback: number) {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`KINTSUGI_FRONTEND_PORT must be a port number, got ${value}`);
  }
  return port;
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: headless ? "127.0.0.1" : host || false,
    hmr: !headless && host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      // The shared packages live outside this app's folder.
      allow: ["../.."],
    },
  },
}));
