'use dom';

// KI-28 spike: the Mac's CodeMirror editor (packages/editor), unchanged,
// rendered inside an Expo DOM component. Dev-only; see app/editor-spike.tsx.
// Everything here runs in the WebView's JS engine, not Hermes.

import { redo, undo } from '@codemirror/commands';
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useDOMImperativeHandle, type DOMImperativeFactory } from 'expo/dom';
import { type Ref, useEffect, useMemo, useRef } from 'react';
import { Editor } from '@kintsugi/editor/Editor';
import type { References } from '@kintsugi/editor/Editor';

import './spike.css';

export type Metrics = {
  /** Native screen render → editor mounted here (props over the bridge,
   *  WebView load, bundle parse, CodeMirror setup). */
  readyMs: number;
  docChars: number;
  /** This bundle evaluated → editor mounted. */
  mountMs: number;
  /** Real keystrokes: beforeinput → next frame painted. */
  keys: number;
  keyP50: number;
  keyP95: number;
  keyMax: number;
  /** Synthetic bench: one dispatch per frame. */
  bench?: { n: number; p50: number; p95: number; max: number };
  /** Full text through a native action and back. */
  bridgeMs?: number;
  /** Scrolling: frames over 20ms while the scroller moved. */
  scrollFrames: number;
  scrollJank: number;
  lines: number;
  scrollTop: number;
  selection: string;
};

export interface SpikeEditorRef extends DOMImperativeFactory {
  undo: () => void;
  redo: () => void;
  bold: () => void;
  link: () => void;
  blur: () => void;
  focusEnd: () => void;
  bench: () => void;
  scrollBench: () => void;
  report: () => void;
}

type Props = {
  ref: Ref<SpikeEditorRef>;
  dom?: import('expo/dom').DOMProps;
  text: string;
  sentAt: number;
  dark: boolean;
  /** Turn the keyboard's autocorrect, predictions, spellcheck and
   *  auto-capitalisation back on (CodeMirror switches them off). */
  keyboardText: boolean;
  onMetrics: (metrics: Metrics) => Promise<void>;
  onText: (text: string) => Promise<number>;
};

const pct = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] * 10) / 10;
};

// Module evaluation in the WebView: the start of this side's work.
const loadedAt = performance.now();

const afterPaint = (fn: () => void) => requestAnimationFrame(() => setTimeout(fn, 0));

const sources: References['sources'] = [
  { kind: 'document', path: 'drafts/on-writing.mdx', title: 'On writing in the margins' },
  { kind: 'document', path: 'posts/kintsugi.mdx', title: 'Kintsugi: mending with gold' },
  { kind: 'document', path: 'notes/phone-editor.md', title: 'Phone editor notes' },
] as References['sources'];

export default function SpikeEditor({ ref, text, sentAt, dark, keyboardText, onMetrics, onText }: Props) {
  const viewRef = useRef<EditorView | null>(null);
  const keys = useRef<number[]>([]);
  const frames = useRef({ n: 0, jank: 0 });
  const metrics = useRef<Metrics>({
    readyMs: 0,
    docChars: text.length,
    mountMs: 0,
    keys: 0,
    keyP50: 0,
    keyP95: 0,
    keyMax: 0,
    scrollFrames: 0,
    scrollJank: 0,
    lines: 0,
    scrollTop: 0,
    selection: '',
  });
  const onMetricsRef = useRef(onMetrics);
  const onTextRef = useRef(onText);
  useEffect(() => {
    onMetricsRef.current = onMetrics;
    onTextRef.current = onText;
  });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const report = () => {
    const view = viewRef.current;
    const m = metrics.current;
    m.keys = keys.current.length;
    m.keyP50 = pct(keys.current, 0.5);
    m.keyP95 = pct(keys.current, 0.95);
    m.keyMax = pct(keys.current, 1);
    m.scrollFrames = frames.current.n;
    m.scrollJank = frames.current.jank;
    if (view) {
      m.lines = view.state.doc.lines;
      m.docChars = view.state.doc.length;
      m.scrollTop = Math.round(view.scrollDOM.scrollTop);
      const s = view.state.selection.main;
      m.selection = `${s.from}-${s.to}`;
    }
    console.log('[spike] metrics', JSON.stringify(m));
    void onMetricsRef.current({ ...m });
  };

  const references = useMemo<References>(
    () => ({ sources, onOpen: (source) => console.log('[spike] open', source.path) }),
    [],
  );

  // Measure real keystrokes: the time from the input event to the next
  // painted frame, which is what the writer feels.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    metrics.current.readyMs = Date.now() - sentAt;
    metrics.current.mountMs = Math.round(performance.now() - loadedAt);
    const onInput = () => {
      const start = performance.now();
      afterPaint(() => {
        keys.current.push(performance.now() - start);
        if (keys.current.length % 10 === 0) report();
      });
    };
    view.contentDOM.addEventListener('beforeinput', onInput, true);
    let last = 0;
    const onScroll = () => {
      requestAnimationFrame((t) => {
        if (last && t - last > 20) frames.current.jank++;
        frames.current.n++;
        last = t;
      });
    };
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    afterPaint(report);
    return () => {
      view.contentDOM.removeEventListener('beforeinput', onInput, true);
      view.scrollDOM.removeEventListener('scroll', onScroll);
    };
    // `sentAt` is fixed for the life of the screen.
  }, [sentAt]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !keyboardText) return;
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.contentAttributes.of({ autocorrect: 'on', autocapitalize: 'sentences', spellcheck: 'true' }),
      ),
    });
  }, [keyboardText]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  useDOMImperativeHandle(
    ref,
    () => ({
      undo: () => {
        const view = viewRef.current;
        if (view) undo(view);
      },
      redo: () => {
        const view = viewRef.current;
        if (view) redo(view);
      },
      bold: () => {
        const view = viewRef.current;
        if (!view) return;
        const mark = '**';
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: [
            { from, insert: mark },
            { from: to, insert: mark },
          ],
          selection: { anchor: from + mark.length, head: to + mark.length },
        });
      },
      link: () => {
        const view = viewRef.current;
        if (!view) return;
        const insert = '[[';
        const { from, to } = view.state.selection.main;
        view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.type' });
      },
      blur: () => viewRef.current?.contentDOM.blur(),
      focusEnd: () => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
        view.focus();
      },
      // One insert per frame at the cursor, timing dispatch → painted frame.
      bench: () => {
        const n = 200;
        const view = viewRef.current;
        if (!view) return;
        const times: number[] = [];
        const word = 'lorem ipsum dolor sit amet ';
        let i = 0;
        const step = () => {
          if (i >= n) {
            metrics.current.bench = { n, p50: pct(times, 0.5), p95: pct(times, 0.95), max: pct(times, 1) };
            report();
            return;
          }
          const start = performance.now();
          const at = view.state.selection.main.head;
          view.dispatch({ changes: { from: at, insert: word[i % word.length] }, selection: { anchor: at + 1 }, scrollIntoView: true, userEvent: 'input.type' });
          afterPaint(() => {
            times.push(performance.now() - start);
            i++;
            step();
          });
        };
        step();
      },
      // Programmatic smooth scroll through the document, counting slow frames.
      scrollBench: () => {
        const view = viewRef.current;
        if (!view) return;
        frames.current = { n: 0, jank: 0 };
        const scroller = view.scrollDOM;
        const end = scroller.scrollHeight - scroller.clientHeight;
        const startAt = performance.now();
        const tick = () => {
          const t = Math.min(1, (performance.now() - startAt) / 4000);
          scroller.scrollTop = end * t;
          if (t < 1) requestAnimationFrame(tick);
          else afterPaint(report);
        };
        requestAnimationFrame(tick);
      },
      report,
    }),
    [],
  );

  return (
    <div className="spike-root">
      <Editor
        path="spike.mdx"
        text={text}
        viewRef={viewRef}
        references={references}
        onChange={(_path, next) => {
          // What the real phone editor would do: hand the text to native
          // storage, debounced. Timed so the bridge cost is visible.
          clearTimeout(timer.current);
          timer.current = setTimeout(async () => {
            const start = performance.now();
            await onTextRef.current(next);
            metrics.current.bridgeMs = Math.round((performance.now() - start) * 10) / 10;
          }, 400);
        }}
      />
    </div>
  );
}
