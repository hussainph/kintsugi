import { useState, type CSSProperties } from "react";
import { Button } from "@kintsugi/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@kintsugi/ui/components/dialog";

type Props = {
  initialOpen?: boolean;
  radius?: number;
  duration?: number;
  reducedMotion?: boolean;
  title?: string;
};
/** The same Radix-backed primitives as the product; focus trapping and Escape remain real. */
export function DialogPreview({
  initialOpen = true,
  radius = 0.625,
  duration = 100,
  reducedMotion = false,
  title = "Move this clip to Trash?",
}: Props) {
  const [open, setOpen] = useState(initialOpen);
  const [result, setResult] = useState("The saved image goes with the clip.");
  return (
    <div
      className="flex min-h-svh flex-col items-center justify-center gap-4 p-8"
      style={{ "--radius": `${radius}rem` } as CSSProperties}
    >
      <style>{`[data-slot="dialog-content"],[data-slot="dialog-overlay"]{--radius:${radius}rem;animation-duration:${reducedMotion ? 0 : duration}ms!important;transition-duration:${reducedMotion ? 0 : duration}ms!important}${reducedMotion ? '[data-slot="dialog-content"],[data-slot="dialog-overlay"]{animation:none!important}' : ""}`}</style>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline">Move clip to Trash…</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Its saved image goes with it. You can recover both from the Mac’s
              Trash.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            In Lab, this confirmation only changes the message behind the
            dialog.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button
                variant="ghost"
                onClick={() => setResult("Kept the clip in this preview.")}
              >
                Keep it
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setResult(
                  "Moved the fixture clip to Trash. No files were touched.",
                );
                setOpen(false);
              }}
            >
              Move to Trash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <p
        className="max-w-sm text-center text-sm text-muted-foreground"
        role="status"
      >
        {result}
      </p>
    </div>
  );
}
