import { EditorView } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Palette, PaletteMode } from "@/components/Palette";
import { PhoneDialog } from "@/components/PhoneDialog";
import { UnsavedChoice, UnsavedDialog } from "@/components/UnsavedDialog";
import { Sidebar } from "@/components/Sidebar";
import { Badge } from "@kintsugi/ui/components/badge";
import { Kbd } from "@kintsugi/ui/components/kbd";
import { SidebarInset, SidebarProvider } from "@kintsugi/ui/components/sidebar";
import { Toaster } from "@kintsugi/ui/components/sonner";
import { External } from "@kintsugi/editor/Editor";
import { Writing } from "@/references/Writing";
import { UsedIn } from "@/references/UsedIn";
import { Refine } from "@/refine/Refine";
import { Library, type LibraryHandle } from "@/inspiration/Library";
import { KinChat } from "@/kin/Chat";
import { KinDev } from "@/kin/KinDev";
import { editorChips } from "@/kin/screen";
import { useScreenContext } from "@/lib/chat";
import { Settings } from "@/kin/Settings";
import { AboutYou } from "@/kin/AboutYou";
import { Feed } from "@/feed/Feed";
import { Ideas } from "@/ideas/Ideas";
import { IdeasBeside } from "@/ideas/Beside";
import { ideasForDraft, onOpenIdeas } from "@/ideas/api";
import { Publish } from "@/publish/Publish";
import { openPublish } from "@/lib/blog";
import { Picked } from "@/feed/Picked";
import { field, setField, wordCount } from "@kintsugi/core/frontmatter";
import { Changed, phone, PhoneStatus } from "@/lib/phone";
import { Failure, Saves } from "@/lib/saves";
import { useUpdates } from "@/lib/updates";
import { Entry, flatten, parentDir, renamedPath, vault } from "@/lib/vault";

const SAVE_DELAY = 400;
const SAVE_TOAST = "kintsugi-save-failed";
const requestClip = (path: string) => window.dispatchEvent(new CustomEvent("kintsugi:open-clip", { detail: { path } }));

type SaveState = "saved" | "editing" | "error";
type Blocked = { failures: Failure[]; action: string; resolve: (choice: UnsavedChoice) => void };

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
  const [feedOpen, setFeedOpen] = useState(false);
  // Ideas, optionally filtered to one document ("Ideas for this draft").
  const [ideasOpen, setIdeasOpen] = useState<{ path?: string } | null>(null);
  const [openClip, setOpenClip] = useState<{ path: string; seq: number }>();
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phoneStatus, setPhoneStatus] = useState<PhoneStatus | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);

  const viewRef = useRef<EditorView | null>(null);
  const libraryRef = useRef<LibraryHandle>(null);
  const saves = useRef(new Saves(vault.write));
  const blockedRef = useRef<Blocked | null>(null);
  const known = useRef(new Map<string, string>());
  const metaChanged = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const rootRef = useRef<string | null>(null);

  const docs = useMemo(() => flatten(tree), [tree]);
  // The editor stays mounted (and keeps its state) behind the library and feed.
  const away = libraryOpen || feedOpen || !!ideasOpen;

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

  // Writes every pending change; returns the ones that failed. They stay
  // pending, so a later save (autosave, ⌘S, Try again) retries them.
  const write = useCallback(async (): Promise<Failure[]> => {
    window.clearTimeout(timer.current);
    if (!saves.current.size) return [];
    const result = await saves.current.flush();
    if (!result.ok) {
      const [first] = result.failures;
      setSave("error");
      toast.error(`Couldn’t save ${first.path}: ${first.error}`, {
        id: SAVE_TOAST,
        duration: Infinity,
        action: { label: "Try again", onClick: () => void flushRef.current() },
      });
      return result.failures;
    }
    toast.dismiss(SAVE_TOAST);
    // Keystrokes typed during the write have their own autosave coming.
    if (!saves.current.size) setSave("saved");
    if (metaChanged.current) {
      metaChanged.current = false;
      await refresh();
    }
    return [];
  }, [refresh]);

  const flush = useCallback(async () => !(await write()).length, [write]);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const ask = useCallback((failures: Failure[], action: string) => {
    // Only one question at a time; an older one is answered "stay".
    blockedRef.current?.resolve("stay");
    return new Promise<UnsavedChoice>((resolve) => {
      const next = { failures, action, resolve };
      blockedRef.current = next;
      setBlocked(next);
    });
  }, []);

  const answer = (choice: UnsavedChoice) => {
    const current = blockedRef.current;
    blockedRef.current = null;
    setBlocked(null);
    current?.resolve(choice);
  };

  /**
   * Before leaving the open document (another document, another vault, the
   * library, closing): every change must be on disk, or the writer must say
   * to discard it. False means stay where we are.
   */
  const settleDocs = useCallback(
    async (action: string): Promise<false | "saved" | "discarded"> => {
      for (;;) {
        const failures = await write();
        if (!failures.length) {
          if (!saves.current.size) return "saved";
          continue;
        }
        const choice = await ask(failures, action);
        if (choice === "stay") return false;
        if (choice === "discard") {
          saves.current.discard();
          metaChanged.current = false;
          toast.dismiss(SAVE_TOAST);
          setSave("saved");
          return "discarded";
        }
      }
    },
    [write, ask],
  );

  const settle = useCallback(
    async (action: string) => {
      if ((await libraryRef.current?.flush()) === false) return false;
      return settleDocs(action);
    },
    [settleDocs],
  );

  const onChange = useCallback(
    (path: string, next: string, fromElsewhere: boolean) => {
      // Already on disk: it came from there.
      if (fromElsewhere) {
        known.current.set(path, meta(next));
        setText(next);
        return;
      }
      saves.current.set(path, next);
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
      setPalette(null);
      if (!(await settle("opened that document"))) return;
      setLibraryOpen(false);
      setFeedOpen(false);
      setIdeasOpen(null);
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
    [settle, fail],
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
      saves.current.drop(payload.path);
      if (!saves.current.size) setSave("saved");
      setExternal({ path: payload.path, text: payload.text, seq: Date.now() });
    });
    return () => {
      off.then((stop) => stop());
    };
  }, [refresh]);

  useEffect(() => {
    phone.status().then(setPhoneStatus).catch(() => {});
  }, []);

  // An update restarts the app, so it waits for the same saves a close does.
  useUpdates(async () => (await settle("restarted")) !== false);

  // Never lose the last few keystrokes: save on blur, and don't close until
  // everything is on disk or the writer discards it.
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await settle("closed the window"))) event.preventDefault();
    });
    window.addEventListener("blur", flush);
    return () => {
      unlisten.then((off) => off());
      window.removeEventListener("blur", flush);
    };
  }, [flush, settle]);

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
    const settled = await settleDocs("renamed it");
    if (!settled) return;
    try {
      const to = await vault.rename(path, name);
      const moved = doc && renamedPath(doc.path, path, to);
      if (moved) {
        // Discarded changes leave the editor; the disk's copy comes back.
        const current = settled === "discarded" ? await vault.read(moved) : viewRef.current?.state.doc.toString() ?? text;
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
    if (!(await settleDocs("moved it to the Trash"))) return;
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
    if (field(current, "mirror")) return;
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
    if (!(await settle("switched vaults"))) return;
    try {
      await loadVault(await vault.open(picked));
    } catch (e) {
      fail(e);
    }
  };

  const showLibrary = useCallback(async () => {
    if (await libraryRef.current?.showGrid() === false) return;
    if (!(await settleDocs("opened the library"))) return;
    viewRef.current?.contentDOM.blur();
    setRefine(null);
    setOpenClip(undefined);
    setFeedOpen(false);
    setIdeasOpen(null);
    setLibraryOpen(true);
  }, [settleDocs]);

  // The Feed keeps its own data (not the vault), so it only needs the editor settled.
  const showFeed = useCallback(async () => {
    if ((await libraryRef.current?.flush()) === false) return;
    if (!(await settleDocs("opened the feed"))) return;
    viewRef.current?.contentDOM.blur();
    setRefine(null);
    setLibraryOpen(false);
    setIdeasOpen(null);
    setFeedOpen(true);
  }, [settleDocs]);

  // Ideas keep their own data too; Adopt writes a draft and opens it.
  const showIdeas = useCallback(async (path?: string) => {
    if ((await libraryRef.current?.flush()) === false) return;
    if (!(await settleDocs("opened Ideas"))) return;
    viewRef.current?.contentDOM.blur();
    setRefine(null);
    setLibraryOpen(false);
    setFeedOpen(false);
    setIdeasOpen({ path });
  }, [settleDocs]);
  useEffect(() => onOpenIdeas((path) => void showIdeas(path)), [showIdeas]);

  // The editor can open a clip without coupling its state to the library.
  useEffect(() => {
    const open = async (event: Event) => {
      const path = (event as CustomEvent<{ path: string }>).detail?.path;
      if (typeof path !== "string") return;
      if (!(await settle("opened the clip"))) return;
      viewRef.current?.contentDOM.blur();
      setRefine(null);
      setOpenClip({ path, seq: Date.now() });
      setFeedOpen(false);
      setIdeasOpen(null);
      setLibraryOpen(true);
    };
    window.addEventListener("kintsugi:open-clip", open);
    return () => window.removeEventListener("kintsugi:open-clip", open);
  }, [settle]);

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
    else if (key === "f" && e.shiftKey) run(showFeed);
    else if (key === "e" && e.shiftKey) run(() => void showIdeas());
    else if (key === "d" && e.shiftKey && !away) run(toggleStatus);
    else if (key === "s" && !e.shiftKey) run(() => { if (libraryOpen) void libraryRef.current?.flush(); else if (!feedOpen) void flush(); });
    else if (key === "o" && e.shiftKey) run(openVault);
    else if (key === "k" && !e.shiftKey && doc && !away) run(openRefine);
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => shortcuts.current(e);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // What Kin's chat picks up from the editor: the selection, the document.
  useScreenContext("writing", doc && !away ? () => editorChips(viewRef.current, doc.path) : null, [doc?.path]);

  const status = field(text, "status");
  const mirror = field(text, "mirror");
  const vaultName = root?.split("/").filter(Boolean).pop() ?? "";

  return (
    <SidebarProvider>
      <Sidebar
        tree={tree}
        vaultName={vaultName}
        active={away ? null : doc?.path ?? null}
        libraryOpen={libraryOpen}
        onLibrary={showLibrary}
        feedOpen={feedOpen}
        onFeed={showFeed}
        ideasOpen={!!ideasOpen}
        onIdeas={() => void showIdeas()}
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
        {libraryOpen && <Library ref={libraryRef} key={root} openClip={openClip} renderUsedIn={(clip) => <UsedIn root={root} path={clip.path} onOpen={openDoc} />} />}
        {feedOpen && <Feed picked={<Picked />} />}
        {ideasOpen && (
          <Ideas
            key={root}
            filter={ideasOpen.path}
            filterTitle={docs.find((d) => d.path === ideasOpen.path)?.title ?? undefined}
            onFilter={(path) => setIdeasOpen({ path })}
            onOpenDoc={openDoc}
            drafts={docs.filter((d) => d.status !== "complete").map((d) => ({ path: d.path, title: d.title ?? d.name }))}
          />
        )}
        {doc && !away && <IdeasBeside path={doc.path} text={text} onOpenDoc={openDoc} />}
        <div inert={away} className={away ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        {doc ? (
          <Writing
            key={root}
            root={root}
            onOpenDoc={openDoc}
            onOpenClip={requestClip}
            path={doc.path}
            text={doc.text}
            onChange={onChange}
            external={external}
            viewRef={viewRef}
            readOnly={!!field(doc.text, "mirror")}
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
        {doc && !away && (
          <footer className="absolute right-18 bottom-3 flex items-center gap-3 text-xs text-muted-foreground opacity-60 transition-opacity hover:opacity-100">
            {mirror ? (
              <span title="Generated from the blog repository; edit the post there">Read-only mirror of {mirror}</span>
            ) : (
              <>
                <Badge asChild variant={status === "complete" ? "default" : "outline"}>
                  <button onClick={toggleStatus} title="Toggle status (⇧⌘D)">
                    {status ?? "no status"}
                  </button>
                </Badge>
                {status === "complete" && <button className="hover:text-foreground" onClick={openPublish} title="Publish to the blog (⇧⌘P)">Publish…</button>}
              </>
            )}
            <span>{wordCount(text).toLocaleString()} words</span>
            <button onClick={() => ideasForDraft(doc.path)} className="hover:text-foreground" title="Ideas for this draft">
              Ideas
            </button>
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
      <UnsavedDialog failures={blocked?.failures ?? null} action={blocked?.action ?? ""} onChoose={answer} />
      <PhoneDialog
        open={phoneOpen}
        status={phoneStatus}
        onStatus={setPhoneStatus}
        onClose={() => setPhoneOpen(false)}
      />
      <Publish root={root} path={doc && !away ? doc.path : null} viewRef={viewRef} flush={flush} />
      <Settings />
      <AboutYou />
      <KinDev />
      <KinChat />
      <Toaster position="bottom-center" />
    </SidebarProvider>
  );
}
