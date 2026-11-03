import { Check, ChevronDown, Minus } from "@kintsugi/ui/icons";
import { Menu } from "@kintsugi/ui/graphical";
import { Button } from "@kintsugi/ui/components/button";
import { cn } from "@kintsugi/ui/lib/utils";
import { snippet } from "@/lib/chips";
import { KinAvatar } from "./Avatar";
import { KinComposer, KinHelpers, KinLog, KinSummary } from "./Conversation";
import { useKinChat, type KinChatState } from "./useKinChat";

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

/**
 * Kin everywhere: one avatar on every screen, opening one chat. Whatever is
 * on screen comes along as removable chips; the conversation shown is the
 * thread for what's on screen (a view of the open vault's log), resumable
 * later. ⌘J shows and hides it; `discuss()` opens it with an item attached.
 *
 * The pane is a shell: the log, helpers and composer are their own
 * components (`Conversation.tsx`) over `useKinChat`, so a sidebar can hold
 * the same chat (KI-63).
 */
export function KinChat() {
  const chat = useKinChat();
  const { open, show, hide, talking, unread, helpers } = chat;
  const busy = helpers.some((j) => j.status === "running");
  return (
    <>
      <button
        type="button"
        aria-label={open ? "Hide Kin" : "Ask Kin"}
        title="Kin (⌘J)"
        aria-expanded={open}
        onClick={() => (open ? hide() : show())}
        className="ki-kin-launcher"
      >
        <KinAvatar talking={talking} />
        {(unread || busy) && <span aria-hidden data-kin-unread={unread || undefined} className={cn("ki-kin-launcher-dot", !unread && "ki-kin-launcher-dot-busy")} />}
      </button>

      {open && (
        <section
          role="dialog"
          aria-label="Kin"
          onKeyDown={(e) => {
            // A menu's Esc (in a portal, outside this panel) closes only the menu.
            if (e.key === "Escape" && e.currentTarget.contains(e.target as Node)) {
              e.stopPropagation();
              hide();
            }
          }}
          className="ki-kin-pane"
        >
          <header className="ki-kin-header">
            <KinAvatar className="ki-kin-header-avatar" talking={talking} />
            <ThreadMenu chat={chat} />
            <Button variant="ghost" size="icon-sm" aria-label="Hide Kin" title="Hide (⌘J)" onClick={hide}>
              <Minus />
            </Button>
          </header>
          <KinSummary chat={chat} />
          <KinLog chat={chat} />
          <div className="ki-kin-footer">
            <KinHelpers helpers={helpers} />
            <KinComposer chat={chat} onManage={hide} />
          </div>
        </section>
      )}
    </>
  );
}
