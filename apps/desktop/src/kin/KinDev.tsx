import { useEffect, useRef, useState } from "react";
import { Button } from "@kintsugi/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@kintsugi/ui/components/dialog";
import { Textarea } from "@kintsugi/ui/components/textarea";
import { ask, dollars, KinEvent, KinTask, Summary } from "@/lib/kin";

type Log = { id: string; name: string; arguments: unknown; preview?: string; isError?: boolean };

/** A minimal developer surface for Kin's harness: ask one question, watch
 *  the tool calls stream, see the cost. The real chat UI comes later.
 *  Opens on ⇧⌘K or the `kintsugi:open-kin-dev` event. */
export function KinDev() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [task, setTask] = useState<KinTask>("chat");
  const [background, setBackground] = useState(false);
  const [remember, setRemember] = useState(true);
  const [text, setText] = useState("");
  const [log, setLog] = useState<Log[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const cancel = useRef<(() => void) | null>(null);

  useEffect(() => {
    const show = () => setOpen(true);
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        show();
      }
    };
    window.addEventListener("kintsugi:open-kin-dev", show);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("kintsugi:open-kin-dev", show);
      window.removeEventListener("keydown", key, true);
    };
  }, []);

  const onEvent = (event: KinEvent) => {
    switch (event.type) {
      case "text":
        return setText((t) => t + event.delta);
      case "toolCall":
        // Text before a tool call was thinking aloud; the answer comes after.
        setText("");
        return setLog((l) => [...l, { id: event.id, name: event.name, arguments: event.arguments }]);
      case "toolResult":
        return setLog((l) => l.map((x) => (x.id === event.id ? { ...x, preview: event.preview, isError: event.isError } : x)));
      default:
        return;
    }
  };

  const run = async () => {
    if (!question.trim() || running) return;
    setText("");
    setLog([]);
    setSummary(null);
    setError(null);
    setRunning(true);
    const turn = ask({ question, task, background, remember }, onEvent);
    cancel.current = () => void turn.cancel();
    try {
      setSummary(await turn.done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      cancel.current = null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) cancel.current?.(); setOpen(next); }}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Kin (developer)</DialogTitle>
          <DialogDescription>Ask one question. Kin searches and reads the vault; it can only change its own memory and skills.</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          rows={3}
          placeholder="Where have I written about…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) run();
          }}
        />
        <div className="flex items-center gap-3 text-sm">
          <select className="h-8 rounded-md border bg-transparent px-2" value={task} onChange={(e) => setTask(e.target.value as KinTask)} aria-label="Task">
            <option value="chat">chat</option>
            <option value="ideas">ideas</option>
            <option value="triage">triage</option>
          </select>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} />
            background (stops at the cap)
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={!remember} onChange={(e) => setRemember(!e.target.checked)} />
            don’t remember this
          </label>
          <span className="flex-1" />
          {running ? (
            <Button size="sm" variant="outline" onClick={() => cancel.current?.()}>Cancel</Button>
          ) : (
            <Button size="sm" onClick={run} disabled={!question.trim()}>Ask ⌘↩</Button>
          )}
        </div>

        {log.length > 0 && (
          <ol className="space-y-1 font-mono text-xs" aria-label="Tool calls">
            {log.map((call) => (
              <li key={call.id} className="rounded bg-muted/50 px-2 py-1">
                <div className={call.isError ? "text-destructive" : ""}>
                  {call.name} {JSON.stringify(call.arguments)}
                </div>
                {call.preview && <pre className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap text-muted-foreground">{call.preview}</pre>}
              </li>
            ))}
          </ol>
        )}
        {text && <p className="whitespace-pre-wrap text-sm" aria-label="Answer">{text}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {summary && (
          <p className="text-xs text-muted-foreground tabular-nums" aria-label="Turn summary">
            {summary.stop} · {summary.steps} step{summary.steps === 1 ? "" : "s"} · {summary.toolCalls} tool call
            {summary.toolCalls === 1 ? "" : "s"} · {summary.model} · {summary.usage.input + summary.usage.cacheRead + summary.usage.cacheWrite} in (
            {summary.usage.cacheRead} cached) / {summary.usage.output} out · {dollars(summary.usd)}
            {summary.capReached && " · monthly cap reached"}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
