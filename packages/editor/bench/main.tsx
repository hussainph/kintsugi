// Types at the end of a document one character at a time and reports, per
// keystroke, the dispatch alone and the dispatch plus CodeMirror's measure
// cycle and layout ("frame"). Timers, not requestAnimationFrame, so a
// background tab measures the same work.
// ?doc=short|long|huge  ?margin=0 drops onParagraph (the phone has none)
// ?onchange=0 drops onChange (the phone reads text on its own schedule)
import { forceParsing } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { createRoot } from "react-dom/client";
import { useRef } from "react";
import { Editor, type References } from "../src/Editor";
import { sample } from "./samples";

const params = new URLSearchParams(location.search);
const name = (params.get("doc") ?? "huge") as "short" | "long" | "huge";
const text = sample(name);
const sources = [
  { kind: "document", path: "drafts/on-writing.mdx", title: "On writing in the margins" },
  { kind: "document", path: "posts/kintsugi.mdx", title: "Kintsugi: mending with gold" },
  { kind: "document", path: "notes/phone-editor.md", title: "Phone editor notes" },
] as References["sources"];
const references: References = {
  sources,
  onOpen: () => {},
  ...(params.get("margin") === "0" ? {} : { onParagraph: () => {} }),
};

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] * 10) / 10;
};

// Hidden tabs throttle timers and frames; message events are not throttled.
const channel = new MessageChannel();
let next: (() => void) | null = null;
channel.port1.onmessage = () => next?.();
const yieldThen = (fn: () => void) => { next = fn; channel.port2.postMessage(0); };

function run(view: EditorView) {
  const n = Number(params.get("n") ?? 200);
  const frame: number[] = [];
  const dispatch: number[] = [];
  const word = "lorem ipsum dolor sit amet ";
  // Finish the Markdown parse first: until it's done, CodeMirror spends up
  // to 20 ms of every update continuing it, whatever the extensions do.
  if (params.get("parse") !== "0") forceParsing(view, view.state.doc.length, 10_000);
  view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
  let i = 0;
  const step = () => {
    if (i >= n) {
      const result = {
        doc: name, chars: view.state.doc.length, n,
        frame: { p50: pct(frame, 0.5), p95: pct(frame, 0.95), max: pct(frame, 1) },
        dispatch: { p50: pct(dispatch, 0.5), p95: pct(dispatch, 0.95), max: pct(dispatch, 1) },
        slow: frame.flatMap((ms, i) => (ms > 10 ? [`${i}:${Math.round(ms)}`] : [])).join(" "),
      };
      (window as unknown as { result: unknown }).result = result;
      document.getElementById("out")!.textContent = JSON.stringify(result);
      return;
    }
    const start = performance.now();
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: word[i % word.length] }, selection: { anchor: at + 1 }, scrollIntoView: true, userEvent: "input.type" });
    dispatch.push(performance.now() - start);
    // Flush the measure cycle CodeMirror would run on the next frame.
    (view as unknown as { measure(flush?: boolean): void }).measure();
    void view.contentDOM.offsetHeight;
    frame.push(performance.now() - start);
    i++;
    yieldThen(step);
  };
  yieldThen(step);
}

function App() {
  const viewRef = useRef<EditorView | null>(null);
  const started = useRef(false);
  const onChange = params.get("onchange") === "0" ? undefined : (_path: string, next: string) => void next.length;
  return (
    <Editor
      path="bench.mdx"
      text={text}
      viewRef={{
        get current() { return viewRef.current; },
        set current(view) {
          viewRef.current = view;
          if (view && !started.current) { started.current = true; setTimeout(() => run(view), 0); }
        },
      }}
      references={references}
      onChange={onChange as never}
    />
  );
}

createRoot(document.getElementById("root")!).render(<App />);
