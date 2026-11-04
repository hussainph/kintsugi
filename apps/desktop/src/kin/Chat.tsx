import { cn } from "@kintsugi/ui/lib/utils";
import { openKin } from "@/lib/chat";
import { keysOf } from "@/lib/keys";
import { SHORTCUTS } from "@/lib/shortcuts";
import { ShortcutHint } from "@/components/Shortcuts";
import { hideMargin, useMargin } from "@/margin/state";
import { KinAvatar } from "./Avatar";
import { useKinStatus } from "./KinTab";

/** The avatar, bottom right on every screen: opens and hides the margin's
 *  Kin tab. Its dot says Kin answered in a thread he isn't looking at (gold)
 *  or a helper is working (grey). */
export function KinLauncher({ hidden }: { hidden?: boolean }) {
  const open = useMargin().showing("kin");
  const { talking, unread, busy } = useKinStatus();
  if (hidden) return null;
  return (
    <button
      type="button"
      aria-label={open ? "Hide Kin" : "Ask Kin"}
      title={`Kin (${keysOf(SHORTCUTS.kin.key)})`}
      aria-expanded={open}
      onClick={() => (open ? hideMargin() : openKin())}
      className="ki-kin-launcher"
    >
      <KinAvatar talking={talking} />
      <ShortcutHint id="kin" side="above" />
      {(unread || busy) && <span aria-hidden data-kin-unread={unread || undefined} className={cn("ki-kin-launcher-dot", !unread && "ki-kin-launcher-dot-busy")} />}
    </button>
  );
}
