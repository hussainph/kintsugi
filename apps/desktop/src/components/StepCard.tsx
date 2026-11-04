import { Button } from "@kintsugi/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@kintsugi/ui/components/tooltip";
import { ChevronLeft, ChevronRight, type IconComponent } from "@kintsugi/ui/icons";
import { keysOf } from "@/lib/keys";
import { SHORTCUTS, type ShortcutId } from "@/lib/shortcuts";

/** One icon button on the card. */
export type StepCardAction = {
  /** Tests and styles find it by `data-card-action={id}`. */
  id: string;
  /** Its name: the tooltip and the accessible label. */
  label: string;
  icon: IconComponent;
  /** Shown in the tooltip. */
  shortcut?: ShortcutId;
  onClick: () => void;
};

export type StepCardProps = {
  /** Where this item is, from 1, and how many there are. With one, ‹ › hide. */
  index: number;
  total: number;
  /** ‹ (-1) and › (1). */
  onStep: (by: 1 | -1) => void;
  /** The keys ‹ and › show in their tooltips. Default: Kin's marks, ⇧⌘' and ⌘'. */
  stepKeys?: { previous?: ShortcutId; next?: ShortcutId };
  /** Words in his draft's type with a rule in Kin's accent: a rewrite, a version. */
  text?: string;
  /** One plain line: Kin's reason. */
  note?: string;
  /** The icon buttons, in order, after ‹ 1 of N ›. */
  actions: readonly StepCardAction[];
  /** The group's accessible name. */
  label?: string;
  /** `data-kind` on the card, for styles and tests. */
  kind?: string;
};

function Action({ action }: { action: StepCardAction }) {
  const Icon = action.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={action.label} data-card-action={action.id} onClick={action.onClick}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {action.label}
        {action.shortcut && <span aria-hidden> {keysOf(SHORTCUTS[action.shortcut].key)}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The `‹ 1 of N ›` card (KI-109): a small card that steps through a list
 * and acts on the item it shows. It knows nothing about what the items are:
 * Kin's marks pass their reason, a rewrite's words and accept, dismiss,
 * discuss and stash (`src/refine/MarkCard.tsx`); KI-111 can pass a span's
 * versions. The editor places it (`inlineCard` in @kintsugi/editor/card),
 * under the anchor's paragraph, so it never covers the line it's about.
 */
export function StepCard({ index, total, onStep, stepKeys, text, note, actions, label, kind }: StepCardProps) {
  return (
    <div className="ki-step-card" role="group" aria-label={label} data-kind={kind}>
      {text !== undefined && <p className="ki-step-card-text">{text}</p>}
      {note && <p className="ki-step-card-note">{note}</p>}
      <div className="ki-step-card-row">
        {total > 1 && (
          <span className="ki-step-card-step">
            <Action action={{ id: "previous", label: "Previous", icon: ChevronLeft, shortcut: stepKeys?.previous ?? "previousMark", onClick: () => onStep(-1) }} />
            <span className="ki-step-card-count" data-card-count>
              {index} of {total}
            </span>
            <Action action={{ id: "next", label: "Next", icon: ChevronRight, shortcut: stepKeys?.next ?? "nextMark", onClick: () => onStep(1) }} />
          </span>
        )}
        <span className="ki-step-card-actions">
          {actions.map((action) => (
            <Action key={action.id} action={action} />
          ))}
        </span>
      </div>
    </div>
  );
}
