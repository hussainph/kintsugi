import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
import { Switch } from "@kintsugi/ui/components/switch";
import { SelectField } from "@kintsugi/ui/graphical";
import { KEY_PAGES, web, type WebProvider, type WebSettings as Settings } from "@/lib/web";
import { Group, Page, Row } from "./parts";

const ENV: Record<WebProvider, string> = { exa: "EXA_API_KEY", brave: "BRAVE_API_KEY", tavily: "TAVILY_API_KEY" };

/** Settings › Web: whether Kin may use the web (and its unattended helpers,
 *  such as the daily Ideas batch), which search provider it uses, and each
 *  provider's key. Keys are saved in Rust and never read back. */
export function WebSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<WebProvider, string>>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    web.settings().then(setSettings).catch((e) => toast.error(String(e)));
  }, []);

  const run = async (action: () => Promise<Settings>, done?: string) => {
    setBusy(true);
    try {
      setSettings(await action());
      if (done) toast(done);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async (id: WebProvider) => {
    const key = drafts[id]?.trim();
    if (!key) return;
    await run(() => web.setKey(id, key), "Key saved.");
    setDrafts((d) => ({ ...d, [id]: "" }));
  };

  const enabled = settings?.enabled ?? false;
  const withKeys = settings?.providers.filter((p) => p.key) ?? [];

  return (
    <Page title="Web">
      <Group aria-busy={busy}>
        <Row
          label="Web search and pages"
          htmlFor="web-tools"
          note={enabled && settings && !settings.active ? "No search key yet. Kin can still read pages." : "Searches go to the provider below."}
        >
          <Switch id="web-tools" checked={enabled} disabled={busy || !settings} onCheckedChange={(on) => void run(() => web.setEnabled(on))} />
        </Row>
        {enabled && (
          <Row label="Background helpers can use it" htmlFor="web-helpers" note="Such as the daily Ideas batch.">
            <Switch
              id="web-helpers"
              checked={settings?.helpers ?? false}
              disabled={busy || !settings}
              onCheckedChange={(on) => void run(() => web.setHelpers(on))}
            />
          </Row>
        )}
        {enabled && withKeys.length > 0 && (
          <Row label="Search provider" data-testid="web-provider" className="[&_.field-label]:sr-only">
            <SelectField<WebProvider>
              label="Search provider"
              value={settings?.active ?? undefined}
              onValueChange={(value) => value && void run(() => web.setProvider(value))}
              options={withKeys.map((p) => ({ value: p.id, label: p.name }))}
            />
          </Row>
        )}
      </Group>

      {enabled && (
        <Group title="Keys" data-testid="web-keys">
          {settings?.providers.map((p) => (
            <Row
              key={p.id}
              label={p.name}
              htmlFor={`web-key-${p.id}`}
              data-web-provider={p.id}
              note={p.key === "settings" ? "Saved" : p.key === "environment" ? `From ${ENV[p.id]}` : undefined}
              className={p.key === "settings" ? undefined : "ki-settings-row-wide"}
            >
              <div className="ki-settings-inline">
                {p.key === "settings" ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => web.setKey(p.id, null), "Key removed.")}>
                    Remove
                  </Button>
                ) : (
                  <>
                    <Input
                      id={`web-key-${p.id}`}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      className="ki-data"
                      placeholder="API key"
                      value={drafts[p.id] ?? ""}
                      onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && void saveKey(p.id)}
                      aria-label={`${p.name} API key`}
                    />
                    <Button size="sm" variant="outline" disabled={busy || !drafts[p.id]?.trim()} onClick={() => void saveKey(p.id)}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void openUrl(KEY_PAGES[p.id]).catch((e) => toast.error(String(e)))}>
                      Get a key
                    </Button>
                  </>
                )}
              </div>
            </Row>
          ))}
        </Group>
      )}
    </Page>
  );
}
