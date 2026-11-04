import { Check, ChevronDown } from "@kintsugi/ui/icons";
import { Menu } from "@kintsugi/ui/graphical";
import { cn } from "@kintsugi/ui/lib/utils";
import { snippet } from "@/lib/chips";
import { KinAvatar } from "./Avatar";
import { KinComposer, KinHelpers, KinLog, KinSummary } from "./Conversation";
import { type KinChatState } from "./useKinChat";
import { openKin } from "@/lib/chat";
import { keysOf } from "@/lib/keys";
import { SHORTCUTS } from "@/lib/shortcuts";
import { ShortcutHint } from "@/components/Shortcuts";

const EVERYTHING = "\u0000everything";

/** Which conversation shows: one thread, or everything in the log. */
function ThreadMenu({ chat }: { chat: KinChatState }) {
  const { view, threadLabel, page } = chat;
  const title = view === null ? "Everything" : view === "" ? threadLabel : `About ${threadLabel}`;
  return (
    <Menu.Root>
      <Menu.Trigger render={<button type="button" className="ki-kin-thread" aria-label="Conversation" />}>
        <span className="ki-kin-thread-label" data-thread={view ?? "*"}>
          {title}
        </span>
        <ChevronDown aria-hidden className="ki-model-chevron" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" side="bottom" sideOffset={4} collisionPadding={8}>
          <Menu.Popup className="ki-kin-thread-menu">
            <Menu.RadioGroup value={view ?? EVERYTHING} onValueChange={(next: string) => chat.setView(next === EVERYTHING ? null : next)}>
              <Menu.RadioItem value={EVERYTHING} label="Everything" closeOnClick className="ki-kin-thread-option">
                <Menu.RadioItemIndicator className="ki-model-check"><Check /></Menu.RadioItemIndicator>
                <span className="ki-kin-thread-name">Everything</span>
              </Menu.RadioItem>
              {page.threads.map((t) => (
                <Menu.RadioItem key={t.key || "*general"} value={t.key} label={t.label} closeOnClick className="ki-kin-thread-option">
                  <Menu.RadioItemIndicator className="ki-model-check"><Check /></Menu.RadioItemIndicator>
                  <span className="ki-kin-thread-name">{t.label}</span>
                  <span className="ki-kin-thread-detail">{t.summary ? snippet(t.summary, 70) : `${t.entries} message${t.entries === 1 ? "" : "s"}`}</span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The avatar, bottom right on every screen: opens and hides the margin's
 *  Kin tab. Its dot says Kin answered while the tab was hidden (gold) or a
 *  helper is working (grey). */
export function KinLauncher({ chat, hidden }: { chat: KinChatState; hidden?: boolean }) {
  const { open, talking, unread, helpers } = chat;
  const busy = helpers.some((j) => j.status === "running");
  if (hidden) return null;
  return (
    <button
      type="button"
      aria-label={open ? "Hide Kin" : "Ask Kin"}
      title={`Kin (${keysOf(SHORTCUTS.kin.key)})`}
      aria-expanded={open}
      onClick={() => (open ? chat.hide() : openKin())}
      className="ki-kin-launcher"
    >
      <KinAvatar talking={talking} />
      <ShortcutHint id="kin" side="above" />
      {(unread || busy) && <span aria-hidden data-kin-unread={unread || undefined} className={cn("ki-kin-launcher-dot", !unread && "ki-kin-launcher-dot-busy")} />}
    </button>
  );
}

/**
 * Today's chat in the margin's Kin tab (KI-103): which conversation, its
 * summary, the log, helpers and the composer. Whatever is on screen comes
 * along as removable chips. "Kin as small threads" (KI-104) replaces this.
 */
export function KinChatTab({ chat }: { chat: KinChatState }) {
  return (
    <section className="ki-kin-tab" aria-label="Kin">
      <div className="ki-kin-header">
        <KinAvatar className="ki-kin-header-avatar" talking={chat.talking} />
        <ThreadMenu chat={chat} />
      </div>
      <KinSummary chat={chat} />
      <KinLog chat={chat} />
      <div className="ki-kin-footer">
        <KinHelpers helpers={chat.helpers} />
        <KinComposer chat={chat} onManage={chat.hide} />
      </div>
    </section>
  );
}
