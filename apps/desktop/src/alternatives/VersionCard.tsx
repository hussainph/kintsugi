import type { VersionCard as Card, VersionCardActions } from "@kintsugi/editor/alternatives";
import { StepCard } from "@/components/StepCard";

/** The cursor's span's versions in place (KI-111): the same `‹ 1 of N ›`
 *  StepCard as Kin's marks. ‹ › and ⌥⌘[ / ⌥⌘] swap; the count opens the
 *  list in the Stash tab. */
export function VersionCard({ card, actions }: { card: Card; actions: VersionCardActions }) {
  return (
    <StepCard
      kind="versions"
      label="Versions"
      index={card.index}
      total={card.total}
      onStep={actions.step}
      stepKeys={{ previous: "previousAlternative", next: "nextAlternative" }}
      count={{ label: "All versions", shortcut: "alternatives", onClick: actions.open }}
    />
  );
}
