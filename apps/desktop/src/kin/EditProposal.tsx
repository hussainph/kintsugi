import { diffWords } from "diff";
import { Check, FileDiff, Undo2 } from "@kintsugi/ui/icons";
import { useEffect, useReducer } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { useCopy } from "@kintsugi/ui/ai";
import { onScreenChanged } from "@/lib/chat";
import { findInDocument, onInsertTarget, replaceInDocument } from "@/lib/insert";
import { openLink } from "./links";
import type { EditPair, ProposedEdit } from "./edits";

/** Applied edits, by reply and block, so a re-render keeps "Applied". */
const applied = new Set<string>();

function Diff({ pair }: { pair: EditPair }) {
  return (
    <p className="ki-edit-diff">
      {diffWords(pair.before, pair.after).map((part, i) =>
        part.added ? (
          <ins key={i} className="ki-diff-added">{part.value}</ins>
        ) : part.removed ? (
          <del key={i} className="ki-diff-removed">{part.value}</del>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </p>
  );
}

/** Re-renders when the open document or the screen changes. */
function useDocumentState() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const offTarget = onInsertTarget(bump);
    const offScreen = onScreenChanged(bump);
    return () => {
      offTarget();
      offScreen();
    };
  }, []);
  return bump;
}

/**
 * An edit Kin proposed (KI-79): the change as a word diff, and Apply,
 * which replaces the passage in the open document as one undoable change.
 * Nothing is written until he applies it.
 */
export function EditProposal({ edit, id }: { edit: ProposedEdit; id: string }) {
  const bump = useDocumentState();
  const { copied, copy } = useCopy();
  const isApplied = applied.has(id);
  const name = edit.path.replace(/^.*\//, "").replace(/\.mdx?$/, "");
  const found = edit.pairs.map((p) => findInDocument(edit.path, isApplied ? p.after : p.before));
  const open = found.every((f) => f !== null);
  const ready = open && found.every((f) => f === "once");

  const apply = () => {
    const done = edit.pairs.filter((p) => replaceInDocument(edit.path, p.before, p.after)).length;
    if (done !== edit.pairs.length) toast.error("The passage changed since Kin read it.");
    if (done) applied.add(id);
    bump();
  };
  const undo = () => {
    edit.pairs.forEach((p) => replaceInDocument(edit.path, p.after, p.before));
    applied.delete(id);
    bump();
  };

  let status: string | null = null;
  if (open && !isApplied && !ready) status = found.includes("ambiguous") ? "The passage appears more than once." : "The passage has changed.";

  return (
    <div className="ki-edit" data-edit={edit.path} data-applied={isApplied || undefined}>
      <div className="ki-edit-header">
        <FileDiff aria-hidden className="ki-edit-icon" />
        <button type="button" className="ki-edit-path" data-path={edit.path} onClick={() => openLink(edit.path)}>
          {name}
        </button>
      </div>
      <div className="ki-edit-body">
        {edit.pairs.map((pair, i) => (
          <Diff key={i} pair={pair} />
        ))}
      </div>
      <div className="ki-edit-footer">
        {isApplied ? (
          <>
            <span className="ki-edit-status" data-applied>
              <Check aria-hidden /> Applied
            </span>
            {open && (
              <Button variant="ghost" size="xs" onClick={undo}>
                <Undo2 aria-hidden /> Undo
              </Button>
            )}
          </>
        ) : open ? (
          <Button size="xs" disabled={!ready} onClick={apply}>
            Apply
          </Button>
        ) : (
          <Button variant="outline" size="xs" onClick={() => openLink(edit.path)}>
            Open {name}
          </Button>
        )}
        <Button variant="ghost" size="xs" onClick={() => void copy(edit.pairs.map((p) => p.after).join("\n\n"))}>
          {copied ? "Copied" : "Copy"}
        </Button>
        {status && <span className="ki-edit-status">{status}</span>}
      </div>
    </div>
  );
}
