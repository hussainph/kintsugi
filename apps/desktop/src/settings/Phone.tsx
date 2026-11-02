import { Copy, RotateCcw } from "@kintsugi/ui/icons";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Switch } from "@kintsugi/ui/components/switch";
import { phone, PhoneStatus } from "@/lib/phone";
import { Group, Page, Row } from "./parts";

type Props = {
  status: PhoneStatus | null;
  onStatus: (status: PhoneStatus) => void;
};

/** What to do when the phone can't connect yet. */
const HINTS: Record<Exclude<PhoneStatus["tailscale"], "ready">, string> = {
  missing: "Install Tailscale on this Mac and your phone, signed in to the same tailnet.",
  down: "Tailscale isn't connected on this Mac. Open Tailscale and connect.",
  no_https: "Turn on HTTPS certificates in the Tailscale admin console (DNS), then turn phone access off and on.",
  not_serving: "Tailscale isn't forwarding to Kintsugi yet. Turn phone access off and on.",
};

/** Settings › Phone: phone access over Tailscale, and pairing. */
export function PhoneSettings({ status, onStatus }: Props) {
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    phone.status().then(onStatus).catch((e) => toast.error(String(e)));
  }, [onStatus]);

  useEffect(() => {
    if (!status?.pair) return setQr(null);
    QRCode.toString(status.pair, { type: "svg", margin: 0, errorCorrectionLevel: "M" }).then(setQr);
  }, [status?.pair]);

  const run = async (action: () => Promise<PhoneStatus>) => {
    setBusy(true);
    try {
      onStatus(await action());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast("Pairing link copied.");
  };

  const enabled = status?.enabled ?? false;

  return (
    <Page title="Phone">
      <Group aria-busy={busy}>
        <Row label="Phone access" htmlFor="phone-access" note="Over Tailscale, while this Mac is awake and Kintsugi is open.">
          <Switch id="phone-access" checked={enabled} disabled={busy || !status} onCheckedChange={(on) => run(() => phone.enable(on))} />
        </Row>
        {enabled && status?.problem && (
          <div className="ki-settings-row">
            <p className="ki-error ki-text-s" role="alert">{status.problem}</p>
          </div>
        )}
        {enabled && status && status.tailscale !== "ready" && (
          <div className="ki-settings-row">
            <p className="ki-muted ki-text-s">{HINTS[status.tailscale]}</p>
          </div>
        )}
        {enabled && status?.tailscale === "ready" && qr && status.pair && (
          <div className="ki-settings-row ki-settings-row-block ki-settings-pairing">
            <div className="ki-pairing-code size-44 [&_svg]:size-full" role="img" aria-label="Pairing code" dangerouslySetInnerHTML={{ __html: qr }} />
            <span className="ki-data ki-muted">{status.url}</span>
          </div>
        )}
        {enabled && status && (
          <div className="ki-settings-row">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(phone.reset)}>
              <RotateCcw /> Unpair phones
            </Button>
            <div className="ki-settings-inline">
              {status.devPair && (
                <Button variant="outline" size="sm" onClick={() => copy(status.devPair!)}>Simulator link</Button>
              )}
              {status.pair && (
                <Button size="sm" onClick={() => copy(status.pair!)}>
                  <Copy /> Copy link
                </Button>
              )}
            </div>
          </div>
        )}
      </Group>
    </Page>
  );
}
