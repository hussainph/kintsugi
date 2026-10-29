import { ImageOff } from "lucide-react";
import { useEffect, useState } from "react";
import { clips } from "./api";

/** Binary IPC, not a filesystem URL. Unmounting a virtual tile frees its bytes. */
export function ClipImage({ path, image, className, alt }: { path: string; image: string; className?: string; alt: string }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setFailed(false);
    clips.image(path).then((bytes) => {
      if (!active) return;
      // The command validates raster bytes. No SVG or arbitrary vault files.
      objectUrl = URL.createObjectURL(new Blob([bytes]));
      setUrl(objectUrl);
    }).catch(() => { if (active) setFailed(true); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, image]);
  return url && !failed ? (
    <img draggable={false} src={url} alt={alt} className={className} decoding="async" onError={() => setFailed(true)} />
  ) : (
    <div className={`${className ?? ""} flex items-center justify-center bg-muted text-muted-foreground`} role="img" aria-label={failed ? "Image unavailable" : "Loading image"}>
      {failed && <ImageOff className="size-5 opacity-50" />}
    </div>
  );
}
