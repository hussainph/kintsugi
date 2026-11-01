import { FilePlus, FolderPlus, Tag } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  commandFilter,
} from "@kintsugi/ui/components/command";
import { hasTags, tagQuery, vocabulary } from "@kintsugi/core/tags";
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

const TAG = "tag:";

/** ⌘P jumps to a document; ⌘N / ⇧⌘N name a new document or folder. In the
 *  jump list, `#tag` keeps documents with that tag (several are ANDed), and a
 *  `#` being typed suggests the tags in use. */
export function Palette({ mode, docs, onOpen, onCreate, onClose }: Props) {
  const [query, setQuery] = useState("");
  const creating = mode && mode.kind !== "open" ? mode : null;
  const where = creating?.dir || "vault";
  const parsed = tagQuery(query);
  const tags = useMemo(() => vocabulary(docs.map((d) => d.tags)), [docs]);
  const shown = parsed.tags.length ? docs.filter((d) => hasTags(d.tags, parsed.tags)) : docs;
  const suggest =
    parsed.partial === null ? [] : tags.filter((t) => t.startsWith(parsed.partial!) && !parsed.tags.includes(t)).slice(0, 8);
  // Picking a suggested tag finishes the `#…` being typed.
  const pickTag = (tag: string) => setQuery(query.replace(/#\S*$/, `#${tag} `));

  return (
    <CommandDialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
        setQuery("");
      }}
      title={creating ? "Create" : "Jump to a document"}
    >
      <Command
        shouldFilter={!creating}
        // `#tag` words were applied above; only the other words are matched.
        filter={(value, search, keywords) => {
          if (value.startsWith(TAG)) return 1;
          const text = tagQuery(search).text;
          return text ? commandFilter(value, text, keywords) : 1;
        }}
      >
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={
            creating?.kind === "new-doc"
              ? `Title of a new document in ${where}…`
              : creating?.kind === "new-folder"
                ? `Name of a new folder in ${where}…`
                : "Jump to a document, or #tag…"
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
              {suggest.length > 0 && (
                <CommandGroup heading="Tags">
                  {suggest.map((tag) => (
                    <CommandItem key={tag} value={TAG + tag} onSelect={() => pickTag(tag)}>
                      <Tag />#{tag}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              <CommandGroup>
                {shown.map((doc) => (
                  <CommandItem
                    key={doc.path}
                    value={`${displayName(doc)} ${doc.path}`}
                    keywords={doc.tags}
                    onSelect={() => onOpen(doc.path)}
                  >
                    <StatusDot status={doc.status} />
                    <span className="max-w-[60%] shrink-0 truncate">{displayName(doc)}</span>
                    {doc.tags?.length ? (
                      <span className="min-w-0 shrink-4 truncate text-xs text-muted-foreground/80">{doc.tags.map((t) => `#${t}`).join(" ")}</span>
                    ) : null}
                    <span className="ml-auto min-w-0 shrink-2 truncate text-xs text-muted-foreground">
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
