'use dom';

// KI-36: the Mac's editor (packages/editor) on the phone, in an Expo DOM
// component. Everything here runs in the WebView, not Hermes. One instance
// lives for the whole app (EditorHost); documents switch through `docKey`,
// and each keeps its own state and undo history.
//
// Text goes to native storage debounced, never per keystroke. `seen` is the
// text native had for the document when the edit started, so the library can
// fold the edit into anything that arrived meanwhile (KI-27's three-way merge).
// Text from elsewhere comes in as `external` and lands as one undoable change.

import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { type EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Editor, type References } from '@kintsugi/editor/Editor';
import { type DOMImperativeFactory, type DOMProps, useDOMImperativeHandle } from 'expo/dom';
import { type Ref, useEffect, useMemo, useRef, useState } from 'react';

import './phone.css';

export type PhoneSource = { path: string; title: string; status?: string | null };
export type PhoneExternal = { key: string; text: string; seq: number };

export interface PhoneEditorRef extends DOMImperativeFactory {
  undo: () => void;
  redo: () => void;
  link: () => void;
  blur: () => void;
  /** Sends any waiting text now, then answers `onFlushed(token)`. */
  flush: (token: unknown) => void;
}

type Props = {
  ref: Ref<PhoneEditorRef>;
  dom?: DOMProps;
  /** Which document; stays the same when a new note is renamed. */
  docKey: string;
  /** The document's text the first time it is opened here. */
  text: string;
  external: PhoneExternal | null;
  /** Bump to put the caret at the end and raise the keyboard (a new note). */
  focus: number;
  dark: boolean;
  sources: PhoneSource[];
  onText: (key: string, text: string, seen: string) => Promise<void>;
  onFlushed: (token: number) => Promise<void>;
  onHistory: (canUndo: boolean, canRedo: boolean) => Promise<void>;
  /** The document has been painted. */
  onShown: (key: string) => Promise<void>;
  onOpen: (path: string) => Promise<void>;
  /** Development builds: what happened in here, for UI tests to read. */
  onLog?: (message: string) => Promise<void>;
};

const SAVE_DELAY = 400;

// CodeMirror turns these off for code; prose wants them back (KI-28).
const keyboardText = EditorView.contentAttributes.of({ autocorrect: 'on', autocapitalize: 'sentences', spellcheck: 'true' });

// The tap that focuses the editor: WebKit places the caret after CodeMirror
// has put its own (old) selection back on focus, so the caret would land
// where it last was, not under the finger. Place it from the tap instead.
// Later taps, double taps and long presses are WebKit's own.
function tapToPlaceCaret() {
  let focusedAt = 0;
  return EditorView.domEventHandlers({
    focus: () => {
      focusedAt = Date.now();
      return false;
    },
    click: (event, view) => {
      if (Date.now() - focusedAt > 800 || !view.state.selection.main.empty) return false;
      focusedAt = 0;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos != null && pos !== view.state.selection.main.head) view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' });
      return false;
    },
  });
}

const afterPaint = (fn: () => void) => requestAnimationFrame(() => setTimeout(fn, 0));

/** The text flow between this WebView and native storage, outside React:
 *  per document, what native has (`synced`) and the newest edited state. */
class Sync {
  private synced = new Map<string, string>();
  private latest = new Map<string, EditorState>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private history = { undo: false, redo: false };
  private view: EditorView | null = null;
  private callbacks: Pick<Props, 'onText' | 'onHistory' | 'onLog'> | null = null;

  attach(view: EditorView | null, callbacks: Pick<Props, 'onText' | 'onHistory' | 'onLog'>) {
    this.view = view;
    this.callbacks = callbacks;
  }

  /** For each document's state, made when it first opens, so the listener
   *  knows whose text changed. */
  extensions(key: string) {
    return [
      keyboardText,
      tapToPlaceCaret(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          this.latest.set(key, update.state);
          if (!update.transactions.some((tr) => tr.annotation(Transaction.remote))) {
            clearTimeout(this.timer);
            this.timer = setTimeout(this.flush, SAVE_DELAY);
          }
        }
        if (update.transactions.length) this.reportHistory(update.state);
        // Development: where the picker's first row is, for UI tests to tap.
        const debug = this.callbacks?.onLog;
        if (debug && update.docChanged) {
          requestAnimationFrame(() => {
            const row = document.querySelector('.cm-reference-option')?.getBoundingClientRect();
            if (row) void debug(`picker row ${Math.round(row.left + row.width / 2)},${Math.round(row.top + row.height / 2)}`);
          });
        }
      }),
    ];
  }

  private textOf(key: string) {
    return this.latest.get(key)?.doc.toString() ?? this.synced.get(key);
  }

  flush = () => {
    clearTimeout(this.timer);
    for (const [key, state] of this.latest) {
      const next = state.doc.toString();
      const seen = this.synced.get(key) ?? next;
      if (next === seen) continue;
      this.synced.set(key, next);
      void this.callbacks?.onText(key, next, seen);
    }
  };

  reportHistory(state: EditorState) {
    const now = { undo: undoDepth(state) > 0, redo: redoDepth(state) > 0 };
    if (now.undo === this.history.undo && now.redo === this.history.redo) return;
    this.history = now;
    void this.callbacks?.onHistory(now.undo, now.redo);
  }

  /** `key` is now the open document (Editor switches before this runs). */
  opened(key: string, text: string) {
    if (!this.synced.has(key)) this.synced.set(key, text);
    else this.receive(key, text);
    if (this.view) this.reportHistory(this.view.state);
  }

  /** New text from native for the open document `key`: shown as one
   *  undoable change, unless edits here haven't been sent yet. Then those go
   *  first, and native answers with the merge. */
  receive(key: string, next: string) {
    const view = this.view;
    if (!view) return;
    if (this.textOf(key) !== this.synced.get(key)) return this.flush();
    this.synced.set(key, next);
    const change = difference(view.state.doc.toString(), next);
    if (change) view.dispatch({ changes: change, annotations: Transaction.remote.of(true) });
  }
}

/** The single replacement that turns `a` into `b` (as Editor's `external`). */
function difference(a: string, b: string) {
  if (a === b) return null;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { from: start, to: a.length - end, insert: b.slice(start, b.length - end) };
}

export default function PhoneEditor({ ref, docKey, text, external, focus, dark, sources, ...actions }: Props) {
  const viewRef = useRef<EditorView | null>(null);
  const [sync] = useState(() => new Sync());
  const callbacks = useRef(actions);
  useEffect(() => {
    callbacks.current = actions;
    sync.attach(viewRef.current, actions);
  });

  const extensions = useMemo(() => sync.extensions(docKey), [sync, docKey]);

  const log = (message: string) => {
    if (process.env.NODE_ENV !== 'production') void callbacks.current.onLog?.(message);
  };

  const references = useMemo<References>(
    () => ({
      sources: sources.map((source) => ({ kind: 'document' as const, ...source })),
      onOpen: (source) => void callbacks.current.onOpen(source.path),
    }),
    [sources],
  );

  // A document opens (Editor has switched to it by now: child effects run first).
  useEffect(() => {
    sync.attach(viewRef.current, callbacks.current);
    sync.opened(docKey, text);
    afterPaint(() => void callbacks.current.onShown(docKey));
    // `text` only matters when a document opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  useEffect(() => {
    if (external && external.key === docKey) sync.receive(external.key, external.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [external]);

  useEffect(() => {
    const view = viewRef.current;
    if (!focus || !view) return;
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    // Native also makes the WebView first responder and focuses the content
    // (EditorHost), which is what lets the keyboard come up.
    view.focus();
    setTimeout(() => log(`focus ${docKey}: ${view.hasFocus}`), 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  // The WebView shrinks when the keyboard comes up; keep the caret in sight.
  useEffect(() => {
    const onResize = () => {
      const view = viewRef.current;
      if (!view?.hasFocus) return;
      // The tap that raised the keyboard may not have reached CodeMirror's
      // selection yet; read it first, or dispatching would put the old one back.
      (view as unknown as { observer: { flush(): void } }).observer.flush();
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 32 }) });
      const dom = document.getSelection();
      log(`resize ${window.innerHeight}: caret ${view.state.selection.main.head} docFocus ${document.hasFocus()} active ${document.activeElement?.className} domSel ${dom?.anchorNode?.nodeName}:${dom?.anchorOffset}`);
    };
    // Leaving the editor (Done, or the app going away) sends at once.
    const onBlur = () => sync.flush();
    const onHidden = () => document.visibilityState === 'hidden' && sync.flush();
    // Development: where taps land, to check the picker's rows take them.
    const onTap = (event: Event) => {
      const target = event.target as HTMLElement | null;
      log(`${event.type} ${target?.className || target?.tagName} caret ${viewRef.current?.state.selection.main.head}`);
    };
    const taps = process.env.NODE_ENV !== 'production' ? ['touchend', 'click'] : [];
    taps.forEach((type) => document.addEventListener(type, onTap, true));
    window.addEventListener('resize', onResize);
    window.addEventListener('focusout', onBlur);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      taps.forEach((type) => document.removeEventListener(type, onTap, true));
      window.removeEventListener('resize', onResize);
      window.removeEventListener('focusout', onBlur);
      document.removeEventListener('visibilitychange', onHidden);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // Opens the [[ picker at the caret, as typing it would.
      link: () => {
        const view = viewRef.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({ changes: { from, to, insert: '[[' }, selection: { anchor: from + 2 }, userEvent: 'input.type', scrollIntoView: true });
        view.focus();
      },
      blur: () => viewRef.current?.contentDOM.blur(),
      flush: (token: unknown) => {
        sync.flush();
        void callbacks.current.onFlushed(Number(token));
      },
    }),
    [sync],
  );

  return (
    <div className="phone-editor">
      <Editor
        path={docKey}
        text={text}
        viewRef={viewRef}
        references={references}
        extensions={extensions}
        focusOnOpen={false}
      />
    </div>
  );
}
