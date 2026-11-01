import { cn } from "@kintsugi/ui/lib/utils";
import { useScreenContext } from "@/lib/chat";
import { Ledger } from "./Ledger";
import { seam } from "./parts";
import { useIdeas, type Props } from "./useIdeas";

/**
 * The Ideas section (KI-39): Kin's daily batch and ideas on demand. The
 * layout is KI-22's recommended Ledger; the model behind it is
 * layout-independent (`useIdeas`), so Desk or Letter can replace it.
 */
export function Ideas(props: Props & { filterTitle?: string }) {
  const model = useIdeas(props);
  const open = model.byId(model.state.open);
  // Kin's chat picks up the idea that's open.
  useScreenContext("ideas", open ? () => [{ kind: "idea", path: open.id, label: open.title }] : null, [open?.id]);
  return (
    <section className={cn("relative flex h-full min-h-0 flex-col", seam)} aria-label="Ideas">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Ledger model={model} onOpenDoc={props.onOpenDoc} filterTitle={props.filterTitle} />
      </div>
    </section>
  );
}
