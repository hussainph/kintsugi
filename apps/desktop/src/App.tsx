import { EditorView } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Palette, PaletteMode } from "@/components/Palette";
import { PhoneDialog } from "@/components/PhoneDialog";
import { Sidebar } from "@/components/Sidebar";
import { Badge } from "@kintsugi/ui/components/badge";
import { Kbd } from "@kintsugi/ui/components/kbd";
import { SidebarInset, SidebarProvider } from "@kintsugi/ui/components/sidebar";
import { Toaster } from "@kintsugi/ui/components/sonner";
import { Editor, External } from "@kintsugi/editor/Editor";
import { Refine } from "@/refine/Refine";
import { Library, type LibraryHandle } from "@/inspiration/Library";
import { field, setField, wordCount } from "@kintsugi/core/frontmatter";
import { Changed, phone, PhoneStatus } from "@/lib/phone";
import { Entry, flatten, parentDir, renamedPath, vault } from "@/lib/vault";

const SAVE_DELAY = 400;

type SaveState = "saved" | "editing" | "error";

/** What the tree shows for a document; when it changes, the tree reloads. */
const meta = (text: string) => `${field(text, "title")}|${field(text, "status")}`;

const lastOpened = {
  key: (root: string) => `kintsugi:last:${root}`,
  get(root: string) {
    try {
      return localStorage.getItem(this.key(root));
    } catch {
      return null;
    }
  },
  set(root: string, path: string) {
    try {
      localStorage.setItem(this.key(root), path);
    } catch {
      // Only a convenience.
    }
  },
};

export default function App() {
  const [root, setRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<Entry[]>([]);
  const [doc, setDoc] = useState<{ path: string; text: string } | null>(null);
  const [text, setText] = useState("");
  const [selectedDir, setSelectedDir] = useState("");
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [save, setSave] = useState<SaveState>("saved");
  const [refine, setRefine] = useState<{ from: number; to: number } | null>(null);
  const [external, setExternal] = useState<External | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [openClip, setOpenClip] = useState<{ path: string; seq: number }>();
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phoneStatus, setPhoneStatus] = useState<PhoneStatus | null>(null);

  const viewRef = useRef<EditorView | null>(null);
  const libraryRef = useRef<LibraryHandle>(null);
  const pending = useRef(new Map<string, string>());
  const known = useRef(new Map<string, string>());
  const metaChanged = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const rootRef = useRef<string | null>(null);

  const docs = useMemo(() => flatten(tree), [tree]);

  const fail = useCallback((e: unknown) => {
    toast.error(String(e));
    setSave("error");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await vault.tree();
      setTree(next);
      return next;
    } catch (e) {
      fail(e);
      return [];
    }
  }, [fail]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const writes = [...pending.current];
    pending.current.clear();
    if (!writes.length) return;
    try {
      await Promise.all(writes.map(([path, contents]) => vault.write(path, contents)));
      setSave("saved");
      if (metaChanged.current) {
        metaChanged.current = false;
        await refresh();
      }
    } catch (e) {
      fail(e);
    }
  }, [refresh, fail]);

  const onChange = useCallback(
    (path: string, next: string, fromElsewhere: boolean) => {
      // Already on disk: it came from there.
      if (fromElsewhere) {
        known.current.set(path, meta(next));
        setText(next);
        return;
      }
      pending.current.set(path, next);
      const m = meta(next);
      if (known.current.get(path) !== m) {
        known.current.set(path, m);
        metaChanged.current = true;
      }
      setText(next);
      setSave("editing");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, SAVE_DELAY);
    },
    [flush],
  );

  const openDoc = useCallback(
    async (path: string) => {
      if (await libraryRef.current?.flush() === false) return;
      setPalette(null);
      await flush();
      setLibraryOpen(false);
      try {
        const contents = await vault.read(path);
        known.current.set(path, meta(contents));
        setDoc({ path, text: contents });
        setText(contents);
        setSelectedDir(parentDir(path));
        if (rootRef.current) lastOpened.set(rootRef.current, path);
      } catch (e) {
        fail(e);
      }
    },
    [flush, fail],
  );

  const loadVault = useCallback(
    async (path: string) => {
      rootRef.current = path;
      setRoot(path);
      setDoc(null);
      setOpenClip(undefined);
      setLibraryOpen(false);
      setText("");
      setSelectedDir("");
      const all = flatten(await refresh());
      const last = lastOpened.get(path);
      const pick = all.find((d) => d.path === last) ?? all[0];
      if (pick) await openDoc(pick.path);
    },
    [refresh, openDoc],
  );

  useEffect(() => {
    vault.current().then(loadVault).catch(fail);
  }, [loadVault, fail]);

  // The phone saved something: show it. If the open document changed, the
  // phone's version wins over keystrokes not yet saved here; a writer isn't
  // typing on both at once, and the phone checked it had the latest copy.
  useEffect(() => {
    const off = listen<Changed>("vault:changed", ({ payload }) => {
      refresh();
      if (payload.text == null) return;
      pending.current.delete(payload.path);
      if (!pending.current.size) setSave("saved");
      setExternal({ path: payload.path, text: payload.text, seq: Date.now() });
    });
    return () => {
      off.then((stop) => stop());
    };
  }, [refresh]);

  useEffect(() => {
    phone.status().then(setPhoneStatus).catch(() => {});
  }, []);

  // Never lose the last few keystrokes: save on blur and before the window closes.
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      if (await libraryRef.current?.flush() === false) { event.preventDefault(); return; }
      await flush();
    });
    window.addEventListener("blur", flush);
    return () => {
      unlisten.then((off) => off());
      window.removeEventListener("blur", flush);
    };
  }, [flush]);

  const create = async (mode: PaletteMode, name: string) => {
    setPalette(null);
    try {
      if (mode.kind === "new-doc") {
        const path = await vault.createDoc(mode.dir, name);
        await refresh();
        await openDoc(path);
      } else if (mode.kind === "new-folder") {
        const path = await vault.createFolder(mode.dir, name);
        await refresh();
        setSelectedDir(path);
      }
    } catch (e) {
      fail(e);
    }
  };

  const rename = async (path: string, name: string) => {
    // Keep a document a document: "draft" becomes "draft.mdx".
    const ext = /\.mdx?$/.exec(path)?.[0];
    if (ext && !/\.mdx?$/.test(name)) name += ext;
    await flush();
    try {
      const to = await vault.rename(path, name);
      const moved = doc && renamedPath(doc.path, path, to);
      if (moved) {
        const current = viewRef.current?.state.doc.toString() ?? text;
        known.current.set(moved, meta(current));
        setDoc({ path: moved, text: current });
        if (rootRef.current) lastOpened.set(rootRef.current, moved);
      }
      setSelectedDir((dir) => renamedPath(dir, path, to) ?? dir);
      await refresh();
    } catch (e) {
      fail(e);
    }
  };

  const trash = async (path: string) => {
    await flush();
    try {
      await vault.trash(path);
      const all = flatten(await refresh());
      if (doc && renamedPath(doc.path, path, "") !== null) {
        setDoc(null);
        if (all[0]) await openDoc(all[0].path);
      }
      setSelectedDir((dir) => (renamedPath(dir, path, "") !== null ? parentDir(path) : dir));
    } catch (e) {
      fail(e);
    }
  };

  const toggleStatus = () => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    const next = field(current, "status") === "complete" ? "draft" : "complete";
    view.dispatch({ changes: setField(current, "status", next) });
  };

  // ⌘K: the selection, or the paragraph under the cursor when nothing is selected.
  const openRefine = () => {
    const view = viewRef.current;
    if (!view) return;
    let { from, to } = view.state.selection.main;
    if (from === to) ({ from, to } = view.state.doc.lineAt(from));
    if (!view.state.sliceDoc(from, to).trim()) return toast("Select some text to edit.");
    setRefine({ from, to });
  };

  const openVault = async () => {
    const picked = await pickFolder({ directory: true, title: "Open a vault" });
    if (typeof picked !== "string") return;
    if (await libraryRef.current?.flush() === false) return;
    await flush();
    try {
      await loadVault(await vault.open(picked));
    } catch (e) {
      fail(e);
    }
  };

  const showLibrary = useCallback(async () => {
    if (await libraryRef.current?.showGrid() === false) return;
    await flush();
    viewRef.current?.contentDOM.blur();
    setRefine(null);
    setOpenClip(undefined);
    setLibraryOpen(true);
  }, [flush]);

  // The editor can open a clip without coupling its state to the library.
  useEffect(() => {
    const open = async (event: Event) => {
      const path = (event as CustomEvent<{ path: string }>).detail?.path;
      if (typeof path !== "string") return;
      if (await libraryRef.current?.flush() === false) return;
      await flush();
      viewRef.current?.contentDOM.blur();
      setRefine(null);
      setOpenClip({ path, seq: Date.now() });
      setLibraryOpen(true);
    };
    window.addEventListener("kintsugi:open-clip", open);
    return () => window.removeEventListener("kintsugi:open-clip", open);
  }, [flush]);

  // HTML drops must never navigate the webview to a Finder file. Components
  // still receive the event (the library captures images; CodeMirror edits text).
  useEffect(() => {
    const stayHere = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    document.addEventListener("dragover", stayHere);
    document.addEventListener("drop", stayHere);
    return () => {
      document.removeEventListener("dragover", stayHere);
      document.removeEventListener("drop", stayHere);
    };
  }, []);

  // App shortcuts run in the capture phase so they win over the editor's keymap.
  const shortcuts = useRef<(e: KeyboardEvent) => void>(() => {});
  shortcuts.current = (e) => {
    if (!e.metaKey || e.altKey || e.ctrlKey) return;
    const run = (action: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      action();
    };
    const key = e.key.toLowerCase();
    if (key === "p" && !e.shiftKey) run(() => setPalette({ kind: "open" }));
    else if (key === "n") run(() => setPalette({ kind: e.shiftKey ? "new-folder" : "new-doc", dir: selectedDir }));
    else if (key === "i" && e.shiftKey) run(showLibrary);
    else if (key === "d" && e.shiftKey && !libraryOpen) run(toggleStatus);
    else if (key === "s" && !e.shiftKey) run(() => { if (libraryOpen) void libraryRef.current?.flush(); else void flush(); });
    else if (key === "o" && e.shiftKey) run(openVault);
    else if (key === "k" && !e.shiftKey && doc && !libraryOpen) run(openRefine);
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => shortcuts.current(e);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const status = field(text, "status");
  const vaultName = root?.split("/").filter(Boolean).pop() ?? "";

  return (
    <SidebarProvider>
      <Sidebar
        tree={tree}
        vaultName={vaultName}
        active={libraryOpen ? null : doc?.path ?? null}
        libraryOpen={libraryOpen}
        onLibrary={showLibrary}
        selectedDir={selectedDir}
        onOpen={openDoc}
        onSelectDir={setSelectedDir}
        onNewDoc={(dir) => setPalette({ kind: "new-doc", dir })}
        onNewFolder={(dir) => setPalette({ kind: "new-folder", dir })}
        onRename={rename}
        onTrash={trash}
        phoneOn={phoneStatus?.enabled ?? false}
        onPhone={() => setPhoneOpen(true)}
      />
      <SidebarInset className="relative h-svh min-w-0">
        <div className="absolute inset-x-0 top-0 z-10 h-8" data-tauri-drag-region />
        {libraryOpen && <Library ref={libraryRef} key={root} openClip={openClip} />}
        <div inert={libraryOpen} className={libraryOpen ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        {doc ? (
          <Editor
            key={root}
            path={doc.path}
            text={doc.text}
            onChange={onChange}
            external={external}
            viewRef={viewRef}
          />
        ) : (
          <div className="m-auto space-y-2 text-center text-sm text-muted-foreground">
            <p>
              <Kbd>⌘N</Kbd> to start writing
            </p>
            <p>
              <Kbd>⌘P</Kbd> to find something
            </p>
          </div>
        )}
        </div>
        {doc && !libraryOpen && (
          <footer className="absolute right-4 bottom-3 flex items-center gap-3 text-xs text-muted-foreground opacity-60 transition-opacity hover:opacity-100">
            <Badge asChild variant={status === "complete" ? "default" : "outline"}>
              <button onClick={toggleStatus} title="Toggle status (⇧⌘D)">
                {status ?? "no status"}
              </button>
            </Badge>
            <span>{wordCount(text).toLocaleString()} words</span>
            <span className={save === "error" ? "text-destructive" : ""}>
              {{ saved: "Saved", editing: "Editing", error: "Not saved" }[save]}
            </span>
          </footer>
        )}
      </SidebarInset>
      {refine && viewRef.current && (
        <Refine
          view={viewRef.current}
          from={refine.from}
          to={refine.to}
          onClose={() => {
            setRefine(null);
            viewRef.current?.focus();
          }}
        />
      )}
      <Palette mode={palette} docs={docs} onOpen={openDoc} onCreate={create} onClose={() => setPalette(null)} />
      <PhoneDialog
        open={phoneOpen}
        status={phoneStatus}
        onStatus={setPhoneStatus}
        onClose={() => setPhoneOpen(false)}
      />
      <Toaster position="bottom-center" />
    </SidebarProvider>
  );
}
