import { invoke } from "@tauri-apps/api/core";

/** Tells the backend the app rendered with its vault loaded. Only CI's
 *  packaged-app smoke test acts on it (`KINTSUGI_SMOKE=1`, see
 *  `scripts/smoke-app.mjs`); otherwise the backend ignores it. */
export async function appReady() {
  // Let React paint what the vault load set before measuring it.
  await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  const rendered = document.getElementById("root")?.innerText.trim().length ?? 0;
  await invoke("app_ready", { rendered }).catch(() => {});
}
