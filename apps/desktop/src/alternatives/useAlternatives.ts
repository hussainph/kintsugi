import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Alternatives, AlternativeSet } from "@kintsugi/editor/Editor";

/**
 * The open document's alternatives (KI-86) for the editor. They're stored
 * beside the document in `.kintsugi/alternatives/` (`src-tauri/src/alternatives.rs`);
 * the editor places them, swaps them and hands back the whole list to save.
 */
type File = { path: string; sets: AlternativeSet[] };

export function useAlternatives(path: string): Alternatives | undefined {
  const [file, setFile] = useState<File | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    invoke<File>("alternatives_load", { path })
      .then((loaded) => { if (!cancelled) setFile({ path, sets: loaded.sets }); })
      // A file that can't be read is left alone: the editor never saves over it.
      .catch((error) => console.warn("alternatives unavailable", error));
    return () => { cancelled = true; };
  }, [path]);

  return useMemo<Alternatives | undefined>(() => file ? {
    path: file.path,
    sets: file.sets,
    onSave: (at, sets) => {
      invoke("alternatives_save", { path: at, sets }).catch((error) => console.warn("alternatives not saved", error));
    },
  } : undefined, [file]);
}
