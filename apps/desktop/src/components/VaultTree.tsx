import {
  Archive, Book, Briefcase, Camera, ChevronRight, Code, FileText, Folder, Globe, Heart, ImageIcon,
  Inbox, Lightbulb, Music, Note, Pencil, Quote, Star, type IconComponent,
} from "@kintsugi/ui/icons";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@kintsugi/ui/components/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@kintsugi/ui/components/context-menu";
import { Input } from "@kintsugi/ui/components/input";
import { SidebarMenuButton, SidebarMenuItem } from "@kintsugi/ui/components/sidebar";
import { cn } from "@kintsugi/ui/lib/utils";
import {
  canMove, FOLDER_COLORS, FOLDER_ICONS, isFolderColor, isFolderIcon,
  type FolderIcon, type FolderStyle, type FolderStyles,
} from "@kintsugi/core/folders";
import { displayName, type Entry, type Folder as FolderEntry, parentDir } from "@/lib/vault";

export const FOLDER_GLYPHS: Record<FolderIcon, IconComponent> = {
  folder: Folder, inbox: Inbox, pen: Pencil, note: Note, book: Book, bulb: Lightbulb, star: Star,
  heart: Heart, quote: Quote, image: ImageIcon, code: Code, globe: Globe, music: Music,
  camera: Camera, briefcase: Briefcase, archive: Archive,
};

const COLOR_NAMES: Record<(typeof FOLDER_COLORS)[number], string> = {
  red: "Red", amber: "Amber", green: "Green", sage: "Sage", sand: "Sand", lavender: "Lavender",
};

const ICON_NAMES: Record<FolderIcon, string> = {
  folder: "Folder", inbox: "Inbox", pen: "Pen", note: "Note", book: "Book", bulb: "Light bulb",
  star: "Star", heart: "Heart", quote: "Quote", image: "Image", code: "Code", globe: "Globe",
  music: "Music", camera: "Camera", briefcase: "Briefcase", archive: "Archive",
};

/** A folder's icon in its colour; unknown keys (a newer app's) fall back to plain. */
export function FolderGlyph({ style, className }: { style?: FolderStyle; className?: string }) {
  const Glyph = isFolderIcon(style?.icon) ? FOLDER_GLYPHS[style.icon] : Folder;
  return <Glyph className={cn("ki-folder-glyph", className)} data-color={isFolderColor(style?.color) ? style.color : undefined} />;
}

// ---------------------------------------------------------------------------
// Drag and drop: documents and folders move between folders. Only the
// innermost folder under the pointer is the target; dropping on a document
// targets the folder it sits in.

const DRAG_TYPE = "application/x-kintsugi-path";
let dragging: string | null = null;

export type TreeDrag = {
  /** The folder a drop would land in ("" is the vault root), or null. */
  target: string | null;
  source: (path: string) => Pick<React.HTMLAttributes<HTMLElement>, "draggable" | "onDragStart" | "onDragEnd">;
  zone: (dir: string) => Pick<React.HTMLAttributes<HTMLElement>, "onDragOver" | "onDrop">;
  /** On the area around the tree: clears the target when the pointer leaves. */
  area: Pick<React.HTMLAttributes<HTMLElement>, "onDragLeave">;
};

export function useTreeDrag(onMove: (path: string, dir: string) => void): TreeDrag {
  const [target, setTarget] = useState<string | null>(null);
  const source = useCallback<TreeDrag["source"]>((path) => ({
    draggable: true,
    onDragStart: (e) => {
      e.stopPropagation();
      dragging = path;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(DRAG_TYPE, path);
    },
    onDragEnd: () => {
      dragging = null;
      setTarget(null);
    },
  }), []);
  const zone = useCallback<TreeDrag["zone"]>((dir) => ({
    onDragOver: (e) => {
      if (!dragging || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
      // Stop here even when the drop isn't allowed, so the folder around
      // this one doesn't light up instead.
      e.stopPropagation();
      const ok = canMove(dragging, dir);
      if (ok) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
      setTarget(ok ? dir : null);
    },
    onDrop: (e) => {
      const path = dragging;
      if (!path) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = null;
      setTarget(null);
      if (canMove(path, dir)) onMove(path, dir);
    },
  }), [onMove]);
  const area = {
    onDragLeave: (e: React.DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(null);
    },
  };
  return { target, source, zone, area };
}

// ---------------------------------------------------------------------------
// Which folders are closed, kept per vault across restarts. Folders start open.

export function useClosedFolders(vault: string, active: string | null, selectedDir: string) {
  const key = `kintsugi:closed-folders:${vault}`;
  const [closed, setClosed] = useState<Set<string>>(() => read(key));
  useEffect(() => setClosed(read(key)), [key]);
  const set = useCallback((path: string, open: boolean) => {
    setClosed((now) => {
      if (open !== now.has(path)) return now;
      const next = new Set(now);
      if (open) next.delete(path);
      else next.add(path);
      try { localStorage.setItem(key, JSON.stringify([...next])); } catch { /* A convenience only. */ }
      return next;
    });
  }, [key]);
  // The open document and the selected folder (a new one, say) are always
  // visible: the folders around them open.
  useEffect(() => {
    for (let dir = active ? parentDir(active) : ""; dir; dir = parentDir(dir)) set(dir, true);
  }, [active, set]);
  useEffect(() => {
    for (let dir = parentDir(selectedDir); dir; dir = parentDir(dir)) set(dir, true);
  }, [selectedDir, set]);
  return [closed, set] as const;
}

function read(key: string): Set<string> {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------

type Props = {
  entries: Entry[];
  /** Every folder in the vault, for Move to (the tree may be filtered). */
  folders: { path: string; name: string; depth: number }[];
  vaultName: string;
  active: string | null;
  selectedDir: string;
  styles: FolderStyles;
  closed: Set<string>;
  onToggle: (path: string, open: boolean) => void;
  drag: TreeDrag;
  onOpen: (path: string) => void;
  onSelectDir: (path: string) => void;
  onNewDoc: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (path: string, name: string) => void;
  onMove: (path: string, dir: string) => void;
  onTrash: (path: string) => void;
  onFolderStyle: (path: string, style: FolderStyle) => void;
};

/** Every folder under `entries`, in tree order, for Move to. */
export function folderList(entries: Entry[], depth = 0): Props["folders"] {
  return entries.flatMap((e) =>
    e.kind === "folder" ? [{ path: e.path, name: e.name, depth }, ...folderList(e.children, depth + 1)] : [],
  );
}

type Tree = Props & { renaming: string | null; setRenaming: (path: string | null) => void };
const TreeContext = createContext<Tree | null>(null);
const useTree = () => useContext(TreeContext)!;

/** The vault's documents and folders, after Dia's sidebar: an open folder
 *  and what's in it share one soft rounded group, nested as deep as the
 *  folders go. */
export function VaultTree(props: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  return (
    <TreeContext.Provider value={{ ...props, renaming, setRenaming }}>
      {props.entries.map((entry) => <TreeEntry key={entry.path} entry={entry} />)}
    </TreeContext.Provider>
  );
}

function RenameField({ entry }: { entry: Entry }) {
  const tree = useTree();
  return (
    <Input
      autoFocus
      aria-label={`Rename ${entry.name}`}
      defaultValue={entry.name}
      onFocus={(e) => e.target.setSelectionRange(0, entry.name.replace(/\.mdx?$/, "").length)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") tree.setRenaming(null);
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onBlur={(e) => {
        const name = e.target.value.trim();
        tree.setRenaming(null);
        if (name && name !== entry.name) tree.onRename(entry.path, name);
      }}
    />
  );
}

function keys(tree: Tree, path: string) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && e.metaKey) tree.onTrash(path);
    if (e.key === "F2") tree.setRenaming(path);
  };
}

function EntryMenu({ entry, children }: { entry: Entry; children: React.ReactNode }) {
  const tree = useTree();
  const dir = entry.kind === "folder" ? entry.path : parentDir(entry.path);
  const style = tree.styles[entry.path] ?? {};
  const color = isFolderColor(style.color) ? style.color : undefined;
  const targets = [{ path: "", name: tree.vaultName, depth: 0 }, ...tree.folders.map((f) => ({ ...f, depth: f.depth + 1 }))]
    .filter((f) => canMove(entry.path, f.path));
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => tree.onNewDoc(dir)}>
          New document<ContextMenuShortcut>⌘N</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => tree.onNewFolder(dir)}>
          New folder<ContextMenuShortcut>⇧⌘N</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        {entry.kind === "folder" && (
          <>
            <ContextMenuSub>
              <ContextMenuSubTrigger>Colour</ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-40">
                <ContextMenuRadioGroup
                  value={color ?? ""}
                  onValueChange={(next) => tree.onFolderStyle(entry.path, { ...style, color: next || undefined })}
                >
                  <ContextMenuRadioItem value="" className="gap-(--space-xs)">
                    <span className="ki-folder-swatch" aria-hidden="true" />
                    None
                  </ContextMenuRadioItem>
                  {FOLDER_COLORS.map((c) => (
                    <ContextMenuRadioItem key={c} value={c} className="gap-(--space-xs)">
                      <span className="ki-folder-glyph ki-folder-swatch" data-color={c} aria-hidden="true" />
                      {COLOR_NAMES[c]}
                    </ContextMenuRadioItem>
                  ))}
                </ContextMenuRadioGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSub>
              <ContextMenuSubTrigger>Icon</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuRadioGroup
                  className="ki-icon-grid"
                  value={isFolderIcon(style.icon) ? style.icon : "folder"}
                  onValueChange={(icon) => tree.onFolderStyle(entry.path, { ...style, icon: icon === "folder" ? undefined : icon })}
                >
                  {FOLDER_ICONS.map((icon) => {
                    const Glyph = FOLDER_GLYPHS[icon];
                    return (
                      <ContextMenuRadioItem key={icon} value={icon} aria-label={ICON_NAMES[icon]} title={ICON_NAMES[icon]} className="ki-icon-choice justify-center p-(--space-xs)! pr-(--space-xs)!">
                        <Glyph className="ki-folder-glyph" data-color={color} />
                      </ContextMenuRadioItem>
                    );
                  })}
                </ContextMenuRadioGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </>
        )}
        {targets.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>Move to</ContextMenuSubTrigger>
            <ContextMenuSubContent className="ki-move-menu w-52">
              {targets.map((f) => (
                <ContextMenuItem key={f.path || "/"} onSelect={() => tree.onMove(entry.path, f.path)} className="gap-(--space-xs)">
                  <span aria-hidden="true" style={{ width: `calc(${f.depth} * var(--space-s))` }} className="shrink-0" />
                  {f.path ? <FolderGlyph style={tree.styles[f.path]} /> : null}
                  <span className="truncate">{f.name}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuItem onSelect={() => tree.setRenaming(entry.path)}>Rename</ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => tree.onTrash(entry.path)}>
          Move to Trash<ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TreeEntry({ entry }: { entry: Entry }) {
  const tree = useTree();
  if (entry.kind === "folder") return <FolderRow entry={entry} />;
  return (
    <SidebarMenuItem>
      {tree.renaming === entry.path ? (
        <RenameField entry={entry} />
      ) : (
        <EntryMenu entry={entry}>
          <SidebarMenuButton
            isActive={tree.active === entry.path}
            onClick={() => tree.onOpen(entry.path)}
            onDoubleClick={() => tree.setRenaming(entry.path)}
            onKeyDown={keys(tree, entry.path)}
            title={entry.path}
            {...tree.drag.source(entry.path)}
          >
            <FileText />
            <span className="truncate">{displayName(entry)}</span>
            <StatusDot status={entry.status} className="ml-auto" />
          </SidebarMenuButton>
        </EntryMenu>
      )}
    </SidebarMenuItem>
  );
}

function FolderRow({ entry }: { entry: FolderEntry }) {
  const tree = useTree();
  const open = !tree.closed.has(entry.path);
  const over = tree.drag.target === entry.path;
  // Held over a closed folder while dragging: it opens to take the drop deeper.
  const toggle = tree.onToggle;
  useEffect(() => {
    if (!over || open) return;
    const timer = window.setTimeout(() => toggle(entry.path, true), 600);
    return () => window.clearTimeout(timer);
  }, [over, open, toggle, entry.path]);
  return (
    <Collapsible bare asChild open={open} onOpenChange={(next) => toggle(entry.path, next)}>
      <SidebarMenuItem className="ki-tree-folder" data-empty={!entry.children.length || undefined} data-drop={over || undefined} {...tree.drag.zone(entry.path)}>
        {tree.renaming === entry.path ? (
          <RenameField entry={entry} />
        ) : (
          <EntryMenu entry={entry}>
            <CollapsibleTrigger asChild>
              <SidebarMenuButton
                className={cn(tree.selectedDir === entry.path && "ki-medium")}
                onClick={() => tree.onSelectDir(entry.path)}
                onDoubleClick={() => tree.setRenaming(entry.path)}
                onKeyDown={keys(tree, entry.path)}
                {...tree.drag.source(entry.path)}
              >
                <FolderGlyph style={tree.styles[entry.path]} />
                <span className="min-w-0 truncate">{entry.name}</span>
                <ChevronRight className="ki-tree-chevron" data-open={open} />
              </SidebarMenuButton>
            </CollapsibleTrigger>
          </EntryMenu>
        )}
        <CollapsibleContent bare>
          <ul role="group" className="ki-tree-children">
            {entry.children.map((child) => <TreeEntry key={child.path} entry={child} />)}
          </ul>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
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
