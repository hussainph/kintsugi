import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
import { Kbd } from "@kintsugi/ui/components/kbd";
import { Meter } from "@kintsugi/ui/graphical";
import { ModelMenu } from "@/kin/ModelMenu";
import { models as listModels, type ProviderModels } from "@/lib/ai";
import { dollars, kin, type DefaultTask, type KinSettings, type UsageReport, openAboutYou, openKinDev } from "@/lib/kin";
import { Group, Page, Row } from "./parts";

/** The tasks with a default model, in the order they're listed. */
const TASKS: { task: DefaultTask; label: string }[] = [
  { task: "chat", label: "Chat" },
  { task: "ideas", label: "Ideas" },
  { task: "edit", label: "Edits" },
  { task: "complete", label: "Completions" },
  { task: "triage", label: "Feed triage" },
];

/** Settings › Kin and models: the default model per task, this month's
 *  spend and the monthly cap, and Kin's memory. */
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

  const pick = async (task: DefaultTask, model: Parameters<typeof kin.setModel>[1]) => {
    try {
      setSettings(await kin.setModel(task, model));
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
              <ModelMenu
                providers={providers}
                chosen={t?.chosen ?? null}
                current={t?.resolved ?? null}
                onChange={(model) => void pick(task, model)}
                label={`${label} model`}
                automatic="Automatic"
                disabled={!settings}
              />
            </Row>
          );
        })}
      </Group>

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
        <Row label="What Kin remembers">
          <Button size="sm" variant="outline" onClick={openAboutYou}>About you</Button>
        </Row>
        <Row label="Developer panel">
          <Button size="sm" variant="ghost" onClick={openKinDev}>Open <Kbd>⇧⌘K</Kbd></Button>
        </Row>
      </Group>
    </Page>
  );
}
