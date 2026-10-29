import { ChevronRight, FileText, Folder, Smartphone } from "lucide-react";
import { useState } from "react";
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
} from "@kintsugi/ui/components/sidebar";
import { cn } from "@kintsugi/ui/lib/utils";
import { displayName, Entry, parentDir } from "@/lib/vault";

type Props = {
  tree: Entry[];
  vaultName: string;
  active: string | null;
  selectedDir: string;
  onOpen: (path: string) => void;
  onSelectDir: (path: string) => void;
  onNewDoc: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (path: string, name: string) => void;
  onTrash: (path: string) => void;
  phoneOn: boolean;
  onPhone: () => void;
};

export function Sidebar(props: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);

  const rename = (entry: Entry) => (
    <Input
      autoFocus
      className="h-7 px-2 text-sm"
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
                    className={cn(props.selectedDir === entry.path && "font-medium")}
                    onClick={() => props.onSelectDir(entry.path)}
                    onDoubleClick={() => setRenaming(entry.path)}
                    onKeyDown={keys(entry.path)}
                  >
                    <ChevronRight className="transition-transform" />
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

  return (
    <SidebarRoot>
      {/* Room for the traffic lights; the whole strip drags the window. */}
      <SidebarHeader className="h-10" data-tauri-drag-region />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel
            className={cn("cursor-default", props.selectedDir === "" && "text-sidebar-foreground")}
            onClick={() => props.onSelectDir("")}
            title="New documents go to the vault root"
          >
            {props.vaultName}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{props.tree.map(render)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="sm" className="text-muted-foreground" onClick={props.onPhone}>
              <Smartphone />
              <span>{props.phoneOn ? "Phone access on" : "Connect your phone"}</span>
            </SidebarMenuButton>
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
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "complete" ? "bg-primary" : "ring-1 ring-muted-foreground ring-inset",
        className,
      )}
    />
  );
}
