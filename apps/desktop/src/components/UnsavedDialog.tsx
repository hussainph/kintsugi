import { Button } from "@kintsugi/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@kintsugi/ui/components/dialog";
import type { Failure } from "@/lib/saves";

export type UnsavedChoice = "retry" | "discard" | "stay";

type Props = {
  failures: Failure[] | null;
  /** Why the writer is being asked: what waits for the save. */
  action: string;
  onChoose: (choice: UnsavedChoice) => void;
};

const name = (path: string) => path.split("/").pop() ?? path;

/** Shown when a save failed and the writer tried to leave the document. */
export function UnsavedDialog({ failures, action, onChoose }: Props) {
  const files = failures ?? [];
  const title = files.length === 1 ? `“${name(files[0].path)}” isn’t saved` : `${files.length} documents aren’t saved`;
  return (
    <Dialog open={failures !== null} onOpenChange={(open) => !open && onChoose("stay")}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Kintsugi couldn’t write your latest changes to disk, so it hasn’t {action} yet. Your changes are kept
            here until a save works or you discard them.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {files.map((f) => (
            <li key={f.path}>
              <span className="font-medium text-foreground">{f.path}</span>: {f.error}
            </li>
          ))}
        </ul>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => onChoose("discard")}>
            Discard changes
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onChoose("stay")}>
              Keep editing
            </Button>
            <Button size="sm" autoFocus onClick={() => onChoose("retry")}>
              Try again
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
