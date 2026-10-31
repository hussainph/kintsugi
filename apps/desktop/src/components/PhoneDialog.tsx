import { Copy, RotateCcw } from "@kintsugi/ui/icons";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@kintsugi/ui/components/dialog";
import { Switch } from "@kintsugi/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@kintsugi/ui/components/tooltip";
import { phone, PhoneStatus } from "@/lib/phone";

type Props = {
  open: boolean;
  status: PhoneStatus | null;
  onStatus: (status: PhoneStatus) => void;
  onClose: () => void;
};

/** Why the phone can't connect yet, and what to do about it. */
const HINTS: Record<Exclude<PhoneStatus["tailscale"], "ready">, string> = {
  missing: "Install Tailscale on this Mac and your phone, and sign in to the same tailnet on both.",
  down: "Tailscale isn't connected on this Mac. Open Tailscale and connect.",
  no_https:
    "Your tailnet needs HTTPS certificates turned on: Tailscale admin console → DNS → HTTPS Certificates. Then turn phone access off and on.",
  not_serving: "Tailscale is connected but isn't forwarding to Kintsugi yet. Turn phone access off and on again.",
};

export function PhoneDialog({ open, status, onStatus, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (open) phone.status().then(onStatus).catch((e) => toast.error(String(e)));
  }, [open, onStatus]);

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
    toast("Pairing link copied. Paste it into Kintsugi on your phone.");
  };

  const enabled = status?.enabled ?? false;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md" aria-busy={busy}>
        <DialogHeader>
          <DialogTitle>Connect your phone</DialogTitle>
          <DialogDescription>
            Read, edit and capture notes into this vault from the Kintsugi app, over Tailscale, while this Mac is awake
            and Kintsugi is open.
          </DialogDescription>
        </DialogHeader>

        <label className="ki-phone-label flex items-center justify-between gap-[var(--space-xs)]">
          Phone access
          <Switch checked={enabled} disabled={busy || !status} onCheckedChange={(on) => run(() => phone.enable(on))} />
        </label>

        {enabled && status && (
          <div className="ki-stack-m ki-text-s">
            {status.problem && <p className="ki-error" role="alert">{status.problem}</p>}
            {status.tailscale === "ready" && qr && status.pair ? (
              <div className="flex flex-col items-center gap-[var(--space-s)]">
                <div
                  className="ki-pairing-code size-44 [&_svg]:size-full"
                  role="img"
                  aria-label="Pairing code"
                  dangerouslySetInnerHTML={{ __html: qr }}
                />
                <p className="ki-muted text-center">
                  Scan with your phone's camera to pair. Your Mac is at{" "}
                  <span className="ki-data text-(--neutral-10)">{status.url}</span>
                </p>
              </div>
            ) : (
              status.tailscale !== "ready" && <p className="ki-muted">{HINTS[status.tailscale]}</p>
            )}
          </div>
        )}

        {enabled && status && (
          <DialogFooter className="sm:justify-between">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(phone.reset)}>
                  <RotateCcw /> Unpair phones
                </Button>
              </TooltipTrigger>
              <TooltipContent>Makes a new pairing code; phones paired with the old one are signed out</TooltipContent>
            </Tooltip>
            <div className="flex flex-wrap gap-[var(--space-xs)]">
              {status.devPair && (
                <Tooltip>
                  <TooltipTrigger asChild><Button variant="outline" size="sm" onClick={() => copy(status.devPair!)}>Simulator link</Button></TooltipTrigger>
                  <TooltipContent>Pairs the iOS Simulator</TooltipContent>
                </Tooltip>
              )}
              {status.pair && (
                <Button size="sm" onClick={() => copy(status.pair!)}>
                  <Copy /> Copy link
                </Button>
              )}
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
