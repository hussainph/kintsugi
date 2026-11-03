import { openUrl } from "@tauri-apps/plugin-opener";
import { BookmarkCheck, BookmarkPlus, ChevronDown, Globe, Lightbulb, Link } from "@kintsugi/ui/icons";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@kintsugi/ui/components/collapsible";
import { cn } from "@kintsugi/ui/lib/utils";
import { ideas, openIdeas } from "@/ideas/api";
import { clips } from "@/inspiration/api";
import { capturedAt } from "@/inspiration/capture";
import { insertIntoDocument, insertTarget } from "@/lib/insert";
import { domain, markdownLink, sourcesOf, type WebCall, type WebSource } from "@/lib/web";

/** One capture id per URL, so a second click can't make a second clip. */
const captureIds = new Map<string, string>();
const saved = new Set<string>();

function Favicon({ source }: { source: WebSource }) {
  const [failed, setFailed] = useState(false);
  if (!source.favicon || failed) return <Globe className="size-3.5 shrink-0 text-muted-foreground" />;
  return <img src={source.favicon} alt="" className="size-3.5 shrink-0 rounded-sm" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

const open = (url: string) => void openUrl(url).catch((e) => toast.error(String(e)));

async function saveClip(source: WebSource, done: () => void) {
  const id = captureIds.get(source.url) ?? crypto.randomUUID();
  captureIds.set(source.url, id);
  try {
    await clips.create({ id, url: source.url, ...(source.title ? { title: source.title } : {}), capturedAt: capturedAt(), via: "mac" });
    saved.add(source.url);
    done();
    toast.success("Saved to Inspiration");
  } catch (e) {
    toast.error(String(e));
  }
}

async function turnIntoIdea(source: WebSource) {
  const about = [source.title && `“${source.title}”`, source.url, source.snippet].filter(Boolean).join(" · ");
  try {
    await ideas.generate(`Something he found on the web: ${about}`.slice(0, 500));
    toast("Kin is finding ideas in it.", { action: { label: "Open Ideas", onClick: () => openIdeas() } });
  } catch (e) {
    toast.error(String(e));
  }
}

function addLink(source: WebSource) {
  if (insertIntoDocument(markdownLink(source))) toast("Link added.");
  else toast.error("Open a document to add the link to.");
}

function Row({ source }: { source: WebSource }) {
  const [, rerender] = useState(0);
  const host = domain(source.url);
  const isSaved = saved.has(source.url);
  const canInsert = insertTarget() !== null;
  return (
    <li className="group/source flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50" data-web-source={source.url}>
      <span className="mt-0.5"><Favicon source={source} /></span>
      <button type="button" onClick={() => open(source.url)} className="min-w-0 flex-1 text-left" title={source.url}>
        <span className="block truncate text-xs text-foreground">{source.title || host || source.url}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {host}
          {source.date && ` · ${source.date}`}
        </span>
      </button>
      <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/source:opacity-100 group-focus-within/source:opacity-100 motion-reduce:transition-none">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={isSaved ? "Saved to Inspiration" : "Save to Inspiration"}
          title={isSaved ? "Saved to Inspiration" : "Save to Inspiration"}
          disabled={isSaved}
          onClick={() => void saveClip(source, () => rerender((n) => n + 1))}
        >
          {isSaved ? <BookmarkCheck /> : <BookmarkPlus />}
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Turn into an idea" title="Turn into an idea" onClick={() => void turnIntoIdea(source)}>
          <Lightbulb />
        </Button>
        {canInsert && (
          <Button variant="ghost" size="icon-xs" aria-label="Add link to the document" title="Add link to the document" onClick={() => addLink(source)}>
            <Link />
          </Button>
        )}
      </span>
    </li>
  );
}

/**
 * The web sources behind one reply of Kin's (KI-78): what it searched for
 * and the pages it read, each one clickable, with Save to Inspiration, Turn
 * into an idea and Add link to the document. Self-contained so the chat's
 * layout can change around it.
 */
export function WebSources({ calls, className }: { calls: WebCall[]; className?: string }) {
  const [openList, setOpenList] = useState(false);
  const sources = sourcesOf(calls);
  if (!sources.length) return null;
  const queries = calls.filter((c) => c.tool === "search" && c.query).map((c) => `“${c.query}”`);
  const read = calls.filter((c) => c.tool === "fetch").length;
  const icons = sources.slice(0, 4);
  const did = [queries.length > 0 && `searched ${queries.join(", ")}`, read > 0 && `read ${read} page${read === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  const done = did && did[0].toUpperCase() + did.slice(1);
  return (
    <Collapsible open={openList} onOpenChange={setOpenList} className={cn("w-full", className)} data-web-sources>
      <CollapsibleTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`${sources.length} web sources`}>
          <span className="flex -space-x-1" aria-hidden>
            {icons.map((s) => (
              <span key={s.url} className="rounded-full bg-popover p-px ring-1 ring-popover">
                <Favicon source={s} />
              </span>
            ))}
          </span>
          <span>
            {sources.length} source{sources.length === 1 ? "" : "s"}
          </span>
          <ChevronDown className={cn("size-3 transition-transform motion-reduce:transition-none", openList && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-1">
          {done && <p className="px-1.5 text-xs text-muted-foreground">{done}</p>}
          <ul className="space-y-0.5">
            {sources.map((s) => (
              <Row key={s.url} source={s} />
            ))}
          </ul>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
