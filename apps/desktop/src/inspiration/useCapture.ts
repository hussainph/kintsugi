import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DesktopClipCapture } from "@kintsugi/core/clips";
import { clips } from "./api";
import { capturedAt, imageCapture, isEditable, textCapture } from "./capture";

/** Library-wide listeners include the detail view, but never steal text editing. */
export function useCapture(onCaptured: () => void) {
  const [dragging, setDragging] = useState(false);
  const callback = useRef(onCaptured);
  callback.current = onCaptured;
  const capture = useCallback(async (value: DesktopClipCapture) => {
    const path = await clips.create(value);
    callback.current();
    toast.success("Saved to inspiration");
    return path;
  }, []);

  useEffect(() => {
    const saveFiles = async (files: File[]) => {
      for (const file of files) {
        try { await capture(await imageCapture(file)); }
        catch (e) { toast.error(String(e)); }
      }
    };
    const paste = (e: ClipboardEvent) => {
      if (isEditable(e.target) || !e.clipboardData) return;
      const files = Array.from(e.clipboardData.files);
      if (files.length) {
        e.preventDefault();
        void saveFiles(files);
      } else {
        const value = textCapture(e.clipboardData.getData("text/plain"));
        if (!value) return;
        e.preventDefault();
        capture(value).catch((e) => toast.error(String(e)));
      }
    };
    let depth = 0;
    const enter = (e: DragEvent) => { e.preventDefault(); depth++; setDragging(true); };
    const leave = () => { if (--depth <= 0) { depth = 0; setDragging(false); } };
    const over = (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (!e.dataTransfer) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length) void saveFiles(files);
      else {
        const uri = e.dataTransfer.getData("text/uri-list").split("\n").find((line) => line.trim() && !line.startsWith("#"));
        const value = textCapture(uri || e.dataTransfer.getData("text/plain"));
        if (value) capture(value).catch((e) => toast.error(String(e)));
      }
    };
    document.addEventListener("paste", paste);
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragleave", leave);
    document.addEventListener("dragover", over);
    document.addEventListener("drop", drop);
    // Tauri intercepts Finder drops before HTML receives the file bytes.
    let active = true;
    const off = getCurrentWebview().onDragDropEvent(async ({ payload }) => {
      if (!active) return;
      setDragging(payload.type === "enter" || payload.type === "over");
      if (payload.type !== "drop") return;
      for (const path of payload.paths) {
        try {
          await clips.captureImage(path, capturedAt());
          callback.current();
          toast.success("Saved to inspiration");
        } catch (e) { toast.error(String(e)); }
      }
    }).catch(() => () => {});
    return () => {
      active = false;
      off.then((stop) => stop());
      document.removeEventListener("paste", paste);
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", drop);
    };
  }, [capture]);
  return { capture, dragging };
}
