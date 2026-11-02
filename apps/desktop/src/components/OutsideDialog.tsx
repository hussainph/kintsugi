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
          <DialogDescription>{gone ? "Your changes here aren’t saved." : "Both versions changed the same lines. Neither has been overwritten."}</DialogDescription>{/* copy-lint-allow: what's at stake (unsaved or both kept) isn't visible */}
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
