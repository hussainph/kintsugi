import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DESTINATIONS } from "@kintsugi/core/export";
import { HUMAN_STATEMENT } from "@kintsugi/core/publish";
import { Button } from "@kintsugi/ui/components/button";
import { Switch } from "@kintsugi/ui/components/switch";
import { Textarea } from "@kintsugi/ui/components/textarea";
import { exporting, type ExportSettings as Settings } from "@/lib/exporting";

/** Settings → Export: which destinations the Export menu offers, and the
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
    <section className="space-y-3 text-sm" aria-labelledby="export-settings">
      <h3 id="export-settings" className="font-medium">Export</h3>
      <p className="text-muted-foreground">In the Export menu:</p>
      <ul className="space-y-2" aria-label="Export destinations">
        {DESTINATIONS.map((d) => (
          <li key={d.id} className="flex items-start gap-2">
            <Switch
              className="mt-0.5"
              checked={settings?.destinations.includes(d.id) ?? false}
              disabled={!settings}
              onCheckedChange={(on) => toggle(d.id, on)}
              aria-label={d.label}
            />
            <div>
              <div>{d.label}</div>
              <div className="text-xs text-muted-foreground">{d.hint}</div>
            </div>
          </li>
        ))}
      </ul>

      <label className="flex items-center gap-2 pt-1">
        <Switch checked={settings?.appendix ?? false} disabled={!settings} onCheckedChange={(on) => void change({ appendix: on })} aria-label="Sources appendix by default" />
        Sources appendix by default
      </label>
      <p className="text-xs text-muted-foreground">Lists the clips a piece references, at the end of a post or export.</p>

      <label className="flex items-center gap-2 pt-1">
        <Switch checked={settings?.statement ?? false} disabled={!settings} onCheckedChange={(on) => void change({ statement: on })} aria-label="Add a “written by a human” statement" />
        Add a “written by a human” statement
      </label>
      <Textarea
        className="text-sm"
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
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Ends every export and post while it's on. Kintsugi can't check it for you: text you accept from ⌘K is written by the AI.
        </p>
        {wording.trim() !== HUMAN_STATEMENT && (
          <Button size="sm" variant="ghost" onClick={() => { setWording(HUMAN_STATEMENT); void saveWording(HUMAN_STATEMENT); }}>
            Reset
          </Button>
        )}
      </div>
    </section>
  );
}
