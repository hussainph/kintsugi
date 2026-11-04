import type { MarkCard as Card, MarkCardActions } from "@kintsugi/editor/Editor";
import { Bookmark, Check, MessageCircle, X } from "@kintsugi/ui/icons";
import { StepCard, type StepCardAction } from "@/components/StepCard";

const ACCEPT = { cut: "Cut", rewrite: "Accept", flag: "Done" } as const;

/** The focused mark's card (KI-109): the `‹ 1 of N ›` StepCard with Kin's
 *  reason, a rewrite's words, and accept, dismiss, discuss and stash. */
export function MarkCard({ card, actions }: { card: Card; actions: MarkCardActions }) {
  const { mark, can } = card;
  const buttons: StepCardAction[] = [
    ...(can.accept ? [{ id: "accept", label: ACCEPT[mark.kind], icon: Check, shortcut: "acceptMark" as const, onClick: actions.accept }] : []),
    { id: "dismiss", label: mark.kind === "cut" ? "Keep" : "Dismiss", icon: X, shortcut: "dismissMark", onClick: actions.dismiss },
    ...(can.discuss ? [{ id: "discuss", label: "Discuss", icon: MessageCircle, shortcut: "discussMark" as const, onClick: actions.discuss }] : []),
    ...(can.stash ? [{ id: "stash", label: "Stash", icon: Bookmark, onClick: actions.stash }] : []),
  ];
  return (
    <StepCard
      kind={mark.kind}
      label="Kin’s suggestion"
      index={card.index}
      total={card.total}
      onStep={actions.step}
      text={mark.kind === "rewrite" ? mark.text : undefined}
      note={mark.reason}
      actions={buttons}
    />
  );
}
