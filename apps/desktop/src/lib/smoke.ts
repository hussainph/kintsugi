import { invoke } from "@tauri-apps/api/core";

/** Tells the backend the app rendered with its vault loaded. Only CI's
 *  packaged-app smoke test acts on it (`KINTSUGI_SMOKE=1`, see
 *  `scripts/smoke-app.mjs`); otherwise the backend ignores it. During a
 *  smoke run the native app asks for one reload first, which has to get past
 *  the navigation guard. */
export async function appReady() {
  // Let React paint what the vault load set before measuring it.
  await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  const rendered = document.getElementById("root")?.innerText.trim().length ?? 0;
  const again = await invoke<boolean>("app_ready", { rendered }).catch(() => false);
  if (again) location.reload();
}
