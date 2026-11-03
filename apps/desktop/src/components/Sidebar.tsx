import { Bookmark, ChevronRight, FileText, Folder, Lightbulb, Rss, Settings, Smartphone, UserRound } from "@kintsugi/ui/icons";
import { useCallback, useMemo, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@kintsugi/ui/components/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@kintsugi/ui/components/context-menu";
import { Input } from "@kintsugi/ui/components/input";
import { Kbd } from "@kintsugi/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@kintsugi/ui/components/tooltip";
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarFooter,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarTrigger,
  useSidebar,
} from "@kintsugi/ui/components/sidebar";
import { cn } from "@kintsugi/ui/lib/utils";
import { openAboutYou, openSettings } from "@/lib/kin";
import { displayName, Entry, filterTree, flatten, parentDir } from "@/lib/vault";
import { hasTags, vocabulary } from "@kintsugi/core/tags";
import { TagChips, TagFilter } from "./Tags";

type Props = {
  tree: Entry[];
  vaultName: string;
  active: string | null;
  libraryOpen: boolean;
  onLibrary: () => void;
  feedOpen: boolean;
  onFeed: () => void;
  ideasOpen?: boolean;
  onIdeas?: () => void;
  selectedDir: string;
  onOpen: (path: string) => void;
  onSelectDir: (path: string) => void;
  onNewDoc: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (path: string, name: string) => void;
  onTrash: (path: string) => void;
  phoneOn: boolean;
  onPhone: () => void;
  settingsOpen?: boolean;
  /** Settings covers the app: nothing here takes focus or clicks. */
  inert?: boolean;
  /** Show only documents carrying every one of these tags. Kept here when
   *  the parent doesn't hold it (the Lab's previews). */
  tagFilter?: string[];
  onTagFilter?: (tags: string[]) => void;
};

const SIDEBAR_KEY = "kintsugi:sidebar";
/** Expanded or collapsed to the icon rail, kept across restarts. Toggled by
 *  the trigger and ⌘\ (⌘B is the editor's bold). */
export function useSidebarOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) !== "collapsed"; } catch { return true; }
  });
  const change = useCallback((next: boolean) => {
    setOpen(next);
    try { localStorage.setItem(SIDEBAR_KEY, next ? "expanded" : "collapsed"); } catch { /* A convenience only. */ }
  }, []);
  return [open, change];
}

export function Sidebar(props: Props) {
  const collapsed = useSidebar().state === "collapsed";
  const [renaming, setRenaming] = useState<string | null>(null);
  const [ownFilter, setOwnFilter] = useState<string[]>([]);
  const { tree } = props;
  const tagFilter = props.tagFilter ?? ownFilter;
  const setTagFilter = props.onTagFilter ?? setOwnFilter;
  const docs = useMemo(() => flatten(tree), [tree]);
  const tags = useMemo(() => vocabulary(docs.map((d) => d.tags)), [docs]);
  const counts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const doc of docs) for (const tag of doc.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return counts;
  }, [docs]);
  const shown = useMemo(
    () => (tagFilter.length ? filterTree(tree, (doc) => hasTags(doc.tags, tagFilter)) : tree),
    [tree, tagFilter],
  );

  const rename = (entry: Entry) => (
    <Input
      autoFocus
      aria-label={`Rename ${entry.name}`}
      defaultValue={entry.name}
      onFocus={(e) => e.target.setSelectionRange(0, entry.name.replace(/\.mdx?$/, "").length)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") setRenaming(null);
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onBlur={(e) => {
        const name = e.target.value.trim();
        setRenaming(null);
        if (name && name !== entry.name) props.onRename(entry.path, name);
      }}
    />
  );

  const menu = (entry: Entry, row: React.ReactNode) => {
    const dir = entry.kind === "folder" ? entry.path : parentDir(entry.path);
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={() => props.onNewDoc(dir)}>
            New document<ContextMenuShortcut>⌘N</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => props.onNewFolder(dir)}>
            New folder<ContextMenuShortcut>⇧⌘N</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setRenaming(entry.path)}>Rename</ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => props.onTrash(entry.path)}>
            Move to Trash<ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const keys = (path: string) => (e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && e.metaKey) props.onTrash(path);
    if (e.key === "F2") setRenaming(path);
  };

  const render = (entry: Entry): React.ReactNode => {
    if (entry.kind === "doc") {
      return (
        <SidebarMenuItem key={entry.path}>
          {renaming === entry.path
            ? rename(entry)
            : menu(
                entry,
                <SidebarMenuButton
                  isActive={props.active === entry.path}
                  onClick={() => props.onOpen(entry.path)}
                  onDoubleClick={() => setRenaming(entry.path)}
                  onKeyDown={keys(entry.path)}
                  title={entry.path}
                >
                  <FileText />
                  <span className="truncate">{displayName(entry)}</span>
                  <StatusDot status={entry.status} className="ml-auto" />
                </SidebarMenuButton>,
              )}
        </SidebarMenuItem>
      );
    }
    return (
      <SidebarMenuItem key={entry.path}>
        <Collapsible defaultOpen className="group/collapsible [&[data-state=open]>button>svg:first-child]:rotate-90">
          {renaming === entry.path
            ? rename(entry)
            : menu(
                entry,
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton
                    className={cn(props.selectedDir === entry.path && "ki-medium")}
                    onClick={() => props.onSelectDir(entry.path)}
                    onDoubleClick={() => setRenaming(entry.path)}
                    onKeyDown={keys(entry.path)}
                  >
                    <ChevronRight className="ki-chevron" />
                    <Folder />
                    <span className="truncate">{entry.name}</span>
                  </SidebarMenuButton>
                </CollapsibleTrigger>,
              )}
          <CollapsibleContent>
            <SidebarMenuSub className="mr-0 pr-0">{entry.children.map(render)}</SidebarMenuSub>
          </CollapsibleContent>
        </Collapsible>
      </SidebarMenuItem>
    );
  };

  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const phoneLabel = props.phoneOn ? "Phone access on" : "Connect your phone";

  return (
    <SidebarRoot collapsible="icon" inert={props.inert}>
      {/* Room for the traffic lights; the whole strip drags the window. In the
          rail they take the strip, so the trigger sits under them. */}
      <SidebarHeader
        className="h-10 flex-row items-center justify-end group-data-[collapsible=icon]:h-auto group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:pt-10"
        data-tauri-drag-region
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarTrigger aria-label={toggleLabel} />
          </TooltipTrigger>
          <TooltipContent side="right">
            {toggleLabel} <Kbd>⌘\</Kbd>
          </TooltipContent>
        </Tooltip>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={props.feedOpen} onClick={props.onFeed} tooltip={{ children: <>Feed <Kbd>⇧⌘F</Kbd></> }}>
                <Rss />
                <span>Feed</span>
                <span className="ki-data ki-muted ml-auto group-data-[collapsible=icon]:hidden">⇧⌘F</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={props.libraryOpen} onClick={props.onLibrary} tooltip={{ children: <>Inspiration <Kbd>⇧⌘I</Kbd></> }}>
                <Bookmark />
                <span>Inspiration</span>
                <span className="ki-data ml-auto ki-muted group-data-[collapsible=icon]:hidden">⇧⌘I</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={props.ideasOpen} onClick={props.onIdeas} tooltip={{ children: <>Ideas <Kbd>⇧⌘E</Kbd></> }}>
                <Lightbulb />
                <span>Ideas</span>
                <span className="ki-data ki-muted ml-auto group-data-[collapsible=icon]:hidden">⇧⌘E</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {/* The tree needs its names; the rail leaves it out. */}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarGroupLabel
                className={cn("cursor-default", props.selectedDir === "" && "text-sidebar-foreground")}
                onClick={() => props.onSelectDir("")}
              >
                {props.vaultName}
              </SidebarGroupLabel>
            </TooltipTrigger>
            <TooltipContent>New documents go to the vault root</TooltipContent>
          </Tooltip>
          <TagFilter vocabulary={tags} counts={counts} selected={tagFilter} onChange={setTagFilter} />
          <TagChips
            className="px-2 pb-1"
            tags={tagFilter}
            onRemove={(tag) => setTagFilter(tagFilter.filter((t) => t !== tag))}
          />
          <SidebarGroupContent>
            <SidebarMenu>{shown.map(render)}</SidebarMenu>
            {tagFilter.length > 0 && !shown.length && (
              <p className="ki-text-xs ki-muted px-2 py-1">
                No documents are tagged {tagFilter.map((t) => `#${t}`).join(" and ")}.
              </p>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {/* One row: Settings with its label, then phone and About you as icons.
          In the rail they stack. */}
      <SidebarFooter>
        <SidebarMenu className="flex-row items-center gap-(--space-xxs) group-data-[collapsible=icon]:flex-col">
          <SidebarMenuItem className="min-w-0 flex-1 group-data-[collapsible=icon]:flex-none">
            <SidebarMenuButton size="sm" isActive={props.settingsOpen} onClick={() => openSettings()} tooltip={{ children: <>Settings <Kbd>⌘,</Kbd></> }}>
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarMenuButton size="sm" className="relative size-8! justify-center!" onClick={props.onPhone} aria-label={phoneLabel}>
                  <Smartphone />
                  <span className="ki-phone-dot" data-phone-on={props.phoneOn} />
                </SidebarMenuButton>
              </TooltipTrigger>
              <TooltipContent side={collapsed ? "right" : "top"}>{phoneLabel}</TooltipContent>
            </Tooltip>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarMenuButton size="sm" className="size-8! justify-center!" onClick={openAboutYou} aria-label="About you">
                  <UserRound />
                </SidebarMenuButton>
              </TooltipTrigger>
              <TooltipContent side={collapsed ? "right" : "top"}>About you</TooltipContent>
            </Tooltip>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </SidebarRoot>
  );
}

/** A draft is an open ring; complete is filled. */
export function StatusDot({ status, className }: { status: string | null; className?: string }) {
  if (!status) return null;
  return (
    <span
      aria-label={status}
      data-complete={status === "complete"}
      className={cn("ki-status-dot", className)}
    />
  );
}
