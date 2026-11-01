import { Button } from "@kintsugi/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@kintsugi/ui/components/dialog";

export type OutsideChoice = "disk" | "mine";

type Props = {
  /** The open document another app changed (`disk` is its text) or removed
   *  (`disk` null) while it had unsaved edits that couldn't be merged. */
  collision: { path: string; disk: string | null } | null;
  onChoose: (choice: OutsideChoice) => void;
};

const name = (path: string) => path.split("/").pop() ?? path;

/** Asked only on a true collision; every other outside edit reloads or merges. */
export function OutsideDialog({ collision, onChoose }: Props) {
  const gone = collision?.disk === null;
  const file = collision ? name(collision.path) : "";
  return (
    <Dialog open={collision !== null}>
      <DialogContent className="sm:max-w-md" showCloseButton={false} onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{gone ? `“${file}” was moved or deleted in another app` : `“${file}” changed in another app`}</DialogTitle>
          <DialogDescription>
            {gone
              ? "You have changes here that aren’t saved. Keep them to save the document again where it was, or close it and let it go."
              : "You changed the same lines here before saving, so the two versions can’t be combined. Nothing has been saved over either one."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onChoose("disk")}>
            {gone ? "Close it" : "Use the file on disk"}
          </Button>
          <Button size="sm" autoFocus onClick={() => onChoose("mine")}>
            Keep mine
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
