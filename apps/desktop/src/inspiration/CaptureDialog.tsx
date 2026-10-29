import { ImagePlus } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@kintsugi/ui/components/dialog";
import { Textarea } from "@kintsugi/ui/components/textarea";
import type { DesktopClipCapture } from "@kintsugi/core/clips";
import { IMAGE_TYPES, imageCapture, textCapture } from "./capture";

export function CaptureDialog({ open, onClose, capture }: { open: boolean; onClose: () => void; capture: (value: DesktopClipCapture) => Promise<string> }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File>();
  const [saving, setSaving] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const save = async () => {
    const value = textCapture(text);
    if (!value && !file) return;
    setSaving(true);
    try {
      const image = file ? await imageCapture(file) : undefined;
      await capture({ ...(value ?? image!), ...(image ? { image: image.image, imageType: image.imageType } : {}) });
      setText("");
      setFile(undefined);
      onClose();
    } catch (e) { toast.error(String(e)); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-md motion-reduce:animate-none">
        <DialogHeader>
          <DialogTitle>Keep a little inspiration</DialogTitle>
          <DialogDescription>A link, a passage, an image, or a thought of your own.</DialogDescription>
        </DialogHeader>
        <Textarea autoFocus aria-label="URL or text to capture" placeholder="What would you like to keep?" className="min-h-36 resize-y select-text" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
          if (e.metaKey && e.key === "Enter") { e.preventDefault(); void save(); }
        }} />
        <div className="flex items-center justify-between gap-3">
          <input ref={picker} type="file" accept={IMAGE_TYPES.join(",")} className="hidden" aria-label="Choose an image" onChange={(e) => setFile(e.target.files?.[0])} />
          <Button variant="ghost" onClick={() => picker.current?.click()} className="min-w-0 text-muted-foreground"><ImagePlus /><span className="truncate">{file?.name ?? "Add an image"}</span></Button>
          <Button disabled={saving || (!text.trim() && !file)} onClick={save}>{saving ? "Saving…" : "Keep it"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
