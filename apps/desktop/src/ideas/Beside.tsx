import { listen } from "@tauri-apps/api/event";
import { Lightbulb, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { body } from "@kintsugi/core/frontmatter";
import { cn } from "@kintsugi/ui/lib/utils";
import { discuss } from "@/lib/chat";
import { ideas, IDEAS_CHANGED, type Idea, type Quote } from "./api";
import { adoptedIds } from "./model";
import { ClipQuote, KinMark, Label, seam, serif } from "./parts";

/**
 * Adopt's other half: the idea and its clips beside the draft, never in
 * it. Shown when the open document's frontmatter lists ideas; open at first
 * while the body is still empty.
 */
export function IdeasBeside({ path, text, onOpenDoc }: { path: string; text: string; onOpenDoc: (path: string) => void }) {
  const idsKey = adoptedIds(text).join(" ");
  const ids = useMemo(() => (idsKey ? idsKey.split(" ") : []), [idsKey]);
  const [found, setFound] = useState<Idea[]>([]);
  const empty = !body(text).trim();
  const [open, setOpen] = useState(empty);

  useEffect(() => setOpen(empty), [path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ids.length) return setFound([]);
    let live = true;
    const load = () => void ideas.get(ids).then((next) => live && setFound(next), () => live && setFound([]));
    load();
    const off = listen(IDEAS_CHANGED, load);
    return () => {
      live = false;
      off.then((stop) => stop());
    };
  }, [ids]);

  if (!found.length) return null;
  const clips = found.flatMap((i) => i.quotes).filter((q) => q.source !== path);
  const label = `${found.length === 1 ? "Idea" : `${found.length} ideas`} · ${clips.length} ${clips.length === 1 ? "clip" : "clips"}`;
  const openQuote = (q: Quote) => {
    if (q.source.startsWith("inspiration/")) window.dispatchEvent(new CustomEvent("kintsugi:open-clip", { detail: { path: q.source } }));
    else if (!q.source.startsWith("feed:")) onOpenDoc(q.source);
  };

  return (
    // Left of the reference margin's toggle (right: 18px, top: 38px in
    // references.css), on the same line, so neither covers the other.
    <div className={cn("absolute top-[38px] right-14 z-10 flex max-h-[calc(100%-6rem)] w-80 flex-col items-end", seam)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        aria-label={`${label} beside this draft`}
        title="The idea beside this draft, never in it"
        className="flex items-center gap-1.5 rounded-full border bg-background/90 px-3 py-1 text-xs whitespace-nowrap text-muted-foreground shadow-xs backdrop-blur hover:text-foreground"
      >
        <Lightbulb className="size-3.5 text-[var(--seam-ink)]" />
        {label}
      </button>
      {open && (
        <aside aria-label="Idea beside the draft" className="mt-2 w-full space-y-6 overflow-y-auto rounded-xl border bg-background p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <Label>{found.length === 1 ? "The idea" : "The ideas"}</Label>
            <button type="button" aria-label="Hide" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </div>
          {found.map((idea) => (
            <div key={idea.id} className="space-y-4">
              <div className="space-y-2">
                <KinMark size="xs">from Kin · {idea.created.slice(0, 10)}</KinMark>
                <p className="text-sm font-medium">{idea.title}</p>
                <p className={cn(serif, "border-l-2 border-[var(--seam)] pl-3.5 text-[15px] leading-relaxed")}>{idea.hunch}</p>
              </div>
              <div className="space-y-3">
                {idea.quotes
                  .filter((q) => q.source !== path)
                  .map((q) => (
                    <ClipQuote key={q.source + q.text} quote={q} compact onOpen={openQuote} />
                  ))}
              </div>
              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => discuss([{ kind: "idea", path: idea.id, label: idea.title }, { kind: "doc", path }])}
              >
                Discuss with Kin
              </button>
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">In the file’s frontmatter, never in the prose. Clips are wikilinks.</p>
        </aside>
      )}
    </div>
  );
}
