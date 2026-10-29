import { FilePlus, FolderPlus } from "lucide-react";
import { useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@kintsugi/ui/components/command";
import { displayName, Doc } from "@/lib/vault";
import { StatusDot } from "./Sidebar";

export type PaletteMode =
  | { kind: "open" }
  | { kind: "new-doc"; dir: string }
  | { kind: "new-folder"; dir: string };

type Props = {
  mode: PaletteMode | null;
  docs: Doc[];
  onOpen: (path: string) => void;
  onCreate: (mode: PaletteMode, name: string) => void;
  onClose: () => void;
};

/** ⌘P jumps to a document; ⌘N / ⇧⌘N name a new document or folder. */
export function Palette({ mode, docs, onOpen, onCreate, onClose }: Props) {
  const [query, setQuery] = useState("");
  const creating = mode && mode.kind !== "open" ? mode : null;
  const where = creating?.dir || "vault";

  return (
    <CommandDialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
        setQuery("");
      }}
      title={creating ? "Create" : "Jump to a document"}
    >
      <Command shouldFilter={!creating}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={
            creating?.kind === "new-doc"
              ? `Title of a new document in ${where}…`
              : creating?.kind === "new-folder"
                ? `Name of a new folder in ${where}…`
                : "Jump to a document…"
          }
        />
        <CommandList>
          {creating ? (
            query.trim() && (
              <CommandGroup>
                <CommandItem onSelect={() => onCreate(creating, query.trim())}>
                  {creating.kind === "new-doc" ? <FilePlus /> : <FolderPlus />}
                  Create “{query.trim()}”
                </CommandItem>
              </CommandGroup>
            )
          ) : (
            <>
              <CommandEmpty>No documents match.</CommandEmpty>
              <CommandGroup>
                {docs.map((doc) => (
                  <CommandItem
                    key={doc.path}
                    value={`${displayName(doc)} ${doc.path}`}
                    onSelect={() => onOpen(doc.path)}
                  >
                    <StatusDot status={doc.status} />
                    <span className="truncate">{displayName(doc)}</span>
                    <span className="ml-auto truncate text-xs text-muted-foreground">
                      {doc.path}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
