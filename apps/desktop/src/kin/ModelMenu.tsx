import { type ReactElement } from "react";
import { Menu } from "@kintsugi/ui/graphical";
import { Brain, Check, ChevronDown, ImageIcon } from "@kintsugi/ui/icons";
import { cn } from "@kintsugi/ui/lib/utils";
import { modelName, priceLabel, shown, type ModelInfo, type ModelRef, type ProviderModels } from "@/lib/ai";

const SEP = "\u0000";
const keyOf = (m: Pick<ModelRef, "provider" | "model">) => `${m.provider}${SEP}${m.model}`;
const AUTOMATIC = "";

type Props = {
  /** Providers with a usable credential, and their models (`models()`). */
  providers: ProviderModels[] | null;
  /** His pick, checked in the list; null when nothing is picked. */
  chosen: ModelRef | null;
  /** What runs now, named on the trigger. */
  current: ModelRef | null;
  onChange: (model: ModelRef | null) => void;
  /** Names the trigger and the filter field. */
  label: string;
  /** The item that clears the pick ("Default", "Automatic"), first in the list. */
  automatic: string;
  /** `compact`: a small ghost button, for the chat's composer. `field`: a select-like control. */
  look?: "compact" | "field";
  disabled?: boolean;
};

/** A model's capabilities, as two small icons at most. */
function Badges({ model }: { model: ModelInfo }) {
  return (
    <span className="ki-model-badges">
      {model.reasoning && <span role="img" aria-label="Thinks" title="Thinks"><Brain /></span>}
      {model.images && <span role="img" aria-label="Reads images" title="Reads images"><ImageIcon /></span>}
    </span>
  );
}

/**
 * Picks a model: the one in use on the trigger, then every usable
 * provider's models grouped by provider, with a filter field. Each row
 * shows the price per million tokens (input · output) and what it can do.
 */
export function ModelMenu({ providers, chosen, current, onChange, label, automatic, look = "field", disabled }: Props) {
  const list = (providers ?? []).filter(shown);
  const name = current ? modelName(providers, current) : "None";
  // A pick whose provider has no credential now still shows, so it can be seen and changed.
  const stale = chosen && !list.some((p) => p.id === chosen.provider && p.models.some((m) => m.id === chosen.model));

  const trigger: ReactElement = (
    <button
      type="button"
      className={cn("ki-model-trigger", look === "compact" ? "ki-model-trigger-compact" : "ki-model-trigger-field")}
      aria-label={`${label}: ${name}`}
      data-model={current ? keyOf(current) : undefined}
      disabled={disabled}
    />
  );

  return (
    <Menu.FilterProvider>
      <Menu.Root>
        <Menu.Trigger render={trigger}>
          <span className="truncate">{name}</span>
          <ChevronDown aria-hidden className="ki-model-chevron" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="start" side={look === "compact" ? "top" : "bottom"} sideOffset={4}>
            <Menu.Popup className="ki-model-menu">
              <Menu.Input aria-label={`Filter ${label.toLowerCase()}`} placeholder="Filter" className="ki-model-filter" />
              <Menu.Empty>No models match.</Menu.Empty>
              <Menu.List className="ki-model-list">
                <Menu.RadioGroup
                  value={chosen ? keyOf(chosen) : AUTOMATIC}
                  onValueChange={(value: string) => {
                    if (value === AUTOMATIC) return onChange(null);
                    const [provider, model] = value.split(SEP);
                    onChange({ provider, model });
                  }}
                >
                  <Menu.Group data-filter-section>
                    <Menu.RadioItem value={AUTOMATIC} label={automatic} closeOnClick className="ki-model-option">
                      <Menu.RadioItemIndicator className="ki-model-check"><Check /></Menu.RadioItemIndicator>
                      <span className="ki-model-name">{automatic}</span>
                    </Menu.RadioItem>
                    {stale && chosen && (
                      <Menu.RadioItem value={keyOf(chosen)} label={chosen.model} closeOnClick className="ki-model-option" disabled>
                        <Menu.RadioItemIndicator className="ki-model-check"><Check /></Menu.RadioItemIndicator>
                        <span className="ki-model-name">{chosen.model}</span>
                        <span className="ki-model-price">Not set up</span>
                      </Menu.RadioItem>
                    )}
                  </Menu.Group>
                  {list.map((p) => (
                    <Menu.Group key={p.id} data-filter-section data-provider={p.id}>
                      <Menu.GroupLabel className="ki-model-group">{p.name}</Menu.GroupLabel>
                      {p.models.map((m) => (
                        <Menu.RadioItem
                          key={m.id}
                          value={keyOf({ provider: p.id, model: m.id })}
                          label={`${m.name} ${p.name}`}
                          closeOnClick
                          className="ki-model-option"
                        >
                          <Menu.RadioItemIndicator className="ki-model-check"><Check /></Menu.RadioItemIndicator>
                          <span className="ki-model-name">{m.name}</span>
                          <Badges model={m} />
                          <span className="ki-model-price" title="Per million tokens, in · out">{priceLabel(m.price)}</span>
                        </Menu.RadioItem>
                      ))}
                    </Menu.Group>
                  ))}
                </Menu.RadioGroup>
              </Menu.List>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </Menu.FilterProvider>
  );
}
