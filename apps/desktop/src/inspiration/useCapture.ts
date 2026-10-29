import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DesktopClipCapture } from "@kintsugi/core/clips";
import { clips } from "./api";
import { imageCapture, isEditable, textCapture } from "./capture";

/** HTML drops handle URLs/text as well as Finder files; native interception is off. */
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
    const saveTransfer = async (data: DataTransfer) => {
      const uri = data.getData("text/uri-list").split("\n").find((line) => line.trim() && !line.startsWith("#"));
      const text = textCapture(uri || data.getData("text/plain"));
      const files = Array.from(data.files);
      if (!files.length) {
        if (text) await capture(text);
        return;
      }
      for (const file of files) {
        try {
          const image = await imageCapture(file);
          await capture({ ...image, ...(text?.url ? { url: text.url } : {}) });
        } catch (e) { toast.error(String(e)); }
      }
    };
    const paste = (e: ClipboardEvent) => {
      if (!e.clipboardData || isEditable(e.target)) return;
      if (!e.clipboardData.files.length && !e.clipboardData.getData("text/plain").trim()) return;
      e.preventDefault();
      saveTransfer(e.clipboardData).catch((e) => toast.error(String(e)));
    };
    let depth = 0;
    let internal = false;
    const start = () => { internal = true; };
    const end = () => { internal = false; depth = 0; setDragging(false); };
    const editing = (e: DragEvent) => isEditable(e.target) && !e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (internal || editing(e)) return;
      e.preventDefault(); depth++; setDragging(true);
    };
    const leave = () => { if (--depth <= 0) { depth = 0; setDragging(false); } };
    const over = (e: DragEvent) => {
      if (internal || editing(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (internal || editing(e)) return;
      e.preventDefault();
      if (e.dataTransfer) saveTransfer(e.dataTransfer).catch((e) => toast.error(String(e)));
    };
    document.addEventListener("dragstart", start);
    document.addEventListener("dragend", end);
    document.addEventListener("paste", paste);
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragleave", leave);
    document.addEventListener("dragover", over);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragstart", start);
      document.removeEventListener("dragend", end);
      document.removeEventListener("paste", paste);
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", drop);
    };
  }, [capture]);
  return { capture, dragging };
}
