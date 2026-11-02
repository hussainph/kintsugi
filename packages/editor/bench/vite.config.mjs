// Keystroke benchmark for packages/editor in a real browser (see README.md).
import path from "node:path";
import { createRequire } from "node:module";

// react-dom isn't a dependency of the editor; borrow the desktop app's.
const desktop = createRequire(path.resolve(import.meta.dirname, "../../../apps/desktop/package.json"));
export default {
  root: import.meta.dirname,
  resolve: {
    alias: {
      "react-dom/client": desktop.resolve("react-dom/client"),
      react: path.dirname(desktop.resolve("react/package.json")),
    },
    dedupe: ["react", "@codemirror/state", "@codemirror/view"],
  },
  server: { host: "127.0.0.1", port: Number(process.env.BENCH_PORT ?? 5199), strictPort: true },
};
