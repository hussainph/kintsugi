import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

/** Checked shortly after launch, then this often while the app stays open. */
const FIRST_CHECK = 10_000;
const EVERY = 6 * 60 * 60 * 1000;
const TOAST = "kintsugi-update";

/** Release builds only. Dev and headless runs never update or relaunch. */
const enabled = !import.meta.env.DEV;

/**
 * Looks for a signed release on GitHub and, when there is one, offers it
 * quietly. Nothing installs until the writer asks, and nothing restarts until
 * `beforeRestart` confirms every edit reached the disk.
 */
export function useUpdates(beforeRestart: () => Promise<boolean>) {
  const offered = useRef<string | null>(null);
  const save = useRef(beforeRestart);
  save.current = beforeRestart;

  useEffect(() => {
    if (!enabled) return;
    const look = async () => {
      let update: Update | null;
      try {
        update = await check();
      } catch (e) {
        // Offline, or GitHub unreachable: try again next time, silently.
        console.warn("update check failed", e);
        return;
      }
      if (!update || offered.current === update.version) return;
      offered.current = update.version;
      offer(update, () => save.current());
    };
    const first = window.setTimeout(look, FIRST_CHECK);
    const timer = window.setInterval(look, EVERY);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
}

function offer(update: Update, beforeRestart: () => Promise<boolean>) {
  toast(`Kintsugi ${update.version} is ready`, {
    id: TOAST,
    duration: Infinity,
    description: "Restart when it suits you. Your writing is saved first.",
    action: { label: "Restart to update", onClick: () => void install(update, beforeRestart) },
  });
}

async function install(update: Update, beforeRestart: () => Promise<boolean>) {
  if (!(await beforeRestart())) {
    toast.error("Some changes couldn't be saved, so Kintsugi won't restart yet.", { id: TOAST });
    return;
  }
  toast.loading(`Updating to ${update.version}…`, { id: TOAST, duration: Infinity });
  try {
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    toast.error(`The update didn't install: ${e instanceof Error ? e.message : String(e)}`, { id: TOAST });
  }
}
