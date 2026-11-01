import { EditorView } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Palette, PaletteMode } from "@/components/Palette";
import { PhoneDialog } from "@/components/PhoneDialog";
import { UnsavedChoice, UnsavedDialog } from "@/components/UnsavedDialog";
import { OutsideChoice, OutsideDialog } from "@/components/OutsideDialog";
import { Sidebar } from "@/components/Sidebar";
import { DocTags } from "@/components/Tags";
import { Badge } from "@kintsugi/ui/components/badge";
import { Kbd } from "@kintsugi/ui/components/kbd";
import { SidebarInset, SidebarProvider } from "@kintsugi/ui/components/sidebar";
import { Toaster } from "@kintsugi/ui/components/sonner";
import { External, paragraphRange, replaceText } from "@kintsugi/editor/Editor";
import { Writing } from "@/references/Writing";
import { UsedIn } from "@/references/UsedIn";
import { Refine } from "@/refine/Refine";
import type { Action } from "@/refine/prompts";
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
import { Export } from "@/export/Export";
import { ExportMenu } from "@/export/ExportMenu";
import { field, setField, wordCount } from "@kintsugi/core/frontmatter";
import { setTags, tags as tagsOf, vocabulary } from "@kintsugi/core/tags";
import { Changed, phone, PhoneStatus } from "@/lib/phone";
import { Failure, Saves } from "@/lib/saves";
import { decide, removes } from "@/lib/outside";
import { invert, question, restored, skipped, updated, type Relink, type RelinkOutcome, type RelinkPlan } from "@/lib/links";
import { version } from "@kintsugi/core/remote";
import { useUpdates } from "@/lib/updates";
import { Entry, flatten, Outside, parentDir, renamedPath, vault } from "@/lib/vault";

const SAVE_DELAY = 400;
const SAVE_TOAST = "kintsugi-save-failed";
const requestClip = (path: string) => window.dispatchEvent(new CustomEvent("kintsugi:open-clip", { detail: { path } }));

type SaveState = "saved" | "editing" | "error";
type Blocked = { failures: Failure[]; action: string; resolve: (choice: UnsavedChoice) => void };
type Collision = { path: string; disk: string | null };

/** What the tree shows for a document; when it changes, the tree reloads. */
const meta = (text: string) => `${field(text, "title")}|${field(text, "status")}|${tagsOf(text).join(",")}`;

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
  const [refine, setRefine] = useState<{ from: number; to: number; action?: Action } | null>(null);
  const [external, setExternal] = useState<External | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);
  // Ideas, optionally filtered to one document ("Ideas for this draft").
  const [ideasOpen, setIdeasOpen] = useState<{ path?: string } | null>(null);
  const [openClip, setOpenClip] = useState<{ path: string; seq: number }>();
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phoneStatus, setPhoneStatus] = useState<PhoneStatus | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [collision, setCollision] = useState<Collision | null>(null);
  // The sidebar's tag filter; it belongs to the vault it was chosen in.
  const [tagFilter, setTagFilter] = useState<string[]>([]);

  const viewRef = useRef<EditorView | null>(null);
  const libraryRef = useRef<LibraryHandle>(null);
  // The write is defined below; it needs the outside-edit handling.
  const writeDoc = useRef<(path: string, contents: string) => Promise<void>>(async () => {});
  const saves = useRef(new Saves((path, contents) => writeDoc.current(path, contents)));
  // Each document's text as Kintsugi last knew it on disk: saves send its
  // version, so another app's edit is never saved over, and it is the base
  // for merging such an edit with unsaved changes.
  const bases = useRef(new Map<string, string>());
  const collisionRef = useRef<Collision | null>(null);
  const docPath = useRef<string | null>(null);
  docPath.current = doc?.path ?? null;
  const blockedRef = useRef<Blocked | null>(null);
  const known = useRef(new Map<string, string>());
  /** Bumped by every openDoc; only the latest may land. */
  const opening = useRef(0);
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
      // A held change waits on the outside-edit question, which is already showing.
      const first = result.failures.find((f) => !f.held);
      if (first) {
        setSave("error");
        toast.error(`Couldn’t save ${first.path}: ${first.error}`, {
          id: SAVE_TOAST,
          duration: Infinity,
          action: { label: "Try again", onClick: () => void flushRef.current() },
        });
      }
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

  const showCollision = useCallback((next: Collision | null) => {
    collisionRef.current = next;
    setCollision(next);
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
        // Another app's edit collided with this one: answer that first.
        if (failures.every((f) => f.held)) return false;
        const choice = await ask(failures, action);
        if (choice === "stay") return false;
        if (choice === "discard") {
          if (collisionRef.current) showCollision(null);
          saves.current.discard();
          metaChanged.current = false;
          toast.dismiss(SAVE_TOAST);
          setSave("saved");
          return "discarded";
        }
      }
    },
    [write, ask, showCollision],
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
    /** `behind`: load it into the editor without leaving the view that's
     *  showing (the startup open must not undo ⇧⌘E pressed meanwhile). */
    async (path: string, behind?: boolean) => {
      // The latest open wins: a slower read of an earlier one (the startup
      // open, or a quick second click) must not replace it when it lands.
      const ticket = ++opening.current;
      setPalette(null);
      if (!(await settle("opened that document"))) return;
      if (behind !== true) {
        setLibraryOpen(false);
        setFeedOpen(false);
        setIdeasOpen(null);
      }
      try {
        const contents = await vault.read(path);
        if (ticket !== opening.current) return;
        // Already open (clicked again, or the startup open raced a click):
        // the editor's text is newer than this read, so leave it be.
        if (docPath.current !== path) {
          known.current.set(path, meta(contents));
          bases.current.set(path, contents);
          setDoc({ path, text: contents });
          setText(contents);
          // The editor keeps the state of documents opened before; bring it
          // up to the disk, which another app (or a discard) may have changed.
          setExternal({ path, text: contents, seq: Date.now() });
        }
        setSelectedDir(parentDir(path));
        if (rootRef.current) lastOpened.set(rootRef.current, path);
      } catch (e) {
        fail(e);
      }
    },
    [settle, fail],
  );

  /**
   * Another app changed `path` on disk to `disk`, or removed it (null). The
   * open document reloads when it has nothing unsaved, merges line by line
   * when it does, and asks only when the two edits collide (as the phone
   * does). `movedTo`: where a removed document's text turned up, if anywhere.
   */
  const fromOutside = useCallback(
    (path: string, disk: string | null, movedTo?: string) => {
      const view = docPath.current === path ? viewRef.current : null;
      if (!view) {
        // Not in the editor; opening it reads the disk again.
        if (disk === null) {
          bases.current.delete(path);
          saves.current.release(path);
          saves.current.drop(path);
        } else if (!saves.current.paths().includes(path)) bases.current.set(path, disk);
        return;
      }
      const name = path.split("/").pop();
      const settled = () => {
        saves.current.release(path);
        saves.current.drop(path);
        if (collisionRef.current?.path === path) showCollision(null);
        if (!saves.current.size) setSave("saved");
      };
      const decision = decide(bases.current.get(path), view.state.doc.toString(), disk);
      switch (decision.kind) {
        case "none":
          return;
        case "reload":
          bases.current.set(path, decision.text);
          settled();
          replaceText(view, decision.text);
          return;
        case "merged":
          bases.current.set(path, disk!);
          saves.current.release(path);
          if (collisionRef.current?.path === path) showCollision(null);
          // Arrives as the writer's own edit, so it saves (against the new base).
          replaceText(view, decision.text, true);
          toast(`Merged changes to “${name}” from another app.`);
          return;
        case "gone":
          bases.current.delete(path);
          settled();
          if (movedTo) {
            void openDoc(movedTo);
            return;
          }
          toast(`“${name}” was moved or deleted in another app.`);
          setDoc(null);
          setText("");
          return;
        case "collision":
          // Keep the writer's text pending, but write nothing until they choose.
          saves.current.set(path, view.state.doc.toString());
          saves.current.hold(path);
          setSave("editing");
          showCollision({ path, disk: decision.disk });
          return;
      }
    },
    [openDoc, showCollision],
  );

  const chooseOutside = (choice: OutsideChoice) => {
    const current = collisionRef.current;
    if (!current) return;
    const { path, disk } = current;
    showCollision(null);
    saves.current.release(path);
    if (choice === "disk") {
      saves.current.drop(path);
      if (!saves.current.size) setSave("saved");
      if (disk === null) {
        bases.current.delete(path);
        if (docPath.current === path) {
          setDoc(null);
          setText("");
        }
      } else {
        bases.current.set(path, disk);
        const view = docPath.current === path ? viewRef.current : null;
        if (view) replaceText(view, disk);
      }
      return;
    }
    // Keep mine: save it over the disk's current version, or as a new file.
    if (disk === null) bases.current.delete(path);
    else bases.current.set(path, disk);
    const mine = docPath.current === path ? viewRef.current?.state.doc.toString() : undefined;
    if (mine !== undefined) saves.current.set(path, mine);
    // Written back on purpose: the tree shows it again.
    void flush().then(() => {
      if (disk === null) void refresh();
    });
  };

  // Every save sends the version it started from; the disk may have moved on.
  writeDoc.current = async (path, contents) => {
    const base = bases.current.get(path);
    const result = await vault.write(path, contents, base === undefined ? null : version(base));
    if (result.result === "saved") {
      bases.current.set(path, contents);
      return;
    }
    const disk = result.result === "gone" ? null : result.current.text;
    if (docPath.current === path) return fromOutside(path, disk);
    throw new Error(disk === null ? "it was moved or deleted in another app" : "it changed in another app");
  };

  const loadVault = useCallback(
    async (path: string) => {
      // Switching vaults lands in the editor. On first load (which dev
      // StrictMode runs twice) nothing is open yet, unless he opened it while
      // the vault was loading: leave that be.
      const switching = rootRef.current !== null && rootRef.current !== path;
      const opened = opening.current;
      rootRef.current = path;
      setRoot(path);
      setOpenClip(undefined);
      if (switching) {
        setDoc(null);
        setText("");
        setLibraryOpen(false);
        setFeedOpen(false);
        setIdeasOpen(null);
      }
      setSelectedDir("");
      setTagFilter([]);
      const all = flatten(await refresh());
      // He opened a document while the vault loaded (or StrictMode's other
      // run already did): that one stays, not the startup pick (KI-47).
      if (opening.current !== opened) return;
      const last = lastOpened.get(path);
      const pick = all.find((d) => d.path === last) ?? all[0];
      // A view opened while the vault loaded (Feed, Inspiration, Ideas) stays open.
      if (pick) await openDoc(pick.path, true);
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
      bases.current.set(payload.path, payload.text);
      saves.current.drop(payload.path);
      if (!saves.current.size) setSave("saved");
      setExternal({ path: payload.path, text: payload.text, seq: Date.now() });
    });
    return () => {
      off.then((stop) => stop());
    };
  }, [refresh]);

  // Another app (Obsidian, git, iCloud, an editor) changed the vault. The
  // backend has already left out Kintsugi's own saves and temp files.
  const fromOutsideRef = useRef(fromOutside);
  fromOutsideRef.current = fromOutside;
  useEffect(() => {
    const off = listen<Outside>("vault:outside", ({ payload }) => {
      void refresh();
      for (const { path, text } of payload.docs) fromOutsideRef.current(path, text);
      for (const path of [...bases.current.keys()]) {
        if (!payload.gone.some((gone) => removes(gone, path))) continue;
        // A rename shows up as a removal plus a document with the same text.
        const known = bases.current.get(path);
        const movedTo = payload.docs.find((d) => d.text === known && d.path !== path)?.path;
        fromOutsideRef.current(path, null, movedTo);
      }
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

  // The links prompt or its result. Each toast gets its own id: sonner merges
  // an update into the old one's buttons, and a reused id can be swept away
  // with the toast it replaced.
  const linksToast = useRef<string | number | undefined>(undefined);
  const nextLinksToast = () => {
    if (linksToast.current !== undefined) toast.dismiss(linksToast.current);
    linksToast.current = `kintsugi-links-${Date.now()}-${Math.random()}`;
    return linksToast.current;
  };

  // Kintsugi wrote `text` to `path` outside the editor's save queue: it is
  // the disk's copy now, unless the writer has changes of their own pending.
  const wroteBehind = (path: string, text: string) => {
    if (bases.current.has(path) && !saves.current.paths().includes(path)) bases.current.set(path, text);
  };

  /** The [[links]] update for one rename, once applied: undo needs it. */
  type Relinked = { disk: Relink[]; open?: Relink };

  const linksDone = (title: string, notes: number, outcomes: RelinkOutcome[], undo?: () => void) => {
    const left = skipped(outcomes);
    const description = left.length ? `Skipped ${left.join(", ")}` : undefined;
    const options = {
      id: nextLinksToast(),
      description,
      // Something left alone stays until he has read it.
      duration: left.length ? Infinity : 10_000,
      ...(undo && { action: { label: "Undo", onClick: undo } }),
    };
    if (!notes) toast.error(title, options);
    else toast(title, options);
  };

  /** Undo: every file back to its old links, again version-checked. */
  const undoLinks = async ({ disk, open }: Relinked) => {
    const outcomes: RelinkOutcome[] = [];
    let links = 0;
    let notes = 0;
    if (open) {
      const view = viewRef.current;
      if (docPath.current === open.path && view) {
        if (view.state.doc.toString() === open.after) {
          view.dispatch({ changes: invert(open.before, open.edits) });
          links += open.edits.length;
          notes++;
          outcomes.push({ path: open.path, result: "saved" });
        } else outcomes.push({ path: open.path, result: "conflict" });
      } else {
        // It left the editor, which saved it on the way: undo it on disk.
        await flush();
        disk = [...disk, open];
      }
    }
    try {
      const written = disk.length
        ? await vault.linksWrite(disk.map((f) => ({ path: f.path, text: f.before, base: version(f.after) })))
        : [];
      for (const outcome of written) {
        const file = disk.find((f) => f.path === outcome.path)!;
        if (outcome.result === "saved") {
          wroteBehind(file.path, file.before);
          links += file.edits.length;
          notes++;
        }
        outcomes.push(outcome);
      }
    } catch (e) {
      toast.error(`Couldn’t undo the link update: ${e}`, { id: nextLinksToast() });
      return;
    }
    linksDone(notes ? restored(links, notes) : "Nothing to undo; every note changed since.", notes, outcomes);
  };

  /** Writes the update he agreed to. Other documents are written as they
   *  were read for the prompt, so one changed since is left alone; the open
   *  document changes through the editor, in step with its pending saves. */
  const updateLinks = async (plan: RelinkPlan) => {
    const view = viewRef.current;
    const openPath = view ? docPath.current : null;
    let open: Relink | undefined;
    try {
      if (openPath && view) {
        const fresh = await vault.linksPlan(plan.from, plan.to, { path: openPath, text: view.state.doc.toString() });
        open = fresh.files.find((f) => f.path === openPath);
      }
      const disk = plan.files.filter((f) => f.path !== openPath);
      const written = disk.length
        ? await vault.linksWrite(disk.map((f) => ({ path: f.path, text: f.after, base: f.version })))
        : [];
      const done: Relinked = { disk: [] };
      const outcomes: RelinkOutcome[] = [];
      for (const outcome of written) {
        const file = disk.find((f) => f.path === outcome.path)!;
        if (outcome.result === "saved") {
          wroteBehind(file.path, file.after);
          done.disk.push(file);
        }
        outcomes.push(outcome);
      }
      if (open) {
        const now = viewRef.current;
        if (now && docPath.current === open.path && now.state.doc.toString() === open.before) {
          // An edit like his own: it saves, and ⌘Z in the editor undoes it too.
          now.dispatch({ changes: open.edits });
          done.open = open;
          outcomes.push({ path: open.path, result: "saved" });
        } else outcomes.push({ path: open.path, result: "conflict" });
      }
      const files = [...done.disk, ...(done.open ? [done.open] : [])];
      const links = files.reduce((n, f) => n + f.edits.length, 0);
      linksDone(
        files.length ? updated(links, files.length) : "No links updated; every note changed since.",
        files.length,
        outcomes,
        files.length ? () => void undoLinks(done) : undefined,
      );
    } catch (e) {
      toast.error(`Couldn’t update links: ${e}`, { id: nextLinksToast() });
    }
  };

  /** After a rename: offer, quietly, to rewrite the links that pointed at it.
   *  Nothing is written until he says Update. */
  const offerLinks = async (from: string, to: string, open: { path: string; text: string } | null) => {
    try {
      const plan = await vault.linksPlan(from, to, open);
      if (!plan.files.length) return;
      toast(question(plan.links, plan.files.length), {
        id: nextLinksToast(),
        duration: Infinity,
        action: { label: "Update", onClick: () => void updateLinks(plan) },
        cancel: { label: "Not now", onClick: () => {} },
      });
    } catch (e) {
      toast.error(`Couldn’t look for links to update: ${e}`, { id: nextLinksToast() });
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
        bases.current.set(moved, current);
        setDoc({ path: moved, text: current });
        if (rootRef.current) lastOpened.set(rootRef.current, moved);
      }
      setSelectedDir((dir) => renamedPath(dir, path, to) ?? dir);
      await refresh();
      const view = viewRef.current;
      const openPath = doc ? (moved ?? doc.path) : null;
      void offerLinks(path, to, openPath && view ? { path: openPath, text: view.state.doc.toString() } : null);
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

  // Tags live in the frontmatter, so adding one is an edit like any other:
  // it saves, undoes and syncs with the writing.
  const changeTags = (update: (tags: string[]) => string[]) => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (field(current, "mirror")) return;
    const change = setTags(current, update(tagsOf(current)));
    if (change) view.dispatch({ changes: change });
  };

  // ⌘K: the selection, or the paragraph under the cursor when nothing is selected.
  const openRefine = () => {
    const view = viewRef.current;
    if (!view) return;
    let { from, to } = view.state.selection.main;
    if (from === to) ({ from, to } = paragraphRange(view.state) ?? view.state.doc.lineAt(from));
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
  const docTags = useMemo(() => tagsOf(text), [text]);
  const tagsInUse = useMemo(() => vocabulary(docs.map((d) => d.tags)), [docs]);
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
        tagFilter={tagFilter}
        onTagFilter={setTagFilter}
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
            onRefine={(from, to, action) => setRefine({ from, to, action })}
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
                <DocTags tags={docTags} vocabulary={tagsInUse} onChange={changeTags} />
                <Badge asChild variant={status === "complete" ? "default" : "outline"}>
                  <button onClick={toggleStatus} title="Toggle status (⇧⌘D)">
                    {status ?? "no status"}
                  </button>
                </Badge>
                {status === "complete" && <button className="hover:text-foreground" onClick={openPublish} title="Publish to the blog (⇧⌘P)">Publish…</button>}
              </>
            )}
            <ExportMenu mirror={!!mirror} />
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
      {refine && viewRef.current && doc && (
        <Refine
          view={viewRef.current}
          from={refine.from}
          to={refine.to}
          path={doc.path}
          docs={docs}
          initial={refine.action}
          onClose={() => {
            setRefine(null);
            viewRef.current?.focus();
          }}
        />
      )}
      <Palette mode={palette} docs={docs} onOpen={openDoc} onCreate={create} onClose={() => setPalette(null)} />
      <UnsavedDialog failures={blocked?.failures ?? null} action={blocked?.action ?? ""} onChoose={answer} />
      <OutsideDialog collision={collision} onChoose={chooseOutside} />
      <PhoneDialog
        open={phoneOpen}
        status={phoneStatus}
        onStatus={setPhoneStatus}
        onClose={() => setPhoneOpen(false)}
      />
      <Publish root={root} path={doc && !away ? doc.path : null} viewRef={viewRef} flush={flush} />
      <Export root={root} path={doc && !away ? doc.path : null} viewRef={viewRef} flush={flush} />
      <Settings />
      <AboutYou />
      <KinDev />
      <KinChat />
      <Toaster position="bottom-center" />
    </SidebarProvider>
  );
}
