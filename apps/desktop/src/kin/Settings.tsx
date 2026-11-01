import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@kintsugi/ui/components/dialog";
import { Input } from "@kintsugi/ui/components/input";
import { OptionalTools } from "@/components/OptionalTools";
import { BlogSettings } from "@/publish/BlogSettings";
import { dollars, kin, KinSettings, KinTask, modelLabel, openAboutYou, openKinDev, sameModel, UsageReport } from "@/lib/kin";

/** The plain privacy statement, as the vision puts it. */
export const PRIVACY =
  "Your writing, collection and Kin's memory stay on this Mac. What leaves it: calls to your own AI provider with your own key, fetching the sources you follow or save, and one-time downloads of local models and tools. Nothing is used for training.";

const TASKS: Record<KinTask, { label: string; hint: string }> = {
  chat: { label: "Chat", hint: "Talking with Kin. Worth a strong model." },
  ideas: { label: "Ideas", hint: "Daily ideas. Worth a strong model." },
  triage: { label: "Feed triage", hint: "Sorting the feed in the background. A cheap model is fine." },
};

/** Settings: privacy, AI spending and its monthly cap, and Kin's models.
 *  Opens on ⌘, or the `kintsugi:open-settings` event. */
export function Settings() {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [settings, setSettings] = useState<KinSettings | null>(null);
  const [cap, setCap] = useState("");

  const load = useCallback(async () => {
    try {
      const [u, s] = await Promise.all([kin.usage(), kin.settings()]);
      setUsage(u);
      setSettings(s);
      setCap(s.capUsd == null ? "" : String(s.capUsd));
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  useEffect(() => {
    const show = () => setOpen(true);
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key === ",") {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("kintsugi:open-settings", show);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("kintsugi:open-settings", show);
      window.removeEventListener("keydown", key, true);
    };
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

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

  const pick = async (task: KinTask, value: string) => {
    const options = settings?.tasks.find((t) => t.task === task)?.options ?? [];
    const model = value === "" ? null : options[Number(value)] ?? null;
    try {
      setSettings(await kin.setModel(task, model && { provider: model.provider, model: model.model, reasoning: model.reasoning }));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const spentShare = usage?.capUsd ? Math.min(1, usage.spentUsd / usage.capUsd) : 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Privacy, AI spending, Kin's models, optional tools and the blog.</DialogDescription>
        </DialogHeader>

        <section className="space-y-2 text-sm">
          <h3 className="font-medium">Privacy</h3>
          <p className="text-muted-foreground" data-testid="privacy">{PRIVACY}</p>
        </section>

        <section className="space-y-3 text-sm">
          <h3 className="font-medium">AI spending</h3>
          {usage && (
            <div className="space-y-2">
              <p>
                <span className="text-lg font-medium tabular-nums">{dollars(usage.spentUsd)}</span>{" "}
                <span className="text-muted-foreground">
                  this month{usage.capUsd != null && ` of ${dollars(usage.capUsd)}`}
                  {usage.estimated && " (estimated)"}
                </span>
              </p>
              {usage.capUsd != null && (
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={usage.capReached ? "h-full bg-destructive" : "h-full bg-primary"}
                    style={{ width: `${spentShare * 100}%` }}
                  />
                </div>
              )}
              {usage.capReached && (
                <p className="text-destructive">The cap is reached. Background work has stopped until next month or a higher cap.</p>
              )}
              {usage.byTask.length > 0 && (
                <ul className="text-muted-foreground">
                  {usage.byTask.map((t) => (
                    <li key={t.task} className="flex justify-between tabular-nums">
                      <span>{t.task} · {t.calls} call{t.calls === 1 ? "" : "s"}</span>
                      <span>{dollars(t.usd)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <label className="flex items-center gap-2">
            <span className="shrink-0">Monthly cap</span>
            <Input
              className="h-8 w-28"
              inputMode="decimal"
              placeholder="No cap"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveCap()}
              aria-label="Monthly cap in US dollars"
            />
            <Button size="sm" variant="outline" onClick={saveCap}>Save</Button>
          </label>
          <p className="text-xs text-muted-foreground">
            In US dollars. Prices are estimates; subscription logins and local models count as free.
          </p>
        </section>

        <section className="space-y-3 text-sm">
          <h3 className="font-medium">Kin's models</h3>
          {settings?.tasks.map((t) => {
            const chosenIndex = t.chosen ? t.options.findIndex((o) => sameModel(o, t.chosen)) : -1;
            return (
              <label key={t.task} className="block space-y-1">
                <span className="flex justify-between">
                  <span>{TASKS[t.task].label}</span>
                  <span className="text-xs text-muted-foreground">{t.resolved ? `Using ${modelLabel(t.resolved)}` : "No usable provider"}</span>
                </span>
                <select
                  className="h-8 w-full rounded-md border bg-transparent px-2"
                  value={chosenIndex < 0 ? "" : String(chosenIndex)}
                  onChange={(e) => pick(t.task, e.target.value)}
                >
                  <option value="">Automatic</option>
                  {t.options.map((o, i) => (
                    <option key={i} value={String(i)}>
                      {modelLabel(o)}{o.usable ? "" : " (not set up)"}
                    </option>
                  ))}
                </select>
                <span className="block text-xs text-muted-foreground">{TASKS[t.task].hint}</span>
              </label>
            );
          })}
        </section>

        <OptionalTools open={open} />

        <BlogSettings />

        <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => { setOpen(false); openAboutYou(); }}>
          What Kin remembers (About you)
        </Button>
        <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => { setOpen(false); openKinDev(); }}>
          Try Kin (developer panel, ⇧⌘K)
        </Button>
      </DialogContent>
    </Dialog>
  );
}
