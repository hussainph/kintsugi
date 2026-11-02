import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DESTINATIONS } from "@kintsugi/core/export";
import { HUMAN_STATEMENT } from "@kintsugi/core/publish";
import { Button } from "@kintsugi/ui/components/button";
import { Switch } from "@kintsugi/ui/components/switch";
import { Textarea } from "@kintsugi/ui/components/textarea";
import { exporting, type ExportSettings as Settings } from "@/lib/exporting";
import { Group, Page, Row } from "./parts";

/** Settings › Export: which destinations the Export menu offers, and the
 *  provenance every export and publish can carry. */
export function ExportSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [wording, setWording] = useState("");
  const typing = useRef<number | undefined>(undefined);

  useEffect(() => {
    exporting.settings().then((s) => { setSettings(s); setWording(s.statementText ?? HUMAN_STATEMENT); }).catch((e) => toast.error(String(e)));
  }, []);

  const change = async (next: Partial<Settings>) => {
    try {
      const s = await exporting.configure(next);
      setSettings(s);
      return s;
    } catch (e) {
      toast.error(String(e));
      return null;
    }
  };

  const toggle = (id: string, on: boolean) => {
    if (!settings) return;
    const order = DESTINATIONS.map((d) => d.id);
    const ids = on ? [...settings.destinations, id] : settings.destinations.filter((d) => d !== id);
    // Known destinations in their usual order; any others (added later) after them.
    void change({ destinations: [...order.filter((d) => ids.includes(d)), ...ids.filter((d) => !order.includes(d))] });
  };

  // The wording saves as it's typed (and on blur), so closing Settings
  // straight after typing keeps it.
  const saveWording = async (value: string) => {
    window.clearTimeout(typing.current);
    const text = value.trim();
    if (!text) return;
    await change({ statementText: text === HUMAN_STATEMENT ? "" : text });
  };
  useEffect(() => () => window.clearTimeout(typing.current), []);

  return (
    <Page title="Export">
      <Group title="In the Export menu">
        <ul aria-label="Export destinations">
          {DESTINATIONS.map((d) => (
            <li key={d.id}>
              <Row label={d.label}>
                <Switch
                  checked={settings?.destinations.includes(d.id) ?? false}
                  disabled={!settings}
                  onCheckedChange={(on) => toggle(d.id, on)}
                  aria-label={d.label}
                />
              </Row>
            </li>
          ))}
        </ul>
      </Group>

      <Group title="Every export and post">
        <Row label="Sources appendix">
          <Switch checked={settings?.appendix ?? false} disabled={!settings} onCheckedChange={(on) => void change({ appendix: on })} aria-label="Sources appendix by default" />
        </Row>
        <Row label="“Written by a human” statement" note="Text you accept from ⌘K is written by AI.">
          <Switch checked={settings?.statement ?? false} disabled={!settings} onCheckedChange={(on) => void change({ statement: on })} aria-label="Add a “written by a human” statement" />
        </Row>
        <div className="ki-settings-row ki-settings-row-block">
          <Textarea
            className="ki-text-s"
            value={wording}
            disabled={!settings}
            maxLength={600}
            onChange={(e) => {
              const value = e.target.value;
              setWording(value);
              window.clearTimeout(typing.current);
              typing.current = window.setTimeout(() => void saveWording(value), 500);
            }}
            onBlur={() => void saveWording(wording)}
            aria-label="Statement wording"
          />
          {wording.trim() !== HUMAN_STATEMENT && (
            <Button size="sm" variant="ghost" className="ki-settings-end" onClick={() => { setWording(HUMAN_STATEMENT); void saveWording(HUMAN_STATEMENT); }}>
              Reset
            </Button>
          )}
        </div>
      </Group>
    </Page>
  );
}
