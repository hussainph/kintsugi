import { Bookmark, Folder, FolderPlus, Lightbulb, Rss, Settings, Smartphone, UserRound } from "@kintsugi/ui/icons";
import { useCallback, useMemo, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@kintsugi/ui/components/tooltip";
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarFooter,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@kintsugi/ui/components/sidebar";
import { cn } from "@kintsugi/ui/lib/utils";
import { openAboutYou, openSettings } from "@/lib/kin";
import { Entry, filterTree, flatten } from "@/lib/vault";
import type { FolderStyle, FolderStyles } from "@kintsugi/core/folders";
import { hasTags, vocabulary } from "@kintsugi/core/tags";
import { Shortcut, ShortcutHint } from "./Shortcuts";
import { TagChips, TagFilter } from "./Tags";
import { folderList, useClosedFolders, useTreeDrag, VaultTree } from "./VaultTree";

export { StatusDot } from "./VaultTree";

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
  /** Into `dir` (the root when empty), by drag and drop or Move to. */
  onMove?: (path: string, dir: string) => void;
  onTrash: (path: string) => void;
  folderStyles?: FolderStyles;
  onFolderStyle?: (path: string, style: FolderStyle) => void;
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
  const { state, setOpen } = useSidebar();
  const collapsed = state === "collapsed";
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
  const folders = useMemo(() => folderList(tree), [tree]);
  const noop = useCallback(() => {}, []);
  const drag = useTreeDrag(props.onMove ?? noop);
  const [closed, setFolderOpen] = useClosedFolders(props.vaultName, props.active, props.selectedDir);

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
        <ShortcutHint id="sidebar" className="mr-(--space-xxs)" />
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarTrigger aria-label={toggleLabel} />
          </TooltipTrigger>
          <TooltipContent side="right">
            {toggleLabel} <Shortcut id="sidebar" />
          </TooltipContent>
        </Tooltip>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={props.feedOpen} onClick={props.onFeed} tooltip={{ children: <>Feed <Shortcut id="feed" /></> }}>
                <Rss />
                <span>Feed</span>
                <ShortcutHint id="feed" />
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={props.libraryOpen} onClick={props.onLibrary} tooltip={{ children: <>Inspiration <Shortcut id="inspiration" /></> }}>
                <Bookmark />
                <span>Inspiration</span>
                <ShortcutHint id="inspiration" />
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={props.ideasOpen} onClick={props.onIdeas} tooltip={{ children: <>Ideas <Shortcut id="ideas" /></> }}>
                <Lightbulb />
                <span>Ideas</span>
                <ShortcutHint id="ideas" />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {/* The tree needs its names, so the rail leaves it out and offers a
            way back to it instead. */}
        <SidebarGroup className="hidden group-data-[collapsible=icon]:flex">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => setOpen(true)} tooltip="Documents">
                <Folder />
                <span>Documents</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup
          className="group-data-[collapsible=icon]:hidden ki-tree-root"
          data-drop={drag.target === "" || undefined}
          {...drag.zone("")}
          {...drag.area}
        >
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
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarGroupAction
                className="right-[calc(var(--space-s)+1.75rem)] text-sidebar-foreground/50 [&>svg]:size-3.5"
                aria-label="New folder"
                onClick={() => props.onNewFolder(props.selectedDir)}
              >
                <FolderPlus />
              </SidebarGroupAction>
            </TooltipTrigger>
            <TooltipContent>
              New folder <Shortcut id="newFolder" />
            </TooltipContent>
          </Tooltip>
          <TagFilter vocabulary={tags} counts={counts} selected={tagFilter} onChange={setTagFilter} />
          <TagChips
            className="px-2 pb-1"
            tags={tagFilter}
            onRemove={(tag) => setTagFilter(tagFilter.filter((t) => t !== tag))}
          />
          <SidebarGroupContent>
            <SidebarMenu className="ki-tree">
              <VaultTree
                entries={shown}
                folders={folders}
                vaultName={props.vaultName}
                active={props.active}
                selectedDir={props.selectedDir}
                styles={props.folderStyles ?? {}}
                closed={closed}
                onToggle={setFolderOpen}
                drag={drag}
                onOpen={props.onOpen}
                onSelectDir={props.onSelectDir}
                onNewDoc={props.onNewDoc}
                onNewFolder={props.onNewFolder}
                onRename={props.onRename}
                onMove={props.onMove ?? noop}
                onTrash={props.onTrash}
                onFolderStyle={props.onFolderStyle ?? noop}
              />
            </SidebarMenu>
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
            <SidebarMenuButton size="sm" isActive={props.settingsOpen} onClick={() => openSettings()} tooltip={{ children: <>Settings <Shortcut id="settings" /></> }}>
              <Settings />
              <span>Settings</span>
              <ShortcutHint id="settings" />
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarMenuButton size="sm" className="relative size-8! justify-center!" onClick={props.onPhone} aria-label={phoneLabel}>
                  <Smartphone />
                  <span className="ki-phone-dot" data-phone-on={props.phoneOn} aria-hidden="true" />
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
