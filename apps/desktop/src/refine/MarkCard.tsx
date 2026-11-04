import type { MarkCard as Card, MarkCardActions } from "@kintsugi/editor/Editor";
import { Button } from "@kintsugi/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@kintsugi/ui/components/tooltip";
import { Bookmark, Check, ChevronLeft, ChevronRight, MessageCircle, X } from "@kintsugi/ui/icons";
import type { ComponentType, ReactNode } from "react";
import { keysOf } from "@/lib/keys";
import { SHORTCUTS, type ShortcutId } from "@/lib/shortcuts";

function Action({ label, shortcut, icon: Icon, onClick, data }: { label: string; shortcut?: ShortcutId; icon: ComponentType; onClick: () => void; data: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={label} data-card-action={data} onClick={onClick}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <span aria-hidden> {keysOf(SHORTCUTS[shortcut].key)}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

const ACCEPT = { cut: "Cut", rewrite: "Accept", flag: "Done" } as const;

/**
 * The focused mark's card (KI-109): Kin's one-line reason, a rewrite's
 * words, ‹ 1 of N › and icon buttons. The editor puts it under the
 * paragraph, so it never covers the line it's about.
 */
export function MarkCard({ card, actions }: { card: Card; actions: MarkCardActions }): ReactNode {
  const { mark, can } = card;
  return (
    <div className="ki-mark-card" data-kind={mark.kind}>
      {mark.kind === "rewrite" && mark.text !== undefined && <p className="ki-mark-card-text">{mark.text}</p>}
      {mark.reason && <p className="ki-mark-card-reason">{mark.reason}</p>}
      <div className="ki-mark-card-row">
        {card.total > 1 && (
          <span className="ki-mark-card-step">
            <Action label="Previous" shortcut="previousMark" icon={ChevronLeft} onClick={() => actions.step(-1)} data="previous" />
            <span className="ki-mark-card-count" data-card-count>
              {card.index} of {card.total}
            </span>
            <Action label="Next" shortcut="nextMark" icon={ChevronRight} onClick={() => actions.step(1)} data="next" />
          </span>
        )}
        <span className="ki-mark-card-actions">
          {can.accept && <Action label={ACCEPT[mark.kind]} shortcut="acceptMark" icon={Check} onClick={actions.accept} data="accept" />}
          <Action label={mark.kind === "cut" ? "Keep" : "Dismiss"} shortcut="dismissMark" icon={X} onClick={actions.dismiss} data="dismiss" />
          {can.discuss && <Action label="Discuss" shortcut="discussMark" icon={MessageCircle} onClick={actions.discuss} data="discuss" />}
          {can.stash && <Action label="Stash" icon={Bookmark} onClick={actions.stash} data="stash" />}
        </span>
      </div>
    </div>
  );
}
