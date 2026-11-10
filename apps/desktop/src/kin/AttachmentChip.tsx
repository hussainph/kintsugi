import { useEffect, useState } from "react";
import { FileText, X } from "@kintsugi/ui/icons";
import { PromptInputChip } from "@kintsugi/ui/ai";
import { attachments } from "@/lib/chat";
import { chipKey, chipTitle, type Chip } from "@/lib/chips";

let cachedVault = -1;
const previews = new Map<string, Promise<string | null>>();

/** Only data URLs are cached, never native paths or credentials. A new vault
 * gets a fresh cache even if it happens to use the same attachment reference. */
function preview(vault: number, path: string) {
  if (vault !== cachedVault) {
    previews.clear();
    cachedVault = vault;
  }
  let result = previews.get(path);
  if (!result) {
    result = attachments.preview(path).then((url) => url?.startsWith("data:image/") ? url : null);
    previews.set(path, result);
    if (previews.size > 32) previews.delete(previews.keys().next().value!);
    const requested = result;
    void result.catch(() => { if (previews.get(path) === requested) previews.delete(path); });
  }
  return result;
}

/** Pending attachments can be removed; the same preview is read-only once sent. */
export function AttachmentChip({ chip, vault, onRemove }: { chip: Chip; vault: number; onRemove?: () => void }) {
  const [image, setImage] = useState<{ vault: number; path: string; url: string } | null>(null);
  useEffect(() => {
    let active = true;
    void preview(vault, chip.path).then((url) => {
      if (active) setImage(url ? { vault, path: chip.path, url } : null);
    }).catch(() => { if (active) setImage(null); });
    return () => { active = false; };
  }, [vault, chip.path]);
  const title = chipTitle(chip);
  const url = image?.vault === vault && image.path === chip.path ? image.url : null;
  if (!url) return <PromptInputChip data-chip={chipKey(chip)} data-attachment icon={FileText} label={title} title={title} onRemove={onRemove} />;
  return (
    <span data-chip={chipKey(chip)} data-attachment className="ki-prompt-chip ki-kin-attachment" title={title}>
      <img className="ki-kin-attachment-image" src={url} alt="" onError={() => setImage(null)} />
      <span className="ki-prompt-chip-label">{title}</span>
      {onRemove && <button type="button" className="ki-prompt-chip-remove" aria-label={`Remove ${title}`} onClick={onRemove}><X /></button>}
    </span>
  );
}
