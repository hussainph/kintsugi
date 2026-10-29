// Imported first by main.tsx. In `tauri dev` and in production builds this
// does nothing: production folds `import.meta.env.DEV` to false and drops the
// bridge entirely, and a real Tauri webview already has `__TAURI_INTERNALS__`.
import {
  createHeadlessBridge,
  installHeadlessBridge,
  readHeadlessConfig,
  shouldInstallHeadlessBridge,
} from "./bridge";
import { domAlert, domConfirm, domPrompt } from "./dialog";

if (import.meta.env.DEV && shouldInstallHeadlessBridge(import.meta.env, window)) {
  // Re-opening the printed URL in the same tab only changes the fragment;
  // reload so a new run's bridge and token take over.
  window.addEventListener("hashchange", () => {
    if (new URLSearchParams(location.hash.slice(1)).has("headless")) location.reload();
  });
  const found = readHeadlessConfig(location.hash, sessionStorage);
  if (!found) {
    console.warn(
      "Kintsugi: no Tauri runtime and no #headless=…&token=… bridge in the URL; native calls will fail.",
    );
  } else {
    // Keep the token out of the address bar; sessionStorage carries it over reloads.
    if (found.fromFragment) {
      const hash = found.rest ? `#${found.rest}` : "";
      history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
    }
    const bridge = createHeadlessBridge(found.config, {
      fetch: (input, init) => window.fetch(input, init),
      EventSource: window.EventSource,
      prompt: domPrompt,
      alert: domAlert,
      confirm: domConfirm,
      open: (url, target, features) => window.open(url, target, features),
      clientId: crypto.randomUUID(),
      random: () => crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000,
    });
    installHeadlessBridge(window as unknown as Record<string, unknown>, bridge);
    window.addEventListener("pagehide", () => bridge.close());
    // A page restored from the back/forward cache has a closed stream: start over.
    window.addEventListener("pageshow", (e) => e.persisted && location.reload());
    console.info(`Kintsugi: headless dev bridge at ${found.config.base}`);
  }
}
