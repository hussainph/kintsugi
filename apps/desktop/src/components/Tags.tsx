import { Plus, Tag, X } from "lucide-react";
import { useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@kintsugi/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@kintsugi/ui/components/popover";
import { SidebarGroupAction } from "@kintsugi/ui/components/sidebar";
import { cn } from "@kintsugi/ui/lib/utils";
import { normalTag } from "@kintsugi/core/tags";

/** A document's tags, shown quietly beside its status. Tags are never
 *  required: an untagged document shows only a faint "Tag" button. */
export function DocTags({
  tags,
  vocabulary,
  onChange,
}: {
  tags: string[];
  /** Tags already in use in the vault, most used first. */
  vocabulary: string[];
  /** Called with an update, applied to the document's tags as they are
   *  now, so quick successive edits never undo each other. */
  onChange: (update: (tags: string[]) => string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Commas separate tags, as in a clip's tag field.
  const typed = query.split(",").map(normalTag).filter((t): t is string => !!t && !tags.includes(t));
  const add = (more: string[]) => {
    if (more.length) onChange((now) => [...now, ...more.filter((t) => !now.includes(t))]);
    setQuery("");
  };
  // Filtered here rather than by cmdk, so `#Glaze ` finds `glaze`.
  const needle = normalTag(query.split(",").pop() ?? "") ?? "";
  const suggestions = vocabulary.filter((t) => !tags.includes(t) && t.includes(needle));

  return (
    <span role="group" className="flex items-center gap-1.5" aria-label="Tags">
      {tags.map((tag) => (
        <span key={tag} className="group/tag inline-flex items-center rounded-full bg-muted/60 py-0.5 pr-1 pl-2 text-[11px] text-muted-foreground">
          #{tag}
          <button
            className="ml-0.5 rounded-full p-0.5 opacity-40 group-hover/tag:opacity-100 hover:text-foreground focus-visible:opacity-100"
            onClick={() => onChange((now) => now.filter((t) => t !== tag))}
            aria-label={`Remove tag ${tag}`}
            title={`Remove #${tag}`}
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-0.5 hover:text-foreground" title="Add a tag" aria-label="Add a tag">
            {tags.length ? <Plus className="size-3" /> : <><Tag className="size-3" /> Tag</>}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="w-60 p-0">
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Add a tag…"
              onKeyDown={(e) => {
                // A comma finishes a tag, as Enter does.
                if (e.key === "," && typed.length) {
                  e.preventDefault();
                  add(typed);
                }
              }}
            />
            <CommandList>
              <CommandEmpty>Type a new tag.</CommandEmpty>
              {typed.length > 0 && !vocabulary.includes(typed[0]) && (
                <CommandGroup>
                  <CommandItem value={`new:${query}`} onSelect={() => add(typed)}>
                    <Plus />
                    Add {typed.map((t) => `#${t}`).join(", ")}
                  </CommandItem>
                </CommandGroup>
              )}
              {suggestions.length > 0 && (
                <CommandGroup heading="In use">
                  {suggestions.map((tag) => (
                    <CommandItem key={tag} value={tag} onSelect={() => add([tag])}>
                      <Tag />#{tag}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </span>
  );
}

/** The sidebar's tag filter: pick tags, and the tree keeps only documents
 *  carrying all of them. */
export function TagFilter({
  vocabulary,
  counts,
  selected,
  onChange,
}: {
  vocabulary: string[];
  counts: Map<string, number>;
  selected: string[];
  onChange: (tags: string[]) => void;
}) {
  const toggle = (tag: string) => onChange(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag]);
  if (!vocabulary.length && !selected.length) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <SidebarGroupAction
          className={cn("[&>svg]:size-3.5", !selected.length && "text-sidebar-foreground/50")}
          title="Filter by tag"
          aria-label="Filter by tag"
        >
          <Tag />
        </SidebarGroupAction>
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="w-56 p-0">
        <Command>
          <CommandInput placeholder="Filter by tag…" />
          <CommandList>
            <CommandEmpty>No tags match.</CommandEmpty>
            <CommandGroup>
              {vocabulary.map((tag) => (
                <CommandItem key={tag} value={tag} onSelect={() => toggle(tag)} data-checked={selected.includes(tag)}>
                  <span className="truncate">#{tag}</span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">{counts.get(tag) ?? 0}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The active filters, each removable. */
export function TagChips({ tags, onRemove, className }: { tags: string[]; onRemove: (tag: string) => void; className?: string }) {
  if (!tags.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {tags.map((tag) => (
        <button
          key={tag}
          className="inline-flex items-center gap-0.5 rounded-full bg-sidebar-accent px-2 py-0.5 text-[11px] text-sidebar-accent-foreground hover:bg-sidebar-accent/70"
          onClick={() => onRemove(tag)}
          title={`Stop filtering by #${tag}`}
          aria-label={`Stop filtering by ${tag}`}
        >
          #{tag}
          <X className="size-2.5" />
        </button>
      ))}
    </div>
  );
}
