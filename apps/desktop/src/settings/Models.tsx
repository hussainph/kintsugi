import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
import { Switch } from "@kintsugi/ui/components/switch";
import { Meter, SelectField } from "@kintsugi/ui/graphical";
import { Effort } from "@/kin/Effort";
import { ModelMenu } from "@/kin/ModelMenu";
import {
  effortLevels,
  modelInfo,
  models as listModels,
  priceLabel,
  sameEntry,
  shown,
  type ModelInfo,
  type ModelRef,
  type ProviderModels,
  type ThinkingLevel,
} from "@/lib/ai";
import { dollars, kin, type DefaultTask, type KinSettings, type Tone, type UsageReport, openAboutYou, openKinDev } from "@/lib/kin";
import { Group, Page, Row } from "./parts";
import { ShortcutHint } from "@/components/Shortcuts";

/** The tasks with a default model, in the order they're listed. */
const TASKS: { task: DefaultTask; label: string }[] = [
  { task: "chat", label: "Chat" },
  { task: "ideas", label: "Ideas" },
  { task: "edit", label: "Edits" },
  { task: "complete", label: "Completions" },
  { task: "triage", label: "Feed triage" },
];

/** Kin's tones (KI-102), in the order the menu lists them. */
const TONES: { value: Tone; label: string }[] = [
  { value: "plain", label: "Plain" },
  { value: "editorial", label: "Editorial" },
  { value: "casual", label: "Casual" },
  { value: "dry", label: "Dry" },
];

/** The most search results listed at once. */
const MAX_RESULTS = 40;

type Entry = { provider: ProviderModels; model: ModelInfo; ref: ModelRef };

/** Every term in the model's name, id or provider's name. */
const matches = (e: Entry, terms: string[]) => {
  const text = `${e.model.name} ${e.model.id} ${e.provider.name}`.toLowerCase();
  return terms.every((t) => text.includes(t));
};

/**
 * The models the pickers offer: the ones on, or with a search, any of the
 * usable providers' models, each with a switch. A task's default is always
 * on, so its switch can't be turned off.
 */
function EnabledModels({ providers, settings, onToggle }: { providers: ProviderModels[] | null; settings: KinSettings | null; onToggle: (model: ModelRef, on: boolean) => void }) {
  const [query, setQuery] = useState("");
  const all = useMemo<Entry[]>(
    () => (providers ?? []).filter(shown).flatMap((p) => p.models.map((m) => ({ provider: p, model: m, ref: { provider: p.id, model: m.id } }))),
    [providers],
  );
  const on = (ref: ModelRef) => !!settings?.enabled.some((e) => sameEntry(e, ref));
  const defaultFor = (ref: ModelRef) => TASKS.filter(({ task }) => sameEntry(settings?.tasks.find((t) => t.task === task)?.resolved, ref)).map((t) => t.label.toLowerCase());
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = terms.length ? all.filter((e) => matches(e, terms)).slice(0, MAX_RESULTS) : all.filter((e) => on(e.ref));

  return (
    <Group title="Models" data-testid="enabled-models">
      <div className="ki-settings-row ki-settings-row-block">
        <Input type="search" placeholder="Search all models" aria-label="Search all models" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {rows.map(({ provider, model, ref }) => {
        const tasks = defaultFor(ref);
        const note = [provider.name, priceLabel(model.price), tasks.length ? `Default for ${tasks.join(", ")}` : null].filter(Boolean).join(" · ");
        return (
          <Row key={`${provider.id}/${model.id}`} label={model.name} note={note} data-model={`${provider.id}/${model.id}`}>
            <Switch
              checked={on(ref)}
              disabled={!settings || tasks.length > 0}
              onCheckedChange={(next) => onToggle(ref, next)}
              aria-label={`${model.name}, ${provider.name}`}
            />
          </Row>
        );
      })}
      {terms.length > 0 && rows.length === 0 && <Row label="No models match." className="ki-settings-row-sub" />}
    </Group>
  );
}

/** Settings › Kin and models: the default model and effort per task, the
 *  models the pickers offer, this month's spend and the monthly cap, the
 *  tone Kin writes in (KI-102) and Kin's memory. */
export function ModelSettings() {
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [settings, setSettings] = useState<KinSettings | null>(null);
  const [providers, setProviders] = useState<ProviderModels[] | null>(null);
  const [cap, setCap] = useState("");

  const load = useCallback(async () => {
    try {
      const [u, s, p] = await Promise.all([kin.usage(), kin.settings(), listModels()]);
      setUsage(u);
      setSettings(s);
      setProviders(p);
      setCap(s.capUsd == null ? "" : String(s.capUsd));
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveCap = async () => {
    const trimmed = cap.trim().replace(/^\$/, "");
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && !(Number.isFinite(value) && value >= 0)) return toast.error("Enter an amount in dollars, or leave it empty for no cap.");
    try {
      setUsage(await kin.setCap(value));
      toast(value === null ? "No monthly cap." : `Monthly cap set to ${dollars(value)}.`);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const save = async (change: Promise<KinSettings>) => {
    try {
      setSettings(await change);
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <Page title="Kin and models">
      <Group title="Default models" data-testid="default-models">
        {TASKS.map(({ task, label }) => {
          const t = settings?.tasks.find((x) => x.task === task);
          return (
            <Row key={task} label={label} data-task={task}>
              <div className="ki-settings-inline">
                <Effort
                  levels={effortLevels(modelInfo(providers, t?.resolved))}
                  value={t?.resolved?.reasoning as ThinkingLevel | undefined}
                  onChange={(level) => void save(kin.setEffort(task, level))}
                  label={`${label} effort`}
                  disabled={!settings}
                />
                <ModelMenu
                  providers={providers}
                  enabled={settings?.enabled ?? null}
                  chosen={t?.chosen ?? null}
                  current={t?.resolved ?? null}
                  onChange={(model) => void save(kin.setModel(task, model))}
                  label={`${label} model`}
                  automatic="Automatic"
                  disabled={!settings}
                />
              </div>
            </Row>
          );
        })}
      </Group>

      <EnabledModels providers={providers} settings={settings} onToggle={(model, on) => void save(kin.setEnabled(model, on))} />

      <Group title="Spending">
        <Row label="This month">
          {usage && (
            <span className="ki-data" data-testid="spent">
              {dollars(usage.spentUsd)}
              {usage.capUsd != null && ` of ${dollars(usage.capUsd)}`}
              {usage.estimated && " (estimated)"}
            </span>
          )}
        </Row>
        {usage?.capUsd != null && (
          <div className="ki-settings-row ki-settings-row-block">
            <Meter.Root value={Math.min(usage.spentUsd, usage.capUsd)} max={usage.capUsd || 1} aria-label="Spent this month" data-reached={usage.capReached || undefined}>
              <Meter.Track>
                <Meter.Indicator />
              </Meter.Track>
            </Meter.Root>
            {usage.capReached && <p className="ki-error ki-text-s">Cap reached. Background work waits for next month or a higher cap.</p>}
          </div>
        )}
        {usage?.byTask.map((t) => (
          <Row key={t.task} label={`${t.task} · ${t.calls} call${t.calls === 1 ? "" : "s"}`} className="ki-settings-row-sub">
            <span className="ki-data ki-muted">{dollars(t.usd)}</span>
          </Row>
        ))}
        <Row label="Monthly cap" htmlFor="monthly-cap" note="US dollars. Subscriptions count as $0.">
          <div className="ki-settings-inline">
            <Input
              id="monthly-cap"
              className="ki-settings-cap ki-data"
              inputMode="decimal"
              placeholder="No cap"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveCap()}
              aria-label="Monthly cap in US dollars"
            />
            <Button size="sm" variant="outline" onClick={saveCap}>Save</Button>
          </div>
        </Row>
      </Group>

      <Group title="Kin">
        <Row label="Tone for summaries and ideas" data-testid="kin-tone" className="[&_.field-label]:sr-only">
          <SelectField<Tone>
            label="Tone for summaries and ideas"
            value={settings?.tone ?? "plain"}
            onValueChange={(value) => value && void save(kin.setTone(value))}
            options={TONES}
            disabled={!settings}
          />
        </Row>
        <Row label="What Kin remembers">
          <Button size="sm" variant="outline" onClick={openAboutYou}>About you</Button>
        </Row>
        <Row label="Developer panel">
          <Button size="sm" variant="ghost" className="relative" onClick={openKinDev}>Open<ShortcutHint id="kinDev" side="end" /></Button>
        </Row>
      </Group>
    </Page>
  );
}
