import { type ReactElement } from "react";
import { Menu } from "@kintsugi/ui/graphical";
import { Check, ChevronDown, Settings as SettingsIcon } from "@kintsugi/ui/icons";
import { cn } from "@kintsugi/ui/lib/utils";
import { modelName, priceLabel, sameEntry, shown, type ModelRef, type ProviderModels } from "@/lib/ai";
import { openSettings } from "@/lib/kin";

const SEP = "\u0000";
const keyOf = (m: Pick<ModelRef, "provider" | "model">) => `${m.provider}${SEP}${m.model}`;
const AUTOMATIC = "";
/** A list this long gets a filter field. */
const FILTER_AT = 12;

type Props = {
  /** Providers with a usable credential, and their models (`models()`). */
  providers: ProviderModels[] | null;
  /** The models to offer (Settings' enabled list, `KinSettings.enabled`);
   *  `null` while it loads. The pick is always listed. */
  enabled: ModelRef[] | null;
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
  /** Ends the list with a way to Settings' list of models; called as it opens. */
  onManage?: () => void;
  disabled?: boolean;
};

/**
 * Picks a model: the one in use on the trigger, then the models turned on
 * in Settings, by provider (named only when there's more than one), each
 * with its price per million tokens (input · output).
 */
export function ModelMenu({ providers, enabled, chosen, current, onChange, label, automatic, look = "field", onManage, disabled }: Props) {
  const offered = (m: ModelRef) => sameEntry(m, chosen) || !!enabled?.some((e) => sameEntry(e, m));
  const list = (providers ?? [])
    .filter(shown)
    .map((p) => ({ ...p, models: p.models.filter((m) => offered({ provider: p.id, model: m.id })) }))
    .filter((p) => p.models.length > 0);
  const count = list.reduce((n, p) => n + p.models.length, 0);
  const name = current ? modelName(providers, current) : "None";
  // A pick whose provider has no credential now still shows, so it can be seen and changed.
  const stale = chosen && !list.some((p) => p.id === chosen.provider && p.models.some((m) => m.id === chosen.model));
  const filter = count > FILTER_AT;
  const labelled = list.length > 1;

  const trigger: ReactElement = (
    <button
      type="button"
      className={cn("ki-model-trigger", look === "compact" ? "ki-model-trigger-compact" : "ki-model-trigger-field")}
      aria-label={`${label}: ${name}`}
      data-model={current ? keyOf(current) : undefined}
      disabled={disabled}
    />
  );

  const menu = (
    <Menu.Root>
      <Menu.Trigger render={trigger}>
        <span className="truncate">{name}</span>
        <ChevronDown aria-hidden className="ki-model-chevron" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" side={look === "compact" ? "top" : "bottom"} sideOffset={4} collisionPadding={8}>
          <Menu.Popup className="ki-model-menu">
            {filter && <Menu.Input aria-label={`Filter ${label.toLowerCase()}`} placeholder="Filter" className="ki-model-filter" />}
            {filter && <Menu.Empty>No models match.</Menu.Empty>}
            <Menu.List className={cn("ki-model-list", !filter && "ki-model-list-plain")}>
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
                    {labelled && <Menu.GroupLabel className="ki-model-group">{p.name}</Menu.GroupLabel>}
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
                        <span className="ki-model-price">{priceLabel(m.price)}</span>
                      </Menu.RadioItem>
                    ))}
                  </Menu.Group>
                ))}
              </Menu.RadioGroup>
              {onManage && (
                <Menu.Group data-filter-section>
                  <Menu.Separator />
                  <Menu.Item label="Choose models" className="ki-model-option ki-model-manage" onClick={() => {
                      onManage();
                      openSettings("kin");
                    }}>
                    <SettingsIcon aria-hidden className="ki-model-check" />
                    <span className="ki-model-name">Choose models</span>
                  </Menu.Item>
                </Menu.Group>
              )}
            </Menu.List>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
  // Base UI filters only a menu with its field; a short list has neither.
  return filter ? <Menu.FilterProvider>{menu}</Menu.FilterProvider> : menu;
}
