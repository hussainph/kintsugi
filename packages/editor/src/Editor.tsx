import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { search, searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { RefObject, useEffect, useRef } from "react";
import { frontmatter } from "@kintsugi/core/frontmatter";
import { frontmatterLines, highlight, theme } from "./theme";

/** New text for a document from somewhere else, such as the phone. `seq`
 *  tells repeated deliveries of the same text apart. */
export type External = { path: string; text: string; seq: number };

type Props = {
  path: string;
  text: string;
  /** `external` is true when the change came in through the `external` prop. */
  onChange: (path: string, text: string, external: boolean) => void;
  external?: External | null;
  viewRef: RefObject<EditorView | null>;
};

/** One EditorView for the app. Each document keeps its own EditorState (and so
 *  its own undo history) for as long as this component lives. */
export function Editor({ path, text, onChange, external, viewRef }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const states = useRef(new Map<string, EditorState>());
  const current = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const create = (docPath: string, doc: string) =>
    EditorState.create({
      doc,
      selection: EditorSelection.cursor(bodyStart(doc)),
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        search({ top: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: languages }) }),
        syntaxHighlighting(highlight),
        frontmatterLines,
        theme,
        placeholder("Start writing…"),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const fromElsewhere = update.transactions.some((tr) => tr.annotation(Transaction.remote));
          onChangeRef.current(docPath, update.state.doc.toString(), fromElsewhere);
        }),
      ],
    });

  useEffect(() => {
    const view = new EditorView({ parent: host.current! });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
      current.current = null;
    };
  }, [viewRef]);

  useEffect(() => {
    const view = viewRef.current!;
    if (current.current === path) return;
    if (current.current) states.current.set(current.current, view.state);
    view.setState(states.current.get(path) ?? create(path, text));
    current.current = path;
    view.focus();
    // `text` only seeds a document the first time it is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Apply outside edits as a normal, undoable change to just the part that
  // differs, so the cursor and scroll position stay put.
  useEffect(() => {
    if (!external) return;
    const apply = (state: EditorState) => {
      const change = difference(state.doc.toString(), external.text);
      return change && state.update({ changes: change, annotations: Transaction.remote.of(true) });
    };
    const view = viewRef.current;
    if (view && current.current === external.path) {
      const tr = apply(view.state);
      if (tr) view.dispatch(tr);
    } else {
      const stored = states.current.get(external.path);
      const tr = stored && apply(stored);
      if (tr) states.current.set(external.path, tr.state);
    }
  }, [external, viewRef]);

  return <div className="min-h-0 flex-1 cursor-text select-text" ref={host} />;
}

/** The single replacement that turns `a` into `b`, trimming what they share. */
function difference(a: string, b: string) {
  if (a === b) return null;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { from: start, to: a.length - end, insert: b.slice(start, b.length - end) };
}

/** Where the cursor lands on open: the first line of the body, past the frontmatter. */
function bodyStart(doc: string): number {
  const block = frontmatter(doc);
  if (!block) return 0;
  const end = doc.indexOf("\n", block.close);
  if (end === -1) return doc.length;
  return doc[end + 1] === "\n" ? end + 2 : end + 1;
}
