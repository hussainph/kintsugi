import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { labPlugin } from "@kintsugi/lab/server";
import { analyze } from "@kintsugi/lab/analysis";
import { discover } from "@kintsugi/lab/discovery";

const root = path.resolve(import.meta.dirname, "../..");
const entriesDir = "apps/lab/entries";
export default defineConfig({
  cacheDir: "node_modules/.vite-lab",
  plugins: [
    react(),
    tailwindcss(),
    labPlugin({
      root,
      entriesDir,
      analysis: async () => {
        const entries = await discover(root, entriesDir);
        return analyze({
          root,
          tokenFiles: [
            "packages/ui/src/styles.css",
            "packages/editor/src/theme.ts",
          ],
          sourceDirs: [
            "packages/ui/src",
            "packages/editor/src",
            "apps/desktop/src",
          ],
          entries: entries.map(({ meta }) => ({
            id: meta.id,
            sources: meta.sources,
          })),
        });
      },
    }),
  ],
  resolve: { alias: { "@": path.resolve(root, "apps/desktop/src") } },
  server: {
    host: "127.0.0.1",
    port: 4315,
    strictPort: true,
    fs: { allow: [root] },
    watch: {
      ignored: [
        "**/thread.jsonl",
        "**/*.tmp",
        "**/.lab-artifacts/**",
        "**/src-tauri/**",
      ],
    },
  },
});
