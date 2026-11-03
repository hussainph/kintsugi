import { AlertCircle, CircleCheckIcon, FileExport, Globe, Keyboard, Lightbulb, NotebookPen } from "@kintsugi/ui/icons";
import { Toolbar } from "@kintsugi/ui/graphical";
import { Tooltip, TooltipContent, TooltipTrigger } from "@kintsugi/ui/components/tooltip";
import type { ComponentProps, ReactNode } from "react";
import { Shortcut, ShortcutHint } from "@/components/Shortcuts";
import { DocTags } from "@/components/Tags";
import type { ShortcutId } from "@/lib/shortcuts";
import { ExportMenu } from "@/export/ExportMenu";

type Save = "saved" | "editing" | "error";

/** The bar under the open document: its tags and status, what can be done
 *  with it, and how long it is and whether it is saved. */
export function DocumentBar({
  mirror,
  tags,
  vocabulary,
  onTags,
  status,
  onToggleStatus,
  onPublish,
  onIdeas,
  words,
  save,
  onShortcuts,
  extra,
}: {
  /** The blog repository a read-only mirror comes from, if it is one. */
  mirror: string | null;
  tags: string[];
  vocabulary: string[];
  onTags: (update: (tags: string[]) => string[]) => void;
  status: string | null;
  onToggleStatus: () => void;
  onPublish: () => void;
  onIdeas: () => void;
  words: number;
  save: Save;
  onShortcuts: () => void;
  /** PROTOTYPE (KI-96): controls the Kin surface prototype adds. */
  extra?: ReactNode;
}) {
  return (
    <footer className="ki-document-bar ki-text-xs">
      <div className="ki-document-bar-meta">
        {mirror ? (
          <span className="truncate" title="Generated from the blog repository; edit the post there">
            Read-only mirror of {mirror}
          </span>
        ) : (
          <>
            <DocTags tags={tags} vocabulary={vocabulary} onChange={onTags} />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="ki-chip ki-status-chip"
                  data-status={status ?? "none"}
                  onClick={onToggleStatus}
                  aria-label={`Status: ${status ?? "no status"}. Toggle status`}
                >
                  {status ?? "no status"}
                  <ShortcutHint id="status" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Toggle status <Shortcut id="status" /></TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
      {extra}
      <Toolbar.Root className="ki-document-bar-actions" aria-label="Document actions">
        {!mirror && status === "complete" && (
          <BarButton label="Publish…" tip="Publish to the blog" shortcut="publish" onClick={onPublish}>
            <Globe />
          </BarButton>
        )}
        <ExportMenu mirror={!!mirror}>
          <BarButton label="Export…" tip="Export" shortcut="export">
            <FileExport />
          </BarButton>
        </ExportMenu>
        <BarButton label="Ideas" tip="Ideas for this draft" onClick={onIdeas}>
          <Lightbulb />
        </BarButton>
        <BarButton label="Keyboard shortcuts" tip="Keyboard shortcuts" shortcut="shortcuts" onClick={onShortcuts}>
          <Keyboard />
        </BarButton>
      </Toolbar.Root>
      <div className="ki-document-bar-info">
        <span className="ki-document-bar-words">{words.toLocaleString()} {words === 1 ? "word" : "words"}</span>
        <span role="status" className="ki-document-bar-save" data-save={save}>
          {save === "error" ? <AlertCircle /> : save === "editing" ? <NotebookPen /> : <CircleCheckIcon />}
          {{ saved: "Saved", editing: "Editing", error: "Not saved" }[save]}
        </span>
      </div>
    </footer>
  );
}

/** An icon-only toolbar button named by `label`, with a tooltip. Props it
 *  doesn't use pass through, so a popover trigger can wrap it. */
function BarButton({
  label,
  tip,
  shortcut,
  children,
  ...props
}: { label: string; tip: string; shortcut?: ShortcutId; children: ReactNode } & ComponentProps<typeof Toolbar.Button>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toolbar.Button className="ui-toolbar-icon relative" aria-label={label} {...props}>
          {children}
          {shortcut && <ShortcutHint id={shortcut} side="above" />}
        </Toolbar.Button>
      </TooltipTrigger>
      <TooltipContent>{tip}{shortcut && <> <Shortcut id={shortcut} /></>}</TooltipContent>
    </Tooltip>
  );
}
